import { Router } from "express";
import { query, tx } from "../../config/db.js";
import {
  requireLogin,
  requireRole,
  hasRole,
  assertTreeAccess,
} from "../../middleware/auth.js";
import { editMemberSchema, addChildSchema } from "../../utils/schemas.js";
import { badRequest } from "../../utils/errors.js";
import {
  getMemberRow,
  getMemberCard,
  getMemberDetails,
  getAncestors,
  toSummary,
  applyEdit,
  applyAddChild,
} from "../../services/members.js";
import { audit } from "../../utils/audit.js";

const router = Router();
router.use(requireLogin);

const idParam = (v) => {
  const id = Number(v);
  if (!Number.isInteger(id) || id <= 0) throw badRequest("Invalid member id.");
  return id;
};

// Every member route first checks that the user may open that member's country tree
async function loadAndCheck(req) {
  const m = await getMemberRow(idParam(req.params.id));
  await assertTreeAccess(req.user, m.tree);
  return m;
}

// Click on a name -> the short card
router.get("/:id", async (req, res) => {
  const m = await loadAndCheck(req);
  res.json({ member: await getMemberCard(m.id) });
});

// "More details" -> full data (bio, parents, siblings, children, spouses ...)
router.get("/:id/details", async (req, res) => {
  const m = await loadAndCheck(req);
  res.json({ member: await getMemberDetails(m.id) });
});

router.get("/:id/children", async (req, res) => {
  const m = await loadAndCheck(req);
  const { rows } = await query(
    "SELECT * FROM members WHERE parent_id=$1 ORDER BY serial_parts, sort_index",
    [m.id],
  );
  res.json({ items: rows.map(toSummary) });
});

router.get("/:id/ancestors", async (req, res) => {
  const m = await loadAndCheck(req);
  res.json({ items: await getAncestors(m.id) });
});

// â”€â”€ EDIT member â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// ADMIN / SUPER_ADMIN: applied immediately (200).
// CONTRIBUTOR: saved as a request waiting for approval (202).
router.patch("/:id", requireRole("CONTRIBUTOR"), async (req, res) => {
  const m = await loadAndCheck(req);
  const data = editMemberSchema.parse(req.body);

  if (hasRole(req.user, "ADMIN")) {
    await tx(async (c) => {
      await applyEdit(c, m.id, data, req.user.id);
      await audit(c, req.user.id, "MEMBER_EDITED", "member", m.id, data);
    });
    return res.json({ applied: true, member: await getMemberDetails(m.id) });
  }

  const before = await getMemberDetails(m.id);
  const { rows } = await query(
    `INSERT INTO change_requests (type, tree, member_id, payload, before_data, requested_by)
     VALUES ('EDIT_MEMBER',$1,$2,$3,$4,$5) RETURNING id`,
    [m.tree, m.id, JSON.stringify(data), JSON.stringify(before), req.user.id],
  );
  res
    .status(202)
    .json({
      applied: false,
      requestId: rows[0].id,
      message: "Your edit was sent to the admins for approval.",
    });
});

// â”€â”€ ADD child to this member â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.post("/:id/children", requireRole("CONTRIBUTOR"), async (req, res) => {
  const parent = await loadAndCheck(req);
  const data = addChildSchema.parse(req.body);

  if (hasRole(req.user, "ADMIN")) {
    const newId = await tx(async (c) => {
      const id = await applyAddChild(c, parent.id, data, req.user.id);
      await audit(c, req.user.id, "MEMBER_ADDED", "member", id, {
        parentId: parent.id,
      });
      return id;
    });
    return res
      .status(201)
      .json({ applied: true, member: await getMemberDetails(newId) });
  }

  const { rows } = await query(
    `INSERT INTO change_requests (type, tree, member_id, payload, requested_by)
     VALUES ('ADD_CHILD',$1,$2,$3,$4) RETURNING id`,
    [parent.tree, parent.id, JSON.stringify(data), req.user.id],
  );
  res
    .status(202)
    .json({
      applied: false,
      requestId: rows[0].id,
      message: "The new child was sent to the admins for approval.",
    });
});

export default router;
