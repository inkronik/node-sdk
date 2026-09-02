# Inkronik Node SDK integration patterns

Read only the sections matching the target service.

## Initialization

For environment-based configuration, make this the first application import:

```ts
import '@inkronik/node-sdk/init'
```

An environment loader may precede it:

```ts
import 'dotenv/config'
import '@inkronik/node-sdk/init'
```

Required environment variables:

```text
INKRONIK_COLLECTOR_URL
INKRONIK_INGEST_API_KEY
INKRONIK_SERVICE_NAME
```

Use `INKRONIK_APPLICATION_ID`, `INKRONIK_ENVIRONMENT`, and `INKRONIK_SERVICE_VERSION` when the target deployment requires them. Follow the target repository's configuration validation and deployment conventions.

## Next.js

Use the framework entrypoints instead of generic preload or HTTP middleware. Install exact releases containing the `./next` exports, then add
server instrumentation at the project root or under `src/`:

```ts
// instrumentation.ts
export { onRequestError, register } from '@inkronik/node-sdk/next'
```

The complete server path targets the Next.js Node Runtime. The entrypoint is safe to evaluate for Edge routes and intentionally does nothing there.
Do not work around this boundary by exposing the server ingest key to browser or Edge client code. Do not register another OpenTelemetry provider or
add Express/Nest request middleware unless the repository proves a separate request pipeline needs it.

For a full-stack application, add browser instrumentation through the official Next.js client hook:

```ts
// instrumentation-client.ts
import { createInkronikNext } from '@inkronik/browser-sdk/next'

export const { client: inkronik, onRouterTransitionStart } = createInkronikNext({
    publicKey: process.env.NEXT_PUBLIC_INKRONIK_PUBLIC_KEY!,
    collectorUrl: process.env.NEXT_PUBLIC_INKRONIK_COLLECTOR_URL!,
    environment: process.env.NEXT_PUBLIC_INKRONIK_ENVIRONMENT ?? 'development',
    tracePropagationOrigins: ['https://api.example.com'],
})
```

Use two application-scoped credentials:

- `INKRONIK_INGEST_API_KEY` is a show-once server secret and must never use the `NEXT_PUBLIC_` prefix;
- `NEXT_PUBLIC_INKRONIK_PUBLIC_KEY` is the Browser Source key, constrained to browser telemetry and exact allowed origins.

Initialize browser telemetry only after the application's consent policy permits it. The Next.js adapter disables the generic History patch and
uses `onRouterTransitionStart`, preventing one transition from producing duplicate navigation views. Verify a production Next.js build, one real
route transition, one Node Runtime request trace, downstream child spans, server error delivery, and the documented Edge no-op.

## Authenticated user resolver

Use the authenticated principal attached by the application. Adapt property names to the actual request type and keep reusable shapes in the target module's `types.ts` when its repository conventions require it.

```ts
import type { EventUserContext, HttpLikeRequest } from '@inkronik/node-sdk'

export const getInkronikUserContext = (request: HttpLikeRequest): EventUserContext | undefined => {
    const account = request.currentAccount as { readonly role?: string; readonly tenantId?: string; readonly uuid?: string } | undefined

    if (account?.uuid === undefined || account.uuid === '') {
        return undefined
    }

    return {
        id: account.uuid,
        attributes: {
            ...(account.role === undefined ? {} : { role: account.role }),
            ...(account.tenantId === undefined ? {} : { tenant_id: account.tenantId }),
        },
    }
}
```

Do not copy the example shape blindly. Inspect the authentication guard or middleware and use its verified principal. Prefer an opaque application user or account ID. Exclude email, name, tokens, authorization headers, and arbitrary principal fields unless the repository has an explicit telemetry policy allowing them.

The SDK automatically recognizes common IDs on `request.user` and `request.currentAccount`, but fields such as `userUUID` are nonstandard and
need an explicit resolver. An explicit resolver prevents these authentication shapes from losing identity and is required by this skill when
authentication exists.

## NestJS

Use the default client initialized by the first import and pass the same resolver to the HTTP instrumentation:

```ts
import { APP_INTERCEPTOR } from '@nestjs/core'
import { getDefaultInkronikClient } from '@inkronik/node-sdk'
import { InkronikNestInterceptor } from '@inkronik/node-sdk/nest'
import { getInkronikUserContext } from './inkronik-user-context.js'

const inkronik = getDefaultInkronikClient()

export const inkronikInterceptorProvider = {
    provide: APP_INTERCEPTOR,
    useValue: new InkronikNestInterceptor(inkronik, {
        getUserContext: getInkronikUserContext,
    }),
}
```

Keep the early Nest middleware if the service uses it for trace propagation. Pass the same `getUserContext` option when it owns request capture; do not configure two adapters to emit duplicate request spans.

## Express

```ts
import { getDefaultInkronikClient } from '@inkronik/node-sdk'
import { createInkronikExpressMiddleware } from '@inkronik/node-sdk/express'
import { getInkronikUserContext } from './inkronik-user-context.js'

app.use(
    createInkronikExpressMiddleware({
        client: getDefaultInkronikClient(),
        options: { getUserContext: getInkronikUserContext },
    }),
)
```

The resolver is evaluated lazily. The Inkronik middleware may start tracing before authentication middleware as long as authentication attaches the principal before handlers emit events and before the response finishes.

## GraphQL request operations

Use this path when an Express or NestJS service accepts GraphQL JSON envelopes. The adapter needs a parsed `request.body`, so register `express.json()` or the framework body parser before Inkronik. Verify that the service has the SDK's exact optional parser peer:

```sh
bun add graphql@16.11.0
```

GraphQL document attributes are disabled by default. Named operations still produce `graphql.operation.name`, `graphql.operation.type`, and a logical label such as `query GetOrder`; the original method and route remain available as transport context.

Enable searchable document structure only when the application's telemetry policy explicitly permits it:

```ts
app.use(express.json())
app.use(
    createInkronikExpressMiddleware({
        client: getDefaultInkronikClient(),
        options: {
            graphql: {
                captureDocument: 'sanitized',
                maxDocumentBytes: 4_096,
            },
        },
    }),
)
```

For NestJS, pass the same option to the global interceptor:

```ts
new InkronikNestInterceptor(getDefaultInkronikClient(), {
    graphql: {
        captureDocument: 'sanitized',
        maxDocumentBytes: 4_096,
    },
})
```

Exercise the integration with a real named request rather than checking configuration only:

```sh
curl http://localhost:3000/graphql \
  --header 'content-type: application/json' \
  --data '{"operationName":"GetOrder","query":"query GetOrder($id: ID!) { order(id: $id) { id status } }","variables":{"id":"order_123"}}'
```

Verify one server span named `query GetOrder`, `graphql.operation.name=GetOrder`, `graphql.operation.type=query`, and the original `POST /graphql` transport. A response containing an `errors` array must mark the operation failed even with HTTP 200. Also verify deterministic anonymous, persisted, malformed, and batch behavior when the target service accepts those request shapes.

Sanitized capture removes comments and literal/default values. Variables remain only in the existing bounded and redacted request evidence; never copy them, arguments, result values, or persisted-query hashes into span attributes. Do not add a raw document mode.

## Scheduled and background work

For NestJS scheduled methods:

```ts
import { InkronikSpan } from '@inkronik/node-sdk/nest'

@InkronikSpan({ name: 'sales.import', category: 'scheduled' })
async runImport(): Promise<void> {
    await this.importSales()
}
```

For framework-independent work:

```ts
await inkronik.withSpan({
    name: 'sales.import',
    category: 'scheduled',
    callback: () => importSales(),
})
```

Call `await inkronik.shutdown()` before a short-lived process exits.

## PostgreSQL

`pg` is patched by import-first initialization and covers direct `Client`/`Pool`, TypeORM, and Drizzle's `node-postgres` driver.

Static Postgres.js imports need Bun preload for transparent instrumentation:

```bash
bun --preload @inkronik/node-sdk/init src/main.ts
```

When preload is unsuitable, wrap the shared Postgres.js client before passing it to Drizzle:

```ts
const sql = inkronik.instrumentPostgres({
    sql: postgres(process.env.DATABASE_URL!),
    peerService: 'postgres-primary',
})
```

Verify an actual query creates a database child span. A successful application query without a telemetry assertion is insufficient.
