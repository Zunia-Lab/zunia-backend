# ADR-0001: API framework and runtime

- Status: **Accepted**
- Date: 2026-08-31
- Decision owner: backend

## Context

`zunia-backend` was scaffolded with configuration only: notification, privacy and indexer
proxy config, one Vercel queue consumer stub, and a `dev` script that echoes a reminder to
pick a framework. Nothing can be built until the runtime and HTTP layer are chosen.

Constraints:

- `zunia-indexer` already runs Hono on Node 22 with Zod validation and has accepted ADRs.
  Two different HTTP stacks across two small services would double the middleware,
  observability and testing work.
- Part of the surface is a queue consumer that must run on Vercel Functions, because the
  `zunia-tx-events` topic trigger is already declared in `vercel.json`.
- Part of the surface may need to run in an always-on container next to the indexer worker.
- The wallet is self-custody per [core ADR-0003](../../../zunia-core/docs/adr/0003-custody-model.md),
  so there is no user account system, no session database and no OAuth to accommodate.

## Options considered

1. **Hono on Node 22.** Web-standard `Request` and `Response`, so the same handlers run on
   Vercel Functions and in a container. Matches the indexer.
2. **Next.js route handlers.** Convenient on Vercel, but pulls a React build into a service
   with no UI, and does not run in a plain container.
3. **Fastify or NestJS.** Both are Node-only and would not share middleware with the indexer.
   NestJS in particular is a large framework for roughly a dozen endpoints.

## Decision

**Hono on Node 22**, with:

- Zod for request and response validation, shared schema style with the indexer.
- Drizzle over Postgres (Neon), with **drizzle-kit migrations**. The indexer currently applies
  `sql/schema.sql` by hand; both repositories move to drizzle-kit and an initial migration is
  back-filled from the existing schema.
- `@vercel/queue` for the `zunia-tx-events` consumer, already wired in `vercel.json`.
- OpenTelemetry traces and structured JSON logs.
- Per-route rate limits backed by Redis (Upstash) with an in-memory fallback for local runs.

## Consequences

- Handlers are portable: the same code serves Vercel Functions and a container deployment.
- Middleware, validation and observability are written once and shared in style with the
  indexer, at the cost of keeping the two repositories aligned by hand since they are separate
  packages.
- No authentication framework is adopted. Device binding for push uses an ADR-36 signed
  challenge from the wallet, so the backend never stores an email, a password or an identity
  record. See `config/privacy.ts`.
- `FCM_SERVER_KEY` in `config/notifications.ts` names the legacy FCM credential Google
  deprecated. The implementation uses the FCM HTTP v1 API with a service account, and the
  config field is renamed accordingly.
