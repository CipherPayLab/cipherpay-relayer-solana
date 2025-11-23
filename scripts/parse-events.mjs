// scripts/parse-events.mjs
/**
 * Troubleshooting parser for Anchor events
 *
 * Usage:
 *   export PROGRAM_ID=BCrt2kn5HR4B7CHEMSBacekhzVTKYhzAQAB5YNkr5kJf
 *   export SOLANA_URL=http://127.0.0.1:8899
 *   node scripts/parse-events.mjs <tx-signature> [--publics-le s0,...,s6] [--roots-be old,new]
 */

import * as anchor from "@coral-xyz/anchor";
import { web3, BorshCoder, EventParser } from "@coral-xyz/anchor";
import fs from "node:fs";
import idl from "../src/idl/cipherpay_anchor.json" with { type: "json" };

const RPC = process.env.SOLANA_URL || "http://127.0.0.1:8899";
const SIG = process.argv[2];
const PROGRAM_ID = new web3.PublicKey(process.env.PROGRAM_ID || idl.address);

// ---------- optional comparison flags (same as before) ----------
const args = process.argv.slice(3);
function getFlag(name) {
  const i = args.indexOf(name);
  if (i >= 0 && i + 1 < args.length) return args[i + 1];
  return undefined;
}
const publicsLeCsv = getFlag("--publics-le") || process.env.PUBLICS_LE || "";
const rootsBeCsv   = getFlag("--roots-be")   || process.env.ROOTS_BE   || "";

// ---------- helpers ----------
const asBuf = (v) => {
  if (v == null) return null;
  if (v instanceof Uint8Array) return Buffer.from(v);
  if (Array.isArray(v) && v.every((x) => Number.isInteger(x))) return Buffer.from(v);
  return null;
};
const hex0x   = (b) => (b ? "0x" + Buffer.from(b).toString("hex") : null);
const hex     = (b) => (b ? Buffer.from(b).toString("hex") : null);
const hexLE   = (b) => (b ? Buffer.from(b).reverse().toString("hex") : null);
const is32    = (b) => b && Buffer.byteLength(b) === 32;
const pad64   = (s) => s.replace(/^0x/i,"").padStart(64, "0").toLowerCase();
const isHex64 = (s) => /^[0-9a-f]{64}$/i.test(s || "");
const toBufLE64 = (hex64le) => Buffer.from(pad64(hex64le), "hex");
const toBufBE64 = (hex64be) => Buffer.from(pad64(hex64be), "hex");

function parseCsvList64(csv) {
  if (!csv) return [];
  return csv.split(",").map((s) => pad64(s.trim())).filter(isHex64);
}

function prettyValue(v) {
  if (v && typeof v === "object" && v.toBase58) {
    return { type: "pubkey", base58: v.toBase58() };
  }
  const b = asBuf(v);
  if (b) {
    const out = { type: `bytes(${b.length})`, raw: hex0x(b) };
    if (is32(b)) {
      out.le = "0x" + hexLE(b);
      out.be = "0x" + hex(b);
      out.dec = BigInt("0x" + hex(b)).toString(); // treat raw as BE for decimal view
    }
    return out;
  }
  if (typeof v === "number" || typeof v === "bigint" || typeof v === "string") {
    return v.toString();
  }
  return v;
}

function prettyEvent(ev) {
  const obj = {};
  for (const [k, v] of Object.entries(ev)) obj[k] = prettyValue(v);
  return obj;
}

function compareDepositCompleted(ev, publicsLeCsv, rootsBeCsv) {
  const c  = asBuf(ev.commitment);
  const or = asBuf(ev.old_merkle_root);
  const nr = asBuf(ev.new_merkle_root);
  if (!c || !or || !nr || !is32(c) || !is32(or) || !is32(nr)) return;

  const publics = parseCsvList64(publicsLeCsv); // LE per slot
  const roots   = parseCsvList64(rootsBeCsv);   // BE for [old,new]

  const result = { notes: [] };

  if (publics.length === 7) {
    const slots = publics.map(toBufLE64); // LE
    const eventCommitLE = hex(c); // LE view (DB style)
    const idx = slots.findIndex((s) => s.toString("hex") === eventCommitLE);
    result.publics_match = {
      have_publics: true,
      event_commitment_le: eventCommitLE,
      slot_index: idx, // -1 if not found
      slots_le: slots.map((b) => b.toString("hex")),
    };
    if (idx === -1) result.notes.push("Commitment did not match any provided PUBLICS_LE slots.");
  } else if (publicsLeCsv) {
    result.publics_match = { have_publics: false, message: "PUBLICS_LE must have exactly 7 comma-separated 64-hex items (LE)." };
  }

  if (roots.length === 2) {
    const [oldHex, newHex] = roots;
    const evOldBE = hex(or);
    const evNewBE = hex(nr);
    result.roots_match = {
      have_roots: true,
      event_old_be: evOldBE,
      event_new_be: evNewBE,
      provided_old_be: oldHex,
      provided_new_be: newHex,
      old_equal: evOldBE === oldHex,
      new_equal: evNewBE === newHex,
    };
    if (evOldBE !== oldHex) result.notes.push("Old root BE mismatch vs provided ROOTS_BE[0].");
    if (evNewBE !== newHex) result.notes.push("New root BE mismatch vs provided ROOTS_BE[1].");
  } else if (rootsBeCsv) {
    result.roots_match = { have_roots: false, message: "ROOTS_BE must contain exactly 2 comma-separated 64-hex items (BE)." };
  }

  console.log("\n— comparison (DepositCompleted) —");
  console.dir(result, { depth: null, colors: true });
}

// ---------- core fetch with diagnostics ----------
async function fetchTx(connection, sig) {
  const commitments = ["processed", "confirmed", "finalized"];
  let last = null;

  // Status probe first (fast + tells us if the node knows about it)
  try {
    const st = await connection.getSignatureStatuses([sig], { searchTransactionHistory: true });
    const s = st?.value?.[0] || null;
    console.log("\n— signature status —");
    console.dir(s, { depth: null });
    if (!s) {
      console.warn(
        "\n[diagnostic] Node has no status for this signature. " +
        "This usually means wrong RPC/cluster, the tx is too old for this node’s history, " +
        "or the signature has a typo."
      );
    }
  } catch (e) {
    console.warn("[warn] getSignatureStatuses failed:", e?.message || e);
  }

  for (const c of commitments) {
    try {
      const tx = await connection.getTransaction(sig, {
        commitment: c,
        maxSupportedTransactionVersion: 0, // legacy & v0 both ok (0 means allow v0)
      });
      if (tx) return { tx, commitmentTried: c, api: "getTransaction" };
      last = { where: `getTransaction(${c})`, note: "null" };
    } catch (e) {
      last = { where: `getTransaction(${c})`, error: e?.message || String(e) };
    }
  }

  // Fallback: parsed variant
  for (const c of commitments) {
    try {
      const tx = await connection.getParsedTransaction(sig, {
        commitment: c,
        maxSupportedTransactionVersion: 0,
      });
      if (tx) return { tx, commitmentTried: c, api: "getParsedTransaction" };
      last = { where: `getParsedTransaction(${c})`, note: "null" };
    } catch (e) {
      last = { where: `getParsedTransaction(${c})`, error: e?.message || String(e) };
    }
  }

  return { tx: null, last };
}

async function main() {
  if (!SIG) {
    console.error("Usage: node scripts/parse-events.mjs <tx-signature> [--publics-le s0,...,s6] [--roots-be old,new]");
    process.exit(1);
  }

  // quick sig sanity (base58-ish)
  if (!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(SIG)) {
    console.warn("[warn] Signature doesn't look like base58 text of typical length. Double-check it.");
  }

  const connection = new web3.Connection(RPC, "confirmed");
  const version = await connection.getVersion().catch(() => ({}));
  const slot = await connection.getSlot("processed").catch(() => null);

  console.log("— rpc info —");
  console.log({ rpc: RPC, programId: PROGRAM_ID.toBase58(), slot, version });

  const { tx, commitmentTried, api, last } = await fetchTx(connection, SIG);

  if (!tx) {
    console.error("\nNo transaction found on this RPC.");
    if (last) console.error("Last attempt:", last);
    console.error(
      "\nHints:\n" +
      "  • Ensure SOLANA_URL points at the cluster where you sent the tx (local validator vs devnet vs mainnet).\n" +
      "  • If using a local validator, make sure it’s still running and hasn’t pruned the slot.\n" +
      "  • Try a fresher signature or use the same RPC your relayer used to send the tx.\n"
    );
    process.exit(1);
  }

  console.log(`\n— fetched via ${api} @ commitment=${commitmentTried} —`);
  if (!tx.meta?.logMessages) {
    console.error("Transaction has no logs (meta.logMessages missing).");
    process.exit(1);
  }

  console.log("\n— raw logs —");
  for (const l of tx.meta.logMessages) console.log(l);

  console.log("\n— parsed Anchor events (hex/LE/BE/dec) —");
  const coder = new BorshCoder(idl);
  const parser = new EventParser(PROGRAM_ID, coder);
  let found = false;
  for (const ev of parser.parseLogs(tx.meta.logMessages)) {
    found = true;
    console.log(`event: ${ev.name}`);
    const pretty = prettyEvent(ev.data);
    console.dir(pretty, { depth: null, colors: true });

    if (ev.name === "DepositCompleted" || ev.name === "depositCompleted") {
      compareDepositCompleted(ev.data, publicsLeCsv, rootsBeCsv);
    }
  }
  if (!found) {
    console.log("No Anchor events parsed. Check that PROGRAM_ID matches the program that emitted logs.");
    console.log("IDL events present:", (idl.events || []).map((e) => e.name));
  }

  // Arg format checks
  if (publicsLeCsv && parseCsvList64(publicsLeCsv).length !== 7) {
    console.warn("\n[warn] PUBLICS_LE / --publics-le must contain exactly 7 comma-separated 64-hex items (LE).");
  }
  if (rootsBeCsv && parseCsvList64(rootsBeCsv).length !== 2) {
    console.warn("[warn] ROOTS_BE / --roots-be must contain exactly 2 comma-separated 64-hex items (BE).");
  }
}

main().catch((e) => {
  console.error("parse-events error:", e?.stack || e);
  process.exit(1);
});
