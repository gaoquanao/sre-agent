export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogEntry {
  ts: number
  level: LogLevel
  scope: string
  text: string
}

export type LogSink = (entry: LogEntry) => void

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

/**
 * Small scoped logger. Keeps a bounded ring buffer so the web UI can show recent
 * platform logs without a log-shipping dependency.
 */
export class Logger {
  private readonly scope: string
  private readonly minLevel: LogLevel
  private readonly sinks: LogSink[] = []
  private readonly ring: LogEntry[] = []
  private readonly ringSize: number

  constructor(scope: string, options: { minLevel?: LogLevel; ringSize?: number } = {}) {
    this.scope = scope
    this.minLevel = options.minLevel ?? (process.env.SRE_AGENT_DEBUG ? 'debug' : 'info')
    this.ringSize = options.ringSize ?? 500
  }

  child(scope: string): Logger {
    const child = new Logger(`${this.scope}.${scope}`, { minLevel: this.minLevel, ringSize: this.ringSize })
    for (const sink of this.sinks) child.addSink(sink)
    return child
  }

  addSink(sink: LogSink): () => void {
    this.sinks.push(sink)
    return () => {
      const index = this.sinks.indexOf(sink)
      if (index >= 0) this.sinks.splice(index, 1)
    }
  }

  history(): LogEntry[] {
    return [...this.ring]
  }

  debug(text: string): void {
    this.write('debug', text)
  }

  info(text: string): void {
    this.write('info', text)
  }

  warn(text: string): void {
    this.write('warn', text)
  }

  error(text: string, error?: unknown): void {
    this.write('error', error === undefined ? text : `${text}: ${describeError(error)}`)
  }

  private write(level: LogLevel, text: string): void {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[this.minLevel]) return
    const entry: LogEntry = { ts: Date.now(), level, scope: this.scope, text }
    this.ring.push(entry)
    if (this.ring.length > this.ringSize) this.ring.splice(0, this.ring.length - this.ringSize)
    const line = `[${new Date(entry.ts).toISOString()}] ${level.toUpperCase().padEnd(5)} ${entry.scope}: ${text}`
    if (level === 'error' || level === 'warn') console.error(line)
    else console.log(line)
    for (const sink of this.sinks) {
      try {
        sink(entry)
      } catch {
        // A failing sink must never break the caller.
      }
    }
  }
}

export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause
    return cause === undefined ? error.message : `${error.message} (cause: ${describeError(cause)})`
  }
  return String(error)
}
