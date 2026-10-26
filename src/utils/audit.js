import { query } from "../config/db.js";

// Writes "who did what" to the audit_log table. Never breaks the request if logging fails.
export async function audit(
  client,
  userId,
  action,
  entity,
  entityId,
  details = null,
) {
  try {
    await (client || { query }).query(
      "INSERT INTO audit_log (user_id, action, entity, entity_id, details) VALUES ($1,$2,$3,$4,$5)",
      [
        userId,
        action,
        entity,
        String(entityId ?? ""),
        details ? JSON.stringify(details) : null,
      ],
    );
  } catch (e) {
    console.error("audit failed", e.message);
  }
}
