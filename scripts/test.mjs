import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const entryPoints = readdirSync('tests')
  .filter((name) => name.endsWith('.test.ts'))
  .map((name) => join('tests', name));
const outdir = '.test-dist';
rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir);

try {
  await build({
    entryPoints,
    outdir,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    outExtension: { '.js': '.mjs' },
    logLevel: 'warning',
  });
  const files = readdirSync(outdir).map((name) => join(outdir, name));
  const run = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
  process.exitCode = run.status ?? 1;
} finally {
  rmSync(outdir, { recursive: true, force: true });
}
