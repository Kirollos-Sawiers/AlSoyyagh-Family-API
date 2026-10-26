import { query } from '../../config/db.js';
import { AppError } from '../../utils/errors.js';
import { auditLog } from '../../utils/audit.js';
import { REQUEST_STATUS } from '../../utils/constants.js';

export async function createAccessRequest(req, res) {
  const { requestedRole, reason } = req.body;
  const { rows } = await query(
    `INSERT INTO access_requests (user_id, requested_role, reason) VALUES ($1,$2,$3) RETURNING *`,
    [req.user.id, requestedRole, reason || null]
  );
  res.status(201).json(rows[0]);
}

export async function listAccessRequests(req, res) {
  const { rows } = await query('SELECT * FROM access_requests ORDER BY created_at DESC');
  res.json(rows);
}

export async function reviewAccessRequest(req, res) {
  const { id } = req.params;
  const { status } = req.body;
  if (!Object.values(REQUEST_STATUS).includes(status)) throw new AppError('Invalid status', 400);
  const { rows } = await query(
    `UPDATE access_requests SET status = $1, reviewed_by = $2, reviewed_at = NOW() WHERE id = $3 RETURNING *`,
    [status, req.user.id, id]
  );
  if (!rows[0]) throw new AppError('Request not found', 404);
  await auditLog({ actorId: req.user.id, action: `access_request_${status}`, resourceType: 'access_request', resourceId: id });
  res.json(rows[0]);
}
