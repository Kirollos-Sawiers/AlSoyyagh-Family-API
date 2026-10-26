import { pool } from "../src/config/db.js";
import { hashPassword } from "../src/utils/password.js";

const {
  SUPERADMIN_NAME,
  SUPERADMIN_EMAIL,
  SUPERADMIN_PHONE,
  SUPERADMIN_PASSWORD,
} = process.env;
if (!SUPERADMIN_EMAIL || !SUPERADMIN_PASSWORD) {
  console.error(
    "Set SUPERADMIN_EMAIL and SUPERADMIN_PASSWORD in your .env file first.",
  );
  process.exit(1);
}
try {
  const exists = await pool.query(
    `SELECT 1 FROM users WHERE role='SUPER_ADMIN' LIMIT 1`,
  );
  if (exists.rowCount) {
    console.log("ℹ️  A super admin already exists. Nothing to do.");
  } else {
    await pool.query(
      `INSERT INTO users (name, email, phone, relation, role, password_hash, must_change_password)
       VALUES ($1,$2,$3,'Site owner','SUPER_ADMIN',$4,TRUE)`,
      [
        SUPERADMIN_NAME || "Super Admin",
        SUPERADMIN_EMAIL,
        SUPERADMIN_PHONE || "-",
        await hashPassword(SUPERADMIN_PASSWORD),
      ],
    );
    console.log(
      `✅ Super admin created: ${SUPERADMIN_EMAIL} (you must change the password at first login)`,
    );
  }
} finally {
  await pool.end();
}
