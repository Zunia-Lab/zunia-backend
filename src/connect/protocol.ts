/**
 * zunia.connect.v2: the relay that pairs a dApp with the Zunia mobile wallet.
 *
 * The relay only routes. It sees session ids, token hashes, the dApp's HTTP `Origin`,
 * presence, and ciphertext sizes. Everything the dApp and the wallet say to each other
 * travels inside `msg` frames encrypted end to end with keys the relay never holds.
 */
import { z } from "zod";

export const ZUNIA_CONNECT_PROTOCOL = "zunia.connect.v2" as const;

export const CONNECT_PATHS = {
  sessions: "/v1/connect/sessions",
  ws: "/v1/connect/ws",
} as const;

/**
 * Clients offer two WebSocket subprotocols: `zunia.connect.v2` and `zunia.token.<token>`.
 * The relay selects `zunia.connect.v2`, so tokens never appear in URLs or access logs.
 */
export const TOKEN_PROTOCOL_PREFIX = "zunia.token.";

export type ConnectRole = "dapp" | "wallet";

export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** X25519 public key, 32 bytes as unpadded base64url. */
const publicKey = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
/** ChaCha20-Poly1305 nonce, 12 bytes as unpadded base64url. */
const nonce = z.string().regex(/^[A-Za-z0-9_-]{16}$/);
/** Ciphertext with its 16-byte tag, unpadded base64url. */
const ciphertext = z.string().min(22).regex(/^[A-Za-z0-9_-]+$/);

/** Frames a client may send. Anything else is answered with `BAD_FRAME`. */
export const clientFrameSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("ping") }).strict(),
  z.object({ t: z.literal("hello"), pk: publicKey }).strict(),
  z.object({ t: z.literal("msg"), n: nonce, c: ciphertext }).strict(),
  z.object({ t: z.literal("paired") }).strict(),
  z.object({ t: z.literal("close"), reason: z.string().max(64).optional() }).strict(),
]);

export type ClientFrame = z.infer<typeof clientFrameSchema>;

/** Who may send each frame. `hello` and `paired` come from the wallet only. */
export const FRAME_SENDERS: Record<ClientFrame["t"], readonly ConnectRole[]> = {
  ping: ["dapp", "wallet"],
  hello: ["wallet"],
  msg: ["dapp", "wallet"],
  paired: ["wallet"],
  close: ["dapp", "wallet"],
};

export type RelayErrorCode = "BAD_FRAME" | "FORBIDDEN" | "QUEUE_FULL";

export type SessionEndReason = "closed" | "deleted" | "expired";

export type ServerFrame =
  | {
      t: "welcome";
      v: typeof ZUNIA_CONNECT_PROTOCOL;
      role: ConnectRole;
      sessionId: string;
      /** Origin the dApp's browser sent when it created the session, or null when absent. */
      verifiedOrigin: string | null;
      paired: boolean;
      /** Whether the other side is connected right now. */
      peer: boolean;
      expiresAt: number;
      /** Sent once, to the wallet, when it joins with the QR token. */
      resumeToken?: string;
    }
  | { t: "peer"; online: boolean }
  | { t: "hello"; pk: string }
  | { t: "msg"; n: string; c: string }
  | { t: "paired"; expiresAt: number }
  | { t: "pong" }
  | { t: "error"; code: RelayErrorCode; message: string }
  | { t: "closed"; reason: SessionEndReason };

/** WebSocket close codes the relay uses. */
export const CLOSE_CODES = {
  /** Another socket authenticated for the same role. */
  replaced: 4000,
  /** The session ended: closed by a peer, deleted, or expired. */
  ended: 4001,
  /** Too many frames. */
  rateLimited: 4008,
  /** Unknown session, wrong token, or a join token that was already used. */
  unauthorized: 4401,
} as const;

/** `POST /v1/connect/sessions` response. The dApp keeps `dappToken` and puts `walletJoinToken` in the QR code. */
export interface CreateSessionResponse {
  v: typeof ZUNIA_CONNECT_PROTOCOL;
  sessionId: string;
  dappToken: string;
  walletJoinToken: string;
  verifiedOrigin: string | null;
  expiresAt: number;
  wsUrl: string;
}

/** `GET /v1/connect/sessions/:id` response, for a holder of the dApp or wallet resume token. */
export interface SessionStatusResponse {
  v: typeof ZUNIA_CONNECT_PROTOCOL;
  sessionId: string;
  role: ConnectRole;
  verifiedOrigin: string | null;
  paired: boolean;
  peerOnline: boolean;
  expiresAt: number;
}
