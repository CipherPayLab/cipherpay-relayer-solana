/* ESM */
// src/services/solana-relayer.ts
import "dotenv/config";
import * as anchor from "@coral-xyz/anchor";
import { Program, AnchorProvider, web3 } from "@coral-xyz/anchor";
import fs from "node:fs";
import idl from "@/idl/cipherpay_anchor.json" with { type: "json" };
import TxManager from "@/solana/tx-manager.js";

// DB + Merkle store
import { getPool } from "@/services/db/mysql.js";
import {
  MySqlMerkleStore,
  type DepositCompletedEvent,
  type TransferCompletedEvent,
  type WithdrawCompletedEvent,
} from "@/services/merkle/stores/mysql-merkle-store.js";

type AnyIdl = Record<string, any>;
const TREE_ID = Number(process.env.MERKLE_TREE_ID ?? 1);
const DEBUG_EVENTS = process.env.RELAYER_EVENT_DEBUG !== "0"; // default ON unless explicitly "0"

/* ---------- optional comparisons via env ---------- */
const PUBLICS_LE_RAW = (process.env.PUBLICS_LE || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const ROOTS_BE_RAW = (process.env.ROOTS_BE || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/* ----------------------------- provider/program ---------------------------- */

function makeProvider(): AnchorProvider {
  const url =
    process.env.ANCHOR_PROVIDER_URL ||
    process.env.SOLANA_URL ||
    "http://127.0.0.1:8899";

  const walletPath =
    process.env.ANCHOR_WALLET || `${process.env.HOME}/.config/solana/id.json`;

  const secret = Buffer.from(JSON.parse(fs.readFileSync(walletPath, "utf8")));
  const kp = web3.Keypair.fromSecretKey(secret);

  const connection = new web3.Connection(url, "confirmed");
  const wallet = new anchor.Wallet(kp);
  return new AnchorProvider(connection, wallet, { commitment: "confirmed" });
}

function makeProgram(provider: AnchorProvider): Program {
  const idlObj = idl as AnyIdl;
  const programIdStr: string = process.env.PROGRAM_ID || idlObj.address;
  if (!programIdStr) throw new Error("PROGRAM_ID not set and IDL.address missing");
  if (idlObj.address !== programIdStr) idlObj.address = programIdStr;
  return new Program(idlObj as unknown as anchor.Idl, provider);
}

/* --------------------------------- types ---------------------------------- */

export type DepositBinArgs = {
  amount: bigint;
  tokenMint: string; // base58
  proofBytes: Buffer; // 256 bytes
  publicInputsBytes: Buffer; // 7*32 bytes
  source?: {
    sourceOwner?: string; // base58
    sourceTokenAccount?: string; // base58
    useDelegate?: boolean;
  };
};

export type TransferBinArgs = {
  tokenMint: string; // base58
  proofBytes: Buffer; // 256 bytes
  publicInputsBytes: Buffer; // 9*32 bytes
};

export type WithdrawBinArgs = {
  tokenMint: string; // base58
  proofBytes: Buffer; // 256 bytes
  publicInputsBytes: Buffer; // 7*32 bytes
};

type SubmitWithinOpts = {
  timeoutMs?: number;
  retries?: number;
  onAttempt?: (attempt: number) => void | Promise<void>;
};

/* ------------------------------- helpers ---------------------------------- */

const hex = (u: Uint8Array | Buffer) => Buffer.from(u).toString("hex");
const viewBE = (u: Uint8Array) => Buffer.from(u); // BE view == raw bytes
const viewLE = (u: Uint8Array) => Buffer.from(u).reverse(); // LE view (reversed)
const pad64 = (s: string) =>
  s.replace(/^0x/i, "").padStart(64, "0").toLowerCase();

const le32ToBig = (u: Uint8Array | Buffer): bigint => {
  const b = Buffer.from(u);
  let x = 0n;
  for (let i = 31; i >= 0; i--) x = (x << 8n) | BigInt(b[i]);
  return x;
};
const be32ToBig = (u: Uint8Array | Buffer): bigint =>
  BigInt("0x" + Buffer.from(u).toString("hex"));

const pick = (obj: any, labels: string[]) => {
  for (const k of labels) {
    if (obj != null && obj[k] != null) return obj[k];
  }
  return undefined;
};
const mustPick = (obj: any, labels: string[], ctx: string) => {
  const v = pick(obj, labels);
  if (v == null) {
    const keys = obj && typeof obj === "object" ? Object.keys(obj) : [];
    throw new Error(
      `event field missing (${ctx}): tried ${labels.join(
        "|"
      )}; available keys: [${keys.join(", ")}]`
    );
  }
  return v;
};

const normalizeMint = (m: any): string => {
  if (m?.toBase58) return m.toBase58();
  if (m instanceof web3.PublicKey) return m.toBase58();
  if (typeof m === "string") return m;
  return new web3.PublicKey(m).toBase58();
};

// ✅ robust byte converters — never pass PublicKey straight to Buffer.from
const isBN = (v: any): v is anchor.BN =>
  !!v && typeof v === "object" && typeof v.toArray === "function";
const toBytes = (v: any): Uint8Array => {
  if (!v) return new Uint8Array();
  if (v instanceof Uint8Array) return v;
  if (Buffer.isBuffer(v)) return new Uint8Array(v);
  if (Array.isArray(v)) return Uint8Array.from(v);
  if (v instanceof web3.PublicKey) return v.toBytes();
  if (isBN(v)) return Uint8Array.from(v.toArray("le"));
  if (typeof v === "bigint") {
    const out = Buffer.alloc(32);
    let x = v;
    for (let i = 0; i < 32; i++) {
      out[i] = Number(x & 0xffn);
      x >>= 8n;
    }
    return out;
  }
  if (typeof v === "string") {
    const s = v.trim();
    // try hex else base58 else utf8
    if (/^[0-9a-f]+$/i.test(s) && s.length % 2 === 0) return Buffer.from(s, "hex");
    try {
      return new web3.PublicKey(s).toBytes();
    } catch {
      /* not base58 */
    }
    return Buffer.from(s, "utf8");
  }
  return Uint8Array.from(v as any); // last resort for number[]-like
};
const toBuf32 = (v: any): Buffer => {
  const b = Buffer.from(toBytes(v));
  if (b.length !== 32) {
    throw new Error(`expected 32 bytes, got ${b.length}`);
  }
  return b;
};

/* ---- tiny runtime guards for proof/publics sizes ---- */
const expectLen = (label: string, buf: Buffer, len: number) => {
  if (!Buffer.isBuffer(buf)) {
    throw new Error(`${label}: expected Buffer, got ${typeof buf}`);
  }
  if (buf.length !== len) {
    throw new Error(`${label}: expected ${len} bytes, got ${buf.length}`);
  }
};

/* Accept both snake_case and camelCase for every field */
const MAP = {
  deposit_hash: ["deposit_hash", "depositHash"],
  owner_cipherpay_pubkey: ["owner_cipherpay_pubkey", "ownerCipherpayPubkey"],
  commitment: ["commitment", "new_commitment", "newCommitment"],
  old_merkle_root: ["old_merkle_root", "oldMerkleRoot"],
  new_merkle_root: ["new_merkle_root", "merkle_root", "newMerkleRoot", "merkleRoot"],
  next_leaf_index: ["next_leaf_index", "nextLeafIndex"],
  mint: ["mint"],
};

/* Accept both snake_case and camelCase for TransferCompleted */
const XFER_MAP = {
  nullifier: ["nullifier", "nf", "nf32"],
  out1_commitment: ["out1_commitment", "out1Commitment"],
  out2_commitment: ["out2_commitment", "out2Commitment"],
  enc_note1_hash: ["enc_note1_hash", "encNote1Hash"],
  enc_note2_hash: ["enc_note2_hash", "encNote2Hash"],
  old_merkle_root: [
    "merkle_root_before",
    "merkleRootBefore",
    "old_merkle_root",
    "oldMerkleRoot",
  ],
  new_merkle_root1: ["new_merkle_root1", "newMerkleRoot1"],
  new_merkle_root2: ["new_merkle_root2", "newMerkleRoot2"],
  next_leaf_index: ["next_leaf_index", "nextLeafIndex"],
  mint: ["mint"],
};

/* Accept both snake_case and camelCase for WithdrawCompleted */
const WD_MAP = {
  nullifier: ["nullifier", "nf", "nf32"],
  old_merkle_root: [
    "merkle_root_used",
    "merkleRootUsed",
    "old_merkle_root",
    "oldMerkleRoot",
  ],
  recipient_wallet_pubkey: [
    "recipient",
    "recipientWalletPubKey",
    "recipient_wallet_pubkey",
  ],
  amount: ["amount"],
  mint: ["mint"],
};

/* --------- Event payload normalizers (PublicKey-safe) --------- */

const toPayload = (raw: any): DepositCompletedEvent => {
  const deposit_hash = toBuf32(mustPick(raw, MAP.deposit_hash, "deposit_hash"));
  const owner_cipherpay_pubkey = toBuf32(
    mustPick(raw, MAP.owner_cipherpay_pubkey, "owner_cipherpay_pubkey"),
  );
  const commitment = toBuf32(mustPick(raw, MAP.commitment, "commitment"));
  const old_merkle_root = toBuf32(
    mustPick(raw, MAP.old_merkle_root, "old_merkle_root"),
  );
  const new_merkle_root = toBuf32(
    mustPick(raw, MAP.new_merkle_root, "new_merkle_root"),
  );
  const next_leaf_index = Number(
    mustPick(raw, MAP.next_leaf_index, "next_leaf_index"),
  );
  const mintRaw = mustPick(raw, MAP.mint, "mint");

  return {
    deposit_hash,
    owner_cipherpay_pubkey,
    commitment,
    old_merkle_root,
    new_merkle_root,
    next_leaf_index,
    mint: normalizeMint(mintRaw),
  };
};

const toTransferPayload = (raw: any): TransferCompletedEvent => {
  const nullifier = toBuf32(mustPick(raw, XFER_MAP.nullifier, "nullifier"));
  const out1_commitment = toBuf32(
    mustPick(raw, XFER_MAP.out1_commitment, "out1_commitment"),
  );
  const out2_commitment = toBuf32(
    mustPick(raw, XFER_MAP.out2_commitment, "out2_commitment"),
  );
  const enc_note1_hash = toBuf32(
    mustPick(raw, XFER_MAP.enc_note1_hash, "enc_note1_hash"),
  );
  const enc_note2_hash = toBuf32(
    mustPick(raw, XFER_MAP.enc_note2_hash, "enc_note2_hash"),
  );
  const old_merkle_root = toBuf32(
    mustPick(raw, XFER_MAP.old_merkle_root, "old_merkle_root"),
  );
  const new_merkle_root1 = toBuf32(
    mustPick(raw, XFER_MAP.new_merkle_root1, "new_merkle_root1"),
  );
  const new_merkle_root2 = toBuf32(
    mustPick(raw, XFER_MAP.new_merkle_root2, "new_merkle_root2"),
  );
  const next_leaf_index = Number(
    mustPick(raw, XFER_MAP.next_leaf_index, "next_leaf_index"),
  );
  const mintRaw = mustPick(raw, XFER_MAP.mint, "mint");

  return {
    nullifier,
    out1_commitment,
    out2_commitment,
    enc_note1_hash,
    enc_note2_hash,
    old_merkle_root,
    new_merkle_root1,
    new_merkle_root2,
    next_leaf_index,
    mint: normalizeMint(mintRaw),
  };
};

const toWithdrawPayload = (raw: any): WithdrawCompletedEvent => {
  const nullifier = toBuf32(mustPick(raw, WD_MAP.nullifier, "nullifier"));
  const old_merkle_root = toBuf32(
    mustPick(raw, WD_MAP.old_merkle_root, "old_merkle_root"),
  );

  // optional fields — normalize if present
  const recipRaw = pick(raw, WD_MAP.recipient_wallet_pubkey);
  const amtRaw = pick(raw, WD_MAP.amount);
  const mintRaw = pick(raw, WD_MAP.mint);

  const recipient_wallet_pubkey =
    recipRaw != null ? toBuf32(recipRaw) : undefined;

  const amount =
    amtRaw != null
      ? Buffer.isBuffer(amtRaw) || amtRaw instanceof Uint8Array
        ? Buffer.from(amtRaw)
        : isBN(amtRaw)
          ? Buffer.from((amtRaw as anchor.BN).toArray("le", 32))
          : toBuf32(amtRaw)
      : undefined;

  return {
    nullifier,
    old_merkle_root,
    recipient_wallet_pubkey,
    amount,
    mint: mintRaw ? normalizeMint(mintRaw) : "",
  };
};

/* Pretty debug block comparing BE/LE + decimal and optional env references */
async function debugEventBlock(store: MySqlMerkleStore, ev: DepositCompletedEvent) {
  if (!DEBUG_EVENTS) return;

  const c = Buffer.from(ev.commitment);
  const or = Buffer.from(ev.old_merkle_root);
  const nr = Buffer.from(ev.new_merkle_root);

  let dbRootLE = "";
  try {
    const rootBuf = await store.getRoot(TREE_ID);
    dbRootLE = hex(rootBuf);
  } catch {
    /* ignore */
  }

  const pubsLE = PUBLICS_LE_RAW.map(pad64);
  type SlotInfo = { slot: number; le_hex: string; le_decimal: string };
  const pubsSlots: SlotInfo[] = pubsLE.map((h, i) => {
    const buf = Buffer.from(h, "hex"); // already LE
    return { slot: i, le_hex: h, le_decimal: le32ToBig(buf).toString() };
  });

  const eventCommitLEHex = hex(c);
  const eventCommitLEDec = le32ToBig(c).toString();
  const matchIdxHex = pubsSlots.findIndex((s) => s.le_hex === eventCommitLEHex);
  const matchIdxDec = pubsSlots.findIndex(
    (s) => s.le_decimal === eventCommitLEDec,
  );

  const rootsBE = ROOTS_BE_RAW.map(pad64);
  const rootOldBE = hex(viewBE(or));
  const rootNewBE = hex(viewBE(nr));
  const cmpOld = rootsBE.length === 2 ? rootOldBE === rootsBE[0] : undefined;
  const cmpNew = rootsBE.length === 2 ? rootNewBE === rootsBE[1] : undefined;

  console.log("\n[events:debug] DepositCompleted (byte views + comparisons)", {
    commitment: {
      raw_as_LE_hex: eventCommitLEHex,
      as_BE_hex: hex(viewLE(c)),
      le_decimal: eventCommitLEDec,
    },
    old_merkle_root: {
      raw_as_BE_hex: hex(viewBE(or)),
      as_LE_hex: hex(viewLE(or)),
      be_decimal: be32ToBig(or).toString(),
      le_decimal: le32ToBig(or).toString(),
    },
    new_merkle_root: {
      raw_as_BE_hex: hex(viewBE(nr)),
      as_LE_hex: hex(viewLE(nr)),
      be_decimal: be32ToBig(nr).toString(),
      le_decimal: le32ToBig(nr).toString(),
    },
    db: { treeId: TREE_ID, current_root_LE_hex: dbRootLE },
    compare: {
      PUBLICS_LE_present: pubsSlots.length === 7,
      PUBLICS_LE_slots: pubsSlots,
      PUBLICS_LE_match_slotIndex_by_hex: matchIdxHex,
      PUBLICS_LE_match_slotIndex_by_decimal: matchIdxDec,
      ROOTS_BE_present: rootsBE.length === 2,
      ROOTS_BE_match:
        rootsBE.length === 2
          ? {
              provided_old_be: rootsBE[0],
              provided_new_be: rootsBE[1],
              event_old_be: rootOldBE,
              event_new_be: rootNewBE,
              old_equal: cmpOld,
              new_equal: cmpNew,
            }
          : undefined,
    },
  });
}

/* --------------------------------- class ---------------------------------- */

class SolanaRelayer {
  readonly provider: AnchorProvider;
  readonly program: Program;
  readonly txm: TxManager;

  private store: MySqlMerkleStore | null = null;
  private depositListenerId: number | null = null;
  private transferListenerId: number | null = null;
  private onLogsSubId: number | null = null;

  constructor() {
    this.provider = makeProvider();
    this.program = makeProgram(this.provider);
    this.txm = new TxManager({
      program: this.program,
      provider: this.provider,
      connection: this.provider.connection,
    });
  }

  async submitDepositWithBin(args: DepositBinArgs) {
    expectLen("deposit.proofBytes", args.proofBytes, 256);
    expectLen("deposit.publicInputsBytes", args.publicInputsBytes, 7 * 32);
    const mint = new web3.PublicKey(args.tokenMint);
    
    // Convert source parameters from strings to PublicKeys if provided
    let source: {
      sourceOwner: web3.PublicKey;
      sourceTokenAccount: web3.PublicKey;
      useDelegate?: boolean;
    } | undefined = undefined;
    
    if (args.source && args.source.useDelegate && args.source.sourceOwner && args.source.sourceTokenAccount) {
      source = {
        sourceOwner: new web3.PublicKey(args.source.sourceOwner),
        sourceTokenAccount: new web3.PublicKey(args.source.sourceTokenAccount),
        useDelegate: args.source.useDelegate,
      };
    }
    
    const sig = await this.txm.submitShieldedDepositAtomicBytes({
      mint,
      amount: args.amount,
      proofBytes: args.proofBytes,
      publicInputsBytes: args.publicInputsBytes,
      source,
    });
    return { signature: sig };
  }

  async submitDepositWithin(
    args: DepositBinArgs,
    opts: SubmitWithinOpts = {},
  ): Promise<{ signature: string }> {
    const timeoutMs = opts.timeoutMs ?? 25_000;
    const retries = Math.max(0, opts.retries ?? 1);

    const attemptOnce = async (attempt: number) => {
      await opts.onAttempt?.(attempt);
      const to = new Promise<never>((_, rej) => {
        const t = setTimeout(() => {
          clearTimeout(t);
          rej(
            new Error(
              `submitDepositWithin: attempt ${attempt} timed out after ${timeoutMs} ms`,
            ),
          );
        }, timeoutMs);
      });
      return Promise.race([this.submitDepositWithBin(args), to]) as Promise<{
        signature: string;
      }>;
    };

    let lastErr: unknown = null;
    for (let i = 1; i <= 1 + retries; i++) {
      try {
        return await attemptOnce(i);
      } catch (e) {
        lastErr = e;
        if (i <= retries) await new Promise((r) => setTimeout(r, 500 * i));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  async submitTransferWithBin(args: TransferBinArgs) {
    expectLen("transfer.proofBytes", args.proofBytes, 256);
    expectLen("transfer.publicInputsBytes", args.publicInputsBytes, 9 * 32);
    const mint = new web3.PublicKey(args.tokenMint);
    const sig = await this.txm.submitShieldedTransferAtomicBytes({
      mint,
      proofBytes: args.proofBytes,
      publicInputsBytes: args.publicInputsBytes,
    });
    return { signature: sig };
  }

  async submitTransferWithin(
    args: TransferBinArgs,
    opts: SubmitWithinOpts = {},
  ): Promise<{ signature: string }> {
    const timeoutMs = opts.timeoutMs ?? 25_000;
    const retries = Math.max(0, opts.retries ?? 1);

    const attemptOnce = async (attempt: number) => {
      await opts.onAttempt?.(attempt);
      const to = new Promise<never>((_, rej) => {
        const t = setTimeout(() => {
          clearTimeout(t);
          rej(
            new Error(
              `submitTransferWithin: attempt ${attempt} timed out after ${timeoutMs} ms`,
            ),
          );
        }, timeoutMs);
      });
      return Promise.race([this.submitTransferWithBin(args), to]) as Promise<{
        signature: string;
      }>;
    };

    let lastErr: unknown = null;
    for (let i = 1; i <= 1 + retries; i++) {
      try {
        return await attemptOnce(i);
      } catch (e) {
        lastErr = e;
        if (i <= retries) await new Promise((r) => setTimeout(r, 500 * i));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  async submitWithdrawWithBin(args: WithdrawBinArgs) {
    expectLen("withdraw.proofBytes", args.proofBytes, 256);
    expectLen("withdraw.publicInputsBytes", args.publicInputsBytes, 7 * 32);
    const mint = new web3.PublicKey(args.tokenMint);
    const sig = await this.txm.submitShieldedWithdrawAtomicBytes({
      mint,
      proofBytes: args.proofBytes,
      publicInputsBytes: args.publicInputsBytes,
    });
    return { signature: sig };
  }

  async submitWithdrawWithin(
    args: WithdrawBinArgs,
    opts: SubmitWithinOpts = {},
  ): Promise<{ signature: string }> {
    const timeoutMs = opts.timeoutMs ?? 25_000;
    const retries = Math.max(0, opts.retries ?? 1);

    const attemptOnce = async (attempt: number) => {
      await opts.onAttempt?.(attempt);
      const to = new Promise<never>((_, rej) => {
        const t = setTimeout(() => {
          clearTimeout(t);
          rej(
            new Error(
              `submitWithdrawWithin: attempt ${attempt} timed out after ${timeoutMs} ms`,
            ),
          );
        }, timeoutMs);
      });
      return Promise.race([this.submitWithdrawWithBin(args), to]) as Promise<{
        signature: string;
      }>;
    };

    let lastErr: unknown = null;
    for (let i = 1; i <= 1 + retries; i++) {
      try {
        return await attemptOnce(i);
      } catch (e) {
        lastErr = e;
        if (i <= retries) await new Promise((r) => setTimeout(r, 500 * i));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  // ---------- Event plumbing ----------
  async startListeners() {
    if (!this.store) {
      const pool = await getPool();
      this.store = new MySqlMerkleStore(pool);
    }

    const idlEvents = (this.program.idl as any)?.events?.map((e: any) => e.name) || [];
    console.log("[events] IDL Events:", idlEvents);

    // (A) Robust path: parse events from logs with Anchor's EventParser
    if (this.onLogsSubId === null) {
      const parser = new anchor.EventParser(this.program.programId, this.program.coder);
      this.onLogsSubId = this.provider.connection.onLogs(
        this.program.programId,
        async (l) => {
          try {
            console.log(
              "[onLogs] signature:",
              (l as any).signature,
              "slot:",
              (l as any).slot,
            );
            for (const m of l.logs) console.log("   ", m);

            for (const ev of parser.parseLogs(l.logs) ?? []) {
              if (ev.name === "depositCompleted" || ev.name === "DepositCompleted") {
                const payload = toPayload(ev.data);
                await debugEventBlock(this.store!, payload);
                await this.store!.recordDepositCompleted(TREE_ID, payload);
                console.info("[events] DepositCompleted persisted from onLogs", {
                  leafIndex: payload.next_leaf_index,
                  mint: payload.mint,
                });
              } else if (ev.name === "transferCompleted" || ev.name === "TransferCompleted") {
                const payload = toTransferPayload(ev.data);
                await this.store!.recordTransferCompleted!(TREE_ID, payload);
                console.info("[events] TransferCompleted persisted from onLogs", {
                  nextLeafIndex: payload.next_leaf_index,
                  mint: payload.mint,
                });
              } else if (ev.name === "withdrawCompleted" || ev.name === "WithdrawCompleted") {
                const payload = toWithdrawPayload(ev.data);
                try {
                  await this.store!.recordWithdrawCompleted?.(TREE_ID, payload);
                } catch (e: any) {
                  console.warn("[events] recordWithdrawCompleted hook error:", e?.message || e);
                }
                console.info("[events] WithdrawCompleted observed from onLogs", {
                  mint: payload.mint,
                  nullifier_hex_LE: hex(payload.nullifier),
                  old_root_BE_hex: hex(viewBE(payload.old_merkle_root)),
                });
              }
            }
          } catch (e: any) {
            console.error("[onLogs] parse/persist error:", e?.message || e);
          }
        },
        "processed",
      );
      console.log("[events] onLogs parser attached:", this.onLogsSubId);
    }

    // (B) Optional: keep Anchor's addEventListener too
    if (this.depositListenerId === null) {
      this.depositListenerId = await this.program.addEventListener(
        "DepositCompleted",
        async (ev: any, slot: number, sig?: string) => {
          try {
            const payload = toPayload(ev);
            await debugEventBlock(this.store!, payload);
            await this.store!.recordDepositCompleted(TREE_ID, payload);
            console.info("[events] DepositCompleted persisted (anchor listener)", {
              slot,
              sig,
            });
          } catch (e: any) {
            console.error(
              "[events] DepositCompleted handler error:",
              e?.message || e,
            );
          }
        },
        "processed",
      );
      console.log("[events] DepositCompleted listener started:", this.depositListenerId);
    }

    // (C) TransferCompleted listener (optional alongside onLogs)
    if (this.transferListenerId === null) {
      this.transferListenerId = await this.program.addEventListener(
        "TransferCompleted",
        async (ev: any, slot: number, sig?: string) => {
          try {
            const payload = toTransferPayload(ev);
            await this.store!.recordTransferCompleted!(TREE_ID, payload);
            console.info("[events] TransferCompleted persisted (anchor listener)", {
              slot,
              sig,
            });
          } catch (e: any) {
            console.error(
              "[events] TransferCompleted handler error:",
              e?.message || e,
            );
          }
        },
        "processed",
      );
      console.log("[events] TransferCompleted listener started:", this.transferListenerId);
    }
  }

  async stopListeners() {
    if (this.depositListenerId !== null) {
      await this.program.removeEventListener(this.depositListenerId);
      this.depositListenerId = null;
      console.log("[events] DepositCompleted listener stopped");
    }
    if (this.transferListenerId !== null) {
      await this.program.removeEventListener(this.transferListenerId);
      this.transferListenerId = null;
      console.log("[events] TransferCompleted listener stopped");
    }
    if (this.onLogsSubId !== null) {
      await this.provider.connection.removeOnLogsListener(this.onLogsSubId);
      this.onLogsSubId = null;
      console.log("[events] onLogs parser detached");
    }
  }
}

export const solanaRelayer = new SolanaRelayer();

// Auto-start listeners (keep this)
if (process.env.RELAYER_AUTO_LISTEN !== "0") {
  solanaRelayer.startListeners().catch((e) => {
    console.error("[events] failed to start listeners:", e?.message || e);
  });
}
