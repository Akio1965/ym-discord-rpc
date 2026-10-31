import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { StatusDisplayType, type Config } from './model.ts';

export const CONFIG_PATH = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'ym-discord-rpc', 'config.json');

export const DEFAULT_CONFIG: Config = {
  clientId: '',
  name: 'Яндекс Музыка',
  statusDisplayType: StatusDisplayType.State,
  buttons: ['web'],
  afkMinutes: 10,
  search: { yandex: true, itunes: true },
  dryRun: false,
  assets: { logo: 'logo', paused: 'paused' },
};

/** Reads CONFIG_PATH over defaults. Missing file is fine; without clientId we force dry run. */
export function loadConfig(path = CONFIG_PATH): Config {
  let user: Partial<Config> = {};
  try {
    user = JSON.parse(readFileSync(path, 'utf8')) as Partial<Config>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Invalid config ${path}: ${(err as Error).message}`);
  }
  const cfg: Config = {
    ...DEFAULT_CONFIG,
    ...user,
    search: { ...DEFAULT_CONFIG.search, ...user.search },
    assets: { ...DEFAULT_CONFIG.assets, ...user.assets },
  };
  if (process.env.YM_RPC_CLIENT_ID) cfg.clientId = process.env.YM_RPC_CLIENT_ID;
  if (process.env.YM_RPC_DRY_RUN === '1') cfg.dryRun = true;
  if (!cfg.clientId) cfg.dryRun = true;
  return cfg;
}
