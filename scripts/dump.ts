// Dry run against the live player: prints snapshots, the chosen catalog match and the activities that
// would be sent, then exits. Never touches Discord (always the console sink).
// Usage: node scripts/dump.ts [seconds=30]   (LOG_LEVEL=debug shows MPRIS and lookup decisions)
import { App } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { createEnricher } from '../src/enrich/index.ts';
import { ConsoleSink } from '../src/presence/consoleSink.ts';
import { MprisSource } from '../src/sources/mpris.ts';

const arg = Number(process.argv[2] ?? 30);
const seconds = Number.isFinite(arg) && arg > 0 ? arg : 30;

const print = (label: string, value: unknown) =>
  process.stdout.write(`${new Date().toISOString()} ${label}\n${JSON.stringify(value, null, 2)}\n`);

const cfg = { ...loadConfig(), dryRun: true };
const app = new App({
  cfg,
  sink: new ConsoleSink(),
  source: new MprisSource(),
  enricher: createEnricher(cfg.search),
  onSnapshot: (s) => print('SNAPSHOT', s),
  onTrackInfo: (_s, info) => print('TRACK_INFO', info),
});

process.on('unhandledRejection', (err) => console.error('unhandled rejection', err));
const finish = async () => {
  clearTimeout(timer);
  await app.stop();
  process.exit(0);
};
const timer = setTimeout(() => void finish(), seconds * 1000);
process.once('SIGINT', () => void finish());
process.stderr.write(`dumping for ${seconds} s (Ctrl+C to stop early)\n`);
await app.start();
