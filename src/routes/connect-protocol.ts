/** Local copy of zunia.connect.v1 constants so backend does not depend on sdk publish. */

export const ZUNIA_CONNECT_PROTOCOL_VERSION = "zunia.connect.v1" as const;

export const ZUNIA_NATIVE_CONNECT = {
  protocolVersion: ZUNIA_CONNECT_PROTOCOL_VERSION,
  httpPath: "/v1/connect/sessions",
  wsPath: "/v1/connect/ws",
  unpairedTtlSeconds: 900,
  pairedTtlSeconds: 86_400,
  deepLinkPath: "zunia://connect",
  defaultMethods: [
    "enable",
    "getKey",
    "getAccounts",
    "signAmino",
    "signDirect",
    "signArbitrary",
  ] as const,
  defaultEvents: ["accountsChanged", "chainChanged"] as const,
} as const;

export type ZuniaConnectRole = "dapp" | "wallet";

export type ZuniaConnectMessageType =
  | "hello"
  | "hello_ok"
  | "connect_request"
  | "connect_approve"
  | "connect_reject"
  | "accounts_get"
  | "accounts"
  | "sign_amino"
  | "sign_direct"
  | "sign_arbitrary"
  | "sign_result"
  | "sign_reject"
  | "event_accounts_changed"
  | "event_chain_changed"
  | "ping"
  | "pong"
  | "disconnect"
  | "error";

export interface ZuniaConnectEnvelope<T = unknown> {
  v: typeof ZUNIA_CONNECT_PROTOCOL_VERSION;
  type: ZuniaConnectMessageType;
  id?: string;
  ts: number;
  payload: T;
}

export interface CreateConnectSessionResponse {
  sessionId: string;
  pairingSecret: string;
  expiresAt: number;
  wsUrl: string;
  deepLink: string;
  qrPayload: string;
  httpUrl: string;
}
