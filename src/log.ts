// Minimal leveled logger to stderr (journald picks it up under systemd).
type Level = 'debug' | 'info' | 'warn' | 'error';
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = order[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? order.info;

function emit(level: Level, scope: string, msg: string, extra?: unknown): void {
  if (order[level] < threshold) return;
  const tail = extra === undefined ? '' : ' ' + (extra instanceof Error ? extra.stack ?? extra.message : JSON.stringify(extra));
  process.stderr.write(`${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}${tail}\n`);
}

export function logger(scope: string) {
  return {
    debug: (msg: string, extra?: unknown) => emit('debug', scope, msg, extra),
    info: (msg: string, extra?: unknown) => emit('info', scope, msg, extra),
    warn: (msg: string, extra?: unknown) => emit('warn', scope, msg, extra),
    error: (msg: string, extra?: unknown) => emit('error', scope, msg, extra),
  };
}
export type Logger = ReturnType<typeof logger>;
