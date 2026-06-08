# @c9up/spectrum

Structured logging for Node.js. Levels, channels, correlation IDs, per-module overrides.

## Usage

```typescript
import { Logger, ConsoleChannel } from '@c9up/spectrum'

const logger = new Logger({
  level: 'info',
  channels: [new ConsoleChannel('pretty')],
})

logger.info('Server started', { port: 3000 })
logger.child({ module: 'db', correlationId: 'abc-123' }).debug('Query executed')
```

## Features

- 6 log levels: trace, debug, info, warn, error, fatal
- ConsoleChannel (pretty + JSON formats)
- Per-module level overrides
- Child loggers with scoped module/correlationId
- error/fatal → stderr, others → stdout

## License

MIT
