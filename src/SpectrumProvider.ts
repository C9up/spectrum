import type { AppContext } from '@c9up/ream'
import { Logger } from './Logger.js'
import { ConsoleChannel } from './channels/ConsoleChannel.js'
import type { LogLevel } from './types.js'

export default class SpectrumProvider {
  constructor(protected app: AppContext) {}

  register() {
    this.app.container.singleton(Logger, () => {
      const config = this.app.config.get<{ level?: LogLevel }>('logger')
      return new Logger({
        level: config?.level ?? (process.env.LOG_LEVEL as LogLevel) ?? 'info',
        channels: [new ConsoleChannel('pretty')],
      })
    })

    this.app.container.singleton('logger', () => {
      return this.app.container.resolve<Logger>(Logger)
    })
  }

  async boot() {}
  async start() {}
  async ready() {}
  async shutdown() {}
}
