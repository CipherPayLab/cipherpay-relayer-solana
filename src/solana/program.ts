// src/solana/program.ts
import fs from "node:fs";
import path from "node:path";
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { AnchorProvider, Program, Wallet, Idl } from "@coral-xyz/anchor";
import type { CipherpayAnchor } from "../types/cipherpay_anchor.js";
import { loadEnv } from "@/services/config/env.js";
import { shouldAttemptAutoAirdrop } from "@/solana/airdrop-policy.js";

type AnyIdl = Record<string, any>;

function readJson(idlPath: string): AnyIdl {
  const abs = path.resolve(idlPath);
  const raw = fs.readFileSync(abs, "utf8");
  const idl = JSON.parse(raw);
  if (!idl || typeof idl !== "object" || !Array.isArray(idl.instructions)) {
    throw new Error(`IDL at ${abs} is invalid (missing instructions[])`);
  }
  return idl as AnyIdl;
}

function stripAccounts(idl: AnyIdl): AnyIdl {
  if (Array.isArray(idl.accounts) && idl.accounts.length) {
    const names = idl.accounts.map((a: any) => a?.name).filter(Boolean);
    console.warn(
      `Anchor accounts namespace disabled to avoid size computation errors; stripped accounts: ${names.join(", ")}`
    );
  }
  const { accounts: _drop, ...rest } = idl;
  return rest;
}

/** Small helper: fund the provider if it has little/no SOL. */
async function ensureProviderFunds(connection: Connection, pubkey: PublicKey) {
  try {
    const bal = await connection.getBalance(pubkey, "confirmed");
    if (bal >= 0.5 * LAMPORTS_PER_SOL) return;

    if (!shouldAttemptAutoAirdrop(connection.rpcEndpoint)) {
      console.warn(
        `Skipping auto-airdrop for ${pubkey.toBase58()}: fund this wallet manually, ` +
          `or set RELAYER_ALLOW_AUTO_AIRDROP=1 (non-local RPC).`
      );
      return;
    }

    // Airdrop on local validator by default; devnet/testnet only if explicitly allowed.
    const sig = await connection.requestAirdrop(pubkey, 2 * LAMPORTS_PER_SOL);
    const bh = await connection.getLatestBlockhash();
    await connection.confirmTransaction({ signature: sig, ...bh }, "confirmed");

    const after = await connection.getBalance(pubkey, "confirmed");
    console.log(
      `Airdropped 2 SOL to provider ${pubkey.toBase58()} — balance: ${(after / LAMPORTS_PER_SOL).toFixed(3)} SOL`
    );
  } catch (e) {
    // Ignore on mainnet or if faucet not available; just log for visibility.
    console.warn("Airdrop skipped/failed (likely mainnet or faucet down):", (e as Error)?.message || e);
  }
}

export class SolanaProgram {
  public readonly program?: Program<CipherpayAnchor>;
  public readonly provider: AnchorProvider;
  public readonly connection: Connection;
  public readonly programId: PublicKey;

  private constructor(
    connection: Connection,
    provider: AnchorProvider,
    programId: PublicKey,
    program?: Program<CipherpayAnchor>
  ) {
    this.connection = connection;
    this.provider = provider;
    this.programId = programId;
    this.program = program;
  }

  static async create(): Promise<SolanaProgram> {
    const env = loadEnv();

    const rpcUrl = env.rpcUrl || env.solanaRpcUrl || "https://api.devnet.solana.com";
    const connection = new Connection(rpcUrl, { commitment: "confirmed" });

    // Random dev wallet (replace with a real one in prod).
    const wallet = new Wallet(Keypair.generate());
    const provider = new AnchorProvider(connection, wallet, {
      commitment: "confirmed",
      preflightCommitment: "confirmed",
    });

    // 🔋 Ensure it has some SOL for fees/ATA rent on local/dev clusters.
    await ensureProviderFunds(connection, provider.publicKey);

    const programIdStr = env.programId;
    if (!programIdStr) throw new Error("PROGRAM_ID is missing in environment");
    const programId = new PublicKey(programIdStr);

    const idlPath = env.idlPath;
    const idl = readJson(idlPath);
    const idlLite = stripAccounts(idl);

    const program = new Program<CipherpayAnchor>(idlLite as Idl, provider);
    return new SolanaProgram(connection, provider, programId, program);
  }

  // PDA helpers
  getTreePDA(): PublicKey {
    return PublicKey.findProgramAddressSync([Buffer.from("tree")], this.programId)[0];
  }
  getVaultPDA(mint: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync([Buffer.from("vault"), mint.toBuffer()], this.programId)[0];
  }
  getRootCachePDA(): PublicKey {
    return PublicKey.findProgramAddressSync([Buffer.from("root_cache")], this.programId)[0];
  }
  getNullifierPDA(nullifier: Buffer): PublicKey {
    return PublicKey.findProgramAddressSync([Buffer.from("nullifier"), nullifier], this.programId)[0];
  }
  getDepositMarkerPDA(depositHash: Buffer): PublicKey {
    return PublicKey.findProgramAddressSync([Buffer.from("deposit"), depositHash], this.programId)[0];
  }
}
