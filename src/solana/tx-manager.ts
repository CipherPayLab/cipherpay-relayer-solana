/* ESM */
// src/solana/tx-manager.ts
import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { shouldAttemptAutoAirdrop } from "@/solana/airdrop-policy.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  ACCOUNT_SIZE as TOKEN_ACCOUNT_SIZE,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  createTransferCheckedInstruction,
  getAccount,
  getMint,
} from "@solana/spl-token";

const TREE_SEED = Buffer.from("tree");
const ROOT_CACHE_SEED = Buffer.from("root_cache");
const VAULT_SEED = Buffer.from("vault");
const DEPOSIT_SEED = Buffer.from("deposit");
const NULLIFIER_SEED = Buffer.from("nullifier");

const MEMO_PROGRAM_ID = new PublicKey(
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"
);

type AnchorCtx = {
  program: anchor.Program<any>;
  provider: anchor.AnchorProvider;
  connection: anchor.web3.Connection;
};

function pda(seeds: (Buffer | Uint8Array)[], programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}
function bn(x: number | bigint | BN): BN {
  // @ts-ignore
  if (BN.isBN?.(x)) return x as BN;
  return new BN(x.toString(), 10);
}
function slice32(buf: Buffer, i: number): Buffer {
  const off = i * 32;
  return buf.subarray(off, off + 32);
}
function hexLE32(buf: Buffer): string {
  return Buffer.from(buf).toString("hex");
}

export default class TxManager {
  private readonly program: anchor.Program<any>;
  private readonly provider: anchor.AnchorProvider;
  private readonly connection: anchor.web3.Connection;
  private readonly programId: PublicKey;

  constructor(ctx: AnchorCtx) {
    this.program = ctx.program;
    this.provider = ctx.provider;
    this.connection = ctx.connection;
    this.programId = this.program.programId;
  }

  private async ensurePayerFunds(minLamports = 60_000_000): Promise<void> {
    const payer = this.provider.wallet.publicKey;
    const bal = await this.connection.getBalance(payer, {
      commitment: "confirmed",
    });
    if (bal >= minLamports) return;

    const rpc = this.connection.rpcEndpoint;
    if (!shouldAttemptAutoAirdrop(rpc)) {
      throw new Error(
        `Relayer wallet ${payer.toBase58()} has insufficient SOL: balance=${bal} lamports, ` +
          `need>=${minLamports}. Fund the key used by ANCHOR_WALLET (or default ~/.config/solana/id.json). ` +
          `For local validator only, airdrop is used automatically. To allow public cluster faucets ` +
          `(devnet/testnet; subject to rate limits), set RELAYER_ALLOW_AUTO_AIRDROP=1.`
      );
    }

    const want = Math.max(120_000_000, minLamports * 2);
    const sig = await this.connection.requestAirdrop(payer, want);
    await this.connection.confirmTransaction(sig, "confirmed");

    const bal2 = await this.connection.getBalance(payer, {
      commitment: "confirmed",
    });
    if (bal2 < minLamports) {
      throw new Error(
        `Airdrop failed: balance=${bal2}, needed>=${minLamports}`
      );
    }
  }

  private async getMintDecimals(mint: PublicKey): Promise<number> {
    if (mint.equals(NATIVE_MINT)) return 9;
    const mi = await getMint(this.connection, mint, "confirmed");
    return mi.decimals;
  }

  private memoIxUtf8(s: string): TransactionInstruction {
    return new TransactionInstruction({
      keys: [],
      programId: MEMO_PROGRAM_ID,
      data: Buffer.from(s, "utf8"),
    });
  }

  private async accountExists(pubkey: PublicKey): Promise<boolean> {
    const ai = await this.connection.getAccountInfo(pubkey, "confirmed");
    return !!ai;
  }

  private async sendIxs(ixs: TransactionInstruction[]) {
    if (ixs.length === 0) return;
    const tx = new anchor.web3.Transaction().add(...ixs);
    await this.provider.sendAndConfirm(tx, [], { commitment: "confirmed" });
  }

  private async maybeInitRootCacheIx(
    rootCachePda: PublicKey,
    payer: PublicKey
  ) {
    const ai = await this.connection.getAccountInfo(rootCachePda, "confirmed");
    if (ai) return null;
    return await (this.program as any).methods
      .initializeRootCache()
      .accountsPartial({
        rootCache: rootCachePda,
        authority: payer,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  /** Vault ATA + root cache only. Deposits are always user-delegate funded (no relayer token ATA). */
  private async buildDepositVaultSetupIxs(
    payer: PublicKey,
    mint: PublicKey,
    vaultOwnerPda: PublicKey,
    rootCachePda: PublicKey
  ): Promise<{
    ixs: TransactionInstruction[];
    vaultAta: PublicKey;
  }> {
    const ixs: TransactionInstruction[] = [];

    const vaultAta = getAssociatedTokenAddressSync(
      mint,
      vaultOwnerPda,
      true,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const initRoot = await this.maybeInitRootCacheIx(rootCachePda, payer);
    if (initRoot) ixs.push(initRoot);

    if (!(await this.accountExists(vaultAta))) {
      ixs.push(
        createAssociatedTokenAccountIdempotentInstruction(
          payer,
          vaultAta,
          vaultOwnerPda,
          mint,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      );
    }

    return { ixs, vaultAta };
  }

  /** Idempotently ensure root cache + both ATAs (vault & recipient) exist for withdraw. */
  private async buildWithdrawSetupIxs(
    payer: PublicKey,
    mint: PublicKey,
    vaultOwnerPda: PublicKey,
    rootCachePda: PublicKey,
    recipientOwner?: PublicKey
  ): Promise<{
    ixs: TransactionInstruction[];
    recipientAta: PublicKey;
    vaultAta: PublicKey;
  }> {
    const ixs: TransactionInstruction[] = [];

    const recipientOwnerKey = recipientOwner || payer;
    const recipientAta = getAssociatedTokenAddressSync(
      mint,
      recipientOwnerKey,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    const vaultAta = getAssociatedTokenAddressSync(
      mint,
      vaultOwnerPda,
      true,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const initRoot = await this.maybeInitRootCacheIx(rootCachePda, payer);
    if (initRoot) ixs.push(initRoot);

    if (!(await this.accountExists(recipientAta))) {
      ixs.push(
        createAssociatedTokenAccountIdempotentInstruction(
          payer,
          recipientAta,
          recipientOwnerKey,
          mint,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      );
    }
    if (!(await this.accountExists(vaultAta))) {
      ixs.push(
        createAssociatedTokenAccountIdempotentInstruction(
          payer,
          vaultAta,
          vaultOwnerPda,
          mint,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      );
    }

    return { ixs, recipientAta, vaultAta };
  }

  /**
   * Submit deposit with **binary** proof + publics.
   * Funds always come from the user's token ATA via SPL delegate (relayer signs as delegate).
   */
  async submitShieldedDepositAtomicBytes(args: {
    mint: PublicKey;
    amount: bigint | number | BN;
    proofBytes: Buffer;
    publicInputsBytes: Buffer;
    source: {
      sourceOwner: PublicKey;
      sourceTokenAccount: PublicKey;
    };
  }): Promise<string> {
    const payer = this.provider.wallet.publicKey;

    if (args.proofBytes.length !== 256) {
      throw new Error(
        `proofBytes must be 256 bytes, got ${args.proofBytes.length}`
      );
    }
    if (args.publicInputsBytes.length !== 7 * 32) {
      throw new Error(
        `publicInputsBytes must be 224 bytes, got ${args.publicInputsBytes.length}`
      );
    }

    const depositHashBytes = slice32(args.publicInputsBytes, 5);
    const depositHashHexLE = hexLE32(depositHashBytes);

    const rentAta = await this.connection.getMinimumBalanceForRentExemption(
      TOKEN_ACCOUNT_SIZE
    );
    const amountBN = bn(args.amount);
    const cushion = 40_000_000;
    // Relayer pays tx fees + vault ATA rent if needed, not the deposit amount.
    const minNeeded = rentAta * 2 + cushion + 10_000_000;
    await this.ensurePayerFunds(minNeeded);

    const treePda = pda([TREE_SEED], this.programId);
    const rootCachePda = pda([ROOT_CACHE_SEED], this.programId);
    const vaultOwnerPda = pda([VAULT_SEED], this.programId);
    const depositMarkerPda = pda(
      [DEPOSIT_SEED, depositHashBytes],
      this.programId
    );

    const mintDecimals = await this.getMintDecimals(args.mint);

    // Stage A — vault ATA + root cache (relayer pays rent creation if needed)
    const { ixs: setupIxs, vaultAta } = await this.buildDepositVaultSetupIxs(
      payer,
      args.mint,
      vaultOwnerPda,
      rootCachePda
    );

    await this.sendIxs(setupIxs);

    const src = args.source;

    // Stage B — transfer from user ATA (delegate) → vault
    const preIxs: TransactionInstruction[] = [];

    if (amountBN.gt(new BN(0))) {
      const srcAcc = await getAccount(
        this.connection,
        src.sourceTokenAccount,
        "confirmed"
      );
      if (!srcAcc.owner.equals(src.sourceOwner)) {
        throw new Error("sourceTokenAccount.owner mismatch with sourceOwner");
      }
      if (!srcAcc.mint.equals(args.mint)) {
        throw new Error("sourceTokenAccount.mint mismatch with tokenMint");
      }
      if (!srcAcc.delegate || !srcAcc.delegate.equals(payer)) {
        throw new Error("sourceTokenAccount.delegate is not the relayer wallet");
      }
      const delegated = BigInt(srcAcc.delegatedAmount.toString());
      if (delegated < BigInt(amountBN.toString())) {
        throw new Error(
          `delegatedAmount ${delegated} < required ${amountBN.toString()}`
        );
      }

      preIxs.push(
        createTransferCheckedInstruction(
          src.sourceTokenAccount,
          args.mint,
          vaultAta,
          payer,
          BigInt(amountBN.toString()),
          mintDecimals
        )
      );
    }

    // Memo matches anchor test
    preIxs.push(this.memoIxUtf8("deposit:" + depositHashHexLE));

    const userTokenAccount = src.sourceTokenAccount;

    const run = () =>
      (this.program as any).methods
        .shieldedDepositAtomic(
          depositHashBytes,
          args.proofBytes,
          args.publicInputsBytes
        )
        .accountsPartial({
          payer,
          tree: treePda,
          rootCache: rootCachePda,
          depositMarker: depositMarkerPda,
          vaultPda: vaultOwnerPda,
          vaultTokenAccount: vaultAta,
          userTokenAccount,  // SECURITY: Source account for transfer verification
          tokenMint: args.mint,
          instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
        .preInstructions(preIxs)
        .rpc();

    try {
      return await run();
    } catch (e: any) {
      const m = String(e?.message ?? "");
      if (
        m.includes("insufficient lamports") ||
        m.includes("custom program error: 0x1")
      ) {
        await this.ensurePayerFunds(minNeeded + 80_000_000);
        return await run();
      }
      throw e;
    }
  }

  async submitShieldedTransferAtomicBytes(args: {
    mint: PublicKey;
    proofBytes: Buffer; // 256 bytes
    publicInputsBytes: Buffer; // 9*32 bytes
    computeUnitLimit?: number;
  }): Promise<string> {
    const payer = this.provider.wallet.publicKey;

    if (args.proofBytes.length !== 256) {
      throw new Error(
        `proofBytes must be 256 bytes, got ${args.proofBytes.length}`
      );
    }
    if (args.publicInputsBytes.length !== 9 * 32) {
      throw new Error(
        `publicInputsBytes must be 288 bytes, got ${args.publicInputsBytes.length}`
      );
    }

    const nullifierBuf = slice32(args.publicInputsBytes, 2);

    const treePda = pda([TREE_SEED], this.programId);
    const rootCachePda = pda([ROOT_CACHE_SEED], this.programId);
    const nullifierRecordPda = pda(
      [NULLIFIER_SEED, nullifierBuf],
      this.programId
    );

    const setupIxs: TransactionInstruction[] = [];
    const initRoot = await this.maybeInitRootCacheIx(rootCachePda, payer);
    if (initRoot) setupIxs.push(initRoot);

    const cu = Number(process.env.CU_LIMIT ?? 800_000);
    const cuIx = ComputeBudgetProgram.setComputeUnitLimit({
      units: args.computeUnitLimit ?? cu,
    });

    const anchorIx = await (this.program as any).methods
      .shieldedTransfer(nullifierBuf, args.proofBytes, args.publicInputsBytes)
      .accountsPartial({
        payer,
        tree: treePda,
        rootCache: rootCachePda,
        nullifierRecord: nullifierRecordPda,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const tx = new anchor.web3.Transaction();
    if (setupIxs.length) tx.add(...setupIxs);
    tx.add(cuIx, anchorIx);

    const sig = await this.provider.sendAndConfirm(tx, [], {
      skipPreflight: false,
      commitment: "confirmed",
    });
    return sig;
  }

  /**
   * Withdraw (no delegate required). Recipient is the payer by default.
   */
  async submitShieldedWithdrawAtomicBytes(args: {
    mint: PublicKey;
    proofBytes: Buffer; // 256
    publicInputsBytes: Buffer; // 7 * 32  (NULLIFIER, ROOT, OWNER_LO, OWNER_HI, RECIPIENT_PK, AMOUNT, TOKEN_ID)
    computeUnitLimit?: number;
    target?: {
      recipientOwner?: string; // base58
      recipientTokenAccount?: string; // base58
    };
  }): Promise<string> {
    const payer = this.provider.wallet.publicKey;

    if (args.proofBytes.length !== 256) {
      throw new Error(
        `proofBytes must be 256 bytes, got ${args.proofBytes.length}`
      );
    }
    if (args.publicInputsBytes.length !== 7 * 32) {
      throw new Error(
        `publicInputsBytes must be 224 bytes, got ${args.publicInputsBytes.length}`
      );
    }

    const nullifierBuf = slice32(args.publicInputsBytes, 0);
    const nullifierHexLE = hexLE32(nullifierBuf);

    const rootCachePda = pda([ROOT_CACHE_SEED], this.programId);
    const vaultOwnerPda = pda([VAULT_SEED], this.programId);
    const nullifierPda = pda([NULLIFIER_SEED, nullifierBuf], this.programId);

    // Use provided recipientOwner or fall back to payer
    const recipientOwner = args.target?.recipientOwner
      ? new PublicKey(args.target.recipientOwner)
      : payer;

    const {
      ixs: setupIxs,
      recipientAta: derivedRecipientAta,
      vaultAta,
    } = await this.buildWithdrawSetupIxs(
      payer,
      args.mint,
      vaultOwnerPda,
      rootCachePda,
      recipientOwner
    );

    // Use provided recipientTokenAccount or the derived one
    let recipientAta: PublicKey;
    if (args.target?.recipientTokenAccount) {
      recipientAta = new PublicKey(args.target.recipientTokenAccount);
      // Ensure the provided ATA matches the derived one
      if (!derivedRecipientAta.equals(recipientAta)) {
        throw new Error(
          `recipientTokenAccount mismatch: provided ${recipientAta.toBase58()}, ` +
          `but derived ${derivedRecipientAta.toBase58()} for recipientOwner ${recipientOwner.toBase58()}`
        );
      }
    } else {
      recipientAta = derivedRecipientAta;
    }

    const cuUnits = Number(process.env.CU_LIMIT ?? 800_000);
    const cuIx = ComputeBudgetProgram.setComputeUnitLimit({
      units: args.computeUnitLimit ?? cuUnits,
    });
    const memoIx = this.memoIxUtf8("withdraw:" + nullifierHexLE);

    const anchorIx = await (this.program as any).methods
      .shieldedWithdraw(nullifierBuf, args.proofBytes, args.publicInputsBytes)
      .accountsPartial({
        payer,
        rootCache: rootCachePda,
        nullifierRecord: nullifierPda,
        vaultPda: vaultOwnerPda,
        vaultTokenAccount: vaultAta,
        recipientOwner: recipientOwner,
        recipientTokenAccount: recipientAta,
        tokenMint: args.mint,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .instruction();

    const tx = new anchor.web3.Transaction();
    if (setupIxs.length) tx.add(...setupIxs);
    tx.add(cuIx, memoIx, anchorIx);

    const sig = await this.provider.sendAndConfirm(tx, [], {
      skipPreflight: false,
      commitment: "confirmed",
    });
    return sig;
  }
}
