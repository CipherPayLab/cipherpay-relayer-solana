/* ESM */
// src/server/routes/submit.ts
import { Router } from "express";
import { ProofVerifier } from "@/zk/proof-verifier.js";
import { solanaRelayer } from "@/services/solana-relayer.js";

// --- BN254 prime and helpers (mirror circuits converter) ---
const FQ =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

function asBig(v: any): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(v);
  if (typeof v === "string") {
    const s = v.trim();
    return s.startsWith("0x") || s.startsWith("0X") ? BigInt(s) : BigInt(s);
  }
  if (Array.isArray(v) && v.length === 1) return asBig(v[0]);
  throw new Error(`Cannot parse BigInt from: ${JSON.stringify(v)}`);
}
function normFq(x: any): bigint {
  let n = asBig(x) % FQ;
  if (n < 0n) n += FQ;
  return n;
}
function le32(x: any): Buffer {
  let v = normFq(x);
  const b = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) {
    b[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return b;
}
function encG1(p: any): Buffer {
  const arr = Array.isArray(p) ? p : [p.x, p.y];
  return Buffer.concat([le32(arr[0]), le32(arr[1])]);
}
function encG2(p: any): Buffer {
  let x0, x1, y0, y1;
  if (Array.isArray(p)) {
    if (p.length === 4 && !Array.isArray(p[0])) {
      [x0, x1, y0, y1] = p;
    } else if (Array.isArray(p[0]) && Array.isArray(p[1])) {
      [x0, x1] = p[0];
      [y0, y1] = p[1];
    } else {
      throw new Error(`Unrecognized G2 shape: ${JSON.stringify(p)}`);
    }
  } else if (p && typeof p === "object" && p.x && p.y) {
    [x0, x1] = p.x;
    [y0, y1] = p.y;
  } else {
    throw new Error(`Unrecognized G2 shape: ${JSON.stringify(p)}`);
  }
  return Buffer.concat([le32(x0), le32(x1), le32(y0), le32(y1)]);
}
function proofJsonToBin(proof: any): Buffer {
  if (!proof?.pi_a || !proof?.pi_b || !proof?.pi_c) {
    throw new Error("Malformed proof JSON");
  }
  return Buffer.concat([
    encG1(proof.pi_a),
    encG2(proof.pi_b),
    encG1(proof.pi_c),
  ]);
}
function publicsToBin(publicSignals: any[]): Buffer {
  return Buffer.concat(publicSignals.map(le32));
}
function slice32(buf: Buffer, i: number): Buffer {
  const o = i * 32;
  return buf.subarray(o, o + 32);
}
function hexLE32(buf: Buffer): string {
  return Buffer.from(buf).toString("hex");
}

export const submit = Router();

/* -------------------- DEPOSIT -------------------- */

// POST /api/v1/submit/deposit
// Required: sourceTokenAccount (user ATA). Optional: sourceOwner (else resolved on-chain).
submit.post("/deposit", async (req, res) => {
  const requestId = (req as any).requestId || "";
  try {
    console.info(
      JSON.stringify({
        level: "info",
        component: "app",
        requestId,
        method: "POST",
        path: "/api/v1/submit/deposit",
        ip: req.ip,
        msg: "Deposit operation initiated",
      })
    );

    const {
      amount,
      tokenMint,
      proof,
      publicSignals,
      proofBytes,
      publicInputsBytes,
      sourceOwner,
      sourceTokenAccount,
    } = req.body || {};

    if (!amount || !tokenMint) {
      return res
        .status(400)
        .json({
          ok: false,
          error: "BadRequest",
          message: "amount and tokenMint required",
        });
    }

    if (!sourceTokenAccount || String(sourceTokenAccount).trim() === "") {
      return res.status(400).json({
        ok: false,
        error: "BadRequest",
        message:
          "sourceTokenAccount required (user token ATA; deposits are SPL-delegate only)",
      });
    }

    let proofBin: Buffer;
    let publicsBin: Buffer;

    if (proof && publicSignals) {
      if (process.env.SKIP_LOCAL_VK !== "1") {
        const pv = new ProofVerifier();
        await pv.verify("deposit", proof, publicSignals);
      }
      proofBin = proofJsonToBin(proof);
      publicsBin = publicsToBin(publicSignals);
    } else if (proofBytes && publicInputsBytes) {
      proofBin = Buffer.isBuffer(proofBytes)
        ? proofBytes
        : Buffer.from(
            proofBytes,
            (proofBytes as any).startsWith?.("0x") ? "hex" : "base64"
          );
      publicsBin = Buffer.isBuffer(publicInputsBytes)
        ? publicInputsBytes
        : Buffer.from(
            publicInputsBytes,
            (publicInputsBytes as any).startsWith?.("0x") ? "hex" : "base64"
          );
    } else {
      return res.status(400).json({
        ok: false,
        error: "BadRequest",
        message:
          "Provide (proof, publicSignals) or (proofBytes, publicInputsBytes)",
      });
    }

    if (proofBin.length !== 256) {
      return res
        .status(400)
        .json({
          ok: false,
          error: "BadProofSize",
          message: `proofBytes must be 256 bytes, got ${proofBin.length}`,
        });
    }
    if (publicsBin.length !== 7 * 32) {
      return res
        .status(400)
        .json({
          ok: false,
          error: "BadPublicsSize",
          message: `publicInputsBytes must be 224 bytes, got ${publicsBin.length}`,
        });
    }

    const depHashLE = hexLE32(slice32(publicsBin, 5));
    console.log({
      proofBytes0_32: hexLE32(slice32(proofBin, 0)),
      publics5_hash_hex: depHashLE,
      sourceOwner,
      sourceTokenAccount,
    });

    const relayerArgs: any = {
      amount: BigInt(amount),
      tokenMint,
      proofBytes: proofBin,
      publicInputsBytes: publicsBin,
      source: {
        ...(sourceOwner ? { sourceOwner } : {}),
        sourceTokenAccount,
      },
    };

    const out = await (solanaRelayer as any).submitDepositWithBin(relayerArgs);

    return res.json({ ok: true, signature: out.signature });
  } catch (e: any) {
    console.error("API Error:", e);
    return res.status(500).json({
      ok: false,
      error: "SolanaTransactionError",
      message: e?.message || String(e),
    });
  }
});

/* -------------------- TRANSFER -------------------- */

// Publics: 0 OUT1, 1 OUT2, 2 NULLIFIER, 3 MERKLE_ROOT, 4 NEW_ROOT1, 5 NEW_ROOT2, 6 NEW_NEXT_IDX, 7 ENC1, 8 ENC2
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

submit.post("/transfer", async (req, res) => {
  const requestId = (req as any).requestId || "";
  try {
    console.info(
      JSON.stringify({
        level: "info",
        component: "app",
        requestId,
        method: "POST",
        path: "/api/v1/submit/transfer",
        ip: req.ip,
        msg: "Transfer operation initiated",
      })
    );

    const { tokenMint, proof, publicSignals, proofBytes, publicInputsBytes } =
      req.body || {};

    if (!tokenMint) {
      return res
        .status(400)
        .json({
          ok: false,
          error: "BadRequest",
          message: "tokenMint required",
        });
    }

    let proofBin: Buffer;
    let publicsBin: Buffer;

    if (proof && publicSignals) {
      if (process.env.SKIP_LOCAL_VK !== "1") {
        const pv = new ProofVerifier();
        await pv.verify("transfer", proof, publicSignals);
      }
      proofBin = proofJsonToBin(proof);
      publicsBin = publicsToBin(publicSignals);
    } else if (proofBytes && publicInputsBytes) {
      proofBin = Buffer.isBuffer(proofBytes)
        ? proofBytes
        : Buffer.from(
            proofBytes,
            (proofBytes as any).startsWith?.("0x") ? "hex" : "base64"
          );
      publicsBin = Buffer.isBuffer(publicInputsBytes)
        ? publicInputsBytes
        : Buffer.from(
            publicInputsBytes,
            (publicInputsBytes as any).startsWith?.("0x") ? "hex" : "base64"
          );
    } else {
      return res.status(400).json({
        ok: false,
        error: "BadRequest",
        message:
          "Provide (proof, publicSignals) or (proofBytes, publicInputsBytes)",
      });
    }

    if (proofBin.length !== 256) {
      return res
        .status(400)
        .json({
          ok: false,
          error: "BadProofSize",
          message: `proofBytes must be 256 bytes, got ${proofBin.length}`,
        });
    }
    if (publicsBin.length !== 9 * 32) {
      return res
        .status(400)
        .json({
          ok: false,
          error: "BadPublicsSize",
          message: `publicInputsBytes must be 288 bytes, got ${publicsBin.length}`,
        });
    }

    const nullifierLE = hexLE32(slice32(publicsBin, PS.NULLIFIER));
    const spentRootLE = hexLE32(slice32(publicsBin, PS.MERKLE_ROOT));
    const newRoot1LE = hexLE32(slice32(publicsBin, PS.NEW_ROOT1));
    const newRoot2LE = hexLE32(slice32(publicsBin, PS.NEW_ROOT2));
    console.log({
      proofBytes0_32: hexLE32(slice32(proofBin, 0)),
      nullifier_hex: nullifierLE,
      spent_root_hex: spentRootLE,
      new_root1_hex: newRoot1LE,
      new_root2_hex: newRoot2LE,
    });

    const out = await solanaRelayer.submitTransferWithBin({
      tokenMint,
      proofBytes: proofBin,
      publicInputsBytes: publicsBin,
    });

    return res.json({ ok: true, signature: out.signature });
  } catch (e: any) {
    console.error("API Error:", e);
    return res.status(500).json({
      ok: false,
      error: "SolanaTransactionError",
      message: e?.message || String(e),
    });
  }
});

/* -------------------- WITHDRAW -------------------- */

// Public signals (withdraw) — NEW ORDER (7):
// 0 NULLIFIER
// 1 MERKLE_ROOT
// 2 RECIPIENT_OWNER_LO   (LE limb in low 16 bytes; upper 16 zero)
// 3 RECIPIENT_OWNER_HI   (LE limb in low 16 bytes; upper 16 zero)
// 4 RECIPIENT_WALLET_PUBKEY (32-byte Solana PK as a field element LE)
// 5 AMOUNT
// 6 TOKEN_ID
const W_PS = {
  NULLIFIER: 0,
  MERKLE_ROOT: 1,
  RECIPIENT_OWNER_LO: 2,
  RECIPIENT_OWNER_HI: 3,
  RECIPIENT_PK: 4,
  AMOUNT: 5,
  TOKEN_ID: 6,
} as const;

// POST /api/v1/submit/withdraw
// Optional extras (strings):
// - recipientOwner: base58
// - recipientTokenAccount: base58
submit.post("/withdraw", async (req, res) => {
  const requestId = (req as any).requestId || "";
  try {
    console.info(
      JSON.stringify({
        level: "info",
        component: "app",
        requestId,
        method: "POST",
        path: "/api/v1/submit/withdraw",
        ip: req.ip,
        msg: "Withdraw operation initiated",
      })
    );

    const {
      tokenMint,
      proof,
      publicSignals,
      proofBytes,
      publicInputsBytes,
      // NEW (optional)
      recipientOwner,
      recipientTokenAccount,
    } = req.body || {};

    if (!tokenMint) {
      return res
        .status(400)
        .json({
          ok: false,
          error: "BadRequest",
          message: "tokenMint required",
        });
    }

    let proofBin: Buffer;
    let publicsBin: Buffer;

    if (proof && publicSignals) {
      if (process.env.SKIP_LOCAL_VK !== "1") {
        const pv = new ProofVerifier();
        await pv.verify("withdraw", proof, publicSignals);
      }
      proofBin = proofJsonToBin(proof);
      publicsBin = publicsToBin(publicSignals);
    } else if (proofBytes && publicInputsBytes) {
      proofBin = Buffer.isBuffer(proofBytes)
        ? proofBytes
        : Buffer.from(
            proofBytes,
            (proofBytes as any).startsWith?.("0x") ? "hex" : "base64"
          );
      publicsBin = Buffer.isBuffer(publicInputsBytes)
        ? publicInputsBytes
        : Buffer.from(
            publicInputsBytes,
            (publicInputsBytes as any).startsWith?.("0x") ? "hex" : "base64"
          );
    } else {
      return res.status(400).json({
        ok: false,
        error: "BadRequest",
        message:
          "Provide (proof, publicSignals) or (proofBytes, publicInputsBytes)",
      });
    }

    if (proofBin.length !== 256) {
      return res
        .status(400)
        .json({
          ok: false,
          error: "BadProofSize",
          message: `proofBytes must be 256 bytes, got ${proofBin.length}`,
        });
    }
    if (publicsBin.length !== 7 * 32) {
      return res
        .status(400)
        .json({
          ok: false,
          error: "BadPublicsSize",
          message: `publicInputsBytes must be 224 bytes, got ${publicsBin.length}`,
        });
    }

    const nullifierLE = hexLE32(slice32(publicsBin, W_PS.NULLIFIER));
    const rootLE = hexLE32(slice32(publicsBin, W_PS.MERKLE_ROOT));
    const ownerLoLE = hexLE32(slice32(publicsBin, W_PS.RECIPIENT_OWNER_LO));
    const ownerHiLE = hexLE32(slice32(publicsBin, W_PS.RECIPIENT_OWNER_HI));
    const walletPkLE = hexLE32(slice32(publicsBin, W_PS.RECIPIENT_PK));
    const amountLE = hexLE32(slice32(publicsBin, W_PS.AMOUNT));
    const tokenIdLE = hexLE32(slice32(publicsBin, W_PS.TOKEN_ID));
    console.log({
      proofBytes0_32: hexLE32(slice32(proofBin, 0)),
      nullifier_hex: nullifierLE,
      spent_root_hex: rootLE,
      recipient_owner_lo_le_hex: ownerLoLE,
      recipient_owner_hi_le_hex: ownerHiLE,
      recipient_wallet_pubkey_le_hex: walletPkLE,
      amount_le_hex: amountLE,
      token_id_le_hex: tokenIdLE,
      recipientOwner,
      recipientTokenAccount,
    });

    // Pass strings only; tx-manager converts to PublicKey at the edge.
    const relayerArgs: any = {
      tokenMint,
      proofBytes: proofBin,
      publicInputsBytes: publicsBin,
      target:
        recipientOwner || recipientTokenAccount
          ? { recipientOwner, recipientTokenAccount }
          : undefined,
    };

    const out = await (solanaRelayer as any).submitWithdrawWithBin(relayerArgs);

    return res.json({ ok: true, signature: out.signature });
  } catch (e: any) {
    console.error("API Error:", e);
    return res.status(500).json({
      ok: false,
      error: "SolanaTransactionError",
      message: e?.message || String(e),
    });
  }
});

export { submit as default };
