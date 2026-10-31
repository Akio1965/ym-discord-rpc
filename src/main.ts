// Daemon entry point: MPRIS → catalog lookup → presence engine → Discord IPC (stdout in dry run).
import { App } from './app.ts';
import { CONFIG_PATH, loadConfig } from './config.ts';
import { DiscordIpc } from './discord/ipc.ts';
import { createEnricher } from './enrich/index.ts';
import { logger } from './log.ts';
import type { Config } from './model.ts';
import { ConsoleSink } from './presence/consoleSink.ts';
import { MprisSource } from './sources/mpris.ts';

const log = logger('main');
/** Bound on the clear + socket close at shutdown; closing the socket clears the presence anyway. */
const SHUTDOWN_TIMEOUT_MS = 5000;

process.on('unhandledRejection', (err) => log.error('unhandled rejection', err));

let cfg: Config;
try {
  cfg = loadConfig();
} catch (err) {
  log.error((err as Error).message);
  process.exit(1);
}
// The Application ID is public, but there is nothing to gain from printing it.
log.info('starting', { config: CONFIG_PATH, ...cfg, clientId: cfg.clientId ? 'set' : 'unset' });
if (cfg.dryRun) log.warn(cfg.clientId ? 'dry run: activities go to stdout, not Discord' : `no clientId in ${CONFIG_PATH}: dry run, activities go to stdout`);

const ipc = cfg.dryRun ? undefined : new DiscordIpc({ clientId: cfg.clientId });
const app = new App({ cfg, sink: ipc ?? new ConsoleSink(), source: new MprisSource(), enricher: createEnricher(cfg.search) });
// DiscordIpc logs READY/disconnects itself and re-sends the last activity after a reconnect;
// a cover rejected during that re-send must still fall back to the logo.
ipc?.on('resendFailed', (err, activity) => app.engine.sinkFailed(activity, err));

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    log.warn(`${signal} again, exiting without cleanup`);
    process.exit(0);
  }
  shuttingDown = true;
  log.info(`${signal}: clearing presence and exiting`);
  const force = setTimeout(() => {
    log.warn(`shutdown took over ${SHUTDOWN_TIMEOUT_MS} ms, exiting anyway`);
    process.exit(0);
  }, SHUTDOWN_TIMEOUT_MS);
  await app.stop();
  clearTimeout(force);
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.start();
  log.info('watching MPRIS for Yandex Music');
} catch (err) {
  log.error('cannot start', err);
  await app.stop();
  process.exit(1);
}
