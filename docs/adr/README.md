# ADR index, zunia-backend

| ADR | Title | Status |
|-----|-------|--------|
| [0001](./0001-api-framework.md) | API framework and runtime (Hono on Node 22) | **Accepted** |

Decisions that constrain this repository but live elsewhere:

- `zunia-core/docs/adr/0003-custody-model.md`: self-custody only. This backend must never
  store a seed, a key share, or an encrypted wallet backup.
- `zunia-core/docs/adr/0005-polyrepo-package-flow.md`: shared code is consumed as published
  packages, not filesystem links.
- `zunia-indexer/docs/adr/0001-user-scoped-tx-history.md`: history is user scoped and capped,
  so the backend proxies rather than indexes.
