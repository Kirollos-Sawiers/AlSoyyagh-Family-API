import { app } from "./app.js";
import { env } from "./config/env.js";
import { pool } from "./config/db.js";

const server = app.listen(env.port, () => {
  console.log(`🚀 API running on port ${env.port} (${env.nodeEnv})`);
});

const shutdown = () => {
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
