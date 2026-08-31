# zunia-backend

> API for notifications, push registry, indexer proxy, phishing list, and opt-in analytics.

**Status:** scaffold / config only. No production endpoints yet.

## Planned surfaces

| Area | Notes |
|------|-------|
| Push registry | `address_hash → devices[]` (platform, token, locale, prefs) |
| Notifications | Fan-out workers; at-least-once + client dedupe |
| Indexer proxy | Light tx history via `INDEXER_API_URL` (`zunia-indexer`) — platform wallets only |
| Phishing / dApp registry | Blocklist feed for extension + mobile |
| Analytics | Opt-in only; never addresses, amounts, or seeds |

## Config

See [`config/`](./config/) — notification categories, privacy defaults, VAPID/FCM placeholders.

## Privacy (non-negotiable defaults)

- Opt-in address watching
- Prefer hashed addresses server-side where design allows
- FCM/APNs payloads are wake-up pings; sensitive detail fetched client-side when possible
- Never put mnemonic/seed material anywhere in this service
- Tx events via Vercel Queues (`api/queues/tx-events.ts`, topic `zunia-tx-events`) — no amounts in payloads

## Develop

```bash
pnpm install
pnpm typecheck
# pnpm dev  # when implementation starts
```

## Security

[security@zuniawallet.com](mailto:security@zuniawallet.com)

## License

Apache-2.0.
