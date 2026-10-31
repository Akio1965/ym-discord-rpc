// Read-only smoke test: prints every MPRIS snapshot as one JSON line for N seconds, then stops.
// Usage: node scripts/live-mpris.ts [seconds=20]   (LOG_LEVEL=debug shows discovery/seek/rate decisions)
import { MprisSource } from '../src/sources/mpris.ts';

const arg = Number(process.argv[2] ?? 20);
const seconds = Number.isFinite(arg) && arg > 0 ? arg : 20;

const source = new MprisSource();
await source.start((snapshot) => process.stdout.write(JSON.stringify(snapshot) + '\n'));
// stop() releases the bus and all timers, so the process exits on its own.
const timer = setTimeout(() => void source.stop(), seconds * 1000);
process.once('SIGINT', () => {
  clearTimeout(timer);
  void source.stop();
});
