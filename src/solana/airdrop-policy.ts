/**
 * Auto-airdrop via `Connection.requestAirdrop` hits public cluster faucets (rate limits / 429).
 * Default: only allow on local RPC (127.0.0.1 / localhost). For devnet/testnet, fund
 * `ANCHOR_WALLET` manually, or set RELAYER_ALLOW_AUTO_AIRDROP=1 to opt into faucet calls.
 */

export function isLocalRpcEndpoint(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    return (
      u.hostname === "localhost" ||
      u.hostname === "127.0.0.1" ||
      u.hostname === "0.0.0.0"
    );
  } catch {
    return false;
  }
}

/** Explicit opt-in for faucet airdrops on non-local clusters. */
export function isRelayerAutoAirdropExplicitlyAllowed(): boolean {
  const primary = (process.env.RELAYER_ALLOW_AUTO_AIRDROP ?? "")
    .toLowerCase()
    .trim();
  const legacy = (process.env.ALLOW_DEVNET_AIRDROP ?? "")
    .toLowerCase()
    .trim();
  const ok = (v: string) =>
    v === "1" || v === "true" || v === "yes" || v === "on";
  return ok(primary) || ok(legacy);
}

/** Whether `requestAirdrop` is allowed for this RPC endpoint + env. */
export function shouldAttemptAutoAirdrop(rpcEndpoint: string): boolean {
  return isLocalRpcEndpoint(rpcEndpoint) || isRelayerAutoAirdropExplicitlyAllowed();
}
