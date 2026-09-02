---
name: integrate-inkronik-node-sdk
description: Integrate or audit @inkronik/node-sdk in a Node.js, Bun, Next.js, or GraphQL service. Use when adding Inkronik tracing, telemetry, GraphQL operation capture, Next.js instrumentation, HTTP adapters, authenticated user context, cron or background spans, fetch, BullMQ, PostgreSQL, Drizzle, or TypeORM instrumentation; when replacing preload with import-first initialization; or when verifying an existing server-side integration. For full-stack Next.js, also configure @inkronik/browser-sdk/next. Do not use for standalone browser-only integrations.
---

# Integrate Inkronik Node SDK

Instrument a service without silently losing HTTP, authenticated-user, background-work, or database telemetry.

## Workflow

1. Read the target repository instructions before editing.
2. Inspect the package manifest, lockfile, runtime, start commands, entrypoints, framework bootstrap, authentication flow, database driver, queues, scheduled jobs, environment schema, tests, and existing telemetry code.
3. Read [references/integration-patterns.md](references/integration-patterns.md) before choosing an integration path.
4. State the detected framework, runtime, database driver, authenticated request shape, and background-work mechanisms. Resolve uncertainty from code; ask only when a choice materially changes behavior and cannot be discovered.
5. Implement the smallest complete integration. Reuse one process-level Inkronik client and avoid duplicate middleware, interceptors, fetch patches, or initialization.
6. Add or update tests for every applicable signal path.
7. Run the target repository's required format, lint, type, test, and build checks. Report anything that could not be verified.

## Integration rules

- Install an exact `@inkronik/node-sdk` version with the repository's package manager. Never introduce a version range.
- For Next.js, use `@inkronik/node-sdk/next` from `instrumentation.ts`; do not add Express/Nest middleware or generic preload initialization to the same Next.js request path.
- Pair full-stack Next.js with an exact `@inkronik/browser-sdk` version and its `./next` entrypoint in `instrumentation-client.ts`. Keep the public Browser Source key separate from the secret server ingest key.
- Prefer `import '@inkronik/node-sdk/init'` as the first application import for environment-based configuration. Allow an environment or secrets loader before it only when that loader provides Inkronik variables.
- Preserve the existing start command unless Postgres.js requires preload or the user explicitly requests command-based initialization.
- Keep the existing `@inkronik/node-sdk/register` entrypoint working when auditing an older integration; migrate it only when requested or when touching the initialization path.
- Configure the appropriate Express or NestJS HTTP adapter. Do not assume the init entrypoint creates server request spans by itself.
- When the service accepts GraphQL, configure the HTTP adapter after parsed-body middleware and verify the exact optional `graphql` peer. Preserve the HTTP route as transport context while capturing one bounded logical operation per request.
- Keep `graphql.document` disabled unless the target repository has an explicit telemetry policy requesting searchable sanitized documents. Never enable raw document capture or copy GraphQL variables, arguments, persisted-query hashes, or result values into span attributes.
- Treat authenticated user propagation as required whenever the service has authentication. Do not consider automatic fallback detection sufficient for a nonstandard request shape.
- Treat database spans as required when the service accesses a supported database. Never accept a migration that silently drops them.
- Instrument cron, scheduled, worker, startup, and other requestless work with `withSpan()` or `@InkronikSpan()`.
- Add environment variable names to the repository's existing configuration and deployment templates, but never write secret values.
- Preserve redaction and avoid adding tokens, raw authorization data, email addresses, names, or other unnecessary personal data to attributes.

## Authenticated user context

Trace the request authentication flow from guard or middleware to the controller or handler. Identify the canonical request property and stable user identifier.

Configure `getUserContext` explicitly on the HTTP adapter when authentication exists. Return:

- a non-empty, stable string `id` required for authenticated requests;
- only allowlisted, non-sensitive string `attributes` needed for telemetry;
- `undefined` for anonymous requests.

Do not decode credentials again or derive identity from an unverified header. Reuse the authenticated principal already attached by the application. Keep the resolver lazy so authentication middleware or guards can populate the request before events and request completion are captured.

Add a regression test proving that:

- an authenticated request produces `user.id` on its server span;
- an event emitted inside that request inherits `user_id` and the selected `user.*` attributes;
- an anonymous request does not receive a fabricated identity.

## Database decision

- For `pg`, including TypeORM and Drizzle's `node-postgres` driver, use import-first initialization and verify a child database span under an active request or job span.
- For static `postgres` imports, including Drizzle's `postgres-js` driver, use Bun preload for transparent instrumentation. If changing the start command is unsuitable, wrap the shared Postgres.js client with `instrumentPostgres()` instead.
- Determine the actual Drizzle driver from imports and configuration. Do not infer it from the presence of `drizzle-orm` alone.

## Verification evidence

Verify behavior, not only compilation. Cover the applicable paths:

- one HTTP request creates exactly one server span;
- one named GraphQL request creates one operation span with its name/type and HTTP route, while an HTTP 200 response containing GraphQL errors is marked failed;
- anonymous, persisted, malformed, and batched GraphQL envelopes follow the documented bounded fallbacks without affecting ordinary REST requests;
- authenticated user context is retained;
- outbound fetch and database work are children of the active request or job span;
- a scheduled operation creates a root `scheduled` span when no request exists;
- shutdown flushes short-lived cron or worker processes;
- existing application behavior and error propagation remain unchanged.
- a Next.js build resolves both `./next` entrypoints, one client route transition creates one navigation view, and Node Runtime request spans do not duplicate server `fetch` spans;
- Edge routes evaluate the server entrypoint without importing Node-only code and match the documented no-op behavior.

If an end-to-end collector is unavailable, add focused tests around adapter inputs and emitted telemetry, then clearly identify the remaining live verification.
