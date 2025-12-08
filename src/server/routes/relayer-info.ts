/* ESM */
// src/server/routes/relayer-info.ts
import { Router } from "express";
import { solanaRelayer } from "@/services/solana-relayer.js";

export function relayerInfoRouter(tree: any) {
  const r = Router();

  r.get("/info", async (_req, res) => {
    try {
      const relayerPubkey = solanaRelayer.provider.wallet.publicKey.toBase58();
      const programId     = solanaRelayer.program.programId.toBase58();
      const clusterUrl    = (solanaRelayer.provider.connection as any)._rpcEndpoint ?? "";
      return res.json({ relayerPubkey, programId, clusterUrl });
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: "InternalError", message: e?.message || String(e) });
    }
  });

  // GET /api/v1/relayer/merkle/root - Get current merkle tree root directly from database
  r.get("/merkle/root", async (_req, res) => {
    try {
      const root = await tree.getRoot();
      const { nextIndex } = await tree.getRootAndIndex();
      return res.json({
        root: root.toString("hex"), // BE hex
        nextLeafIndex: nextIndex,
      });
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: "InternalError", message: e?.message || String(e) });
    }
  });

  return r;
}

// For backward compatibility
export const relayerInfo = Router();
relayerInfo.get("/info", async (_req, res) => {
  try {
    const relayerPubkey = solanaRelayer.provider.wallet.publicKey.toBase58();
    const programId     = solanaRelayer.program.programId.toBase58();
    const clusterUrl    = (solanaRelayer.provider.connection as any)._rpcEndpoint ?? "";
    return res.json({ relayerPubkey, programId, clusterUrl });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: "InternalError", message: e?.message || String(e) });
  }
});

export default relayerInfo;
