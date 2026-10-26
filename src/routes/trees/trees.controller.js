import { query } from '../../config/db.js';

export async function getTree(req, res) {
  const { rows: nodes } = await query('SELECT id, member_id, first_name, last_name, father_id, mother_id, spouse_id, generation, gender FROM members ORDER BY generation NULLS LAST, last_name');
  res.json({ nodes });
}
