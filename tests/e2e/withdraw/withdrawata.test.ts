/* tests/e2e/withdraw/withdrawata.test.ts */
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import util from "node:util";
import dotenv from "dotenv";

/* Solana + SPL for recipient ATA setup */
import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount } from "@solana/spl-token";

/* Poseidon (BN254) — same H used by other tests (variadic) */
import { H } from "@/services/merkle/poseidon.js";

dotenv.config();

/* ------------------------------------------------------------------ */
/* Constants & wiring                                                 */
/* ------------------------------------------------------------------ */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* Load the shared fresh mint from deposit test (hard requirement here) */
const SHARED_MINT_PATH = path.resolve(__dirname, "..", ".shared-mint.json");
function readSharedMint(): { mint: string; decimals: number } {
  if (!fs.existsSync(SHARED_MINT_PATH)) {
    throw new Error(
      `Shared mint file not found at ${SHARED_MINT_PATH}. ` +
        `Run the deposit E2E first to create and persist the test mint.`
    );
  }
  const j = JSON.parse(fs.readFileSync(SHARED_MINT_PATH, "utf8"));
  if (!j?.mint) throw new Error(`Invalid shared mint file: missing "mint"`);
  return { mint: String(j.mint), decimals: Number(j.decimals ?? 0) };
}

const { mint: MINT_ADDRESS } = readSharedMint();

const BASE_URL = process.env.E2E_BASE_URL || "http://localhost:4000";
const AUTH_TOKEN =
  process.env.DASHBOARD_TOKEN || process.env.API_TOKEN || "supersecret";
const HMAC_KEY_ID = process.env.API_KEY_ID || "";
const HMAC_SECRET = process.env.API_KEY_SECRET || "";

/* proofs/withdraw paths */
const PROOFS_DIR = process.env.WITHDRAW_PROOFS_DIR
  ? path.resolve(process.env.WITHDRAW_PROOFS_DIR)
  : path.resolve(__dirname, "./proof");

const EXAMPLE_INPUT = fs.existsSync(
  path.join(PROOFS_DIR, "example_withdraw_input.json")
)
  ? path.join(PROOFS_DIR, "example_withdraw_input.json")
  : path.join(PROOFS_DIR, "example_withdraw_input_template.json");

const WASM_PATH =
  process.env.WITHDRAW_WASM || path.join(PROOFS_DIR, "withdraw.wasm");
const ZKEY_PATH =
  process.env.WITHDRAW_ZKEY || path.join(PROOFS_DIR, "withdraw_final.zkey");

/* Chain connection & wallet (client) */
const RPC_URL =
  process.env.SOLANA_URL ||
  process.env.ANCHOR_PROVIDER_URL ||
  "http://127.0.0.1:8899";
const KEYPAIR_PATH =
  process.env.ANCHOR_WALLET || `${process.env.HOME}/.config/solana/id.json`;

/* BN254 */
const FQ =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */
const modF = (x: bigint) => ((x % FQ) + FQ) % FQ;
/** INDEX → field element (mod FQ) */
function feFromWithdrawIndex(): bigint {
  const idx = Number(process.env.INDEX ?? "0");
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
/** 128-bit hex (32 nybbles) zero-padded, lowercase, no 0x */
function hex32(bi: bigint) {
  return bi.toString(16).padStart(32, "0");
}
function fromHexToBigBE(s: string): bigint {
  const t = s.startsWith("0x") ? s.slice(2) : s;
  return BigInt("0x" + t) % FQ;
}
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

/* --- 128-bit limb helpers for recipientOwner --- */
function bigFromBytesLE(bytes: Uint8Array): bigint {
  let x = 0n;
  let shift = 0n;
  for (const b of bytes) {
    x += BigInt(b) << shift;
    shift += 8n;
  }
  return x;
}
/**
 * EXACTLY like scripts/generate-example-proofs.js:
 * Take the canonical 32 bytes of a Solana PublicKey (big-endian/network order),
 * do NOT reverse, split into two 16-byte chunks, and interpret EACH CHUNK
 * as a little-endian integer. Return limbs as (hi, lo).
 */
function splitPubkeyTo128_LIMBS_MATCH_SCRIPT(pk: PublicKey): {
  hi: bigint;
  lo: bigint;
} {
  const be = pk.toBytes();
  const lo = bigFromBytesLE(be.slice(0, 16));
  const hi = bigFromBytesLE(be.slice(16, 32));
  return { hi: modF(hi), lo: modF(lo) };
}
/** Mirror on-chain pubkey_from_limbs: copy first 16 bytes of each 32-byte FE (LE), concat lo||hi. */
function pubkeyFromLimbsLikeOnchain(loDec: bigint, hiDec: bigint): Uint8Array {
  const toLE32Field = (x: bigint) => {
    const b = Buffer.alloc(32, 0);
    let v = x;
    for (let i = 0; i < 16; i++) {
      b[i] = Number(v & 0xffn);
      v >>= 8n;
    }
    return b;
  };
  const lo32 = toLE32Field(loDec);
  const hi32 = toLE32Field(hiDec);
  const out = new Uint8Array(32);
  out.set(lo32.subarray(0, 16), 0);
  out.set(hi32.subarray(0, 16), 16);
  return out;
}

/* Public signals order (withdraw, 7-pubs variant) */
const PS = {
  NULLIFIER: 0,
  MERKLE_ROOT: 1,
  OWNER_LO: 2,
  OWNER_HI: 3,
  RECIPIENT_PK: 4,
  AMOUNT: 5,
  TOKEN_ID: 6,
} as const;

/* ------------------------------------------------------------------ */
/* The test: client-specified recipient ATA                           */
/* ------------------------------------------------------------------ */
describe("E2E: withdraw via client recipient ATA", () => {
  // Client wallet + connection
  const secret = Buffer.from(JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf8")));
  const client = Keypair.fromSecretKey(secret);
  const connection = new Connection(RPC_URL, "confirmed");

  let example: any;
  let recipientOwner: PublicKey;
  let recipientAta: PublicKey;
  const mint = new PublicKey(MINT_ADDRESS);

  beforeAll(async () => {
    // Airdrop for fees if needed
    const bal = await connection.getBalance(client.publicKey);
    if (bal < 2 * LAMPORTS_PER_SOL) {
      const sig = await connection.requestAirdrop(
        client.publicKey,
        3 * LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(sig, "confirmed");
    }

    // Load example withdraw inputs
    const raw = fs.readFileSync(EXAMPLE_INPUT, "utf8");
    example = JSON.parse(raw);

    // Ensure recipient ATA exists (owned by client) — using the shared test mint
    recipientOwner = client.publicKey;
    const ata = await getOrCreateAssociatedTokenAccount(
      connection,
      client,
      mint,
      recipientOwner
    );
    recipientAta = ata.address;

    console.log("[withdraw-ATA] mint (shared):", mint.toBase58());
    console.log("[withdraw-ATA] recipientOwner:", recipientOwner.toBase58());
    console.log(
      "[withdraw-ATA] recipientTokenAccount:",
      recipientAta.toBase58()
    );
  });

  it("prepares, (optionally) proves, and submits a withdraw to client ATA", async () => {
    // Inputs follow generate-example-proofs.js -> withdraw defaults
    const recipientWalletPubKey = BigInt(example.recipientWalletPubKey ?? 0);
    const recipientWalletPrivKey = BigInt(example.recipientWalletPrivKey ?? 0);
    const amount = BigInt(example.amount ?? 0);
    const tokenId = BigInt(example.tokenId ?? 0);
    const memo = BigInt(example.memo ?? 0);

    // Randomness from INDEX (same pattern as DEPOSIT/TRANSFER)
    const randomness = feFromWithdrawIndex();

    // CipherPay pubkey = Poseidon2(walletPub, walletPriv)
    const recipientCipherPayPubKey = await H(
      modF(recipientWalletPubKey),
      modF(recipientWalletPrivKey)
    );

    // The note we’re spending (typically out2):
    const commitment = await H(
      modF(amount),
      modF(recipientCipherPayPubKey),
      modF(randomness),
      modF(tokenId),
      modF(memo)
    );

    // Nullifier = H(cipherPayPubKey, randomness, tokenId)
    const nullifier = await H(
      modF(recipientCipherPayPubKey),
      modF(randomness),
      modF(tokenId)
    );

    // 1) Ask the relayer for the strict-sync path to THIS commitment
    type PrepareResp = {
      merkleRoot: string;
      pathElements: string[];
      pathIndices: number[];
      leafIndex: number;
    };
    const prep = await httpJson<PrepareResp>(
      `${BASE_URL}/api/v1/prepare/withdraw`,
      { spendCommitment: commitment.toString(10) }
    );

    expect(prep).toBeTruthy();
    expect(Array.isArray(prep.pathElements)).toBe(true);
    expect(Array.isArray(prep.pathIndices)).toBe(true);

    // 2) Verify old root locally from the out2 leaf
    const localOldRoot = await computeRootFromLeafBE(
      commitment,
      prep.pathElements,
      prep.pathIndices
    );
    const localBE = hex64(localOldRoot);
    const prepareBE = normalizeHex(prep.merkleRoot);
    console.log("\n[oldRoot] BE-check (withdraw/out2)", {
      local_be: localBE,
      prepare_root_be: prepareBE,
      leafIndex: prep.leafIndex,
    });
    if (localBE !== prepareBE) {
      throw new Error(
        `oldMerkleRoot mismatch (BE): local=${localBE} prepare=${prepareBE} (leafIndex=${prep.leafIndex}).`
      );
    }

    // 2.5) Compute limbs EXACTLY like the script (no 32-byte reversal)
    const limbs = splitPubkeyTo128_LIMBS_MATCH_SCRIPT(recipientOwner);
    const recipientOwner_hi_hex = hex32(limbs.hi);
    const recipientOwner_lo_hex = hex32(limbs.lo);
    console.log(
      "\n[recipientOwner limbs] (dec for circuit / hex32 for logs):",
      {
        hi_dec: limbs.hi.toString(),
        lo_dec: limbs.lo.toString(),
        hi_hex: recipientOwner_hi_hex,
        lo_hex: recipientOwner_lo_hex,
      }
    );

    // 2.6) Sanity: mirror on-chain pubkey_from_limbs(lo, hi) and compare to original
    const reconstructed = pubkeyFromLimbsLikeOnchain(limbs.lo, limbs.hi);
    const originalBytes = recipientOwner.toBytes();
    const matchPk =
      Buffer.compare(Buffer.from(reconstructed), Buffer.from(originalBytes)) ===
      0;
    console.log("[recipientOwner reconstructed == original?]", matchPk);
    expect(matchPk).toBe(true);

    // 3) Build circuit witness (include owner limbs; 7-publics circuit)
    const inputSignals: Record<string, any> = {
      recipientOwner_lo: limbs.lo.toString(),
      recipientOwner_hi: limbs.hi.toString(),

      recipientWalletPubKey: modF(recipientWalletPubKey).toString(),
      recipientWalletPrivKey: modF(recipientWalletPrivKey).toString(),
      amount: modF(amount).toString(),
      tokenId: modF(tokenId).toString(),
      randomness: modF(randomness).toString(),
      memo: modF(memo).toString(),

      pathElements: prep.pathElements.map((h) => fromHexToBigBE(h).toString()),
      pathIndices: prep.pathIndices,
      commitment: modF(commitment).toString(),
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
        console.error(
          util.inspect(inputSignals, {
            depth: null,
            colors: true,
            maxArrayLength: null,
          })
        );
        console.error(
          "Hint: mismatch between commitment/path and relayer state is the usual culprit."
        );
        throw err;
      }
    } else {
      console.warn(
        `[withdraw-ATA e2e] Missing ${WASM_PATH} / ${ZKEY_PATH}; skipping local proof.`
      );
    }

    // Compare nullifier we recomputed vs the circuit’s PS[0] (when present)
    if (publicSignals.length) {
      const nfHexFromPS = BigInt(publicSignals[PS.NULLIFIER])
        .toString(16)
        .padStart(64, "0");
      const nfHexLocal = hex64(nullifier);
      console.log("\n[withdraw:nullifier] circuit vs local", {
        circuit_ps0: nfHexFromPS,
        local_recomputed: nfHexLocal,
        equal: nfHexFromPS === nfHexLocal,
      });
    } else {
      console.log("\n[withdraw:nullifier] local (no PS):", hex64(nullifier));
    }

    // 5) Build submit body (include canonical pubs if we have them)
    const getHex = (i: number) =>
      publicSignals.length
        ? BigInt(publicSignals[i]).toString(16).padStart(64, "0")
        : "";

    const submitBody: any = {
      operation: "withdraw",
      tokenMint: MINT_ADDRESS,

      // zk
      proof,
      publicSignals,

      // canonical pubs (BE hex fallback if no publicSignals)
      nullifier: publicSignals.length ? getHex(PS.NULLIFIER) : hex64(nullifier),
      oldMerkleRoot: publicSignals.length
        ? getHex(PS.MERKLE_ROOT)
        : normalizeHex(prep.merkleRoot),
      recipientWalletPubKey: publicSignals.length
        ? getHex(PS.RECIPIENT_PK)
        : hex64(recipientWalletPubKey),
      amount: publicSignals.length
        ? String(BigInt(publicSignals[PS.AMOUNT]))
        : String(Number(amount)),
      tokenId: publicSignals.length
        ? String(BigInt(publicSignals[PS.TOKEN_ID]))
        : String(Number(tokenId)),

      // client-specified recipient (owner + ATA) + limbs
      recipientOwner_lo: "0x" + recipientOwner_lo_hex,
      recipientOwner_hi: "0x" + recipientOwner_hi_hex,

      recipientOwner: recipientOwner.toBase58(),
      recipientTokenAccount: recipientAta.toBase58(),

      // Optional bookkeeping
      memo: Number(memo),
    };

    console.log("\n[submit:withdraw-ATA] body (truncated proof):");
    const bodyForLog = {
      ...submitBody,
      proof: proof
        ? { ...proof, pi_a: "[...]", pi_b: "[...]", pi_c: "[...]" }
        : null,
    };
    console.log(
      util.inspect(bodyForLog, {
        depth: null,
        maxArrayLength: null,
        colors: true,
      })
    );
    console.log("[submit:withdraw-ATA] recipientOwner limbs (hex32):", {
      hi: recipientOwner_hi_hex,
      lo: recipientOwner_lo_hex,
    });

    if (!proof) {
      console.warn("[withdraw-ATA e2e] No proof generated. Skipping /submit.");
      return;
    }

    type SubmitResp = {
      ok?: boolean;
      txid?: string;
      txSig?: string;
      signature?: string;
    };
    const result = await httpJson<SubmitResp>(
      `${BASE_URL}/api/v1/submit/withdraw`,
      submitBody
    );

    expect(result).toBeTruthy();
    const sig = (
      result.signature ||
      result.txSig ||
      result.txid ||
      ""
    ).toString();
    console.log("\n[submit:withdraw-ATA] tx signature:", sig);
    if (sig) expect(sig.length).toBeGreaterThan(20);
    if (typeof result.ok === "boolean") expect(result.ok).toBe(true);
  }, 180_000);
});
