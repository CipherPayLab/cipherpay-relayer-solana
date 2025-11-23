/* scripts/migrate.ts
 * One-shot migration runner for MySQL using mysql2/promise.
 * Runs all .sql files in src/db/migrations in lexicographic order.
 * Robust against idle disconnects: short-lived connections per statement + retry.
 */

import fs from "fs";
import path from "path";
import { getPool } from "@/services/db/mysql.js";

const MIGRATIONS_DIR = path.resolve("src/db/migrations");

// --- tiny helpers ---
function stripSqlComments(sql: string) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, "")  // /* ... */
    .replace(/--.*$/gm, "");           // -- to EOL
}

function splitStatements(sql: string): string[] {
  // naive splitter: good for standard DDL/DML (no procs/triggers using DELIMITER)
  return stripSqlComments(sql)
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

function isConnGone(e: any) {
  const code = e?.code || e?.errno || e?.name || "";
  return (
    code === "PROTOCOL_CONNECTION_LOST" ||
    code === "ECONNRESET" ||
    code === "EPIPE"
  );
}

async function withConn<T>(fn: (conn: any) => Promise<T>) {
  const pool = await getPool();
  const conn = await pool.getConnection();
  try {
    // Keep this session alive and fast for bulk ops
    // These may fail without SUPER privileges - that's okay, continue anyway
    try {
      await conn.query("SET SESSION wait_timeout=31536000, interactive_timeout=31536000");
    } catch {}
    try {
      await conn.query("SET SESSION foreign_key_checks = 0");
    } catch {}
    try {
      await conn.query("SET SESSION unique_checks = 0");
    } catch {}
    try {
      await conn.query("SET SESSION sql_log_bin = 0");
    } catch {}
    return await fn(conn);
  } finally {
    try {
      await conn.query("SET SESSION foreign_key_checks = 1");
    } catch {}
    try {
      await conn.query("SET SESSION unique_checks = 1");
    } catch {}
    try {
      await conn.query("SET SESSION sql_log_bin = 1");
    } catch {}
    conn.release();
  }
}

async function execStatement(stmt: string) {
  return withConn(async (conn) => {
    // autocommit by default; most migrations are idempotent or safe to run sequentially
    await conn.query(stmt);
  });
}

async function execWithRetry(stmt: string, file: string, index: number) {
  try {
    await execStatement(stmt);
  } catch (e: any) {
    if (isConnGone(e)) {
      // one quick retry on a fresh connection
      await execStatement(stmt);
      return;
    }
    const preview = stmt.slice(0, 200).replace(/\s+/g, " ");
    const msg = e?.sqlMessage || e?.message || String(e);
    const err = new Error(
      `Migration error in ${path.basename(file)} [statement #${index + 1}]: ${msg}\n   SQL: ${preview}...`
    );
    // @ts-ignore decorate for top-level handler
    (err as any).sql = stmt;
    throw err;
  }
}

async function runSqlFile(filePath: string) {
  const raw = fs.readFileSync(filePath, "utf8");
  const statements = splitStatements(raw);

  console.log(`→ ${path.basename(filePath)} (${statements.length} statements)`);

  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i]!;
    await execWithRetry(stmt, filePath, i);
    // lightweight progress ping for long files
    if ((i + 1) % 20 === 0 || i === statements.length - 1) {
      console.log(`   • executed ${i + 1}/${statements.length}`);
    }
  }
}

async function main() {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    console.error(`Migrations dir not found: ${MIGRATIONS_DIR}`);
    process.exit(1);
  }

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  if (files.length === 0) {
    console.log("No migrations to run.");
    process.exit(0);
  }

  console.log("Running migrations:");
  files.forEach((f) => console.log("  •", f));

  try {
    for (const f of files) {
      await runSqlFile(path.join(MIGRATIONS_DIR, f));
    }
    console.log("✅ Migrations completed.");
    // close pool politely
    const pool = await getPool();
    await pool.end?.();
    process.exit(0);
  } catch (err: any) {
    console.error("❌ Migration failed:", err?.message || err);
    if (err?.sql) {
      console.error("   Offending SQL:", err.sql);
    }
    try {
      const pool = await getPool();
      await pool.end?.();
    } catch {}
    process.exit(1);
  }
}

main();
