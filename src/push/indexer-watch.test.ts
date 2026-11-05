import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  INDEXER_SUBJECT_HEADER,
  INDEXER_SUBSCRIBE_TOKEN_HEADER,
  createIndexerWatch,
} from "./indexer-watch.js";

const ADDRESS = "addr_safro1qyqszqgpqyqszqgpqyqszqgpqyqszqgpexample";
const PAIR = { chainId: "safrochain-1", address: ADDRESS, subject: "device-uuid-1" };

function fetchAnswering(answer: (init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return answer(init);
  }) as typeof fetch;
  return { impl, calls };
}

describe("push/indexer-watch", () => {
  it("asks the indexer to watch the pair, as this device, with both secrets", async () => {
    const { impl, calls } = fetchAnswering(() => new Response("{}", { status: 200 }));
    const watch = createIndexerWatch({
      baseUrl: "http://127.0.0.1:8787/",
      apiKey: "api-key",
      subscribeToken: "subscribe-token",
      fetchImpl: impl,
    });
    assert.equal(await watch(PAIR), "watching");
    assert.equal(calls[0]?.url, "http://127.0.0.1:8787/v1/wallets/subscribe");
    const headers = calls[0]?.init.headers as Record<string, string>;
    assert.equal(headers["x-api-key"], "api-key");
    assert.equal(headers[INDEXER_SUBSCRIBE_TOKEN_HEADER], "subscribe-token");
    assert.equal(headers[INDEXER_SUBJECT_HEADER], "device-uuid-1");
    assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { chainId: "safrochain-1", address: ADDRESS });
  });

  it("reports refusals and outages without throwing or logging the address", async () => {
    const logs: string[] = [];
    const log = (message: string) => logs.push(message);

    const refused = createIndexerWatch({
      baseUrl: "http://indexer",
      fetchImpl: fetchAnswering(() => new Response("{}", { status: 400 })).impl,
      log,
    });
    assert.equal(await refused(PAIR), "refused");
    assert.equal(await refused(PAIR), "refused");
    assert.equal(logs.length, 1, "a chain the indexer does not serve is logged once");

    const busy = createIndexerWatch({
      baseUrl: "http://indexer",
      fetchImpl: fetchAnswering(() => new Response("{}", { status: 503 })).impl,
      log,
    });
    assert.equal(await busy(PAIR), "unavailable");

    const down = createIndexerWatch({
      baseUrl: "http://indexer",
      fetchImpl: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
      log,
    });
    assert.equal(await down(PAIR), "unavailable");
    assert.ok(logs.every((line) => !line.includes(ADDRESS)));
  });

  it("gives up after its timeout", async () => {
    const hanging = (async (_input: string | URL | Request, init: RequestInit = {}) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as typeof fetch;
    const watch = createIndexerWatch({ baseUrl: "http://indexer", fetchImpl: hanging, timeoutMs: 20, log: () => {} });
    assert.equal(await watch(PAIR), "unavailable");
  });
});
