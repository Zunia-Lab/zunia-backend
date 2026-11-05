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

## Mobile push

1. The app subscribes once per wallet and chain: `POST /v1/devices/subscribe` with `{platform, pushToken, locale, prefs, chainId, address}`. `pushToken` is an FCM registration token on Android and on iOS (firebase_messaging). Only a peppered hash of the address is stored. The answer's `realtime` says whether the indexer took the watch (`watching`, `refused`, `unavailable`).
2. The backend asks zunia-indexer to watch the pair (`POST /v1/wallets/subscribe` there, with the device id as `x-zunia-subject`). The indexer keeps a push watch for 30 days; every subscribe call renews it, so the app repeats its subscribe calls well within that.
3. The indexer POSTs each transaction it sees for a watched wallet to `POST /internal/tx-events` (`{chainId, address, txHash}`, header `x-zunia-internal-token`).
4. The backend sends one FCM HTTP v1 message per subscribed device, iOS included: FCM reaches APNs with the key uploaded to the Firebase project. The text is fixed, "Zunia" / "New activity in your wallet", and the data is `{event, chainId, txHash}`, Android channel `zunia_activity` ([`config/notifications.ts`](./config/notifications.ts)). Sends are deduplicated per transaction and device, coalesced per minute and capped per hour; a failed send is not logged, so a redelivered event is pushed, and a token FCM no longer knows removes its device.

`/internal/*` answers only requests that reach `127.0.0.1` directly. One carrying `X-Forwarded-For`, `X-Real-IP` or `CF-Connecting-IP` came through nginx or Cloudflare and gets a 404. Device routes are limited per client address (read through `TRUST_PROXY`), and a device watches at most 200 pairs.

| Variable | Purpose |
|----------|---------|
| `FCM_SERVICE_ACCOUNT_PATH` | Service account key file of the Firebase project (JSON, mode 600), with the Firebase Cloud Messaging API Admin role. Without it every send fails as `fcm_not_configured`. |
| `FCM_PROJECT_ID` | Optional. Overrides the key's `project_id`. |
| `INTERNAL_EVENTS_TOKEN` | Shared secret of 32+ characters the indexer sends as `x-zunia-internal-token`, equal to its `BACKEND_EVENTS_TOKEN`. While unset, events are refused. |
| `ADDRESS_PEPPER` | 16+ characters. Peppers the address hashes; subscribe fails without it. Changing it orphans every watch. |
| `INDEXER_API_URL` | Indexer base URL, default `http://127.0.0.1:8787`. Also used by the history proxy. |
| `INDEXER_API_KEY` | The indexer's `INDEXER_API_KEY`, sent as `x-api-key`. |
| `INDEXER_SUBSCRIBE_TOKEN` | One of the indexer's `INDEXER_SUBSCRIBE_TOKEN` values, sent as `x-zunia-subscribe-token`. |

## Planned surfaces

| Area | Notes |
|------|-------|
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
- Tx events from the indexer on `POST /internal/tx-events`, or via Vercel Queues (`api/queues/tx-events.ts`, topic `zunia-tx-events`); no amounts in payloads

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
