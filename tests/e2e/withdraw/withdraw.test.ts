/* tests/e2e/withdraw/withdraw.test.ts */
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import util from "node:util";

// Poseidon (BN254) — same H used by deposit/transfer tests (variadic)
import { H } from "@/services/merkle/poseidon.js";

dotenv.config();

/* ------------------------------------------------------------------ */
/* Constants & wiring                                                 */
/* ------------------------------------------------------------------ */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE_URL   = process.env.E2E_BASE_URL || "http://localhost:4000";
const AUTH_TOKEN = process.env.DASHBOARD_TOKEN || process.env.API_TOKEN || "supersecret";
const HMAC_KEY_ID = process.env.API_KEY_ID || "";
const HMAC_SECRET = process.env.API_KEY_SECRET || "";

// SPL mint (matches other e2e tests)
const MINT_ADDRESS =
  process.env.TEST_MINT ||
  process.env.USDC_MINT ||
  "So11111111111111111111111111111111111111112"; // wSOL default

// proofs/withdraw paths
const PROOFS_DIR = process.env.WITHDRAW_PROOFS_DIR
  ? path.resolve(process.env.WITHDRAW_PROOFS_DIR)
  : path.resolve(__dirname, "./proof");

const EXAMPLE_INPUT = fs.existsSync(path.join(PROOFS_DIR, "example_withdraw_input.json"))
  ? path.join(PROOFS_DIR, "example_withdraw_input.json")
  : path.join(PROOFS_DIR, "example_withdraw_input_template.json");

const WASM_PATH = process.env.WITHDRAW_WASM || path.join(PROOFS_DIR, "withdraw.wasm");
const ZKEY_PATH = process.env.WITHDRAW_ZKEY || path.join(PROOFS_DIR, "withdraw_final.zkey");

// BN254
const FQ =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/* ------------------------------------------------------------------ */
/* Helpers (shared style with deposit/transfer)                        */
/* ------------------------------------------------------------------ */

const modF = (x: bigint) => ((x % FQ) + FQ) % FQ;
/** WITHDRAW_INDEX → field element (mod FQ) */
function feFromWithdrawIndex(): bigint {
  const idx = Number(process.env.WITHDRAW_INDEX ?? "0");
  return BigInt(idx) % FQ;
}

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
function hex64(bi: bigint) {
  return bi.toString(16).padStart(64, "0");
}
function fromHexToBigBE(s: string): bigint {
  const t = s.startsWith("0x") ? s.slice(2) : s;
  return BigInt("0x" + t) % FQ;
}

/** 0x-only normalizer (don’t corrupt decimal strings) */
function toDecimalIfHex(x: any): any {
  if (typeof x === "string") {
    const s = x.trim();
    if (/^0x[0-9a-fA-F]+$/.test(s)) return BigInt(s).toString();
    if (/^[0-9]+$/.test(s)) return s;
    return s;
  }
  if (typeof x === "number") return x.toString();
  if (typeof x === "bigint") return x.toString();
  if (Array.isArray(x)) return x.map(toDecimalIfHex);
  if (x && typeof x === "object") {
    const out: any = {};
    for (const [k, v] of Object.entries(x)) out[k] = toDecimalIfHex(v);
    return out;
  }
  return x;
}

/** Recompute root from a concrete leaf using BE siblings, bottom→top */
async function computeRootFromLeafBE(
  leafBig: bigint,
  pathHex: string[],
  bits: number[]
): Promise<bigint> {
  if (pathHex.length !== bits.length) {
    throw new Error(`path length ${pathHex.length} != indices length ${bits.length}`);
  }
  let cur = modF(leafBig);
  for (let i = 0; i < bits.length; i++) {
    const sib = fromHexToBigBE(pathHex[i]);
    cur = (bits[i] | 0) === 0 ? await H(modF(cur), modF(sib)) : await H(modF(sib), modF(cur));
    cur = modF(cur);
  }
  return cur;
}

/* ------------------------------------------------------------------ */
/* Public signals order (withdraw circuit)                            */
/*   ["nullifier","merkleRoot","recipientWalletPubKey","amount","tokenId"] */
const PS = {
  NULLIFIER: 0,
  MERKLE_ROOT: 1,
  RECIPIENT_PK: 2,
  AMOUNT: 3,
  TOKEN_ID: 4,
} as const;

/* ------------------------------------------------------------------ */
/* The test                                                           */
/* ------------------------------------------------------------------ */

describe("E2E: withdraw strict-sync flow (spend out2)", () => {
  let example: any;

  beforeAll(async () => {
    const raw = fs.readFileSync(EXAMPLE_INPUT, "utf8");
    example = JSON.parse(raw);
  });

  it(
    "prepares, (optionally) proves, and submits a withdraw (spending out2; randomness via WITHDRAW_INDEX)",
    async () => {
      // Inputs follow generate-example-proof.js -> withdraw defaults
      const recipientWalletPubKey  = BigInt(example.recipientWalletPubKey ?? 0);
      const recipientWalletPrivKey = BigInt(example.recipientWalletPrivKey ?? 0);
      const amount                 = BigInt(example.amount ?? 0);
      const tokenId                = BigInt(example.tokenId ?? 0);
      const memo                   = BigInt(example.memo ?? 0);

      // Randomness comes from WITHDRAW_INDEX (same pattern as DEPOSIT/TRANSFER)
      const randomness = feFromWithdrawIndex();

      // CipherPay pubkey = Poseidon2(walletPub, walletPriv)
      const recipientCipherPayPubKey = await H(modF(recipientWalletPubKey), modF(recipientWalletPrivKey));

      // The note we’re spending (this is out2 from transfer pipeline):
      const commitment = await H(
        modF(amount),
        modF(recipientCipherPayPubKey),
        modF(randomness),
        modF(tokenId),
        modF(memo)
      );

      // ✅ Nullifier must match the circuit:
      //    nullifier = H(cipherPayPubKey, randomness, tokenId)
      const nullifier = await H(
        modF(recipientCipherPayPubKey),
        modF(randomness),
        modF(tokenId)
      );

      // 1) Ask the relayer for the strict-sync path to THIS commitment
      type PrepareResp = {
        merkleRoot: string;       // **BE** hex (32)
        pathElements: string[];   // **BE** hex bottom→top
        pathIndices: number[];    // 0/1 bits, LSB-first
        leafIndex: number;        // index of the out2 leaf
      };

      const prep = await httpJson<PrepareResp>(
        `${BASE_URL}/api/v1/prepare/withdraw`,
        { spendCommitment: commitment.toString(10) }
      );

      expect(prep).toBeTruthy();
      expect(Array.isArray(prep.pathElements)).toBe(true);
      expect(Array.isArray(prep.pathIndices)).toBe(true);

      // 2) Verify old root locally from the out2 leaf
      const localOldRoot = await computeRootFromLeafBE(commitment, prep.pathElements, prep.pathIndices);
      const localBE   = hex64(localOldRoot);
      const prepareBE = normalizeHex(prep.merkleRoot);
      console.log("\n[oldRoot] BE-check (withdraw/out2)", {
        local_be: localBE,
        prepare_root_be: prepareBE,
        leafIndex: prep.leafIndex,
      });
      if (localBE !== prepareBE) {
        throw new Error(`oldMerkleRoot mismatch (BE): local=${localBE} prepare=${prepareBE} (leafIndex=${prep.leafIndex}).`);
      }

      // 3) Build circuit witness
      const inputSignals: Record<string, any> = {
        recipientWalletPubKey:  modF(recipientWalletPubKey).toString(),
        recipientWalletPrivKey: modF(recipientWalletPrivKey).toString(),
        amount:                 modF(amount).toString(),
        tokenId:                modF(tokenId).toString(),
        randomness:             modF(randomness).toString(),
        memo:                   modF(memo).toString(),

        // merkle path for the spent note (BE → decimal strings)
        pathElements:           prep.pathElements.map(h => fromHexToBigBE(h).toString()),
        pathIndices:            prep.pathIndices,

        // private preimage binding for the note being spent
        commitment:             modF(commitment).toString(),
      };

      // 4) Try to prove locally
      let proof: any = null;
      let publicSignals: string[] = [];
      if (hasArtifacts()) {
        try {
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-ignore
          const snarkjs = await import("snarkjs");
          const { groth16 } = snarkjs as any;

        const normalized = toDecimalIfHex(inputSignals);
        const out = await groth16.fullProve(normalized, WASM_PATH, ZKEY_PATH);
        proof = out.proof;
        publicSignals = (out.publicSignals as any[]).map(String);
        } catch (err) {
          console.error("❌ fullProve failed. Inputs were:");
          console.error(util.inspect(inputSignals, { depth: null, colors: true, maxArrayLength: null }));
          console.error("Hint: mismatch between commitment/path and relayer state is the usual culprit.");
          throw err;
        }
      } else {
        console.warn(`[withdraw e2e] Missing ${WASM_PATH} / ${ZKEY_PATH}; skipping local proof.`);
      }

      // Extra visibility: compare nullifier we recomputed vs the circuit’s PS[0] (when present)
      if (publicSignals.length) {
        const nfHexFromPS = BigInt(publicSignals[PS.NULLIFIER]).toString(16).padStart(64, "0");
        const nfHexLocal  = hex64(nullifier);
        console.log("\n[withdraw:nullifier] circuit vs local", {
          circuit_ps0: nfHexFromPS,
          local_recomputed: nfHexLocal,
          equal: nfHexFromPS === nfHexLocal,
        });
      } else {
        console.log("\n[withdraw:nullifier] local (no PS):", hex64(nullifier));
      }

      // 5) Build submit body (include canonical pubs if we have them)
      const oldRootHex = normalizeHex(prep.merkleRoot);
      const getHex = (i: number) =>
        publicSignals.length ? BigInt(publicSignals[i]).toString(16).padStart(64, "0") : "";

      const submitBody = {
        operation: "withdraw",
        tokenMint: MINT_ADDRESS,

        // zk
        proof,
        publicSignals,

        // canonical pubs (BE hex)
        nullifier:      publicSignals.length ? getHex(PS.NULLIFIER) : hex64(nullifier),
        oldMerkleRoot:  publicSignals.length ? getHex(PS.MERKLE_ROOT) : oldRootHex,
        recipientWalletPubKey: publicSignals.length ? getHex(PS.RECIPIENT_PK) : hex64(recipientWalletPubKey),
        amount:         publicSignals.length ? String(BigInt(publicSignals[PS.AMOUNT])) : String(Number(amount)),
        tokenId:        publicSignals.length ? String(BigInt(publicSignals[PS.TOKEN_ID])) : String(Number(tokenId)),

        // for API bookkeeping (optional but handy)
        memo: Number(memo),
      };

      console.log(util.inspect(submitBody, { depth: null, maxArrayLength: null, colors: true }));

      if (!proof) {
        console.warn("[withdraw e2e] No proof generated. Skipping /submit.");
        return;
      }

      type SubmitResp = { ok?: boolean; txid?: string; txSig?: string; signature?: string };
      const result = await httpJson<SubmitResp>(`${BASE_URL}/api/v1/submit/withdraw`, submitBody);

      expect(result).toBeTruthy();
      const sig = (result.signature || result.txSig || result.txid || "").toString();
      if (sig) expect(sig.length).toBeGreaterThan(20);
      if (typeof result.ok === "boolean") expect(result.ok).toBe(true);
    },
    180_000
  );
});
