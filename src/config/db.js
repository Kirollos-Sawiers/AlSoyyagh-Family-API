import pg from "pg";
import { env } from "./env.js";

export const pool = new pg.Pool({
  connectionString: env.databaseUrl,
  ssl: env.databaseSsl ? { rejectUnauthorized: true } : false,
  max: 8,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 15_000, // cloud databases can take a few seconds to wake up
});

pool.on("error", (err) =>
  console.error("Unexpected database error", err.message),
);

export const query = (text, params) => pool.query(text, params);

// Run several queries as ONE all-or-nothing transaction
export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
