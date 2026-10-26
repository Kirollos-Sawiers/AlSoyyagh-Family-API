import jwt from 'jsonwebtoken';
import { config } from '../../config/env.js';
import { query } from '../../config/db.js';
import { comparePassword, hashPassword } from '../../utils/password.js';
import { AppError } from '../../utils/errors.js';
import { auditLog } from '../../utils/audit.js';

function signTokens(user) {
  const payload = { id: user.id, email: user.email, role: user.role };
  const access = jwt.sign(payload, config.jwtSecret, { expiresIn: config.jwtExpiresIn });
  const refresh = jwt.sign(payload, config.refreshTokenSecret, { expiresIn: config.refreshTokenExpiresIn });
  return { access, refresh };
}

export async function register(req, res) {
  const { email, password, firstName, lastName } = req.validatedBody;
  const { rows: existing } = await query('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.length > 0) throw new AppError('Email already exists', 409);
  const password_hash = await hashPassword(password);
  const { rows } = await query(
    `INSERT INTO users (email, password_hash, first_name, last_name, role, is_active)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,email,first_name,last_name,role`,
    [email, password_hash, firstName, lastName, 'viewer', true]
  );
  await auditLog({ actorId: rows[0].id, action: 'register', resourceType: 'user', resourceId: rows[0].id, ipAddress: req.ip, userAgent: req.headers['user-agent'] });
  res.status(201).json(rows[0]);
}

export async function login(req, res) {
  const { email, password } = req.validatedBody;
  const { rows } = await query('SELECT * FROM users WHERE email = $1', [email]);
  if (!rows[0]) throw new AppError('Invalid credentials', 401);
  const user = rows[0];
  if (!user.is_active) throw new AppError('Account disabled', 403);
  const ok = await comparePassword(password, user.password_hash);
  if (!ok) throw new AppError('Invalid credentials', 401);
  const tokens = signTokens(user);
  await auditLog({ actorId: user.id, action: 'login', resourceType: 'user', resourceId: user.id, ipAddress: req.ip, userAgent: req.headers['user-agent'] });
  res.json({ user: { id: user.id, email: user.email, role: user.role, firstName: user.first_name, lastName: user.last_name }, tokens });
}
