import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pool } from '../src/config/db.js';

const sql = readFileSync(fileURLToPath(new URL('../db/schema.sql', import.meta.url)), 'utf8');
try {
  await pool.query(sql);
  console.log('✅ Database tables are ready.');
} catch (e) {
  console.error('❌ Migration failed:', e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}