// src/server/routes/prepare.ts
import { Router } from "express";
import { CanonicalTree } from "@/services/merkle/canonical-tree.js";
import { toBig } from "@/utils/bytes.js";

export function prepareRouter(tree: CanonicalTree) {
  const r = Router();

  // POST /api/v1/prepare/deposit
  // body: { commitment: string (bigint-like) }
  // Returns BE hex for root and path siblings (bottom→top).
  r.post("/deposit", async (req, res, next) => {
    try {
      const { commitment } = req.body ?? {};
      if (!commitment) return res.status(400).json({ error: "missing commitment" });
      toBig(commitment); // validate shape

      const { root, nextIndex } = await tree.getRootAndIndex();
      const zeroPath = await tree.getPathByIndex(nextIndex);

      res.json({
        merkleRoot: root.toString("hex"), // BE hex
        nextLeafIndex: nextIndex,
        inPathElements: zeroPath.pathElements.map((b) => b.toString("hex")), // BE hex
        inPathIndices: zeroPath.pathIndices,
      });
    } catch (e) { next(e); }
  });

  // POST /api/v1/prepare/transfer
  // body: { inCommitment: string (spent note) }
  //
  // BE-only:
  // - merkleRoot: current root (BE hex)
  // - inPathElements/Indices: proof for the spent leaf (bottom→top)
  // - out1PathElements/Indices: zero-path at nextLeafIndex (for OUT1 insert)
  // - out2PathElements/Indices: zero-path at nextLeafIndex+1 (for OUT2 insert)
  // - leafIndex: actual index of inCommitment
  // - nextLeafIndex: cursor before transfer (will advance by +2 on success)
  r.post("/transfer", async (req, res) => {
    try {
      const { inCommitment } = req.body ?? {};
      if (!inCommitment) {
        return res.status(400).json({ ok: false, error: "MissingInCommitment", message: "missing inCommitment" });
      }

      // Path to the SPENT note
      const pathIn = await tree.getPathByCommitment(toBig(inCommitment));

      // Current root and cursor
      const { root, nextIndex } = await tree.getRootAndIndex();

      // Zero paths for the two outgoing notes (next and next+1)
      const pathOut1 = await tree.getPathByIndex(nextIndex);
      const pathOut2 = await tree.getPathByIndex(nextIndex + 1);

      res.json({
        merkleRoot: root.toString("hex"), // BE hex
        // spent path
        inPathElements:  pathIn.pathElements.map((b) => b.toString("hex")),
        inPathIndices:   pathIn.pathIndices,
        leafIndex:       pathIn.index, // include where the input was found

        // zero paths (for outputs)
        out1PathElements: pathOut1.pathElements.map((b) => b.toString("hex")),
        out1PathIndices:  pathOut1.pathIndices,
        out2PathElements: pathOut2.pathElements.map((b) => b.toString("hex")),
        out2PathIndices:  pathOut2.pathIndices,

        // cursor before insertion
        nextLeafIndex: nextIndex,
      });
    } catch (e: any) {
      const message = e?.message ?? String(e);
      const status = message === "commitment not found" ? 404 : 500;
      return res.status(status).json({
        ok: false,
        error: message === "commitment not found" ? "CommitmentNotFound" : "InternalError",
        message,
      });
    }
  });

  // POST /api/v1/prepare/withdraw
  // body: { spendCommitment: string }
  r.post("/withdraw", async (req, res) => {
    try {
      const { spendCommitment } = req.body ?? {};
      if (!spendCommitment) return res.status(400).json({ ok: false, error: "MissingSpendCommitment", message: "missing spendCommitment" });

      const path = await tree.getPathByCommitment(toBig(spendCommitment));
      const root = await tree.getRoot();

      res.json({
        merkleRoot: root.toString("hex"),
        pathElements: path.pathElements.map((b) => b.toString("hex")),
        pathIndices: path.pathIndices,
        leafIndex: path.index,
      });
    } catch (e: any) {
      const message = e?.message ?? String(e);
      const status = message === "commitment not found" ? 404 : 500;
      return res.status(status).json({
        ok: false,
        error: message === "commitment not found" ? "CommitmentNotFound" : "InternalError",
        message,
      });
    }
  });

  return r;
}

// also export default, so either `import { prepareRouter }` or `import prepareRouter` works
export default prepareRouter;
