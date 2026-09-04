import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { addressWatches, devices } from "../db/schema.js";
import { addressWatchInsertPayload, hashAddress } from "../privacy/hash.js";

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

export function createPushRoutes(db: Db) {
  const app = new Hono();

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

    await db
      .insert(addressWatches)
      .values(watchPayload)
      .onConflictDoNothing();

    return c.json({
      ok: true,
      deviceId: device.id,
      chainId: body.chainId,
      addressHash: watchPayload.addressHash,
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
