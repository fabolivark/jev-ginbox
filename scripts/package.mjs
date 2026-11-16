import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

function fail(message) {
  console.error(`package: ${message}`);
  process.exit(1);
}

function manifestFiles(manifest) {
  const files = new Set(['manifest.json']);
  for (const path of Object.values(manifest.icons ?? {})) files.add(path);
  if (manifest.background?.service_worker) files.add(manifest.background.service_worker);
  for (const script of manifest.content_scripts ?? []) {
    for (const path of [...(script.js ?? []), ...(script.css ?? [])]) files.add(path);
  }
  if (manifest.action?.default_popup) files.add(manifest.action.default_popup);
  for (const path of Object.values(manifest.action?.default_icon ?? {})) files.add(path);
  return [...files];
}

const { version } = readJson('package.json');
const manifest = readJson('manifest.json');
if (version !== manifest.version) {
  fail(`package.json version ${version} does not match manifest.json version ${manifest.version}`);
}

const build = spawnSync(process.execPath, [join('scripts', 'build.mjs')], { stdio: 'inherit' });
if (build.status !== 0) fail('build failed');

const missing = manifestFiles(manifest).filter((path) => !existsSync(join('dist', path)));
if (missing.length > 0) fail(`dist/ is missing files the manifest references: ${missing.join(', ')}`);

mkdirSync('release', { recursive: true });
const zip = resolve('release', `jev-inbox-${version}.zip`);
rmSync(zip, { force: true });
const zipped = spawnSync('zip', ['-X', '-r', '-D', '-q', zip, '.'], { cwd: 'dist', stdio: 'inherit' });
if (zipped.status !== 0) fail('zip failed; is the zip command installed?');

console.log(`package: wrote ${zip}`);
