#!/usr/bin/env node
// Database test runner: builds a fresh database from every migration and runs
// the SQL tests in supabase/tests. Exits non-zero if any check fails.
//
//   npm run test:db                 uses DATABASE_URL (a server you can create databases on)
//   npm run test:db -- --temp       starts a throw-away PostgreSQL cluster (needs initdb/pg_ctl,
//                                   found on PATH or in PG_BIN)
//   npm run test:db -- --keep       keeps the test database afterwards for inspection
//
// Only psql (and initdb/pg_ctl for --temp) are needed; no npm packages.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const args = new Set(process.argv.slice(2));
const migrationsDir = join(root, 'supabase', 'migrations');
const testsDir = join(root, 'supabase', 'tests');

function findTool(name) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  const dirs = [process.env.PG_BIN, ...(process.env.PATH || '').split(delimiter)].filter(Boolean);
  if (process.platform === 'win32') {
    for (const version of ['18', '17', '16', '15']) dirs.push(`C:\\Program Files\\PostgreSQL\\${version}\\bin`);
  }
  for (const dir of dirs) { const candidate = join(dir, exe); if (existsSync(candidate)) return candidate; }
  return exe;
}

const psqlBin = findTool('psql');
function psql(url, extra, options = {}) {
  const result = spawnSync(psqlBin, ['--no-psqlrc', '-X', '-q', '-d', url, ...extra], { encoding: 'utf8', ...options });
  if (result.error) throw new Error(`Could not run psql (${result.error.message}). Install the PostgreSQL client or set PG_BIN.`);
  return result;
}
const withDb = (url, db) => { const u = new URL(url); u.pathname = `/${db}`; return u.toString(); };

let serverUrl = process.env.DATABASE_URL || 'postgresql://postgres@localhost:5432/postgres';
let tempDir = null;
let pgCtl = null;

if (args.has('--temp')) {
  const initdb = findTool('initdb'); pgCtl = findTool('pg_ctl');
  tempDir = mkdtempSync(join(tmpdir(), 'tsg-pg-'));
  const port = String(56000 + Math.floor(Math.random() * 2000));
  const init = spawnSync(initdb, ['-D', join(tempDir, 'data'), '-U', 'postgres', '-A', 'trust', '--no-sync'], { encoding: 'utf8' });
  if (init.status !== 0) { console.error(init.stderr || init.stdout); process.exitCode = 2; throw new Error("Could not start a temporary PostgreSQL cluster"); }
  // stdio 'ignore': the server keeps running after pg_ctl exits; if it inherited
  // a pipe, spawnSync would wait for it forever (Windows).
  const start = spawnSync(pgCtl, ['-D', join(tempDir, 'data'), '-o', `-p ${port} -c fsync=off`, '-l', join(tempDir, 'log.txt'), '-w', 'start'], { stdio: 'ignore' });
  if (start.status !== 0) { process.exitCode = 2; throw new Error(`Could not start a temporary PostgreSQL cluster (see ${join(tempDir, 'log.txt')})`); }
  serverUrl = `postgresql://postgres@localhost:${port}/postgres`;
}

const dbName = `tsg_test_${process.pid}_${Date.now().toString(36)}`;
const testUrl = withDb(serverUrl, dbName);
let failed = false;

function cleanup() {
  if (!args.has('--keep')) psql(serverUrl, ['-c', `drop database if exists ${dbName} with (force)`]);
  else console.log(`\nKept database: ${testUrl}`);
  if (tempDir && !args.has('--keep')) {
    spawnSync(pgCtl, ['-D', join(tempDir, 'data'), '-m', 'immediate', 'stop'], { stdio: 'ignore' });
    rmSync(tempDir, { recursive: true, force: true });
  }
}

try {
  const created = psql(serverUrl, ['-v', 'ON_ERROR_STOP=1', '-c', `create database ${dbName}`]);
  if (created.status !== 0) throw new Error(`Could not create the test database:\n${created.stderr}`);

  const apply = (file, stopOnError = true) => {
    const result = psql(testUrl, ['-v', `ON_ERROR_STOP=${stopOnError ? 1 : 0}`, '-f', file]);
    const errors = (result.stderr || '').split(/\r?\n/).filter(line => /\b(ERROR|FATAL):/.test(line));
    return { ok: result.status === 0 && errors.length === 0, errors, result };
  };

  const stubs = apply(join(testsDir, '00_supabase_stubs.sql'));
  if (!stubs.ok) throw new Error(`Supabase stand-ins failed:\n${stubs.errors.join('\n')}`);

  const migrations = readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  for (const file of migrations) {
    const out = apply(join(migrationsDir, file));
    if (!out.ok) throw new Error(`Migration ${file} failed:\n${out.errors.join('\n') || out.result.stderr}`);
  }
  console.log(`Applied ${migrations.length} migrations.`);

  const testFiles = readdirSync(testsDir).filter(f => f.endsWith('.test.sql')).sort();
  for (const file of testFiles) {
    const out = apply(join(testsDir, file), false);
    if (out.errors.length) {
      failed = true;
      console.log(`\n✗ Unexpected errors in ${file}:`);
      out.errors.forEach(line => console.log(`  ${line.replace(/^psql:[^:]+:\d+:\s*/, '')}`));
    }
  }

  const report = psql(testUrl, ['-A', '-t', '-F', '\t', '-c', 'select ok, label, coalesce(detail, \'\') from tests.results order by id']);
  const rows = report.stdout.trim().split(/\r?\n/).filter(Boolean).map(line => line.split('\t'));
  let passed = 0;
  console.log('');
  for (const [ok, label, detail] of rows) {
    if (ok === 't') { passed += 1; console.log(`  ✓ ${label}`); }
    else { failed = true; console.log(`  ✗ ${label}\n      ${detail}`); }
  }
  console.log(`\n${passed} passed, ${rows.length - passed} failed${failed && rows.length === passed ? ' (plus unexpected SQL errors above)' : ''}.`);
  if (!rows.length) { failed = true; console.log('No test results were recorded.'); }
} catch (error) {
  failed = true;
  console.error(`\n${error.message}`);
} finally {
  cleanup();
}
process.exitCode = failed ? 1 : 0;
