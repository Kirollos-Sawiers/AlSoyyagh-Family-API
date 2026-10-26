import { Router } from "express";
import rateLimit from "express-rate-limit";
import { query, tx } from "../../config/db.js";
import { requireLogin, requireRole } from "../../middleware/auth.js";
import { imageUpload, validateImage } from "../../utils/upload.js";
import {
  joinRequestSchema,
  approveJoinSchema,
  rejectSchema,
} from "../../utils/schemas.js";
import { hashPassword, generateTempPassword } from "../../utils/password.js";
import { HttpError, notFound, conflict } from "../../utils/errors.js";
import { audit } from "../../utils/audit.js";

const router = Router();

const joinLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: "TOO_MANY_REQUESTS",
      message: "Too many requests. Please try again later.",
    },
  },
});

const toDto = (r) => ({
  id: r.id,
  name: r.name,
  phone: r.phone,
  email: r.email,
  relation: r.relation,
  hasImage: r.has_image,
  status: r.status,
  rejectReason: r.reject_reason,
  reviewedAt: r.reviewed_at,
  createdAt: r.created_at,
});

// PUBLIC - a new person asks to join (multipart/form-data so the image can be sent; image is optional)
router.post("/", joinLimiter, imageUpload.single("image"), async (req, res) => {
  const data = joinRequestSchema.parse(req.body);
  const img = validateImage(req.file);

  const existingUser = await query(
    "SELECT 1 FROM users WHERE lower(email)=lower($1)",
    [data.email],
  );
  if (existingUser.rowCount)
    throw conflict(
      "An account with this e-mail already exists. Please log in.",
    );

  try {
    await query(
      `INSERT INTO join_requests (name, phone, email, relation, image, image_mime) VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        data.name,
        data.phone,
        data.email,
        data.relation,
        img?.buffer ?? null,
        img?.mime ?? null,
      ],
    );
  } catch (e) {
    if (e.code === "23505")
      throw conflict(
        "A request with this e-mail is already waiting for approval.",
      );
    throw e;
  }
  res
    .status(201)
    .json({
      ok: true,
      message:
        "Your request was sent. You will be contacted once it is approved.",
    });
});

// ADMIN + SUPER_ADMIN can look. Only SUPER_ADMIN can approve / reject.
router.get("/", requireLogin, requireRole("ADMIN"), async (req, res) => {
  const status = ["PENDING", "APPROVED", "REJECTED"].includes(req.query.status)
    ? req.query.status
    : null;
  const { rows } = await query(
    `SELECT id, name, phone, email, relation, (image IS NOT NULL) AS has_image, status, reject_reason, reviewed_at, created_at
       FROM join_requests WHERE ($1::text IS NULL OR status = $1) ORDER BY created_at DESC LIMIT 200`,
    [status],
  );
  res.json({ items: rows.map(toDto) });
});

router.get(
  "/:id/image",
  requireLogin,
  requireRole("ADMIN"),
  async (req, res) => {
    const { rows } = await query(
      "SELECT image, image_mime FROM join_requests WHERE id = $1",
      [req.params.id],
    );
    if (!rows[0]?.image) throw notFound("No image.");
    res
      .set("Content-Type", rows[0].image_mime)
      .set("Cache-Control", "private, max-age=3600")
      .send(rows[0].image);
  },
);

router.post(
  "/:id/approve",
  requireLogin,
  requireRole("SUPER_ADMIN"),
  async (req, res) => {
    const { role, trees, password } = approveJoinSchema.parse(req.body);
    const tempPassword = password ?? generateTempPassword();
    const hash = await hashPassword(tempPassword);

    const user = await tx(async (c) => {
      const { rows } = await c.query(
        "SELECT * FROM join_requests WHERE id = $1 FOR UPDATE",
        [req.params.id],
      );
      const jr = rows[0];
      if (!jr) throw notFound("Request not found.");
      if (jr.status !== "PENDING")
        throw conflict(`This request was already ${jr.status.toLowerCase()}.`);

      const created = await c
        .query(
          `INSERT INTO users (name, email, phone, relation, role, password_hash, must_change_password, avatar, avatar_mime, approved_by)
       VALUES ($1,$2,$3,$4,$5,$6,TRUE,$7,$8,$9) RETURNING id, name, email, role`,
          [
            jr.name,
            jr.email,
            jr.phone,
            jr.relation,
            role,
            hash,
            jr.image,
            jr.image_mime,
            req.user.id,
          ],
        )
        .catch((e) => {
          if (e.code === "23505")
            throw conflict("A user with this e-mail already exists.");
          throw e;
        });
      const u = created.rows[0];
      for (const t of trees) {
        await c.query(
          "INSERT INTO user_tree_access (user_id, tree, granted_by) VALUES ($1,$2,$3)",
          [u.id, t, req.user.id],
        );
      }
      await c.query(
        `UPDATE join_requests SET status='APPROVED', reviewed_by=$1, reviewed_at=now(), created_user_id=$2 WHERE id=$3`,
        [req.user.id, u.id, jr.id],
      );
      await audit(c, req.user.id, "JOIN_APPROVED", "join_request", jr.id, {
        role,
        trees,
      });
      return u;
    });

    // The temporary password is shown ONCE. The super admin sends it to the person (e.g. WhatsApp).
    res.json({ ok: true, user, temporaryPassword: tempPassword, trees });
  },
);

router.post(
  "/:id/reject",
  requireLogin,
  requireRole("SUPER_ADMIN"),
  async (req, res) => {
    const { reason } = rejectSchema.parse(req.body);
    const { rowCount } = await query(
      `UPDATE join_requests SET status='REJECTED', reviewed_by=$1, reviewed_at=now(), reject_reason=$2
      WHERE id=$3 AND status='PENDING'`,
      [req.user.id, reason ?? null, req.params.id],
    );
    if (!rowCount)
      throw new HttpError(
        409,
        "CONFLICT",
        "Request not found or already reviewed.",
      );
    await audit(
      null,
      req.user.id,
      "JOIN_REJECTED",
      "join_request",
      req.params.id,
    );
    res.json({ ok: true });
  },
);

export default router;
