/** Wake-up-only push payload — never amounts or addresses (config/privacy.ts). */
export type WakeUpPayload = {
  event: "tx_update";
  chainId: string;
  /** tx hash only — client fetches detail locally */
  txHash: string;
};

export type PushPlatform = "web" | "extension" | "ios" | "android";

export type PushTarget = {
  deviceId: string;
  platform: PushPlatform | string;
  pushToken: string;
};

export type PushSendResult =
  | { ok: true }
  | { ok: false; dead: boolean; reason: string };
