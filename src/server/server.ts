// src/server/server.ts
import express from "express";
import cors from "cors";
import morgan from "morgan";
import path from "node:path";

import { makeAuthMiddleware } from "@/auth/index.js";
import { prepareRouter } from "@/server/routes/prepare.js";
import { submit } from "@/server/routes/submit.js";
import { relayerInfoRouter } from "@/server/routes/relayer-info.js";
import { CanonicalTree } from "@/services/merkle/canonical-tree.js";
import { getPool } from "@/services/db/mysql.js";
import { loadEnv, isDashboardAuthEnabled } from "@/services/config/env.js";
import { ProofVerifier } from "@/zk/proof-verifier.js";
import { solanaRelayer } from "@/services/solana-relayer.js";
import { protectDashboard } from "@/server/middleware/auth.js";

import { createLoggingMiddleware } from "@/middleware/logging.js";
import { healthCheckMiddleware, livenessCheck, readinessCheck } from "@/monitoring/health.js";
import { createDashboardRoutes, monitoringService } from "@/monitoring/index.js";
import { LoggedPool } from "@/monitoring/db-logger.js";
import { logger } from "@/utils/logger.js";

const env = loadEnv();

export async function makeServer() {
  const app = express();

  // logging first
  app.use(...createLoggingMiddleware());

  // body parsers (capture raw for HMAC)
  app.use(express.json({
    limit: "1mb",
    verify: (req, _res, buf) => { (req as any).rawBody = Buffer.from(buf); }
  }));
  app.use(express.urlencoded({
    extended: true,
    limit: "1mb",
    verify: (req, _res, buf) => { (req as any).rawBody = Buffer.from(buf); }
  }));

  app.use(cors());
  app.use(morgan("dev"));

  // --- DB + tree ---
  const pool = await getPool();
  const loggedPool = new LoggedPool(pool);
  // CanonicalTree expects a mysql2 Pool directly
  const tree = new CanonicalTree(loggedPool.pool, 1);

  // --- zk verifier ---
  const vkeyDir = env.vkeyDir ?? path.resolve(process.cwd(), "src/zk/circuits");
  const verifier = new ProofVerifier();

  // --- Solana relayer ---
  // Using singleton solanaRelayer instance

  // TODO: Add event listening methods to SolanaRelayer
  // solanaRelayer.startEventListening((event: any) => {
  //   logger.solana.info({ event }, "Solana event received");
  // });

  // --- monitoring & dashboard auth ---
  const DASHBOARD_AUTH_ENABLED = isDashboardAuthEnabled();
  const maybeProtect = DASHBOARD_AUTH_ENABLED ? [protectDashboard] : [];

  app.get("/health", ...maybeProtect, healthCheckMiddleware());
  app.get("/healthz", ...maybeProtect, livenessCheck());
  app.get("/ready", ...maybeProtect, readinessCheck);

  const dashboardRoutes = createDashboardRoutes();
  app.get("/api/v1/monitoring/dashboard", ...maybeProtect, dashboardRoutes.getDashboard);
  app.get("/api/v1/monitoring/health",    ...maybeProtect, dashboardRoutes.getHealth);
  app.get("/api/v1/monitoring/metrics",   ...maybeProtect, dashboardRoutes.getMetrics);
  app.post("/api/v1/monitoring/metrics/reset", ...maybeProtect, dashboardRoutes.resetMetrics);

  // legacy
  app.get("/api/v1/health", ...maybeProtect, (_req, res) => res.json({ ok: true }));

  // protected business APIs
  app.use(makeAuthMiddleware());
  app.use("/api/v1/relayer", relayerInfoRouter(tree));
  app.use("/api/v1/prepare", prepareRouter(tree));
  app.use("/api/v1/submit", submit);

  monitoringService.start(30_000);

  logger.app.info(
    {
      port: env.port,
      solanaRpcUrl: env.solanaRpcUrl,
      programId: env.programId,
      dashboardAuth: DASHBOARD_AUTH_ENABLED ? "enabled" : "disabled",
      vkeyDir,
    },
    "Server initialized with monitoring"
  );

  if (!DASHBOARD_AUTH_ENABLED) {
    logger.app.warn("Dashboard auth is DISABLED. Do not expose this port publicly.");
  }

  return app;
}

export async function startServer() {
  const app = await makeServer();

  // start HTTP server
  const server = app.listen(env.port, () => {
    console.log(`listening on :${env.port}`);
  });

  // ✅ start Solana event listeners AFTER server is up
  try {
    await solanaRelayer.startListeners();
  } catch (e: any) {
    console.error("[relayer] failed to start event listeners:", e?.message || e);
  }

  return server;
}
