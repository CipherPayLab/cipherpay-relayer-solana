#!/usr/bin/env ts-node
/**
 * scripts/init-canonical-tree.ts
 *
 * Bulk-initialize the canonical Merkle tree using multi-row INSERTs.
 * Field element storage is **BE-only** to match mysql-merkle-store.ts:
 *   - fe      : 32-byte Buffer in Big-Endian (bigIntToBe32)
 *   - fe_hex  : lowercase hex string derived from fe (feHex)
 *
 * merkle_meta rows:
 *   - depth (u8), next_index (u64 LE = 0), root (BE bytes), zero (BE bytes)
 */

import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import mysql from "mysql2/promise";
import { buildPoseidon } from "circomlibjs";

// ⬅️ Adjust this import path to wherever your helpers live.
import { bigIntToBe32, feHex } from "../src/utils/bytes.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// Load .env from repo root
dotenv.config({ path: path.join(__dirname, "..", ".env") });

/* ────────────────────────────────────────────────────────────────────────── */
/* Config                                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

const TREE_ID     = Number(process.env.CP_TREE_ID ?? 1);
const TREE_DEPTH  = Number(process.env.CP_TREE_DEPTH ?? 16);
const CHUNK_SIZE  = Number(process.env.CP_BULK_CHUNK_SIZE ?? 2000);

const DB_CONFIG = {
  host:     process.env.MYSQL_HOST     || "127.0.0.1",
  port:     Number(process.env.MYSQL_PORT || 3306),
  user:     process.env.MYSQL_USER     || "root",
  password: process.env.MYSQL_PASSWORD || "",
  database: process.env.MYSQL_DB || process.env.MYSQL_DATABASE || "cipherpay_relayer_solana",
};

/* ────────────────────────────────────────────────────────────────────────── */
/* Helpers                                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

/** Poseidon over two FE inputs (bigint → bigint). */
function poseidon2(poseidon: any, a: bigint, b: bigint): bigint {
  const out = poseidon([a, b]);
  return typeof out === "bigint" ? out : poseidon.F.toObject(out);
}

/** Canonical zero hashes as **bigints** (z[0] = 0; z[l] = H(z[l-1], z[l-1])). */
function buildZeroHashesBig(depth: number, poseidon: any): bigint[] {
  const z: bigint[] = new Array(depth + 1);
  z[0] = 0n;
  for (let lvl = 1; lvl <= depth; lvl++) {
    z[lvl] = poseidon2(poseidon, z[lvl - 1], z[lvl - 1]);
  }
  return z;
}

async function ensureTables(conn: mysql.Connection) {
  const req = ["merkle_meta", "leaves", "nodes", "roots"];
  const [rows] = await conn.execute(
    `SELECT TABLE_NAME FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (${req.map(() => "?").join(",")})`,
    [DB_CONFIG.database, ...req]
  );
  const got  = new Set((rows as any[]).map(r => r.TABLE_NAME));
  const miss = req.filter(t => !got.has(t));
  if (miss.length) throw new Error(`Missing required tables: ${miss.join(", ")}`);
}

async function clearTree(conn: mysql.Connection) {
  await conn.execute("DELETE FROM leaves WHERE tree_id = ?", [TREE_ID]);
  await conn.execute("DELETE FROM nodes  WHERE tree_id = ?", [TREE_ID]);
  await conn.execute("DELETE FROM roots  WHERE tree_id = ?", [TREE_ID]);
  await conn.execute("DELETE FROM merkle_meta WHERE tree_id = ?", [TREE_ID]);
}

/** Insert BE-only metadata: depth (u8), next_index (u64 LE=0), root (BE), zero (BE). */
async function insertMetadata(conn: mysql.Connection, zeroHashes: bigint[]) {
  const depthBuf   = Buffer.from([TREE_DEPTH & 0xff]); // u8
  const nextIdxBuf = Buffer.alloc(8, 0);               // u64 LE = 0
  const rootBuf    = bigIntToBe32(zeroHashes[TREE_DEPTH]);
  const zeroBuf    = bigIntToBe32(zeroHashes[0]);

  const rows: [number, string, Buffer, string][] = [
    [TREE_ID, "depth",      depthBuf,   ""],
    [TREE_ID, "next_index", nextIdxBuf, ""],
    [TREE_ID, "root",       rootBuf,    feHex(rootBuf)],
    [TREE_ID, "zero",       zeroBuf,    feHex(zeroBuf)],
  ];

  // Use a VALUES list that includes fe_hex for binary rows and empty for scalar rows
  await conn.query(
    "INSERT INTO merkle_meta (tree_id, k, v, v_hex) VALUES ?",
    [rows]
  ).catch(async (e: any) => {
    // If your schema doesn't have v_hex, fall back to original 3-column form.
    if (String(e?.message || "").toLowerCase().includes("unknown column 'v_hex'")) {
      const fallbackRows = rows.map(([a, b, c]) => [a, b, c]);
      await conn.query(
        "INSERT INTO merkle_meta (tree_id, k, v) VALUES ?",
        [fallbackRows]
      );
    } else {
      throw e;
    }
  });
}

/** Insert all internal nodes per level with the canonical **BE** zero hash for that level. */
async function insertNodesBulk(conn: mysql.Connection, zeroHashes: bigint[]) {
  let total = 0;
  for (let level = 1; level <= TREE_DEPTH; level++) {
    const count = 2 ** (TREE_DEPTH - level);
    const feBuf = bigIntToBe32(zeroHashes[level]);
    const feHexStr = feHex(feBuf);

    for (let start = 0; start < count; start += CHUNK_SIZE) {
      const end  = Math.min(start + CHUNK_SIZE, count);
      const rows = new Array(end - start);
      for (let i = 0; i < rows.length; i++) {
        const idx = start + i;
        rows[i] = [TREE_ID, level, idx, feBuf, feHexStr];
      }
      await conn.query(
        "INSERT INTO nodes (tree_id, node_layer, node_index, fe, fe_hex) VALUES ?",
        [rows]
      );
      total += rows.length;
    }
  }
  return total;
}

/** Insert all leaves as **BE** zeros (z[0]). */
async function insertLeavesBulk(conn: mysql.Connection) {
  const totalLeaves = 2 ** TREE_DEPTH;
  const feBuf = bigIntToBe32(0n);
  const feHexStr = feHex(feBuf);

  let total = 0;
  for (let start = 0; start < totalLeaves; start += CHUNK_SIZE) {
    const end  = Math.min(start + CHUNK_SIZE, totalLeaves);
    const rows = new Array(end - start);
    for (let i = 0; i < rows.length; i++) {
      const idx = start + i;
      rows[i] = [TREE_ID, idx, feBuf, feHexStr];
    }
    await conn.query(
      "INSERT INTO leaves (tree_id, leaf_index, fe, fe_hex) VALUES ?",
      [rows]
    );
    total += rows.length;
  }
  return total;
}

async function verifyCounts(conn: mysql.Connection) {
  const [rows] = await conn.query(
    "SELECT COUNT(*) AS c FROM nodes WHERE tree_id = ?",
    [TREE_ID]
  );
  const nodeCount = (rows as any[])[0]?.c;
  
  const [leafRows] = await conn.query(
    "SELECT COUNT(*) AS c FROM leaves WHERE tree_id = ?",
    [TREE_ID]
  );
  const leafCount = (leafRows as any[])[0]?.c;
  const expectedNodes  = 2 ** TREE_DEPTH - 1;
  const expectedLeaves = 2 ** TREE_DEPTH;

  if (nodeCount !== expectedNodes)
    throw new Error(`Node count mismatch: expected ${expectedNodes}, got ${nodeCount}`);
  if (leafCount !== expectedLeaves)
    throw new Error(`Leaf count mismatch: expected ${expectedLeaves}, got ${leafCount}`);
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Main                                                                      */
/* ────────────────────────────────────────────────────────────────────────── */

async function main() {
  console.log("🚀 Canonical Merkle tree initialization (bulk, BE-only)...");
  console.log(`   depth=${TREE_DEPTH} leaves=${2 ** TREE_DEPTH} chunk=${CHUNK_SIZE} tree_id=${TREE_ID}`);
  console.log(`   db=${DB_CONFIG.user}@${DB_CONFIG.host}:${DB_CONFIG.port}/${DB_CONFIG.database}`);

  const poseidon = await buildPoseidon();

  const conn = await mysql.createConnection(DB_CONFIG);
  try {
    await ensureTables(conn);

    // Session optimizations (best-effort; some require SUPER e.g. sql_log_bin)
    try {
      await conn.query("SET SESSION foreign_key_checks = 0");
      await conn.query("SET SESSION unique_checks = 0");
      await conn.query("SET SESSION sql_log_bin = 0");
    } catch (_) {
      // Ignore if user lacks privilege (e.g. no SUPER for sql_log_bin)
    }

    await conn.beginTransaction();

    console.log("🧹 Clearing existing tree...");
    await clearTree(conn);

    console.log("🔢 Generating zero hashes (bigint)...");
    const zeroHashesBig = buildZeroHashesBig(TREE_DEPTH, poseidon);

    console.log("📝 Inserting metadata (BE root/zero)...");
    await insertMetadata(conn, zeroHashesBig);

    console.log("🌳 Inserting nodes (bulk, BE)...");
    const totalNodes = await insertNodesBulk(conn, zeroHashesBig);

    console.log("🍃 Inserting leaves (bulk, BE zeros)...");
    const totalLeaves = await insertLeavesBulk(conn);

    console.log("🔍 Verifying counts...");
    await verifyCounts(conn);

    await conn.commit();

    console.log("✅ Done!");
    console.log(`   nodes=${totalNodes.toLocaleString()} leaves=${totalLeaves.toLocaleString()}`);
    console.log(`   root=0x${feHex(bigIntToBe32(zeroHashesBig[TREE_DEPTH]))}`);
  } catch (err: any) {
    await conn.rollback().catch(() => {});
    console.error("💥 Initialization failed:", err?.message || err);
    process.exitCode = 1;
  } finally {
    try {
      await conn.query("SET SESSION foreign_key_checks = 1");
      await conn.query("SET SESSION unique_checks = 1");
      await conn.query("SET SESSION sql_log_bin = 1");
    } catch {
      // Ignore restore errors
    }
    await conn.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
