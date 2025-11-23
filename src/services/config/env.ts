// src/services/config/env.ts
import dotenv from "dotenv";
dotenv.config();

export function loadEnv() {
  return {
    port: Number(process.env.RELAYER_PORT ?? 3000),
    vkeyDir: process.env.VKEY_DIR ?? "./proof",
    mysql: {
      host: process.env.MYSQL_HOST ?? "127.0.0.1",
      port: Number(process.env.MYSQL_PORT ?? 3306),
      user: process.env.MYSQL_USER ?? "cipherpay",
      password: process.env.MYSQL_PASSWORD ?? "cipherpay",
      database: process.env.MYSQL_DB ?? "cipherpay_relayer_solana",
    },
    rpcUrl: process.env.SOLANA_RPC_URL ?? "http://127.0.0.1:8899",
    solanaRpcUrl: process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com",
    programId: process.env.PROGRAM_ID ?? "BCrt2kn5HR4B7CHEMSBacekhzVTKYhzAQAB5YNkr5kJf",
    idlPath: process.env.IDL_PATH ?? "./src/idl/cipherpay_anchor.json",
    skipAnchor: process.env.RELAYER_SKIP_ANCHOR ?? "0",
    authMode: (process.env.AUTH_MODE ?? "jwt") as "jwt" | "hmac",
    disableDashboardAuth: process.env.DISABLE_DASHBOARD_AUTH ?? "1",
    apiToken: process.env.API_TOKEN ?? "supersecret",
    disableApiAuth: process.env.DISABLE_API_AUTH ?? true,
    testMint: process.env.TEST_MINT ?? "",

    jwt: {
      issuer: process.env.AUTH_JWT_ISSUER ?? "",
      audience: process.env.AUTH_JWT_AUDIENCE ?? "",
      jwksUrl: process.env.AUTH_JWKS_URL ?? "",
      publicPem: process.env.AUTH_JWT_PUBLIC_PEM ?? "",
      hs256Secret: process.env.AUTH_JWT_HS256_SECRET ?? "",
    },
    hmac: {
      keyId: process.env.AUTH_HMAC_KEY_ID ?? "",
      secret: process.env.AUTH_HMAC_SECRET ?? "",
      skewSeconds: Number(process.env.AUTH_HMAC_SKEW_SECONDS ?? 300),
    },
  };
}

export function isDashboardAuthEnabled(): boolean {
  // explicit enable wins; then legacy disable; default = enabled
  const val = (process.env.DASHBOARD_AUTH || "disabled").toLowerCase().trim();
  if (val === "enabled" || val === "true" || val === "1") return true;
  if (val === "disabled" || val === "false" || val === "0") return false;
  return true; // default ON in non-local envs
}

export function getDashboardToken(): string | undefined {
  return process.env.DASHBOARD_TOKEN || process.env.API_TOKEN || "supersecret";
}
