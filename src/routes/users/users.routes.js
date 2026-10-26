import { Router } from "express";
import { query, tx } from "../../config/db.js";
import { requireLogin, requireRole, hasRole } from "../../middleware/auth.js";
import {
  updateUserSchema,
  setTreesSchema,
  resetPasswordSchema,
} from "../../utils/schemas.js";
import { hashPassword, generateTempPassword } from "../../utils/password.js";
import { forbidden, notFound, badRequest } from "../../utils/errors.js";
import { ROLE_RANK } from "../../utils/constants.js";
import { audit } from "../../utils/audit.js";

const router = Router();
router.use(requireLogin);

const toDto = (r) => ({
  id: r.id,
  name: r.name,
  email: r.email,
  phone: r.phone,
  relation: r.relation,
  role: r.role,
  status: r.status,
  hasAvatar: r.has_avatar,
  trees: r.trees,
  mustChangePassword: r.must_change_password,
  lastLoginAt: r.last_login_at,
  createdAt: r.created_at,
});

router.get("/", requireRole("ADMIN"), async (_req, res) => {
  const { rows } = await query(
    `SELECT u.id, u.name, u.email, u.phone, u.relation, u.role, u.status, (u.avatar IS NOT NULL) AS has_avatar,
            u.must_change_password, u.last_login_at, u.created_at,
            COALESCE(array_agg(t.tree) FILTER (WHERE t.tree IS NOT NULL), '{}') AS trees
       FROM users u LEFT JOIN user_tree_access t ON t.user_id = u.id
      GROUP BY u.id ORDER BY u.created_at DESC`,
  );
  res.json({ items: rows.map(toDto) });
});

// Profile photo (the one uploaded at join time). Own photo or admins.
router.get("/:id/avatar", async (req, res) => {
  if (req.params.id !== req.user.id && !hasRole(req.user, "ADMIN"))
    throw forbidden();
  const { rows } = await query(
    "SELECT avatar, avatar_mime FROM users WHERE id = $1",
    [req.params.id],
  );
  if (!rows[0]?.avatar) throw notFound("No image.");
  res
    .set("Content-Type", rows[0].avatar_mime)
    .set("Cache-Control", "private, max-age=3600")
    .send(rows[0].avatar);
});

async function loadTarget(id) {
  const { rows } = await query(
    "SELECT id, role, status FROM users WHERE id = $1",
    [id],
  );
  if (!rows[0]) throw notFound("User not found.");
  return rows[0];
}

// Rules: a SUPER_ADMIN can do everything. An ADMIN may only manage users BELOW admin
// (contributors / users) and may not create admins.
function assertCanManage(actor, target, newRole) {
  if (target.id === actor.id)
    throw badRequest("You cannot change your own role or status.");
  if (actor.role === "SUPER_ADMIN") return;
  if (ROLE_RANK[target.role] >= ROLE_RANK.ADMIN)
    throw forbidden("Only a super admin can manage admins.");
  if (newRole && ROLE_RANK[newRole] >= ROLE_RANK.ADMIN)
    throw forbidden("Only a super admin can make someone an admin.");
}

router.patch("/:id", requireRole("ADMIN"), async (req, res) => {
  const body = updateUserSchema.parse(req.body);
  const target = await loadTarget(req.params.id);
  assertCanManage(req.user, target, body.role);
  if (
    target.role === "SUPER_ADMIN" &&
    body.role &&
    body.role !== "SUPER_ADMIN"
  ) {
    const { rows } = await query(
      `SELECT count(*)::int AS n FROM users WHERE role='SUPER_ADMIN' AND status='ACTIVE'`,
    );
    if (rows[0].n <= 1)
      throw badRequest("There must be at least one active super admin.");
  }
  await query(
    `UPDATE users SET role = COALESCE($1, role), status = COALESCE($2, status), updated_at = now() WHERE id = $3`,
    [body.role ?? null, body.status ?? null, target.id],
  );
  await audit(null, req.user.id, "USER_UPDATED", "user", target.id, body);
  res.json({ ok: true });
});

// Replace which country trees a user may open
router.put("/:id/trees", requireRole("ADMIN"), async (req, res) => {
  const { trees } = setTreesSchema.parse(req.body);
  const target = await loadTarget(req.params.id);
  await tx(async (c) => {
    await c.query("DELETE FROM user_tree_access WHERE user_id = $1", [
      target.id,
    ]);
    for (const t of trees) {
      await c.query(
        "INSERT INTO user_tree_access (user_id, tree, granted_by) VALUES ($1,$2,$3)",
        [target.id, t, req.user.id],
      );
    }
    await audit(c, req.user.id, "USER_TREES_SET", "user", target.id, { trees });
  });
  res.json({ ok: true, trees });
});

// Forgot password: super admin sets/generates a new temporary password; user must change it at next login.
router.post(
  "/:id/reset-password",
  requireRole("SUPER_ADMIN"),
  async (req, res) => {
    const { password } = resetPasswordSchema.parse(req.body ?? {});
    const target = await loadTarget(req.params.id);
    const temp = password ?? generateTempPassword();
    await query(
      "UPDATE users SET password_hash=$1, must_change_password=TRUE, updated_at=now() WHERE id=$2",
      [await hashPassword(temp), target.id],
    );
    await audit(null, req.user.id, "PASSWORD_RESET", "user", target.id);
    res.json({ ok: true, temporaryPassword: temp });
  },
);

export default router;
