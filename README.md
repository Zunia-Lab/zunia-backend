<p align="center">
  <img src="https://raw.githubusercontent.com/Zunia-Lab/zunia-brand/main/png/icons/app/zunia-icon-256.png" alt="Zunia" width="96" />
</p>

# zunia-backend

> API for the dApp connect relay, notifications, push registry, indexer proxy, phishing list, and opt-in analytics.

**Status:** the connect relay is implemented and tested. Nothing is deployed yet; the other surfaces are scaffolds.

## Connect relay (`zunia.connect.v2`)

Pairs a dApp in a browser with the Zunia mobile wallet through a QR code, then forwards their messages. The dApp and the wallet encrypt everything end to end (X25519, HKDF-SHA256, ChaCha20-Poly1305), so the relay only routes ciphertext.

- `POST /v1/connect/sessions` returns a session id, a `dappToken` that stays with the dApp, and a single-use `walletJoinToken` for the QR code. The browser's `Origin` header is recorded as the session's verified origin and shown to the wallet.
- The wallet joins once with the QR token and receives a `resumeToken` for reconnects. A socket is only ever replaced by a holder of that role's token.
- Only the wallet may send `hello` (its public key) and `paired`, which locks pairing and extends the session to 24 hours. Unpaired sessions expire after 10 minutes.
- Tokens travel in the `Sec-WebSocket-Protocol` header, never in URLs, and are stored as SHA-256 hashes compared in constant time.
- Limits: session creation and upgrades per client address, frame size and rate per socket, a global session cap, and a bounded queue while a peer is offline.
- Sessions persist in Postgres when `DATABASE_URL` is set (tokens hashed, no metadata), and in memory otherwise. Run one relay instance: live sockets are not shared between instances.

| Variable | Purpose |
|----------|---------|
| `CONNECT_WS_PUBLIC_URL` | Public WebSocket base returned to dApps, for example `wss://api.zunialab.com` |
| `TRUST_PROXY` | `none` (default), `cloudflare`, or the number of trusted proxies in front, used to find the client address |

The protocol itself is in [`src/connect/protocol.ts`](./src/connect/protocol.ts); limits are in [`config/connect.ts`](./config/connect.ts).

## Planned surfaces

| Area | Notes |
|------|-------|
| Push registry | `address_hash → devices[]` (platform, token, locale, prefs) |
| Notifications | Fan-out workers; at-least-once + client dedupe |
| Indexer proxy | Light tx history via `INDEXER_API_URL` (`zunia-indexer`), platform wallets only |
| Phishing / dApp registry | Blocklist feed for extension + mobile |
| Analytics | Opt-in only; never addresses, amounts, or seeds |

## Config

See [`config/`](./config/): connect relay limits, notification categories, privacy defaults, VAPID/FCM placeholders.

## Privacy (non-negotiable defaults)

- Opt-in address watching
- Prefer hashed addresses server-side where design allows
- FCM/APNs payloads are wake-up pings; sensitive detail fetched client-side when possible
- Never put mnemonic/seed material anywhere in this service
- Tx events via Vercel Queues (`api/queues/tx-events.ts`, topic `zunia-tx-events`), no amounts in payloads

## Develop

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm dev          # http://localhost:8788, relay at ws://localhost:8788/v1/connect/ws
pnpm db:migrate   # with DATABASE_URL set
```

Set `TEST_DATABASE_URL` to a disposable Postgres database to also run the persistence tests. They create their own schemas in it.

## Security

[security@zunialab.com](mailto:security@zunialab.com)

## License

Apache-2.0.
