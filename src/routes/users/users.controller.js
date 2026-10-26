import { query } from '../../config/db.js';
import { AppError } from '../../utils/errors.js';
import { auditLog } from '../../utils/audit.js';

export async function listUsers(req, res) {
  const { rows } = await query('SELECT id, email, first_name, last_name, role, is_active, created_at FROM users ORDER BY created_at DESC');
  res.json(rows);
}

export async function getUser(req, res) {
  const { id } = req.params;
  const { rows } = await query('SELECT id, email, first_name, last_name, role, is_active FROM users WHERE id = $1', [id]);
  if (!rows[0]) throw new AppError('User not found', 404);
  res.json(rows[0]);
}

export async function updateUserRole(req, res) {
  const { id } = req.params;
  const { role } = req.body;
  const allowed = ['admin', 'editor', 'viewer'];
  if (!allowed.includes(role)) throw new AppError('Invalid role', 400);
  const { rows } = await query('UPDATE users SET role = $1, updated_at = NOW() WHERE id = $2 RETURNING id,email,role', [role, id]);
  if (!rows[0]) throw new AppError('User not found', 404);
  await auditLog({ actorId: req.user.id, action: 'update_user_role', resourceType: 'user', resourceId: id, details: { role } });
  res.json(rows[0]);
}

export async function toggleActive(req, res) {
  const { id } = req.params;
  const { rows } = await query('UPDATE users SET is_active = NOT is_active, updated_at = NOW() WHERE id = $1 RETURNING id,is_active', [id]);
  if (!rows[0]) throw new AppError('User not found', 404);
  await auditLog({ actorId: req.user.id, action: 'toggle_user_active', resourceType: 'user', resourceId: id, details: { is_active: rows[0].is_active } });
  res.json(rows[0]);
}
