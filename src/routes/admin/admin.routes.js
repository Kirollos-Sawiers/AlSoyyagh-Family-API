import { Router } from "express";
import { query } from "../../config/db.js";
import { requireLogin, requireRole } from "../../middleware/auth.js";

const router = Router();
router.use(requireLogin, requireRole("ADMIN"));

// Numbers for the admin dashboard badges
router.get("/summary", async (_req, res) => {
  const { rows } = await query(
    `SELECT
       (SELECT count(*)::int FROM join_requests   WHERE status='PENDING') AS pending_join,
       (SELECT count(*)::int FROM change_requests WHERE status='PENDING') AS pending_changes,
       (SELECT count(*)::int FROM access_requests WHERE status='PENDING') AS pending_access,
       (SELECT count(*)::int FROM users) AS users,
       (SELECT count(*)::int FROM members WHERE tree='EGYPT') AS egypt_members,
       (SELECT count(*)::int FROM members WHERE tree='JORDAN') AS jordan_members`,
  );
  const r = rows[0];
  res.json({
    pendingJoinRequests: r.pending_join,
    pendingChangeRequests: r.pending_changes,
    pendingAccessRequests: r.pending_access,
    users: r.users,
    members: { EGYPT: r.egypt_members, JORDAN: r.jordan_members },
  });
});

export default router;
