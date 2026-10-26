import { Router } from "express";
import { query, tx } from "../../config/db.js";
import { requireLogin, requireRole, hasRole } from "../../middleware/auth.js";
import {
  reviewSchema,
  editMemberSchema,
  addChildSchema,
} from "../../utils/schemas.js";
import { conflict, notFound, forbidden } from "../../utils/errors.js";
import { applyEdit, applyAddChild } from "../../services/members.js";
import { audit } from "../../utils/audit.js";

const router = Router();
router.use(requireLogin);

const dto = (r) => ({
  id: r.id,
  type: r.type,
  tree: r.tree,
  memberId: r.member_id,
  memberName: r.member_name,
  memberSerial: r.member_serial,
  payload: r.payload,
  before: r.before_data,
  status: r.status,
  requestedBy: { id: r.requested_by, name: r.requester_name },
  reviewedBy: r.reviewed_by
    ? { id: r.reviewed_by, name: r.reviewer_name }
    : null,
  reviewedAt: r.reviewed_at,
  reviewNote: r.review_note,
  resultMemberId: r.result_member_id,
  createdAt: r.created_at,
});

const SELECT = `
  SELECT c.*, m.name AS member_name, m.serial AS member_serial, ru.name AS requester_name, vu.name AS reviewer_name
    FROM change_requests c
    JOIN members m ON m.id = c.member_id
    JOIN users ru ON ru.id = c.requested_by
    LEFT JOIN users vu ON vu.id = c.reviewed_by`;

// ADMIN+ see everything. A contributor sees only their own requests.
router.get("/", requireRole("CONTRIBUTOR"), async (req, res) => {
  const status = ["PENDING", "APPROVED", "REJECTED"].includes(req.query.status)
    ? req.query.status
    : null;
  const onlyMine = !hasRole(req.user, "ADMIN") || req.query.mine === "true";
  const { rows } = await query(
    `${SELECT} WHERE ($1::text IS NULL OR c.status = $1) AND ($2::uuid IS NULL OR c.requested_by = $2)
      ORDER BY c.created_at DESC LIMIT 200`,
    [status, onlyMine ? req.user.id : null],
  );
  res.json({ items: rows.map(dto) });
});

router.get("/:id", requireRole("CONTRIBUTOR"), async (req, res) => {
  const { rows } = await query(`${SELECT} WHERE c.id = $1`, [req.params.id]);
  if (!rows[0]) throw notFound("Request not found.");
  if (!hasRole(req.user, "ADMIN") && rows[0].requested_by !== req.user.id)
    throw forbidden();
  res.json({ request: dto(rows[0]) });
});

// Approve = actually apply the edit / add the child
router.post("/:id/approve", requireRole("ADMIN"), async (req, res) => {
  const { note } = reviewSchema.parse(req.body ?? {});
  const result = await tx(async (c) => {
    const { rows } = await c.query(
      "SELECT * FROM change_requests WHERE id=$1 FOR UPDATE",
      [req.params.id],
    );
    const r = rows[0];
    if (!r) throw notFound("Request not found.");
    if (r.status !== "PENDING")
      throw conflict(`Already ${r.status.toLowerCase()}.`);

    let resultId = r.member_id;
    if (r.type === "EDIT_MEMBER") {
      await applyEdit(
        c,
        r.member_id,
        editMemberSchema.parse(r.payload),
        r.requested_by,
      );
    } else {
      resultId = await applyAddChild(
        c,
        r.member_id,
        addChildSchema.parse(r.payload),
        r.requested_by,
      );
    }
    await c.query(
      `UPDATE change_requests SET status='APPROVED', reviewed_by=$1, reviewed_at=now(), review_note=$2, result_member_id=$3 WHERE id=$4`,
      [req.user.id, note ?? null, resultId, r.id],
    );
    await audit(c, req.user.id, "CHANGE_APPROVED", "change_request", r.id, {
      type: r.type,
      memberId: resultId,
    });
    return resultId;
  });
  res.json({ ok: true, memberId: result });
});

router.post("/:id/reject", requireRole("ADMIN"), async (req, res) => {
  const { note } = reviewSchema.parse(req.body ?? {});
  const { rowCount } = await query(
    `UPDATE change_requests SET status='REJECTED', reviewed_by=$1, reviewed_at=now(), review_note=$2 WHERE id=$3 AND status='PENDING'`,
    [req.user.id, note ?? null, req.params.id],
  );
  if (!rowCount) throw conflict("Request not found or already reviewed.");
  await audit(
    null,
    req.user.id,
    "CHANGE_REJECTED",
    "change_request",
    req.params.id,
  );
  res.json({ ok: true });
});

export default router;
