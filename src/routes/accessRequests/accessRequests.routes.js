import { Router } from 'express';
import { query, tx } from '../../config/db.js';
import { requireLogin, requireRole, canAccessTree } from '../../middleware/auth.js';
import { accessRequestSchema } from '../../utils/schemas.js';
import { conflict, notFound } from '../../utils/errors.js';
import { audit } from '../../utils/audit.js';

const router = Router();
router.use(requireLogin);

const dto = (r) => ({
  id: r.id, tree: r.tree, status: r.status, createdAt: r.created_at, reviewedAt: r.reviewed_at,
  user: r.user_name ? { id: r.user_id, name: r.user_name, email: r.user_email } : undefined,
});

// A user asks to open the other country's tree
router.post('/', async (req, res) => {
  const { tree } = accessRequestSchema.parse(req.body);
  if (await canAccessTree(req.user, tree)) throw conflict('You already have access to this tree.');
  try {
    const { rows } = await query(
      'INSERT INTO access_requests (user_id, tree) VALUES ($1,$2) RETURNING *',
      [req.user.id, tree]
    );
    res.status(201).json({ request: dto(rows[0]) });
  } catch (e) {
    if (e.code === '23505') throw conflict('You already have a pending request for this tree.');
    throw e;
  }
});

router.get('/mine', async (req, res) => {
  const { rows } = await query('SELECT * FROM access_requests WHERE user_id=$1 ORDER BY created_at DESC', [req.user.id]);
  res.json({ items: rows.map(dto) });
});

router.get('/', requireRole('ADMIN'), async (req, res) => {
  const status = ['PENDING', 'APPROVED', 'REJECTED'].includes(req.query.status) ? req.query.status : null;
  const { rows } = await query(
    `SELECT a.*, u.name AS user_name, u.email AS user_email FROM access_requests a JOIN users u ON u.id = a.user_id
      WHERE ($1::text IS NULL OR a.status = $1) ORDER BY a.created_at DESC LIMIT 200`,
    [status]
  );
  res.json({ items: rows.map(dto) });
});

async function review(req, res, approve) {
  await tx(async (c) => {
    const { rows } = await c.query('SELECT * FROM access_requests WHERE id=$1 FOR UPDATE', [req.params.id]);
    const r = rows[0];
    if (!r) throw notFound('Request not found.');
    if (r.status !== 'PENDING') throw conflict(`Already ${r.status.toLowerCase()}.`);
    await c.query(`UPDATE access_requests SET status=$1, reviewed_by=$2, reviewed_at=now() WHERE id=$3`, [
      approve ? 'APPROVED' : 'REJECTED', req.user.id, r.id,
    ]);
    if (approve) {
      await c.query(
        `INSERT INTO user_tree_access (user_id, tree, granted_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [r.user_id, r.tree, req.user.id]
      );
    }
    await audit(c, req.user.id, approve ? 'ACCESS_APPROVED' : 'ACCESS_REJECTED', 'access_request', r.id, { tree: r.tree });
  });
  res.json({ ok: true });
}
router.post('/:id/approve', requireRole('ADMIN'), (req, res) => review(req, res, true));
router.post('/:id/reject', requireRole('ADMIN'), (req, res) => review(req, res, false));

export default router;
