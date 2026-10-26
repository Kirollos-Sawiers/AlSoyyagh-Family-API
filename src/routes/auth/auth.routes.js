import { Router } from "express";
import bcrypt from "bcryptjs";
import rateLimit from "express-rate-limit";
import { query } from "../../config/db.js";
import { authenticate, signToken } from "../../middleware/auth.js";
import { hashPassword, verifyPassword } from "../../utils/password.js";
import { loginSchema, changePasswordSchema } from "../../utils/schemas.js";
import { HttpError, badRequest } from "../../utils/errors.js";
import { audit } from "../../utils/audit.js";

const router = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  skipSuccessfulRequests: true, // only failed logins count
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: "TOO_MANY_ATTEMPTS",
      message: "Too many login attempts. Try again in 15 minutes.",
    },
  },
});

const publicUser = (u) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  phone: u.phone,
  relation: u.relation,
  role: u.role,
  mustChangePassword: u.must_change_password,
});

// A fixed fake hash so that "unknown e-mail" takes as long as "wrong password" (no user enumeration)
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", 12);

router.post("/login", loginLimiter, async (req, res) => {
  const { email, password } = loginSchema.parse(req.body);
  const { rows } = await query(
    "SELECT * FROM users WHERE lower(email) = lower($1)",
    [email],
  );
  const user = rows[0];
  const ok = await verifyPassword(
    password,
    user ? user.password_hash : DUMMY_HASH,
  );
  if (!user || !ok || user.status !== "ACTIVE") {
    throw new HttpError(
      401,
      "INVALID_CREDENTIALS",
      "Wrong e-mail or password.",
    );
  }
  await query("UPDATE users SET last_login_at = now() WHERE id = $1", [
    user.id,
  ]);
  res.json({
    token: signToken(user),
    mustChangePassword: user.must_change_password, // true on first login -> show the "reset password" page
    user: publicUser(user),
  });
});

router.get("/me", authenticate, async (req, res) => {
  const { rows } = await query(
    "SELECT tree FROM user_tree_access WHERE user_id = $1",
    [req.user.id],
  );
  const all = ["ADMIN", "SUPER_ADMIN"].includes(req.user.role);
  res.json({
    user: publicUser(req.user),
    trees: all ? ["EGYPT", "JORDAN"] : rows.map((r) => r.tree),
  });
});

// First login: user sends the temporary (old) password + a new one
router.post("/change-password", authenticate, async (req, res) => {
  const { oldPassword, newPassword } = changePasswordSchema.parse(req.body);
  if (oldPassword === newPassword)
    throw badRequest("The new password must be different from the old one.");
  const { rows } = await query(
    "SELECT password_hash FROM users WHERE id = $1",
    [req.user.id],
  );
  if (!(await verifyPassword(oldPassword, rows[0].password_hash))) {
    throw new HttpError(
      400,
      "WRONG_OLD_PASSWORD",
      "The old password is incorrect.",
    );
  }
  await query(
    "UPDATE users SET password_hash=$1, must_change_password=FALSE, updated_at=now() WHERE id=$2",
    [await hashPassword(newPassword), req.user.id],
  );
  await audit(null, req.user.id, "PASSWORD_CHANGED", "user", req.user.id);
  res.json({ ok: true, token: signToken(req.user), mustChangePassword: false });
});

export default router;
