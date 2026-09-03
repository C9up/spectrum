# @c9up/spectrum

Structured logging for Node.js. Levels, channels, correlation IDs, per-module
overrides, redaction.

## Usage

```typescript
// config/logger.ts
import { defineConfig, logLevel, targets } from '@c9up/spectrum'

const inProduction = process.env.NODE_ENV === 'production'

export default defineConfig({
  default: 'app',
  loggers: {
    app: {
      enabled: true,
      name: 'app',
      level: logLevel(process.env.LOG_LEVEL),
      redact: { paths: ['*.password', 'req.headers.authorization'] },
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
logger.child({ module: 'db', correlationId: 'abc-123' }).debug('Query executed')
```

## Features

- 6 log levels: trace, debug, info, warn, error, fatal
- ConsoleChannel (pretty + JSON formats) and FileChannel (rotating)
- Transport targets, with a level per destination
- Redaction (`*.password`, `users[*].token`, `headers["set-cookie"]`)
- Per-module level overrides
- Child loggers with scoped module/correlationId
- error/fatal → stderr, others → stdout

## License

MIT
