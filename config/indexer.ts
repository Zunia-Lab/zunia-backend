/**
 * Backend proxy config for the light indexer.
 * Clients call zunia-backend; backend calls INDEXER_API_URL.
 */

export const INDEXER_PROXY_CONFIG = {
  /** Env: INDEXER_API_URL — e.g. http://127.0.0.1:8787 */
  apiUrlEnv: "INDEXER_API_URL",
  historyPath: "/v1/wallets/history",
  firstConnectLimit: 5,
  maxTxsPerWallet: 50,
  /** Only forward history for wallets authenticated on our platform */
  requirePlatformSession: true,
} as const;

export async function proxyWalletHistory(input: {
  baseUrl: string;
  chainId: string;
  address: string;
  forceRefresh?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<unknown> {
  const fetchFn = input.fetchImpl ?? fetch;
  const res = await fetchFn(`${input.baseUrl.replace(/\/$/, "")}/v1/wallets/history`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chainId: input.chainId,
      address: input.address,
      forceRefresh: input.forceRefresh ?? false,
    }),
  });
  if (!res.ok) {
    throw new Error(`indexer proxy failed: ${res.status}`);
  }
  return res.json();
}
