import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WindowLimiter } from "../connect/limits.js";
import type { Db } from "../db/client.js";
import { createPushRoutes } from "./push.js";

describe("routes/push: device route limits", () => {
  it("limits subscribe and unsubscribe per client address before touching the database", async () => {
    // Invalid bodies: a request that passes the limiter stops at validation (400), never at the database.
    const app = createPushRoutes({} as Db, {
      limiter: new WindowLimiter(2, 60_000),
      proxyTrust: { mode: "cloudflare" },
    });
    const call = (ip: string, method = "POST", path = "/v1/devices/subscribe") =>
      app.request(path, {
        method,
        headers: { "Content-Type": "application/json", "cf-connecting-ip": ip },
        body: JSON.stringify({}),
      });

    assert.equal((await call("198.51.100.1")).status, 400);
    assert.equal((await call("198.51.100.1", "DELETE", "/v1/devices/unsubscribe")).status, 400);
    assert.equal((await call("198.51.100.1")).status, 429);
    assert.equal((await call("198.51.100.2")).status, 400, "another client has its own window");
  });

  it("ignores client-chosen headers when no proxy is trusted", async () => {
    const app = createPushRoutes({} as Db, { limiter: new WindowLimiter(1, 60_000) });
    const call = (deviceId: string) =>
      app.request("/v1/devices/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-device-id": deviceId, "x-forwarded-for": deviceId },
        body: JSON.stringify({}),
      });
    assert.equal((await call("a")).status, 400);
    assert.equal((await call("b")).status, 429, "a new X-Device-Id is not a new client");
  });
});
