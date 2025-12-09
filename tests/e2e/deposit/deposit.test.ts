/* tests/e2e/deposit/deposit.test.ts */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import util from "node:util";
import mysql from "mysql2/promise";

// Poseidon (BN254)
import { H } from "@/services/merkle/poseidon.js";

dotenv.config();

/* ------------------------------------------------------------------ */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE_URL = process.env.E2E_BASE_URL || "http://localhost:4000";
const AUTH_TOKEN = process.env.DASHBOARD_TOKEN || process.env.API_TOKEN || "supersecret";
const HMAC_KEY_ID = process.env.API_KEY_ID || "";
const HMAC_SECRET = process.env.API_KEY_SECRET || "";

const MINT_ADDRESS =
  process.env.TEST_MINT ||
  process.env.USDC_MINT ||
  "So11111111111111111111111111111111111111112";

const PROOFS_DIR = process.env.DEPOSIT_PROOFS_DIR || path.resolve(__dirname, "./proof");
const EXAMPLE_INPUT = fs.existsSync(path.join(PROOFS_DIR, "example_input.json"))
  ? path.join(PROOFS_DIR, "example_input.json")
  : path.join(PROOFS_DIR, "example_deposit_input_template.json");
const WASM_PATH = process.env.DEPOSIT_WASM || path.join(PROOFS_DIR, "deposit.wasm");
const ZKEY_PATH = process.env.DEPOSIT_ZKEY || path.join(PROOFS_DIR, "deposit_final.zkey");

const FQ =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const SHOW_DB = process.env.SHOW_DB === "1";
const TREE_ID = Number(process.env.TREE_ID || "1");
const DB_CONFIG = {
  host: process.env.MYSQL_HOST || "127.0.0.1",
  port: Number(process.env.MYSQL_PORT || "3306"),
  user: process.env.MYSQL_USER || "root",
  password: process.env.MYSQL_PASSWORD || "",
  database: process.env.MYSQL_DATABASE || "cipherpay",
};
/* ------------------------------------------------------------------ */

function hasArtifacts(): boolean {
  return fs.existsSync(WASM_PATH) && fs.existsSync(ZKEY_PATH);
}
function bearer() {
  return AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {};
}
function hmacHeaders(raw: Buffer) {
  if (!HMAC_SECRET || !HMAC_KEY_ID) return {};
  const sig = crypto.createHmac("sha256", HMAC_SECRET).update(raw).digest("hex");
  return { "X-Api-Key": HMAC_KEY_ID, "X-Api-Signature": sig };
}
async function httpJson<T>(url: string, body: any): Promise<T> {
  const raw = Buffer.from(JSON.stringify(body));
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(), ...hmacHeaders(raw) },
    body: raw,
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${txt}`);
  }
  return (await res.json()) as T;
}

function normalizeHex(h: string) {
  return (h.startsWith("0x") ? h.slice(2) : h).toLowerCase();
}
function beHexToBig(h: string): bigint {
  return BigInt("0x" + normalizeHex(h));
}
function hex64(bi: bigint) {
  return bi.toString(16).padStart(64, "0");
}
function fromHexToBigBE(s: string): bigint {
  const t = s.startsWith("0x") ? s.slice(2) : s;
  return BigInt("0x" + t) % FQ;
}
function beToLeHex(beHex: string): string {
  return Buffer.from(normalizeHex(beHex), "hex").reverse().toString("hex");
}

/** BOTH randomness and nonce are BigInt(DEPOSIT_INDEX) mod FQ (your test simplification). */
function feFromIndex(idx: number): bigint { return BigInt(idx) % FQ; }

/** Poseidon arity-2 via H (your export is variadic) */
async function H2(a: bigint, b: bigint): Promise<bigint> { return await H(a, b); }

/** Compute root from ZERO leaf using BE siblings and indices (bit=0 -> H(cur,sib), bit=1 -> H(sib,cur)) */
async function computeRootFromZeroPathBE(
  pathHex: string[], bits: number[]
): Promise<bigint> {
  if (pathHex.length !== bits.length) throw new Error(`path length ${pathHex.length} != indices length ${bits.length}`);
  let cur = 0n;
  for (let i = 0; i < bits.length; i++) {
    const bit = bits[i] | 0;
    const sib = fromHexToBigBE(pathHex[i]);
    cur = bit === 0 ? await H2(cur, sib) : await H2(sib, cur);
  }
  return cur % FQ;
}

/** Try to build a Groth16 proof with snarkjs if artifacts exist. */
async function generateGroth16Proof(
  inputSignals: any
): Promise<null | { proof: any; publicSignals: string[] }> {
  if (!hasArtifacts()) return null;
  // @ts-ignore
  const snarkjs = await import("snarkjs");
  const { groth16 } = snarkjs as any;
  const normalized = (function toDec(x: any): any {
    if (typeof x === "string") {
      const s = x.trim().toLowerCase();
      if (/^0x[0-9a-f]+$/.test(s)) return BigInt(s).toString();
      if (/^[0-9a-f]{64}$/.test(s)) return BigInt("0x" + s).toString();
      if (/^[0-9]+$/.test(s)) return s;
      if (/^[0-9a-f]+$/.test(s)) return BigInt("0x" + s).toString();
      return s;
    }
    if (typeof x === "number") return x.toString();
    if (typeof x === "bigint") return x.toString();
    if (Array.isArray(x)) return x.map(toDec);
    if (x && typeof x === "object") {
      const out: any = {};
      for (const [k, v] of Object.entries(x)) out[k] = toDec(v);
      return out;
    }
    return x;
  })(inputSignals);
  const { proof, publicSignals } = await groth16.fullProve(normalized, WASM_PATH, ZKEY_PATH);
  return { proof, publicSignals: (publicSignals as any[]).map(String) };
}

/* ------------------------ DB helpers (for SHOW_DB) ------------------------ */
let dbConn: mysql.Connection | null = null;
async function dbConnectIfNeeded() { if (SHOW_DB && !dbConn) dbConn = await mysql.createConnection(DB_CONFIG); }
async function dbCloseIfNeeded() { if (dbConn) { try { await dbConn.end(); } catch {} dbConn = null; } }
async function dbGetNodeBeHex(treeId: number, layer: number, index: number): Promise<string | null> {
  if (!dbConn) return null;
  const [rows] = await dbConn.query(
    `SELECT LOWER(HEX(fe)) AS be_hex FROM nodes_all
     WHERE tree_id=? AND node_layer=? AND node_index=? LIMIT 1`,
    [treeId, layer, index]
  );
  const r = (rows as any[])[0];
  return r?.be_hex || null;
}
function logRow(row: Record<string, any>) {
  console.log(util.inspect(row, { colors: true, depth: null, maxArrayLength: null }));
}

/* ------------------------------------------------------------------ */
/* The test                                                           */
/* ------------------------------------------------------------------ */

describe("E2E: deposit strict-sync flow", () => {
  let example: any;

  beforeAll(async () => {
    const raw = fs.readFileSync(EXAMPLE_INPUT, "utf8");
    example = JSON.parse(raw);
    await dbConnectIfNeeded();
  });

  afterAll(async () => { await dbCloseIfNeeded(); });

  it(
    "prepares, (optionally) proves, and submits a deposit (re-depositable via DEPOSIT_INDEX)",
    async () => {
      const ownerWalletPubKey  = BigInt(example.ownerWalletPubKey ?? 0);
      const ownerWalletPrivKey = BigInt(example.ownerWalletPrivKey ?? 0);
      const tokenId            = BigInt(example.tokenId ?? 0);
      const memo               = BigInt(example.memo ?? 0);
      const amount             = BigInt(example.amount ?? 100);

      // Test simplification
      const idx = Number(process.env.DEPOSIT_INDEX ?? "0");
      const randomness = feFromIndex(idx);
      const nonce      = feFromIndex(idx);

      const ownerCipherPayPubKey = await H(ownerWalletPubKey, ownerWalletPrivKey);
      const commitmentBig = await H(amount, ownerCipherPayPubKey, randomness, tokenId, memo);

      // IMPORTANT: API is now BE-only (merkleRoot BE hex, path elements BE hex)
      type PrepareResp = {
        merkleRoot: string;          // BE hex(32)
        nextLeafIndex: number;
        inPathElements: string[];    // BE hex bottom→top
        inPathIndices: number[];     // 0/1 bits, LSB first
      };
      const prep = await httpJson<PrepareResp>(`${BASE_URL}/api/v1/prepare/deposit`, {
        commitment: commitmentBig.toString(),
      });

      expect(prep).toBeTruthy();
      expect(Array.isArray(prep.inPathElements)).toBe(true);
      expect(Array.isArray(prep.inPathIndices)).toBe(true);

      // Recompute old root locally in BE and compare to server’s BE
      const localOldRoot = await computeRootFromZeroPathBE(prep.inPathElements, prep.inPathIndices);
      const localBE = hex64(localOldRoot);
      const prepareBE = normalizeHex(prep.merkleRoot);
      console.log("\n[oldRoot] BE-check", { local_be: localBE, prepare_root_be: prepareBE });
      if (localBE !== prepareBE) {
        throw new Error(
          `oldMerkleRoot mismatch (BE): local=${localBE} prepare=${prepareBE}.\n` +
          `Check: (1) path/indices order, (2) BE parsing, (3) zero tree init.`
        );
      }

      // Optional DB eyeballing
      if (SHOW_DB && dbConn) {
        let idxCur = prep.nextLeafIndex;
        console.log("\n[db-compare] sibling path bottom→top (one row per layer)");
        for (let layer = 0; layer < prep.inPathIndices.length; layer++) {
          const bit = prep.inPathIndices[layer] | 0;
          const isLeft = bit === 0;
          const sibIndex = isLeft ? idxCur + 1 : idxCur - 1;

          const fromPrepareBE = normalizeHex(prep.inPathElements[layer] || "");
          const fromDbBE = (sibIndex >= 0) ? await dbGetNodeBeHex(TREE_ID, layer, sibIndex) : null;

          const prepDec = BigInt("0x" + fromPrepareBE).toString();
          const dbDec = fromDbBE ? BigInt("0x" + fromDbBE).toString() : null;

          logRow({
            layer,
            idxCur,
            bit,
            isLeft,
            sibIndex,
            prep_be: "0x" + fromPrepareBE,
            prep_le: "0x" + beToLeHex(fromPrepareBE),
            prep_dec: prepDec,
            db_be: fromDbBE ? "0x" + fromDbBE : null,
            db_dec: dbDec,
            equal_hex: !!fromDbBE && (fromPrepareBE === fromDbBE),
            equal_dec: !!fromDbBE && (prepDec === dbDec),
          });

          idxCur >>= 1;
        }
        console.log();
      }

      const depositHashBig = await H(ownerCipherPayPubKey, amount, nonce);

      const inputSignals: Record<string, any> = {
        ownerWalletPubKey:  ownerWalletPubKey.toString(),
        ownerWalletPrivKey: ownerWalletPrivKey.toString(),
        randomness:         randomness.toString(),
        tokenId:            tokenId.toString(),
        memo:               memo.toString(),
        amount:             amount.toString(),
        nonce:              nonce.toString(),

        inPathElements:     prep.inPathElements.map(h => fromHexToBigBE(h).toString()),
        inPathIndices:      prep.inPathIndices,
        nextLeafIndex:      prep.nextLeafIndex.toString(),

        oldMerkleRoot:      beHexToBig(prep.merkleRoot).toString(), // BE-only API
        depositHash:        depositHashBig.toString(),
      };

      let proof: any = null;
      let publicSignals: string[] = [];
      if (hasArtifacts()) {
        try {
          const out = await generateGroth16Proof(inputSignals);
          if (!out) throw new Error("Artifacts missing");
          proof = out.proof;
          publicSignals = out.publicSignals;
        } catch (err) {
          console.error("❌ fullProve failed. Dumping the exact inputs we used:");
          console.error(util.inspect(inputSignals, { depth: null, colors: true, maxArrayLength: null }));
          console.error("Hint: typical causes are depositHash mismatch or oldMerkleRoot/path mismatch.");
          throw err;
        }
      } else {
        console.warn(`[deposit e2e] Missing ${WASM_PATH} / ${ZKEY_PATH}; skipping local proof.`);
      }

      let commitmentHex = hex64(commitmentBig);
      let depHashHex = hex64(depositHashBig);
      if (publicSignals.length >= 7) {
        commitmentHex = BigInt(publicSignals[0]).toString(16).padStart(64, "0");
        depHashHex    = BigInt(publicSignals[5]).toString(16).padStart(64, "0");
      }

      const submitBody = {
        operation: "deposit",
        amount: Number(amount),
        tokenMint: MINT_ADDRESS,
        proof,
        publicSignals,
        depositHash: depHashHex,
        commitment: commitmentHex,
        memo: Number(memo),
      };

      console.log(util.inspect(submitBody, { depth: null, maxArrayLength: null, colors: true }));

      if (!proof) {
        console.warn("[deposit e2e] No proof generated. Skipping /submit.");
        return;
      }

      type SubmitResp = { signature?: string; txid?: string; txSig?: string; ok?: boolean };
      const result = await httpJson<SubmitResp>(`${BASE_URL}/api/v1/submit/deposit`, submitBody);

      expect(result).toBeTruthy();
      const sig = (result.signature || result.txSig || result.txid || "").toString();
      expect(sig.length).toBeGreaterThan(20);
    },
    120_000
  );
});
