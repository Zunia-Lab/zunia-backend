/**
 * Asks zunia-indexer to watch a wallet a device subscribed to, so the
 * wallet's transactions come back on POST /internal/tx-events.
 *
 * The indexer has to hold the plaintext address it watches; this service keeps
 * only the peppered hash and cannot ask again later. So every subscribe call
 * renews the watch, and the app repeats its subscribe calls well within the
 * indexer's push watch lifetime (INDEXER_PUSH_WATCH_TTL_HOURS there).
 */

export type WatchOutcome = "watching" | "refused" | "unavailable";

export type IndexerWatch = (input: {
  chainId: string;
  address: string;
  /** Opaque per-device id: the indexer counts its wallet quota per subject. */
  subject: string;
}) => Promise<WatchOutcome>;

export const INDEXER_SUBSCRIBE_PATH = "/v1/wallets/subscribe";
export const INDEXER_SUBSCRIBE_TOKEN_HEADER = "x-zunia-subscribe-token";
export const INDEXER_SUBJECT_HEADER = "x-zunia-subject";
const DEFAULT_INDEXER_URL = "http://127.0.0.1:8787";
const DEFAULT_TIMEOUT_MS = 3000;

export interface IndexerWatchConfig {
  baseUrl: string;
  /** The indexer's INDEXER_API_KEY, sent as x-api-key. */
  apiKey?: string;
  /** One of the indexer's INDEXER_SUBSCRIBE_TOKEN values. */
  subscribeToken?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
}

/**
 * An abort signal that fires after `ms`. `AbortSignal.timeout` unrefs its
 * timer on Node 20 and 22, so a call with nothing else pending lets the
 * process (or a test) end before the deadline; this timer is ref'd, and
 * `clear` drops it once the call settles.
 */
function deadline(ms: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException("The operation timed out.", "TimeoutError")),
    ms,
  );
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

/**
 * The watch call. Never throws: a refusal or an outage is logged (chain and
 * status only, never the address) and reported, and the subscribe that asked
 * still succeeds.
 */
export function createIndexerWatch(config: IndexerWatchConfig): IndexerWatch {
  const fetchFn = config.fetchImpl ?? fetch;
  const log = config.log ?? ((message: string) => console.warn(message));
  const url = `${config.baseUrl.replace(/\/$/, "")}${INDEXER_SUBSCRIBE_PATH}`;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // A chain the indexer does not serve is refused for every device: say so once.
  const refusedChains = new Set<string>();

  return async ({ chainId, address, subject }) => {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      [INDEXER_SUBJECT_HEADER]: subject,
    };
    if (config.apiKey) headers["x-api-key"] = config.apiKey;
    if (config.subscribeToken) headers[INDEXER_SUBSCRIBE_TOKEN_HEADER] = config.subscribeToken;
    const limit = deadline(timeoutMs);
    try {
      const res = await fetchFn(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ chainId, address }),
        signal: limit.signal,
      });
      if (res.ok) return "watching";
      if (res.status >= 500 || res.status === 429) {
        log(`[indexer-watch] ${chainId}: indexer answered ${res.status}`);
        return "unavailable";
      }
      if (!refusedChains.has(`${chainId}:${res.status}`)) {
        refusedChains.add(`${chainId}:${res.status}`);
        log(`[indexer-watch] ${chainId}: refused with ${res.status}`);
      }
      return "refused";
    } catch (err) {
      const name = err instanceof Error ? err.name : "error";
      log(`[indexer-watch] ${chainId}: indexer unreachable (${name})`);
      return "unavailable";
    } finally {
      limit.clear();
    }
  };
}

/** From INDEXER_API_URL (default http://127.0.0.1:8787), INDEXER_API_KEY and INDEXER_SUBSCRIBE_TOKEN. */
export function indexerWatchFromEnv(env: NodeJS.ProcessEnv = process.env): IndexerWatch {
  return createIndexerWatch({
    baseUrl: env.INDEXER_API_URL?.trim() || DEFAULT_INDEXER_URL,
    apiKey: env.INDEXER_API_KEY?.trim() || undefined,
    subscribeToken: env.INDEXER_SUBSCRIBE_TOKEN?.trim() || undefined,
  });
}
