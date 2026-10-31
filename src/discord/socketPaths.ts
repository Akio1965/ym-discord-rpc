// Where a Discord client may listen for local RPC: native Discord, Flatpak, Snap and Vesktop (arRPC).
import { statSync } from 'node:fs';
import { posix } from 'node:path';

/** Native Discord binds the base dir itself; Flatpak, Snap and Vesktop/arRPC use sub-directories. */
const SUBDIRS = [
  '',
  'app/com.discordapp.Discord',
  'app/com.discordapp.DiscordCanary',
  'app/com.discordapp.DiscordPTB',
  'app/dev.vencord.Vesktop',
  '.flatpak/dev.vencord.Vesktop/xdg-run',
  'snap.discord',
];
/** Discord takes the first free discord-ipc-N, so N is not always 0. */
const INDEXES = Array.from({ length: 10 }, (_, i) => i);

/** Every candidate socket path in priority order (deduplicated). Pure: inputs are injectable; uid null = unknown. */
export function candidateSocketPaths(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  uid: number | null = process.getuid?.() ?? null,
): string[] {
  if (platform === 'win32') return INDEXES.map((i) => `\\\\?\\pipe\\discord-ipc-${i}`);
  const bases = [env.XDG_RUNTIME_DIR, env.TMPDIR, env.TMP, env.TEMP, uid === null ? undefined : `/run/user/${uid}`, '/tmp'];
  const out = new Set<string>();
  for (const base of bases) {
    if (!base || !posix.isAbsolute(base)) continue;
    for (const sub of SUBDIRS) for (const i of INDEXES) out.add(posix.join(base, sub, `discord-ipc-${i}`));
  }
  return [...out];
}

function isSocket(path: string): boolean {
  try {
    return statSync(path, { throwIfNoEntry: false })?.isSocket() ?? false;
  } catch {
    return false;
  }
}

/**
 * Default discovery for DiscordIpc: candidates that exist as sockets right now, so a retry
 * cycle does not attempt ~400 connections. Named pipes are not stat'ed (that would open them).
 */
export function discoverSocketPaths(
  candidates: string[] = candidateSocketPaths(),
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = isSocket,
): string[] {
  return platform === 'win32' ? candidates : candidates.filter(exists);
}
