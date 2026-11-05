import type { IncomingMessage } from "node:http";
import { Hono, type Context } from "hono";
import { zValidator } from "@hono/zod-validator";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { ProxyTrust } from "../../config/connect.js";
import { WindowLimiter } from "../connect/limits.js";
import { clientIp } from "../connect/request.js";
import type { Db } from "../db/client.js";
import { addressWatches, devices } from "../db/schema.js";
import { addressWatchInsertPayload, hashAddress } from "../privacy/hash.js";
import type { IndexerWatch, WatchOutcome } from "../push/indexer-watch.js";

/** Device registry calls one client address may make per minute (the app subscribes once per wallet and chain). */
export const DEVICE_ROUTE_LIMIT_PER_MINUTE = 120;
/** Wallet and chain pairs one device may watch. */
export const MAX_WATCHES_PER_DEVICE = 200;

export interface PushRouteOptions {
  /** How the client address is read behind proxies (TRUST_PROXY). */
  proxyTrust?: ProxyTrust;
  limiter?: WindowLimiter;
  /** Asks zunia-indexer to watch a subscribed wallet; absent in tests. */
  watch?: IndexerWatch;
  maxWatchesPerDevice?: number;
}

function remoteAddressOf(c: Context): string | undefined {
  const env = c.env as { incoming?: IncomingMessage } | undefined;
  return env?.incoming?.socket.remoteAddress;
}

const platformSchema = z.enum(["web", "extension", "ios", "android"]);

const subscribeSchema = z.object({
  platform: platformSchema,
  pushToken: z.string().min(8).max(4096),
  locale: z.string().min(2).max(16).default("en"),
  prefs: z.record(z.unknown()).optional(),
  /** Plaintext address is hashed immediately and never stored. */
  chainId: z.string().min(1).max(128),
  address: z.string().min(8).max(128),
});

const unsubscribeSchema = z.object({
  platform: platformSchema,
  pushToken: z.string().min(8).max(4096),
});

const listSchema = z.object({
  platform: platformSchema,
  pushToken: z.string().min(8).max(4096),
});

export function createPushRoutes(db: Db, options: PushRouteOptions = {}) {
  const app = new Hono();
  const trust: ProxyTrust = options.proxyTrust ?? { mode: "none" };
  const limiter = options.limiter ?? new WindowLimiter(DEVICE_ROUTE_LIMIT_PER_MINUTE, 60_000);
  const maxWatches = options.maxWatchesPerDevice ?? MAX_WATCHES_PER_DEVICE;

  // Keyed on the address the proxy trust vouches for, not on headers a client can pick.
  app.use("/v1/devices/*", async (c, next) => {
    if (!limiter.hit(clientIp(c.req.raw.headers, remoteAddressOf(c), trust))) {
      return c.json({ error: "rate_limited" }, 429);
    }
    await next();
  });

  app.post("/v1/devices/subscribe", zValidator("json", subscribeSchema), async (c) => {
    const body = c.req.valid("json");

    const [device] = await db
      .insert(devices)
      .values({
        platform: body.platform,
        pushToken: body.pushToken,
        locale: body.locale,
        prefs: body.prefs ?? {},
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [devices.platform, devices.pushToken],
        set: {
          locale: body.locale,
          prefs: body.prefs ?? {},
          updatedAt: new Date(),
        },
      })
      .returning();

    if (!device) {
      return c.json({ error: "device_upsert_failed" }, 500);
    }

    const watchPayload = addressWatchInsertPayload({
      deviceId: device.id,
      chainId: body.chainId,
      address: body.address,
    });

    const [known] = await db
      .select({ id: addressWatches.id })
      .from(addressWatches)
      .where(
        and(
          eq(addressWatches.deviceId, device.id),
          eq(addressWatches.chainId, body.chainId),
          eq(addressWatches.addressHash, watchPayload.addressHash),
        ),
      )
      .limit(1);
    if (!known) {
      const [watched] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(addressWatches)
        .where(eq(addressWatches.deviceId, device.id));
      if ((watched?.count ?? 0) >= maxWatches) {
        return c.json({ error: "device_watch_limit", max: maxWatches }, 429);
      }
      await db
        .insert(addressWatches)
        .values(watchPayload)
        .onConflictDoNothing();
    }

    // Repeated on every subscribe, known pair or not: it renews the indexer's watch.
    const realtime: WatchOutcome = options.watch
      ? await options.watch({ chainId: body.chainId, address: body.address, subject: device.id })
      : "unavailable";

    return c.json({
      ok: true,
      deviceId: device.id,
      chainId: body.chainId,
      addressHash: watchPayload.addressHash,
      realtime,
    });
  });

  app.delete("/v1/devices/unsubscribe", zValidator("json", unsubscribeSchema), async (c) => {
    const body = c.req.valid("json");
    const deleted = await db
      .delete(devices)
      .where(
        and(eq(devices.platform, body.platform), eq(devices.pushToken, body.pushToken)),
      )
      .returning({ id: devices.id });

    return c.json({ ok: true, removed: deleted.length });
  });

  app.get("/v1/devices", zValidator("query", listSchema), async (c) => {
    const query = c.req.valid("query");
    const deviceRows = await db
      .select()
      .from(devices)
      .where(
        and(eq(devices.platform, query.platform), eq(devices.pushToken, query.pushToken)),
      );

    const result = [];
    for (const device of deviceRows) {
      const watches = await db
        .select({
          chainId: addressWatches.chainId,
          addressHash: addressWatches.addressHash,
          createdAt: addressWatches.createdAt,
        })
        .from(addressWatches)
        .where(eq(addressWatches.deviceId, device.id));
      result.push({
        deviceId: device.id,
        platform: device.platform,
        locale: device.locale,
        prefs: device.prefs,
        watches,
      });
    }

    return c.json({ ok: true, devices: result });
  });

  /** Debug helper: hash an address without storing (never returns pepper). */
  app.post(
    "/v1/privacy/hash-address",
    zValidator("json", z.object({ address: z.string().min(8) })),
    async (c) => {
      const { address } = c.req.valid("json");
      return c.json({ addressHash: hashAddress(address) });
    },
  );

  return app;
}
