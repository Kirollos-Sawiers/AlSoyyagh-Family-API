import { query } from '../../config/db.js';
import { AppError } from '../../utils/errors.js';
import { auditLog } from '../../utils/audit.js';
import { REQUEST_STATUS } from '../../utils/constants.js';

export async function createJoinRequest(req, res) {
  const { email, firstName, lastName, phone, reason } = req.validatedBody;
  const { rows } = await query(
    `INSERT INTO join_requests (email, first_name, last_name, phone, reason)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [email, firstName, lastName, phone || null, reason || null]
  );
  res.status(201).json(rows[0]);
}

export async function listJoinRequests(req, res) {
  const { status } = req.query;
  let sql = 'SELECT * FROM join_requests';
  const params = [];
  if (status) { params.push(status); sql += ` WHERE status = $1`; }
  sql += ' ORDER BY created_at DESC';
  const { rows } = await query(sql, params);
  res.json(rows);
}

export async function reviewJoinRequest(req, res) {
  const { id } = req.params;
  const { status } = req.body;
  if (!Object.values(REQUEST_STATUS).includes(status)) throw new AppError('Invalid status', 400);
  const { rows } = await query(
    `UPDATE join_requests SET status = $1, reviewed_by = $2, reviewed_at = NOW() WHERE id = $3 RETURNING *`,
    [status, req.user.id, id]
  );
  if (!rows[0]) throw new AppError('Request not found', 404);
  await auditLog({ actorId: req.user.id, action: `join_request_${status}`, resourceType: 'join_request', resourceId: id });
  res.json(rows[0]);
}
