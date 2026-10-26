import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { app } from '../src/app.js';
import http from 'http';
import { pool } from '../src/config/db.js';

let server, baseUrl;

before(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  server.close();
  await pool.end();
});

test('GET /api/health returns ok', async () => {
  const res = await fetch(`${baseUrl}/api/health`);
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.ok, true);
});
