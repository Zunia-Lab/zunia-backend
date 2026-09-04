import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
  INDEXER_PROXY_CONFIG,
  proxyWalletHistory,
} from "../../config/indexer.js";
import phishingBlocklist from "../data/phishing-blocklist.json" with { type: "json" };

const historySchema = z.object({
  chainId: z.string().min(1),
  address: z.string().min(8),
  forceRefresh: z.boolean().optional(),
});

export function createProxyRoutes() {
  const app = new Hono();

  /** Static / JSON placeholder phishing blocklist feed. */
  app.get("/v1/phishing/blocklist", (c) => {
    return c.json(phishingBlocklist);
  });

  /** Chain / dApp registry mirror stub. */
  app.get("/v1/registry/mirror", (c) => {
    const upstream = process.env.REGISTRY_MIRROR_URL;
    if (!upstream) {
      return c.json({
        ok: true,
        stub: true,
        message: "REGISTRY_MIRROR_URL not set",
        chains: [],
        updatedAt: new Date().toISOString(),
      });
    }
    // TODO: fetch + cache upstream registry
    return c.json({
      ok: true,
      stub: true,
      upstream,
      message: "proxy not yet wired",
    });
  });

  /** Price feed stub. */
  app.get("/v1/prices", (c) => {
    const symbols = c.req.query("symbols")?.split(",").filter(Boolean) ?? [];
    return c.json({
      ok: true,
      stub: true,
      base: "usd",
      prices: Object.fromEntries(symbols.map((s) => [s.toUpperCase(), null])),
      updatedAt: new Date().toISOString(),
      // TODO: wire CoinGecko / provider once ADR chooses source
    });
  });

  /** History proxy — forwards to zunia-indexer via config/indexer.ts. */
  app.post("/v1/wallets/history", zValidator("json", historySchema), async (c) => {
    const body = c.req.valid("json");
    const baseUrl = process.env[INDEXER_PROXY_CONFIG.apiUrlEnv];
    if (!baseUrl) {
      return c.json(
        { error: `${INDEXER_PROXY_CONFIG.apiUrlEnv} is not configured` },
        503,
      );
    }

    // Platform session gate (ADR: requirePlatformSession) — stub until ADR-36 challenge lands
    if (INDEXER_PROXY_CONFIG.requirePlatformSession) {
      const session = c.req.header("x-zunia-session");
      if (!session) {
        return c.json({ error: "platform_session_required" }, 401);
      }
    }

    try {
      const data = await proxyWalletHistory({
        baseUrl,
        chainId: body.chainId,
        address: body.address,
        forceRefresh: body.forceRefresh,
      });
      return c.json(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : "proxy_failed";
      return c.json({ error: message }, 502);
    }
  });

  return app;
}
