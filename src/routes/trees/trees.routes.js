import { Router } from "express";
import { query } from "../../config/db.js";
import {
  requireLogin,
  canAccessTree,
  assertTreeAccess,
} from "../../middleware/auth.js";
import { TREES } from "../../utils/constants.js";
import { badRequest, notFound } from "../../utils/errors.js";
import { toSummary, getBranch, getMemberRow } from "../../services/members.js";

const router = Router();
router.use(requireLogin);

const parseTree = (v) => {
  const t = String(v).toUpperCase();
  if (!TREES.includes(t)) throw badRequest("Tree must be EGYPT or JORDAN.");
  return t;
};

// Which trees exist, and which ones this user can open / has asked for
router.get("/", async (req, res) => {
  const pending = await query(
    `SELECT tree FROM access_requests WHERE user_id=$1 AND status='PENDING'`,
    [req.user.id],
  );
  const counts = await query(
    "SELECT tree, count(*)::int AS n FROM members GROUP BY tree",
  );
  const n = Object.fromEntries(counts.rows.map((r) => [r.tree, r.n]));
  const items = [];
  for (const tree of TREES) {
    items.push({
      tree,
      memberCount: n[tree] ?? 0,
      hasAccess: await canAccessTree(req.user, tree),
      accessRequestPending: pending.rows.some((r) => r.tree === tree),
    });
  }
  res.json({ items });
});

// The first screen: top person(s) + their direct children, each with how many descendants they have.
// Egypt -> the grandfather + his 8 children. Jordan -> its top ancestors + their children.
router.get("/:tree/overview", async (req, res) => {
  const tree = parseTree(req.params.tree);
  await assertTreeAccess(req.user, tree);

  const roots = (
    await query(
      "SELECT * FROM members WHERE tree=$1 AND parent_id IS NULL ORDER BY serial_parts",
      [tree],
    )
  ).rows;
  const rootIds = roots.map((r) => r.id);
  const kids = rootIds.length
    ? (
        await query(
          "SELECT * FROM members WHERE parent_id = ANY($1) ORDER BY serial_parts, sort_index",
          [rootIds],
        )
      ).rows
    : [];
  const kidIds = kids.map((k) => k.id);
  const counts = kidIds.length
    ? (
        await query(
          `WITH RECURSIVE d AS (
             SELECT id, id AS top FROM members WHERE id = ANY($1)
             UNION ALL
             SELECT m.id, d.top FROM members m JOIN d ON m.parent_id = d.id
           ) SELECT top, count(*)::int - 1 AS descendants FROM d GROUP BY top`,
          [kidIds],
        )
      ).rows
    : [];
  const desc = Object.fromEntries(counts.map((c) => [c.top, c.descendants]));
  const spouseNames = async (ids) => {
    if (!ids.length) return {};
    const { rows } = await query(
      "SELECT member_id, json_agg(spouse_name ORDER BY sort_order, id) AS names FROM member_spouses WHERE member_id = ANY($1) GROUP BY member_id",
      [ids],
    );
    return Object.fromEntries(rows.map((r) => [r.member_id, r.names]));
  };
  const sp = await spouseNames([...rootIds, ...kidIds]);

  res.json({
    tree,
    roots: roots.map((r) => ({
      ...toSummary(r),
      spouses: sp[r.id] ?? [],
      children: kids
        .filter((k) => k.parent_id === r.id)
        .map((k) => ({
          ...toSummary(k),
          spouses: sp[k.id] ?? [],
          descendantsCount: desc[k.id] ?? 0,
        })),
    })),
  });
});

// Click on one child: everything below him (nested). ?depth=2 limits how deep (optional).
router.get("/:tree/branch/:memberId", async (req, res) => {
  const tree = parseTree(req.params.tree);
  await assertTreeAccess(req.user, tree);
  const m = await getMemberRow(Number(req.params.memberId));
  if (m.tree !== tree) throw notFound("Member not found in this tree.");
  const depth = req.query.depth
    ? Math.min(Math.max(Number(req.query.depth) || 1, 1), 50)
    : 50;
  res.json({ branch: await getBranch(m.id, depth) });
});

// Search by name inside one tree
router.get("/:tree/search", async (req, res) => {
  const tree = parseTree(req.params.tree);
  await assertTreeAccess(req.user, tree);
  const q = String(req.query.q || "").trim();
  if (q.length < 2) throw badRequest("Type at least 2 characters.");
  const like = `%${q.replace(/[%_\\]/g, "\\$&")}%`;
  const { rows } = await query(
    `SELECT * FROM members WHERE tree=$1 AND (name ILIKE $2 OR nickname ILIKE $2)
      ORDER BY depth, serial_parts LIMIT 30`,
    [tree, like],
  );
  res.json({ items: rows.map(toSummary) });
});

export default router;
