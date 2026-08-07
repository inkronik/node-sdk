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
- Express middleware for automatic HTTP span and request/response capture;
- NestJS interceptor for automatic HTTP span and request/response capture;
- NestJS logger adapter for forwarding application logs while preserving console output.
- runtime metrics for Node memory, uptime, and event loop lag;
- trace context propagation with W3C `traceparent`;
- automatic `fetch` instrumentation for downstream HTTP client spans in framework adapters.
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

## Agent Preload

Load Inkronik before the application entrypoint:

```ts
// inkronik-trace.ts
import { initInkronik } from '@inkronik/node-sdk/auto'

export const inkronik = initInkronik()
```

```bash
bun --preload ./inkronik-trace.ts src/main.ts
```

For env-only setup, preload the register entrypoint directly:

```bash
bun --preload @inkronik/node-sdk/register src/main.ts
```

The preload agent initializes the default client, starts runtime metrics, and instruments global `fetch`, Postgres.js, and `pg` before application code runs.

Use `instrumentFetch()` or `instrumentGlobalFetch()` in standalone Node processes. Express and NestJS adapters enable global `fetch`
instrumentation by default, so outbound `fetch` calls made while handling a request appear as child `client` spans and propagate
`traceparent` downstream.

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

The middleware covers responses produced before interceptors run, including guard failures, unmatched routes, and request parser errors.
The interceptor keeps framework exception details and stack traces for controller and pipe failures. Both adapters share request state, so a
request produces one server span rather than duplicate middleware and interceptor spans.

Pass `{ autoInstrumentFetch: false }` to the Express middleware or NestJS interceptor options when another tracer already patches
global `fetch`.

## PostgreSQL

The preload agent automatically instruments both supported PostgreSQL drivers:

- `postgres` for Postgres.js and Drizzle;
- `pg` for TypeORM, direct `Client` queries, and direct `Pool` queries.

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

Automatic module loading currently targets Bun. When running without the Bun preload agent, use the manual API:

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

Framework adapters resolve the trace user id from `request.user` or `request.currentAccount` by default, preferring `uuid`, then `id`. Pass `getUserId` when your authentication context uses a different shape.

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
