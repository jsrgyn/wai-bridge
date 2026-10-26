import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REAL_SCRIPT = resolve(__dirname, '../../scripts/restart-local-services.sh');

interface Scenario {
  dataDir?: string;
  schema: number;
  latest: number;
  pid?: string;
  etime?: string;
  distAgeSeconds: number;
}

let dir: string;

function stub(name: string, body: string): void {
  const file = join(dir, 'bin', name);
  writeFileSync(file, `#!/bin/bash\n${body}\n`);
  chmodSync(file, 0o755);
}

function setup(s: Scenario): { script: string; env: NodeJS.ProcessEnv; db: string } {
  const root = join(dir, 'repo');
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'apps/local-api/dist'), { recursive: true });
  mkdirSync(join(root, 'packages/database/src/migrations'), { recursive: true });
  mkdirSync(join(dir, 'bin'), { recursive: true });
  const dataDir = join(dir, s.dataDir ?? 'data');
  mkdirSync(dataDir, { recursive: true });
  const script = join(root, 'scripts/restart-local-services.sh');
  copyFileSync(REAL_SCRIPT, script);
  chmodSync(script, 0o755);
  for (let n = 1; n <= s.latest; n++) {
    writeFileSync(
      join(root, `packages/database/src/migrations/${String(n).padStart(3, '0')}-synthetic.sql`),
      '-- synthetic\n',
    );
  }
  const main = join(root, 'apps/local-api/dist/main.js');
  writeFileSync(main, '// synthetic build\n');
  const built = new Date(Date.now() - s.distAgeSeconds * 1000);
  utimesSync(main, built, built);

  const db = join(dataDir, 'synthetic.sqlite');
  const sqlite = new Database(db);
  sqlite.exec('CREATE TABLE wa_schema_migrations (version INTEGER PRIMARY KEY, name TEXT)');
  for (let n = 1; n <= s.schema; n++) {
    sqlite.prepare('INSERT INTO wa_schema_migrations(version,name) VALUES(?,?)').run(n, 'x');
  }
  sqlite.close();

  stub(
    'launchctl',
    s.pid
      ? `echo "gui/501/com.wai-bridge.local-api = {"; echo "	pid = ${s.pid}"; echo "}"`
      : 'echo "Could not find service" >&2; exit 113',
  );
  stub('ps', `echo "${s.etime ?? '00:10'}"`);
  stub('pnpm', 'echo "pnpm must not run in --check" >&2; exit 99');

  return {
    script,
    db,
    env: {
      PATH: `${join(dir, 'bin')}:/usr/bin:/bin`,
      HOME: join(dir, 'home'),
      WAI_BRIDGE_DB_PATH: db,
      LANG: 'C',
    },
  };
}

function check(s: Scenario) {
  const { script, env, db } = setup(s);
  const before = readFileSync(db);
  const result = spawnSync('/bin/bash', [script, '--check'], { env, encoding: 'utf8' });
  expect(readFileSync(db).equals(before)).toBe(true);
  return result;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wai-restart-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('restart-local-services.sh --check', () => {
  it('exits 1 with "reinício necessário" when the schema is behind the latest migration', () => {
    const r = check({ schema: 16, latest: 18, pid: '4242', etime: '00:10', distAgeSeconds: 3600 });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('reinício necessário');
    expect(r.stdout).toContain('16');
  });

  it('exits 1 when the API process started before the current build', () => {
    const r = check({ schema: 18, latest: 18, pid: '4242', etime: '02:00:00', distAgeSeconds: 60 });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('reinício necessário');
  });

  it('exits 1 when the process is old (days) and the build is newer', () => {
    const r = check({ schema: 18, latest: 18, pid: '4242', etime: '3-04:05:06', distAgeSeconds: 60 });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('reinício necessário');
  });

  it('exits 0 when the process is newer than the build and the schema is current', () => {
    const r = check({ schema: 18, latest: 18, pid: '4242', etime: '00:10', distAgeSeconds: 3600 });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('ok');
  });

  it('exits 1 with a clear message when the API process is not running', () => {
    const r = check({ schema: 18, latest: 18, distAgeSeconds: 3600 });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('não está em execução');
  });

  it('rejects unknown arguments without side effects', () => {
    const { script, env } = setup({ schema: 18, latest: 18, pid: '1', distAgeSeconds: 10 });
    const r = spawnSync('/bin/bash', [script, '--bogus'], { env, encoding: 'utf8' });
    expect(r.status).toBe(2);
  });
});

describe('restart-local-services.sh (restart mode, stubs only)', () => {
  function restartSetup(opts: { sqliteFails?: boolean; dataDir?: string }) {
    const s = setup({
      schema: 18,
      latest: 18,
      pid: '100',
      etime: '00:01',
      distAgeSeconds: 10,
      ...(opts.dataDir ? { dataDir: opts.dataDir } : {}),
    });
    const log = join(dir, 'calls.log');
    const pidFile = join(dir, 'pid');
    writeFileSync(pidFile, '100');
    stub(
      'launchctl',
      `if [ "$1" = "kickstart" ]; then echo kickstart >> "${log}"; echo 200 > "${pidFile}"; exit 0; fi
echo "gui/501/x = {"; echo "	pid = $(cat "${pidFile}")"; echo "}"`,
    );
    stub('pnpm', `echo build >> "${log}"`);
    stub('sleep', 'exit 0');
    if (opts.sqliteFails) stub('sqlite3', 'exit 1');
    return { ...s, log };
  }

  it('creates a verified 600 backup, kickstarts and confirms the schema', () => {
    const { script, env, log } = restartSetup({});
    const r = spawnSync('/bin/bash', [script], { env, encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(readFileSync(log, 'utf8')).toBe('build\nkickstart\n');
    const backups = spawnSync('/bin/ls', [join(dir, 'data')], { encoding: 'utf8' }).stdout;
    const name = backups.split('\n').find((f) => f.startsWith('backup-'));
    expect(name).toMatch(/^backup-\d{8}-\d{6}\.sqlite$/);
    const mode = statSync(join(dir, 'data', name as string)).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(r.stdout).toContain('recarregue a extensão');
  });

  it('aborts before kickstart when the backup fails', () => {
    const { script, env, log } = restartSetup({ sqliteFails: true });
    const r = spawnSync('/bin/bash', [script], { env, encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('backup falhou');
    expect(readFileSync(log, 'utf8')).toBe('build\n');
  });

  it.each(["App Support 'quoted'", 'App Support', 'odd#dir', 'odd?dir', 'odd%20dir'])(
    'handles a data directory named %s (check and backup)',
    (name) => {
      const { script, env, log } = restartSetup({ dataDir: name });
      const c = spawnSync('/bin/bash', [script, '--check'], { env, encoding: 'utf8' });
      expect(c.stderr).toBe('');
      expect(c.status).toBe(0);
      const r = spawnSync('/bin/bash', [script], { env, encoding: 'utf8' });
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      expect(readFileSync(log, 'utf8')).toBe('build\nkickstart\n');
      const files = readdirSync(join(dir, name)).filter((f) => f.startsWith('backup-'));
      expect(files).toHaveLength(1);
    },
  );
});

describe('restart-local-services.sh schema read resilience', () => {
  function flaky(failures: number, stderrMsg = 'database is locked') {
    const s = setup({ schema: 18, latest: 18, pid: '4242', etime: '00:10', distAgeSeconds: 3600 });
    const counter = join(dir, 'attempts');
    const log = join(dir, 'calls.log');
    writeFileSync(counter, '0');
    stub('sleep', 'exit 0');
    stub(
      'sqlite3',
      `n=$(cat "${counter}"); n=$((n+1)); echo $n > "${counter}"
if [ "$n" -le ${failures} ]; then echo "${stderrMsg}" >&2; echo "second line" >&2; exit 1; fi
exec /usr/bin/sqlite3 "$@"`,
    );
    stub('launchctl', `echo "$@" >> "${log}"; echo "x = {"; echo "	pid = 4242"; echo "}"`);
    return { ...s, counter, log };
  }

  it('retries a locked read and reports the right version on the 3rd attempt', () => {
    const { script, env, counter } = flaky(2);
    const r = spawnSync('/bin/bash', [script, '--check'], { env, encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('schema na versão 18');
    expect(readFileSync(counter, 'utf8').trim()).toBe('3');
  });

  it('does not retry on a wrong version', () => {
    const s = setup({ schema: 16, latest: 18, pid: '4242', etime: '00:10', distAgeSeconds: 3600 });
    const r = spawnSync('/bin/bash', [s.script, '--check'], { env: s.env, encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('16');
  });

  it('gives up within ~25s, shows the first stderr line and never restarts', () => {
    const { script, env, log } = flaky(1000);
    const t0 = Date.now();
    const r = spawnSync('/bin/bash', [script, '--check'], { env, encoding: 'utf8' });
    expect(Date.now() - t0).toBeLessThan(25000);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('não foi possível ler a versão do schema');
    expect(r.stderr).toContain('database is locked');
    expect(r.stderr).not.toContain('second line');
    let calls = '';
    try {
      calls = readFileSync(log, 'utf8');
    } catch {
      /* no calls */
    }
    expect(calls).not.toContain('kickstart');
  });

  it('rejects a trailing comment argument and suggests pasting only the command', () => {
    const { script, env } = setup({ schema: 18, latest: 18, pid: '1', distAgeSeconds: 10 });
    const r = spawnSync('/bin/bash', [script, '--check', '#'], { env, encoding: 'utf8' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('Uso:');
    expect(r.stderr).toContain('somente o comando');
  });
});
