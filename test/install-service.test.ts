// scripts/install-service.sh in a sandbox: a copy of the repo under an awkward path, a temporary
// XDG_CONFIG_HOME and logging stubs for systemctl/systemd-analyze. Nothing touches the real user session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const UNIT = 'ym-discord-rpc.service';
const skip = spawnSync('bash', ['--version']).status === 0 ? false : 'bash is not installed';

/** What systemd needs inside one double-quoted ExecStart= item (function replacers: '$$' is special in replaceAll). */
const execItem = (s: string): string => `"${s.replaceAll('%', () => '%%').replaceAll('$', () => '$$')}"`;

test('install-service.sh --no-start fills both placeholders and leaves the rest of the template alone', { skip }, (t) => {
  const sandbox = mkdtempSync(join(tmpdir(), 'ym-rpc-install-'));
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));

  const repo = join(sandbox, 'my repo 100% $HOME & co');
  for (const dir of ['scripts', 'packaging', 'src', 'node_modules/@jellybrick/dbus-next']) mkdirSync(join(repo, dir), { recursive: true });
  copyFileSync(join(ROOT, 'scripts/install-service.sh'), join(repo, 'scripts/install-service.sh'));
  copyFileSync(join(ROOT, 'packaging', UNIT), join(repo, 'packaging', UNIT));
  writeFileSync(join(repo, 'src/main.ts'), '');

  const bin = join(sandbox, 'bin');
  const calls = join(sandbox, 'calls.log');
  mkdirSync(bin);
  for (const name of ['systemctl', 'systemd-analyze']) {
    writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s\\n' "${name} $*" >>"$STUB_LOG"\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const config = join(sandbox, 'config');

  const run = spawnSync('bash', [join(repo, 'scripts/install-service.sh'), '--no-start'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: join(sandbox, 'home'), XDG_CONFIG_HOME: config, NODE: process.execPath, STUB_LOG: calls },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /systemctl --user enable --now ym-discord-rpc\.service/);

  const unitDir = join(config, 'systemd/user');
  assert.deepEqual(readdirSync(unitDir), [UNIT], 'no temporary file left behind');
  const unit = readFileSync(join(unitDir, UNIT), 'utf8').split('\n');
  const template = readFileSync(join(ROOT, 'packaging', UNIT), 'utf8').split('\n');
  const real = realpathSync(repo);
  const expected = template.map((line) => {
    if (line.startsWith('WorkingDirectory=')) return `WorkingDirectory=${real.replaceAll('%', () => '%%')}`;
    if (line.startsWith('ExecStart=')) return `ExecStart=${execItem(process.execPath)} ${execItem(`${real}/src/main.ts`)}`;
    return line;
  });
  assert.deepEqual(unit, expected);
  assert.ok(unit.some((line) => line.startsWith('#') && line.includes('/ПУТЬ/К/node')), 'header comments still document the placeholders');

  const log = readFileSync(calls, 'utf8');
  assert.match(log, /^systemd-analyze --user verify /m);
  assert.doesNotMatch(log, /daemon-reload|enable|restart/, '--no-start must not touch the service');
});
