import express from "express";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { env } from "./config/env.js";
import { query } from "./config/db.js";
import { errorHandler, notFoundHandler } from "./middleware/error.js";
import authRoutes from "./routes/auth/auth.routes.js";
import joinRoutes from "./routes/joinRequests/joinRequests.routes.js";
import userRoutes from "./routes/users/users.routes.js";
import accessRoutes from "./routes/accessRequests/accessRequests.routes.js";
import changeRoutes from "./routes/changeRequests/changeRequests.routes.js";
import treeRoutes from "./routes/trees/trees.routes.js";
import memberRoutes from "./routes/members/members.routes.js";
import adminRoutes from "./routes/admin/admin.routes.js";

export const app = express();

app.set("trust proxy", 1); // Render sits behind a proxy: needed so rate limiting sees the real client IP
app.use(helmet());
app.use(
  cors({
    origin(origin, cb) {
      // no Origin header = curl / Postman / server-to-server: allow
      if (!origin || env.corsOrigins.includes(origin)) return cb(null, true);
      cb(null, false);
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
    maxAge: 86400,
  }),
);
app.use(express.json({ limit: "100kb" }));
app.use(
  rateLimit({
    windowMs: 60_000,
    limit: 300,
    standardHeaders: true,
    legacyHeaders: false,
  }),
);

app.get("/", (_req, res) =>
  res.json({ name: "Al-Soyyagh family API", status: "running" }),
);
app.get("/api/health", async (_req, res) => {
  await query("SELECT 1"); // also wakes the free database
  res.json({ ok: true, time: new Date().toISOString() });
});

app.use("/api/auth", authRoutes);
app.use("/api/join-requests", joinRoutes);
app.use("/api/users", userRoutes);
app.use("/api/access-requests", accessRoutes);
app.use("/api/change-requests", changeRoutes);
app.use("/api/trees", treeRoutes);
app.use("/api/members", memberRoutes);
app.use("/api/admin", adminRoutes);

app.use(notFoundHandler);
app.use(errorHandler);
