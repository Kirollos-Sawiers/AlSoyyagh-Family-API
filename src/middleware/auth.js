import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { query } from "../config/db.js";
import { HttpError, unauthorized, forbidden } from "../utils/errors.js";
import { ROLE_RANK } from "../utils/constants.js";

export const signToken = (user) =>
  jwt.sign({ sub: user.id }, env.jwtSecret, { expiresIn: env.jwtExpiresIn });

// Reads "Authorization: Bearer <token>", loads the user from the database (so role changes
// and disabled accounts take effect immediately) and puts it on req.user.
export async function authenticate(req, _res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) throw unauthorized();
  let payload;
  try {
    payload = jwt.verify(token, env.jwtSecret);
  } catch {
    throw unauthorized("Your session expired. Please log in again.");
  }
  const { rows } = await query(
    `SELECT id, name, email, phone, relation, role, status, must_change_password FROM users WHERE id = $1`,
    [payload.sub],
  );
  const user = rows[0];
  if (!user || user.status !== "ACTIVE")
    throw unauthorized("This account is not active.");
  req.user = user;
  next();
}

// Same as authenticate but ALSO blocks everything until the first-login password change is done.
export async function requireLogin(req, res, next) {
  await authenticate(req, res, () => {});
  if (req.user.must_change_password) {
    throw new HttpError(
      403,
      "PASSWORD_CHANGE_REQUIRED",
      "You must change your password before continuing.",
    );
  }
  next();
}

// requireRole('ADMIN') = ADMIN or higher (SUPER_ADMIN)
export const requireRole = (minRole) => (req, _res, next) => {
  if (ROLE_RANK[req.user.role] < ROLE_RANK[minRole]) throw forbidden();
  next();
};

export const hasRole = (user, minRole) =>
  ROLE_RANK[user.role] >= ROLE_RANK[minRole];

// Can this user open this country's tree?
export async function canAccessTree(user, tree) {
  if (hasRole(user, "ADMIN")) return true;
  const { rowCount } = await query(
    "SELECT 1 FROM user_tree_access WHERE user_id=$1 AND tree=$2",
    [user.id, tree],
  );
  return rowCount > 0;
}

export async function assertTreeAccess(user, tree) {
  if (!(await canAccessTree(user, tree))) {
    throw new HttpError(
      403,
      "TREE_ACCESS_REQUIRED",
      `You need approval to view the ${tree} tree.`,
      { tree },
    );
  }
}
