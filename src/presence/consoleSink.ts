// Dry-run sink: prints what would be sent to Discord instead of sending it.
import type { Activity, PresenceSink } from '../model.ts';

const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** "bar 1:10 / 3:43" as a viewer would see it right now; "elapsed 1:10" without an end. */
export function describeTimestamps(ts: Activity['timestamps'], now: number): string | undefined {
  if (ts?.start === undefined) return undefined;
  return ts.end === undefined ? `elapsed ${clock(now - ts.start)}` : `bar ${clock(now - ts.start)} / ${clock(ts.end - ts.start)}`;
}

export interface ConsoleSinkOptions {
  write?: (text: string) => void;
  now?: () => number;
}

export class ConsoleSink implements PresenceSink {
  private readonly write: (text: string) => void;
  private readonly now: () => number;

  constructor(opts: ConsoleSinkOptions = {}) {
    this.write = opts.write ?? ((text) => void process.stdout.write(text));
    this.now = opts.now ?? Date.now;
  }

  async setActivity(activity: Activity | null): Promise<void> {
    const now = this.now();
    const head = `${new Date(now).toISOString()} ${activity ? 'SET_ACTIVITY' : 'CLEAR_ACTIVITY'}`;
    const bar = activity && describeTimestamps(activity.timestamps, now);
    this.write(`${head}${bar ? ` (${bar})` : ''}\n${JSON.stringify(activity, null, 2)}\n`);
  }
}
