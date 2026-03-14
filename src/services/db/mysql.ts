// src/services/db/mysql.ts
import mysql, { Pool } from "mysql2/promise.js";
import { loadEnv } from "@/services/config/env.js";

let _pool: Pool | null = null;

export async function getPool(): Promise<Pool> {
  if (_pool) return _pool;
  const env = loadEnv();
  _pool = mysql.createPool({
    host: env.mysql.host,
    port: env.mysql.port,
    user: env.mysql.user,
    password: env.mysql.password,
    database: env.mysql.database,
    connectionLimit: 10,
    waitForConnections: true,
    enableKeepAlive: true,
    namedPlaceholders: true,
    supportBigNumbers: true,
  });
  // Warm up the pool (fail fast if misconfigured)
  try {
    await _pool.query("SELECT 1");
  } catch (e) {
    // ensure we don't leave a broken pool around
    try { await _pool.end(); } catch {}
    _pool = null;
    throw e;
  }
  return _pool;
}

export async function closePool(): Promise<void> {
  if (_pool) {
    try {
      await _pool.end();
    } finally {
      _pool = null;
    }
  }
}
