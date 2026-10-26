import { query } from '../../config/db.js';

export async function stats(req, res) {
  const members = await query('SELECT COUNT(*)::int AS count FROM members');
  const users = await query('SELECT COUNT(*)::int AS count FROM users');
  const joinPending = await query("SELECT COUNT(*)::int AS count FROM join_requests WHERE status = 'pending'");
  const accessPending = await query("SELECT COUNT(*)::int AS count FROM access_requests WHERE status = 'pending'");
  const changePending = await query("SELECT COUNT(*)::int AS count FROM change_requests WHERE status = 'pending'");
  res.json({
    members: members.rows[0].count,
    users: users.rows[0].count,
    joinRequestsPending: joinPending.rows[0].count,
    accessRequestsPending: accessPending.rows[0].count,
    changeRequestsPending: changePending.rows[0].count
  });
}

export async function auditLogs(req, res) {
  const { limit = 50 } = req.query;
  const { rows } = await query('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT $1', [Number(limit)]);
  res.json(rows);
}
