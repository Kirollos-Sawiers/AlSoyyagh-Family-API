import { query } from '../../config/db.js';
import { AppError } from '../../utils/errors.js';
import { auditLog } from '../../utils/audit.js';
import { REQUEST_STATUS } from '../../utils/constants.js';

export async function createChangeRequest(req, res) {
  const { memberId, requestType, proposedData, currentData } = req.body;
  const { rows } = await query(
    `INSERT INTO change_requests (requester_id, member_id, request_type, proposed_data, current_data)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [req.user.id, memberId || null, requestType, proposedData || null, currentData || null]
  );
  res.status(201).json(rows[0]);
}

export async function listChangeRequests(req, res) {
  const { rows } = await query('SELECT * FROM change_requests ORDER BY created_at DESC');
  res.json(rows);
}

export async function reviewChangeRequest(req, res) {
  const { id } = req.params;
  const { status, reviewNotes } = req.body;
  if (!Object.values(REQUEST_STATUS).includes(status)) throw new AppError('Invalid status', 400);
  const { rows } = await query(
    `UPDATE change_requests SET status = $1, reviewed_by = $2, reviewed_at = NOW(), review_notes = $3 WHERE id = $4 RETURNING *`,
    [status, req.user.id, reviewNotes || null, id]
  );
  if (!rows[0]) throw new AppError('Request not found', 404);
  await auditLog({ actorId: req.user.id, action: `change_request_${status}`, resourceType: 'change_request', resourceId: id });
  res.json(rows[0]);
}
