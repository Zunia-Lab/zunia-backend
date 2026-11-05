import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dispatchPush, type PushSenders } from "./consumer.js";
import type { WakeUpPayload } from "./types.js";

const PAYLOAD: WakeUpPayload = { event: "tx_update", chainId: "safrochain-1", txHash: "B".repeat(64) };

function recordingSenders() {
  const calls: Array<{ transport: "fcm" | "webPush"; token: string }> = [];
  const senders: PushSenders = {
    fcm: async ({ deviceToken }) => {
      calls.push({ transport: "fcm", token: deviceToken });
      return { ok: true };
    },
    webPush: async ({ endpoint }) => {
      calls.push({ transport: "webPush", token: endpoint });
      return { ok: true };
    },
  };
  return { senders, calls };
}

describe("push/consumer: dispatch", () => {
  it("sends iOS through FCM, as Android: both register with firebase_messaging", async () => {
    const { senders, calls } = recordingSenders();
    await dispatchPush({ platform: "ios", pushToken: "ios-fcm-token", payload: PAYLOAD }, senders);
    await dispatchPush({ platform: "android", pushToken: "android-fcm-token", payload: PAYLOAD }, senders);
    assert.deepEqual(calls, [
      { transport: "fcm", token: "ios-fcm-token" },
      { transport: "fcm", token: "android-fcm-token" },
    ]);
  });

  it("keeps browsers on Web Push and refuses an unknown platform", async () => {
    const { senders, calls } = recordingSenders();
    await dispatchPush({ platform: "extension", pushToken: "https://push.example/1", payload: PAYLOAD }, senders);
    assert.deepEqual(calls, [{ transport: "webPush", token: "https://push.example/1" }]);
    assert.deepEqual(
      await dispatchPush({ platform: "pager", pushToken: "x", payload: PAYLOAD }, senders),
      { ok: false, dead: false, reason: "unknown_platform" },
    );
  });
});
