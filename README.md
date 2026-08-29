# Inkronik Node SDK

Telemetry SDK for sending Node.js and Bun application signals to the Inkronik Collector.

## Installation

```bash
bun add @inkronik/node-sdk
```

The package requires Node.js 20 or newer. Bun is supported for preload-based automatic PostgreSQL instrumentation.

Both ESM `import` and CommonJS `require()` are supported. Applications may load the core, preload, Express, and NestJS entrypoints
independently; they share one process-level client and trace context so child spans remain correlated across package entrypoints.

## Configuration

Create an ingest API key in your Inkronik workspace and configure the SDK through environment variables:

```bash
export INKRONIK_COLLECTOR_URL=https://collector.inkronik.codemask.dev
export INKRONIK_INGEST_API_KEY=your_ingest_api_key
export INKRONIK_SERVICE_NAME=orders-api
```

`INKRONIK_APPLICATION_ID`, `INKRONIK_SERVICE_VERSION`, `INKRONIK_POD_NAME`, and `INKRONIK_ENVIRONMENT` are optional. Keep the ingest API key
server-side and never expose it in browser bundles or source control.

The package is split into:

- core client for logs, events, gauges, and manual telemetry;
- Next.js server instrumentation built on the framework's stable OpenTelemetry hooks;
- Express middleware for automatic HTTP span and request/response capture;
- NestJS interceptor for automatic HTTP span and request/response capture;
- NestJS logger adapter for forwarding application logs while preserving console output.
- runtime metrics for Node memory, uptime, and event loop lag;
- trace context propagation with W3C `traceparent`;
- automatic global `fetch`, `node:http`, and `node:https` instrumentation for downstream HTTP client spans, including Axios and Nest `HttpService`.
- automatic `postgres-js` and `pg` query instrumentation under the Bun preload agent.

## Core

```ts
import { createInkronikClientFromEnv } from '@inkronik/node-sdk'

const inkronik = createInkronikClientFromEnv()

inkronik.log({
    severityText: 'INFO',
    severityNumber: 9,
    message: 'Invoice created',
})

inkronik.event({
    name: 'invoice_created',
    category: 'billing',
    level: 'info',
    message: 'Invoice was created and queued for delivery',
    attributes: { invoice_id: invoice.uuid },
})

try {
    await capturePayment()
} catch (error) {
    inkronik.captureError(error, {
        name: 'payment_capture_failed',
        message: 'Payment remained pending and a retry was scheduled',
        attributes: { provider: 'stripe' },
    })
}

inkronik.startRuntimeMetrics()
const tracedFetch = inkronik.instrumentFetch()
```

Use `withSpan()` to trace work that does not begin with an incoming request, such as a cron run, startup task, or application-level operation:

```ts
const reconciled = await inkronik.withSpan({
    name: 'billing.reconcile',
    category: 'scheduled',
    attributes: {
        'job.schedule': '0 * * * *',
    },
    callback: () => reconcileBilling(),
})
```

The operation becomes a root span when no trace is active and a child span otherwise. Its callback runs inside the active Inkronik trace context,
so instrumented outbound HTTP, PostgreSQL queries, logs, events, and nested `withSpan()` calls remain correlated. Synchronous return values and promises are
preserved; thrown errors and rejected promises mark the span as failed and are rethrown unchanged. Manual spans default to the `internal` kind and
category. Short-lived processes such as Kubernetes CronJobs should call `await inkronik.shutdown()` before exiting so queued telemetry is flushed.

Log messages, log attributes, and log resource attributes are redacted in the SDK before they are queued. Sensitive keys such as
`setupToken`, `access_token`, `password`, and `authorization` are replaced with `[REDACTED]` by default, including when they appear in a
JSON-formatted message. Add application-specific keys or patterns, change the replacement, or explicitly disable log redaction when creating
the client:

```ts
const inkronik = createInkronikClientFromEnv({
    logRedaction: {
        fieldNames: ['merchantPrivateCode'],
        fieldPatterns: [/^internalCredential$/i],
        redactedValue: '<hidden>',
        // enabled: false, // explicit opt-out; avoid this for production telemetry
    },
})
```

Events support `info`, `warning`, and `error` levels and default to `info`. `captureError` records a handled error with its bounded type, message,
stack, and string code when available; it does not turn a successful request span into a failed span.

Inside Express or NestJS request instrumentation, events automatically inherit the active trace, span, session, and user ID. Configure
`getUserContext` on the adapter when events also need safe user attributes. An explicit event `user` overrides the inherited request user.

## Initialization

For environment-based configuration, add Inkronik as the first application import:

```ts
import '@inkronik/node-sdk/init'

import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module.js'
```

Environment or secrets loaders may run before Inkronik when they provide its configuration:

```ts
import 'dotenv/config'
import '@inkronik/node-sdk/init'
```

This initializes the default client, starts runtime metrics, and instruments global `fetch`, `node:http`, `node:https`, `pg`, and integrations loaded later. The
application start command does not need to change. Keep the Inkronik import ahead of framework, database, queue, and application imports.

### Full Postgres.js auto-instrumentation

Static Postgres.js imports are resolved before application imports execute. Bun therefore needs the preload hook to instrument
Postgres.js or Drizzle using the `postgres-js` driver transparently.

Load Inkronik before the application entrypoint:

```ts
// inkronik-trace.ts
import { initInkronik } from '@inkronik/node-sdk/auto'

export const inkronik = initInkronik()
```

```bash
bun --preload ./inkronik-trace.ts src/main.ts
```

For environment-only setup, preload the init entrypoint directly:

```bash
bun --preload @inkronik/node-sdk/init src/main.ts
```

The existing `@inkronik/node-sdk/register` entrypoint remains available as a backwards-compatible alias.

### Outbound HTTP auto-instrumentation

Preload initialization and the Express/NestJS adapters instrument global `fetch`, `node:http`, and `node:https` by default. Axios and Nest
`HttpService` use the instrumented Node transport automatically; applications do not need interceptors, a custom Axios adapter, or any other
Inkronik-specific HTTP configuration. Each transport request becomes a child `client` span and propagates W3C `traceparent` downstream.

The SDK excludes its own Collector delivery. If a request already contains `traceparent`, the Node transport preserves it and does not create a
second span, which prevents duplicates when a traced high-level client delegates to `node:http` or another tracer owns the request.

Standalone clients can install the same process instrumentation explicitly:

```ts
const restoreHttp = inkronik.instrumentNodeHttp()
const restoreFetch = inkronik.instrumentGlobalFetch()

// Optional manual teardown; inkronik.shutdown() also restores wrappers owned by the client.
restoreHttp()
restoreFetch()
```

## Next.js

Next.js 15 and newer can initialize server telemetry through its stable `instrumentation.ts` convention. Create this file at the application root
or under `src/` when the application uses a source directory:

```ts
// instrumentation.ts
export { onRequestError, register } from '@inkronik/node-sdk/next'
```

Configure the same server-only environment variables shown above. `register` connects Next.js' built-in OpenTelemetry request, rendering, route
handler, and server-operation spans to Inkronik. Existing Inkronik fetch, Node HTTP, PostgreSQL, BullMQ, logs, and manual spans inherit the active
Next.js trace. The adapter drops Next.js' overlapping `AppRender.fetch` span by default, so a downstream request is reported once by the richer
Inkronik transport instrumentation. It also awaits delivery of unhandled request errors and flushes completed root requests for serverless
runtimes.

To pass SDK options explicitly, wrap only registration and keep the error hook exported:

```ts
import { onRequestError, registerInkronikNext } from '@inkronik/node-sdk/next'

export const register = () =>
    registerInkronikNext({
        serviceName: 'storefront',
        instrumentations: { runtimeMetrics: false },
    })

export { onRequestError }
```

Server tracing currently targets the Next.js Node runtime. The entrypoint is safe to evaluate for Edge routes and becomes a no-op there; do not
expose `INKRONIK_INGEST_API_KEY` through `NEXT_PUBLIC_` variables. Add browser RUM and client navigation tracking separately through
`@inkronik/browser-sdk/next` and a Browser Source public key.

## Express

```ts
import express from 'express'
import { createInkronikClientFromEnv } from '@inkronik/node-sdk'
import { createInkronikExpressMiddleware } from '@inkronik/node-sdk/express'

const app = express()
const inkronik = createInkronikClientFromEnv()

app.use(express.json())
app.use(createInkronikExpressMiddleware({ client: inkronik }))
```

## NestJS

```ts
import { APP_INTERCEPTOR } from '@nestjs/core'
import { createInkronikClientFromEnv } from '@inkronik/node-sdk'
import { createInkronikNestMiddleware, InkronikNestInterceptor, InkronikNestLogger } from '@inkronik/node-sdk/nest'

const inkronik = createInkronikClientFromEnv()
const logger = new InkronikNestLogger({ client: inkronik })

export const inkronikInterceptorProvider = {
    provide: APP_INTERCEPTOR,
    useValue: new InkronikNestInterceptor(inkronik),
}
```

Register the early HTTP middleware immediately after creating the Nest application, while keeping the interceptor provider above:

```ts
const app = await NestFactory.create(AppModule, { bufferLogs: true })

app.use(createInkronikNestMiddleware({ client: inkronik }))
```

Scheduled Nest methods can use the `@InkronikSpan()` decorator. It uses the process-level default client configured by
`createInkronikClientFromEnv()` or `initInkronik()`:

```ts
import { Cron, CronExpression } from '@nestjs/schedule'
import { InkronikSpan } from '@inkronik/node-sdk/nest'

export class BillingScheduler {
    @Cron(CronExpression.EVERY_HOUR)
    @InkronikSpan({
        name: 'billing.reconcile',
        category: 'scheduled',
        attributes: { 'job.schedule': 'hourly' },
    })
    async reconcile(): Promise<void> {
        await reconcileBilling()
    }
}
```

The decorator preserves existing method metadata, arguments, `this`, return values, and errors, so it can be combined with Nest scheduling decorators.

The middleware covers responses produced before interceptors run, including guard failures, unmatched routes, and request parser errors.
The interceptor keeps framework exception details and stack traces for controller and pipe failures. Both adapters share request state, so a
request produces one server span rather than duplicate middleware and interceptor spans.

Pass `{ autoInstrumentFetch: false, autoInstrumentHttp: false }` to the Express middleware or NestJS interceptor options when another tracer
already owns global `fetch` and the Node HTTP transports. With preload initialization, use `instrumentations: { fetch: false, http: false }`.

## PostgreSQL

The SDK supports two PostgreSQL drivers with different initialization requirements:

- `pg` works with import-first initialization for TypeORM, Drizzle's `node-postgres` driver, direct `Client` queries, and direct `Pool`
  queries;
- `postgres` works transparently with Bun preload for Postgres.js and Drizzle's `postgres-js` driver.

TypeORM does not need Inkronik-specific database configuration. Its existing `pg` client and pool queries become child `database` spans under the active request trace.

### Postgres.js / Drizzle

With the Bun preload agent, application database code remains unchanged:

```ts
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'

const sql = postgres(process.env.DATABASE_URL!)

export const db = drizzle(sql)
```

Every Postgres.js client created after `initInkronik()` is automatically instrumented. The database name is read from the resolved
Postgres.js options. Each query becomes a child `database` span under the active request trace; tagged-template parameters are replaced
with `?`, while `unsafe()` statements are normalized and truncated before capture.

Configure or disable the automatic integration in the preload file:

```ts
import { initInkronik } from '@inkronik/node-sdk/auto'

initInkronik({
    instrumentations: {
        pg: {
            captureStatement: true,
            maxStatementLength: 2_000,
            peerService: 'postgres-primary',
        },
        postgres: {
            captureStatement: true,
            maxStatementLength: 2_000,
            peerService: 'postgres-primary',
        },
    },
})

// Use `pg: false` to disable automatic node-postgres / TypeORM instrumentation.
// Use `postgres: false` to disable automatic Postgres.js instrumentation.
```

Transparent Postgres.js module loading currently targets Bun preload. When running without it, use the manual API:

```ts
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { createInkronikClientFromEnv } from '@inkronik/node-sdk'

const inkronik = createInkronikClientFromEnv()
const sql = inkronik.instrumentPostgres({
    sql: postgres(process.env.DATABASE_URL!),
    databaseName: 'app',
    peerService: 'postgres-primary',
})
const db = drizzle(sql)
```

Pass `{ bufferLogs: true }` to `NestFactory.create`, then call `app.useLogger(logger)` and `app.flushLogs()` to forward Nest startup logs as well.

Request bodies and successful response samples are captured by default with a 16 KiB body limit. Response samples keep object fields, truncate strings to 10 characters, keep numbers/booleans, and keep only the first array item plus `...` when more items exist. Successful raw response bodies require `captureResponseBody: true`; error response bodies are captured automatically. Before telemetry is queued, the SDK recursively redacts sensitive JSON fields, token-bearing URL parameters, and JWT-like values. The Collector repeats server-side redaction before persistence.

Use `redaction.fieldNames` and `redaction.fieldPatterns` to add application-specific sensitive JSON fields, and `redaction.redactedValue` to change the replacement marker. These options only broaden redaction; built-in token patterns cannot be allowlisted for capture.

The NestJS interceptor also captures the Observable error path automatically. `HttpException` responses such as 400 validation errors retain their HTTP status and public response body. Other thrown values are recorded as 500 responses. Every response with status 400 or higher is marked as a failed request; thrown errors additionally attach their bounded type, message, code, and stack trace to the server span. The original exception continues through NestJS unchanged, so existing exception filters keep working without application-level Inkronik code.

Framework adapters resolve common trace user IDs from `request.user` or `request.currentAccount` by default. Fields outside the recognized
set, such as `userUUID`, require an explicit resolver. Configure `getUserContext` as well when correlated events need safe user attributes:

```ts
import type { EventUserContext, HttpLikeRequest } from '@inkronik/node-sdk'

const getUserContext = (request: HttpLikeRequest): EventUserContext | undefined => {
    const account = request.currentAccount as { readonly role?: string; readonly uuid?: string } | undefined

    if (account?.uuid === undefined || account.uuid === '') {
        return undefined
    }

    return {
        id: account.uuid,
        attributes: account.role === undefined ? {} : { role: account.role },
    }
}

new InkronikNestInterceptor(inkronik, { getUserContext })
```

The same option is available under `options` in `createInkronikExpressMiddleware`. The resolver runs lazily, so authentication middleware
or guards can attach the principal after tracing starts. Return only a stable user ID and allowlisted, non-sensitive string attributes;
do not copy tokens, authorization headers, or arbitrary principal fields into telemetry. Authenticated integration tests should verify
`user.id` on the server span and inherited `user_id` on events emitted inside the request.

Exclude health checks, metrics endpoints, or other requests before tracing:

```ts
new InkronikNestInterceptor(inkronik, {
    exclude: request => request.originalUrl === '/health',
})
```

The same `exclude(request)` option is available in `createInkronikExpressMiddleware`.

HTTP middleware emits:

- server span;
- `http.server.requests` sum;
- `http.server.duration` histogram;
- `http.server.errors` sum for 5xx responses.

Disable request/response capture explicitly for sensitive routes:

```ts
createInkronikExpressMiddleware({
    client: inkronik,
    options: {
        captureRequestResponse: false,
    },
})
```

## License

MIT License. See [LICENSE](./LICENSE).
