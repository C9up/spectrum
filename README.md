# @c9up/spectrum

Structured logging for Node.js. Levels, channels, correlation IDs, per-module
overrides, redaction.

## Usage

```typescript
// config/logger.ts
import { defineConfig, logLevel, stdSerializers, targets } from '@c9up/spectrum'

const inProduction = process.env.NODE_ENV === 'production'

export default defineConfig({
  default: 'app',
  loggers: {
    app: {
      enabled: true,
      name: 'app',
      level: logLevel(process.env.LOG_LEVEL),
      // `req` / `res` (ctx.request, ctx.response, or Node's) are written
      // without body or cookie map; the paths censor their credential headers.
      serializers: { req: stdSerializers.req, res: stdSerializers.res },
      redact: {
        paths: [
          '*.password',
          'req.headers.authorization',
          'req.headers.cookie',
          'res.headers["set-cookie"]',
        ],
      },
      transport: {
        targets: targets()
          .pushIf(!inProduction, targets.pretty())
          .pushIf(inProduction, targets.file({ destination: 1 }))
          .toArray(),
      },
    },
  },
})
```

```typescript
import logger from '@c9up/spectrum/services/main'

logger.info('Server started', { port: 3000 })
// The object is always fields; the message is written as given, `%` included.
logger.warn(`login failed for ${email}`, { req: ctx.request })
logger.child({ module: 'db', correlationId: 'abc-123' }).debug('Query executed')
```

## Features

- 6 log levels: trace, debug, info, warn, error, fatal; an unknown level throws
- JSON lines in the usual shape: `{"level":30,"time":…,"pid":…,"hostname":…,"msg":…}`,
  shaped by `messageKey`, `timestamp`, `base` and `formatters`
- ConsoleChannel (pretty + JSON) and FileChannel (rotating, flushed on exit,
  bounded buffer)
- Transport targets (`pino-pretty`, `pino/file`, or a `LogChannel`), with a
  level per destination; `destination` for a path, a descriptor or a stream
- Redaction (`*.password`, `users[*].token`, `headers["set-cookie"]`), with
  `censor` as a value or a function, and `remove`
- `mixin`, `hooks.logMethod`, `errorKey`, `msgPrefix`, `depthLimit` / `edgeLimit`
- Child loggers with scoped module/correlationId, and `child(bindings, { level, redact, serializers, msgPrefix })`
- `stdSerializers` (`err`, `req`, `res`) and `stdTimeFunctions`. `req` and
  `res` read Node's request and response and the framework's (`ctx.request`,
  `ctx.response`); they write every header unchanged, cookies and
  `authorization` included, and never the body: list the headers to censor in
  `redact`, as the example above does
- printf tokens (`%s %d %i %f %j %o %O %%`) when two values or more follow the
  message; an object written by `%j` / `%o` / `%O` is serialized and redacted
- Per-module level overrides
- Pretty console: error/fatal → stderr, others → stdout

## Not supported

Spectrum writes through its own channels rather than pino streams, so these
are not available: `destination()`, `destinations`, `multistream()` and
`transport()` exports, worker-thread transports (`pino-loki`, `pino-socket`…:
plug a `LogChannel` instead), `transport.pipeline`, `customLevels`,
`useOnlyCustomLevels`, `levelComparison`, `nestedKey`, `crlf`,
`hooks.streamWrite`, and the `pinoVersion` / `version` getters. The options
among them throw when configured, so a config is never run as something else.

## License

MIT
