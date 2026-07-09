# cipherpay-relayer-solana

Headless relayer for the **CipherPay protocol** on Solana.

# Usage

Sync with other projects

1. update program id
2. copy idl file from cipherpay-anchor/target/idl/cipherpay_anchor.json to cipherpay-relayer-solana/src/idl
3. copy \*\_vkey.json from cipherpay-circuits/build/{deposit,transfer,withdraw}/verification_key.json to cipherpay-relayer-solana/src/zk/circuits and cipherpay-relayer-solana/tests/e2e/{deposit,transfer,withdraw}/proof
   npm run copy-vk-to-relayer under cipherpay-circuits
4. copy _\_final.zkey and _.wasm from cipherpay-circuits/build/{deposit,transfer,withdraw}/{deposit_js, transfer_js,withdraw_js}/ to cipherpay-relayer-solana/tests/e2e/{deposit,transfer,withdraw}/proof
   npm run copy-proof-artifacts-to-relayer under cipherpay-circuits
5. npm run build
6. start database - replaced by doc/scripts/docker-compose.yml
   docker compose up -d db
   npm run migrate : Create tables and views by using src/db/migrations/001_init.sql
   npm run init-tree : Initialize all tables
7. npm run dev
8. INDEX=1 npm run test:e2e:depositata
9. INDEX=1 npm run test:e2e:transferata
10. INDEX=1 npm run test:e2e:withdrawata
11. check db
    SELECT k, LENGTH(v) AS len, HEX(v) AS hex FROM merkle_meta WHERE tree_id = 1 AND k = 'roots_next_slot';
    SELECT k, LENGTH(v) AS len, HEX(v) AS hex' FROM merkle_meta WHERE tree_id = 1 AND k = 'root';
    SELECT k, LENGTH(v) AS len, HEX(v) AS hex FROM merkle_meta WHERE tree_id = 1 AND k = 'next_index';

    SELECT _ FROM nodes_all WHERE node_layer=0 limit 5;
    SELECT _ FROM nodes_all WHERE node_layer=16 limit 5;

12. debug
    solana program show AWVNBHaF1upXopq9dQpRpY54c9113bBskqiv16MUTDDd
    solana logs AWVNBHaF1upXopq9dQpRpY54c9113bBskqiv16MUTDDd -u localhost

---

## Overview

The relayer maintains the **canonical Poseidon-based Merkle tree** for private notes and exposes authenticated APIs to:

- **Prepare flows**: return Merkle path elements + indices + current root for deposits, transfers, and withdrawals.
- **Submit flows**: verify Groth16 zero-knowledge proofs off-chain, then relay valid transactions to the on-chain `cipherpay-anchor` program.
- **Stream on-chain events**: track `DepositCompleted`, `TransferCompleted`, and `WithdrawCompleted`.

All state (leaves, intermediate nodes, rolling roots, metadata) is persisted in **MySQL**, enabling large trees (e.g. depth=32).

⚠️ **Security note**
This service is API-only. No CLI or raw DB access is provided.
All API routes require JWT authentication. Run relayers inside trusted networks.

---

## Quick Start

### 1. Clone & install

```bash
git clone https://github.com/your-org/cipherpay-relayer-solana.git
cd cipherpay-relayer-solana
cp .env.example .env   # configure DB + JWT + Solana RPC
npm install
```

### 2. MySQL setup

Bring up MySQL with Docker (recommended):

```bash
docker compose up -d db
docker ps
```

Create database & user matching `.env`.

### 3. Run migrations

```bash
npm run migrate
```

Creates tables:

- `merkle_meta` — depth, next index, etc.
- `leaves` — commitments
- `nodes` — intermediate hashes
- `roots` — recent roots (ring buffer)

### 4. Development server

```bash
npm run dev
```

### Relayer wallet & SOL (auto-airdrop)

The relayer signs with **`ANCHOR_WALLET`** (default `~/.config/solana/id.json`). Deposits require enough SOL on that key for fees, ATA rent, and (for native SOL) wrapping.

- **Local validator** (`http://127.0.0.1:8899` / `localhost`): the relayer may **auto-airdrop** when balance is low.
- **Devnet / testnet / remote RPC**: auto-airdrop is **off by default** (avoids faucet **429** rate limits). **Fund the relayer key** manually (e.g. [faucet.solana.com](https://faucet.solana.com)).
- To opt back into public-faucet `requestAirdrop` on non-local clusters, set **`RELAYER_ALLOW_AUTO_AIRDROP=1`** in `.env` (legacy alias: `ALLOW_DEVNET_AIRDROP=1`).

### 5. Production build

```bash
npm run build
npm start
```

---

## API Usage

### Login

```bash
curl -sX POST localhost:3000/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"admin@cipherpay.com","password":"admin123"}'
```

Response includes JWT token.

---

### Deposit flow

#### Prepare

Client requests path elements + indices for new deposit:

```bash
TOKEN=...
curl -sX POST localhost:3000/api/v1/prepare/deposit \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"amount":"100", "ownerCipherPayPubKey":"..."}'
```

#### Submit

Client submits proof + signals:

```bash
curl -sX POST localhost:3000/api/v1/submit/deposit \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d @deposit_proof.json
```

---

### Transfer flow

#### Prepare

```bash
curl -sX POST localhost:3000/api/v1/prepare/transfer \
  -H "authorization: Bearer $TOKEN" \
  -d '{"nullifier":"...", "outCommitments":["...","..."]}'
```

#### Submit

```bash
curl -sX POST localhost:3000/api/v1/submit/transfer \
  -H "authorization: Bearer $TOKEN" \
  -d @transfer_proof.json
```

---

### Withdraw flow

#### Prepare

```bash
curl -sX POST localhost:3000/api/v1/prepare/withdraw \
  -H "authorization: Bearer $TOKEN" \
  -d '{"nullifier":"...", "recipientWalletPubKey":"..."}'
```

#### Submit

```bash
curl -sX POST localhost:3000/api/v1/submit/withdraw \
  -H "authorization: Bearer $TOKEN" \
  -d @withdraw_proof.json
```

#### client usage

JWT mode – UI/SDK sends:

```bash
Authorization: Bearer <access_token>
```

HMAC mode – UI/SDK sends:

```bash
X-CipherPay-Key: <keyId>
X-CipherPay-Timestamp: <unix-seconds>
X-CipherPay-Signature: HMAC_SHA256(METHOD\nPATH\nTIMESTAMP\nSHA256(body))
```

---

## Security

- Relayer is **not a public API** — restrict to trusted clients (`cipherpay-ui`, `cipherpay-sdk`).
- All endpoints require **JWT authentication**.
- Proofs are always **verified off-chain** before transactions are submitted on-chain.
- Direct DB/CLI access is intentionally excluded.

---

## ⚡ Notes

- Place Groth16 verification keys in `src/zk/circuits/*.json`.
- Configure Merkle tree depth via `.env` → `CP_TREE_DEPTH` (e.g. 16 or 32).
- `tree_id` reserved for multi-tree support in future versions.
