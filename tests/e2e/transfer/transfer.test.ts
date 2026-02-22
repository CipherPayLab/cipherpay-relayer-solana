/* tests/e2e/transfer/transfer.test.ts */
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import util from "node:util";

// Poseidon (BN254) — your project export (variadic H)
import { H } from "@/services/merkle/poseidon.js";

dotenv.config();

/* ------------------------------------------------------------------ */
/* Constants & wiring                                                 */
/* ------------------------------------------------------------------ */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE_URL = process.env.E2E_BASE_URL || "http://localhost:4000";
const AUTH_TOKEN =
  process.env.DASHBOARD_TOKEN || process.env.API_TOKEN || "supersecret";
const HMAC_KEY_ID = process.env.API_KEY_ID || "";
const HMAC_SECRET = process.env.API_KEY_SECRET || "";

// SPL mint to tag outputs with (same as deposit test)
const MINT_ADDRESS =
  process.env.TEST_MINT ||
  process.env.USDC_MINT ||
  "So11111111111111111111111111111111111111112"; // wSOL for local dev

// proofs/transfer paths
const PROOFS_DIR = process.env.TRANSFER_PROOFS_DIR
  ? path.resolve(process.env.TRANSFER_PROOFS_DIR)
  : path.resolve(__dirname, "./proof");
const EXAMPLE_INPUT = fs.existsSync(
  path.join(PROOFS_DIR, "example_transfer_input.json")
)
  ? path.join(PROOFS_DIR, "example_transfer_input.json")
  : path.join(PROOFS_DIR, "example_transfer_input_template.json");

const WASM_PATH =
  process.env.TRANSFER_WASM || path.join(PROOFS_DIR, "transfer.wasm");
const ZKEY_PATH =
  process.env.TRANSFER_ZKEY || path.join(PROOFS_DIR, "transfer_final.zkey");

// BN254 field
const FQ =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

const modF = (x: bigint) => ((x % FQ) + FQ) % FQ;

function hasArtifacts(): boolean {
  return fs.existsSync(WASM_PATH) && fs.existsSync(ZKEY_PATH);
}

function bearer() {
  return AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {};
}

function hmacHeaders(raw: Buffer) {
  if (!HMAC_SECRET || !HMAC_KEY_ID) return {};
  const sig = crypto
    .createHmac("sha256", HMAC_SECRET)
    .update(raw)
    .digest("hex");
  return { "X-Api-Key": HMAC_KEY_ID, "X-Api-Signature": sig };
}

async function httpJson<T>(url: string, body: any): Promise<T> {
  const raw = Buffer.from(JSON.stringify(body));
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...bearer(),
      ...hmacHeaders(raw),
    },
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

/**
 * FIX: 0x-only normalizer.
 * We only convert strings that EXPLICITLY start with 0x.
 * Pure decimal strings (including 64-char ones like "555...") are preserved.
 */
function toDecimalIfHex(x: any): any {
  if (typeof x === "string") {
    const s = x.trim();
    if (/^0x[0-9a-fA-F]+$/.test(s)) return BigInt(s).toString();
    if (/^[0-9]+$/.test(s)) return s; // keep decimal as-is
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

/** INDEX → field element (mod FQ) */
function feFromTransferIndex(): bigint {
  const idx = Number(process.env.INDEX ?? "0");
  return BigInt(idx) % FQ;
}

/** Circom Merkle recompute for the spent leaf (BE siblings, bottom→top). */
async function computeRootFromLeafBE(
  leafBig: bigint,
  pathHex: string[],
  bits: number[]
): Promise<bigint> {
  if (pathHex.length !== bits.length) {
    throw new Error(
      `path length ${pathHex.length} != indices length ${bits.length}`
    );
  }
  let cur = modF(leafBig);
  for (let i = 0; i < bits.length; i++) {
    const sib = fromHexToBigBE(pathHex[i]);
    cur =
      (bits[i] | 0) === 0
        ? await H(modF(cur), modF(sib))
        : await H(modF(sib), modF(cur));
    cur = modF(cur);
  }
  return cur;
}

/** synthesize out2PathElements to match transfer.circom Step 8 */
function synthesizeOut2PathElementsBE(
  depth: number,
  nextLeafIndex: number,
  out1PathElementsBE: string[], // (not used directly, but kept for clarity)
  out2PathElementsBE_pre: string[], // pre-insertion siblings from server
  cur1Nodes: bigint[], // cur1[k] after step-7; length depth+1
  out1Commitment: bigint
): string[] {
  const bits1 = Array.from(
    { length: depth },
    (_, i) => (nextLeafIndex >> i) & 1
  );
  const out: string[] = new Array(depth);

  // k = 0 special case (sib0 = out1 if nextLeafIndex even; else pre-sibling)
  const b0 = bits1[0]; // 0 if even
  out[0] =
    b0 === 0
      ? "0x" + modF(out1Commitment).toString(16).padStart(64, "0")
      : out2PathElementsBE_pre[0];

  // Levels k >= 1:
  // replace_k = (all lower bits of nextLeafIndex are 1) * (this bit is 0)
  let carry = 1;
  for (let k = 1; k < depth; k++) {
    carry = carry * (bits1[k - 1] ? 1 : 0);
    const replaceK = carry * (bits1[k] ? 0 : 1);
    out[k] =
      replaceK === 1
        ? "0x" + modF(cur1Nodes[k]).toString(16).padStart(64, "0")
        : out2PathElementsBE_pre[k];
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Public signals order (must match your transfer circuit)            */
/* ------------------------------------------------------------------ */
// OUT1, OUT2, NULLIFIER, MERKLE_ROOT, NEW_ROOT1, NEW_ROOT2, NEW_NEXT_IDX, ENC1, ENC2
const PS = {
  OUT1: 0,
  OUT2: 1,
  NULLIFIER: 2,
  MERKLE_ROOT: 3,
  NEW_ROOT1: 4,
  NEW_ROOT2: 5,
  NEW_NEXT_IDX: 6,
  ENC1: 7,
  ENC2: 8,
} as const;

/* ------------------------------------------------------------------ */
/* The test                                                           */
/* ------------------------------------------------------------------ */

describe("E2E: transfer strict-sync flow", () => {
  let example: any;

  beforeAll(async () => {
    const raw = fs.readFileSync(EXAMPLE_INPUT, "utf8");
    example = JSON.parse(raw);
  });

  it("prepares, (optionally) proves, and submits a transfer (randomness via INDEX)", async () => {
    // 1) Load/derive canonical inputs
    const inAmount = BigInt(example.inAmount ?? 0);
    const inPubKey = BigInt(example.inSenderWalletPubKey ?? 0);
    const inPrivKey = BigInt(example.inSenderWalletPrivKey ?? 0);
    const inTokenId = BigInt(example.inTokenId ?? 0);
    const inMemo = BigInt(example.inMemo ?? 0);

    const out1Amount = BigInt(example.out1Amount ?? 0);
    const out1Pk = BigInt(example.out1RecipientCipherPayPubKey ?? 0);
    const out1Token = BigInt(example.out1TokenId ?? 0);
    const out1Memo = BigInt(example.out1Memo ?? 0);

    const out2Amount = BigInt(example.out2Amount ?? 0);
    const out2Pk = BigInt(example.out2RecipientCipherPayPubKey ?? 0);
    const out2Token = BigInt(example.out2TokenId ?? 0);
    const out2Memo = BigInt(example.out2Memo ?? 0);

    // Per requirement: all three randomness fields come from INDEX
    const rnd = feFromTransferIndex();
    const inRandomness = rnd;
    const out1Randomness = rnd;
    const out2Randomness = rnd;

    // 2) Compute derived keys/commitments exactly like generate-example-proof.js
    const senderCipherPayPubKey = await H(modF(inPubKey), modF(inPrivKey));
    const inCommitment = await H(
      modF(inAmount),
      modF(senderCipherPayPubKey),
      modF(inRandomness),
      modF(inTokenId),
      modF(inMemo)
    );
    const out1Commitment = await H(
      modF(out1Amount),
      modF(out1Pk),
      modF(out1Randomness),
      modF(out1Token),
      modF(out1Memo)
    );
    const out2Commitment = await H(
      modF(out2Amount),
      modF(out2Pk),
      modF(out2Randomness),
      modF(out2Token),
      modF(out2Memo)
    );

    // Nullifier (same binding as example script)
    const nullifier = await H(
      modF(senderCipherPayPubKey),
      modF(inAmount),
      modF(inRandomness)
    );

    // 🔐 Enc note tags — Poseidon(2) with (commitment, recipientPk)
    // IMPORTANT: Keep same radix for pk as used above; our 0x-only normalizer preserves decimal values.
    const encNote1Hash = await H(modF(out1Commitment), modF(out1Pk));
    const encNote2Hash = await H(modF(out2Commitment), modF(out2Pk));

    // 3) Ask relayer for strict-sync path for the *spent* note
    type PrepareResp = {
      merkleRoot: string; // **BE** hex (32)
      inPathElements: string[]; // **BE** hex (bottom→top)
      inPathIndices: number[]; // 0/1 bits, LSB at level 0
      leafIndex: number; // index where this commitment lives
      // Optional insertion info for outputs:
      nextLeafIndex?: number; // index for out1
      out1PathElements?: string[]; // **BE** siblings for out1 position
      out2PathElements?: string[]; // **BE** siblings for out2 position (pre-state)
    };

    const prep = await httpJson<PrepareResp>(
      `${BASE_URL}/api/v1/prepare/transfer`,
      { inCommitment: inCommitment.toString(10) }
    );

    // 4) Verify old root locally (BE) from the **spent leaf**
    const localOldRoot = await computeRootFromLeafBE(
      inCommitment,
      prep.inPathElements,
      prep.inPathIndices
    );
    const localBE = hex64(localOldRoot);
    const prepareBE = normalizeHex(prep.merkleRoot);
    console.log("\n[oldRoot] BE-check (spent leaf)", {
      local_be: localBE,
      prepare_root_be: prepareBE,
      leafIndex: prep.leafIndex,
    });
    if (localBE !== prepareBE) {
      throw new Error(
        `oldMerkleRoot mismatch (BE): local=${localBE} prepare=${prepareBE} (leafIndex=${prep.leafIndex}).`
      );
    }

    // 5) Work out the insertion index for out1
    const depth = (prep.inPathElements || []).length;
    let nextLeafIndex =
      typeof prep.nextLeafIndex === "number" ? prep.nextLeafIndex : 0;

    // Fallback: if server didn't send nextLeafIndex, infer reasonable default (typical: 1 after single deposit)
    if (typeof prep.nextLeafIndex !== "number") nextLeafIndex = 1;

    // 6) Rebuild Step 7 in JS to obtain cur1[k] nodes (needed for synth at k>=1)
    const bits1 = Array.from(
      { length: depth },
      (_, i) => (nextLeafIndex >> i) & 1
    );
    const cur1: bigint[] = new Array(depth + 1);
    cur1[0] = modF(out1Commitment);

    for (let j = 0; j < depth; j++) {
      const sib = fromHexToBigBE((prep.out1PathElements || [])[j] || "0");
      const left = bits1[j] ? sib : cur1[j];
      const right = bits1[j] ? cur1[j] : sib;
      cur1[j + 1] = modF(await H(modF(left), modF(right)));
    }

    // 7) Synthesize out2PathElements exactly like Step 8 in circom
    const out2BE_pre = prep.out2PathElements || new Array(depth).fill("0");
    const out2BE_synth = synthesizeOut2PathElementsBE(
      depth,
      nextLeafIndex,
      prep.out1PathElements || [],
      out2BE_pre,
      cur1, // cur1[k] from our step-7
      out1Commitment
    );

    // 8) Build circuit inputs (decimal strings; siblings parsed as BE bigints)
    const inputSignals: Record<string, any> = {
      // input note
      inAmount: modF(inAmount).toString(),
      inSenderWalletPubKey: modF(inPubKey).toString(),
      inSenderWalletPrivKey: modF(inPrivKey).toString(),
      inRandomness: modF(inRandomness).toString(),
      inTokenId: modF(inTokenId).toString(),
      inMemo: modF(inMemo).toString(),

      // outputs
      out1Amount: modF(out1Amount).toString(),
      out1RecipientCipherPayPubKey: modF(out1Pk).toString(),
      out1Randomness: modF(out1Randomness).toString(),
      out1TokenId: modF(out1Token).toString(),
      out1Memo: modF(out1Memo).toString(),

      out2Amount: modF(out2Amount).toString(),
      out2RecipientCipherPayPubKey: modF(out2Pk).toString(),
      out2Randomness: modF(out2Randomness).toString(),
      out2TokenId: modF(out2Token).toString(),
      out2Memo: modF(out2Memo).toString(),

      // merkle proof of spent note
      inPathElements: prep.inPathElements.map((h) =>
        fromHexToBigBE(h).toString()
      ),
      inPathIndices: prep.inPathIndices,
      nextLeafIndex: String(nextLeafIndex),

      // insertion siblings
      out1PathElements: (
        prep.out1PathElements || new Array(depth).fill("0")
      ).map((h) => fromHexToBigBE(h).toString()),
      out2PathElements: out2BE_synth.map((h) => fromHexToBigBE(h).toString()),

      // required extra bindings (POSEIDON2(commitment, pk))
      encNote1Hash: modF(encNote1Hash).toString(),
      encNote2Hash: modF(encNote2Hash).toString(),
    };

    // 9) Try proving locally (if artifacts exist)
    let proof: any = null;
    let publicSignals: string[] = [];
    if (hasArtifacts()) {
      try {
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        const snarkjs = await import("snarkjs");
        const { groth16 } = snarkjs as any;

        // KEEP normalizer, but 0x-only ensures we don't corrupt decimal inputs
        const normalized = toDecimalIfHex(inputSignals);
        const out = await groth16.fullProve(normalized, WASM_PATH, ZKEY_PATH);
        proof = out.proof;
        publicSignals = (out.publicSignals as any[]).map(String);
      } catch (err) {
        console.error("❌ fullProve failed. Dumping the exact inputs we used:");
        console.error(
          util.inspect(inputSignals, {
            depth: null,
            colors: true,
            maxArrayLength: null,
          })
        );
        console.error(
          "Hint: typical causes are oldRoot/path mismatch or out2Path synthesis not matching the circuit."
        );
        throw err;
      }
    } else {
      console.warn(
        `[transfer e2e] Missing ${WASM_PATH} / ${ZKEY_PATH}; skipping local proof.`
      );
    }

    // 10) If we produced a proof, fish out key publics in hex (BE)
    const oldRootHex = normalizeHex(prep.merkleRoot); // already BE from server
    const getHex = (i: number) =>
      publicSignals.length
        ? BigInt(publicSignals[i]).toString(16).padStart(64, "0")
        : "";
    const submitBody = {
      operation: "transfer",
      tokenMint: MINT_ADDRESS,

      // zk
      proof,
      publicSignals,

      // canonical pubs we (also) send explicitly (BE hex)
      out1Commitment: publicSignals.length
        ? getHex(PS.OUT1)
        : hex64(out1Commitment),
      out2Commitment: publicSignals.length
        ? getHex(PS.OUT2)
        : hex64(out2Commitment),
      nullifier: publicSignals.length ? getHex(PS.NULLIFIER) : hex64(nullifier),
      oldMerkleRoot: publicSignals.length ? getHex(PS.MERKLE_ROOT) : oldRootHex,
      newMerkleRoot1: publicSignals.length ? getHex(PS.NEW_ROOT1) : undefined,
      newMerkleRoot2: publicSignals.length ? getHex(PS.NEW_ROOT2) : undefined,
      newNextLeafIndex: publicSignals.length
        ? String(BigInt(publicSignals[PS.NEW_NEXT_IDX]))
        : undefined,

      // for server-side accounting / checks
      inAmount: Number(inAmount),
      out1Amount: Number(out1Amount),
      out2Amount: Number(out2Amount),
    };

    console.log(
      util.inspect(submitBody, {
        depth: null,
        maxArrayLength: null,
        colors: true,
      })
    );

    if (!proof) {
      console.warn("[transfer e2e] No proof generated. Skipping /submit.");
      return;
    }

    type SubmitResp = {
      ok?: boolean;
      txid?: string;
      txSig?: string;
      signature?: string;
      root1?: string;
      root2?: string; // optional echoes
    };

    const result = await httpJson<SubmitResp>(
      `${BASE_URL}/api/v1/submit/transfer`,
      submitBody
    );

    expect(result).toBeTruthy();
    const sig = (
      result.signature ||
      result.txSig ||
      result.txid ||
      ""
    ).toString();
    if (sig) expect(sig.length).toBeGreaterThan(20);
    if (typeof result.ok === "boolean") expect(result.ok).toBe(true);
  }, 180_000);
});
