import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface ContentScript {
  js?: string[];
  css?: string[];
}

interface Manifest {
  version: string;
  icons?: Record<string, string>;
  background?: { service_worker?: string };
  content_scripts?: ContentScript[];
  action?: { default_popup?: string; default_icon?: Record<string, string> };
}

const repo = process.cwd();
const sources = ['scripts', 'src', 'dev', 'assets', 'manifest.json', 'package.json', 'tsconfig.json'];

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'jev-package-'));
  for (const entry of sources) cpSync(join(repo, entry), join(dir, entry), { recursive: true });
  symlinkSync(join(repo, 'node_modules'), join(dir, 'node_modules'), 'dir');
  return dir;
}

function setVersion(dir: string, file: string, version: string): void {
  const path = join(dir, file);
  const json: Record<string, unknown> = JSON.parse(readFileSync(path, 'utf8'));
  json['version'] = version;
  writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
}

function run(dir: string, script: string) {
  return spawnSync(process.execPath, [join('scripts', script)], { cwd: dir, encoding: 'utf8' });
}

function readManifest(dir: string): Manifest {
  return JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
}

function manifestFiles(manifest: Manifest): string[] {
  const files = new Set<string>(['manifest.json']);
  for (const path of Object.values(manifest.icons ?? {})) files.add(path);
  if (manifest.background?.service_worker) files.add(manifest.background.service_worker);
  for (const script of manifest.content_scripts ?? []) {
    for (const path of [...(script.js ?? []), ...(script.css ?? [])]) files.add(path);
  }
  if (manifest.action?.default_popup) files.add(manifest.action.default_popup);
  for (const path of Object.values(manifest.action?.default_icon ?? {})) files.add(path);
  return [...files].sort();
}

function zipEntries(zip: string): string[] {
  const list = spawnSync('unzip', ['-Z1', zip], { encoding: 'utf8' });
  assert.equal(list.status, 0, list.stderr);
  return list.stdout
    .split('\n')
    .filter((line) => line !== '' && !line.endsWith('/'))
    .sort();
}

test('npm run package zips a clean build with only the extension files', () => {
  const dir = workspace();
  try {
    mkdirSync(join(dir, 'dist'));
    writeFileSync(join(dir, 'dist', 'stray.txt'), 'left over from an old build');

    const result = run(dir, 'package.mjs');
    assert.equal(result.status, 0, result.stderr);

    const manifest = readManifest(dir);
    const zip = join(dir, 'release', `jev-inbox-${manifest.version}.zip`);
    assert.ok(existsSync(zip), `${zip} exists`);

    const entries = zipEntries(zip);
    for (const file of manifestFiles(manifest)) assert.ok(entries.includes(file), `zip has ${file}`);
    for (const devFile of ['demo.js', 'stub.js', 'assets/icon.svg', 'stray.txt']) {
      assert.ok(!entries.includes(devFile), `zip has no ${devFile}`);
    }
    assert.deepEqual(entries, [...manifestFiles(manifest), 'popup.js'].sort());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('npm run package fails when package.json and manifest.json versions differ', () => {
  const dir = workspace();
  try {
    setVersion(dir, 'package.json', '0.2.0');

    const result = run(dir, 'package.mjs');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /0\.2\.0/);
    assert.match(result.stderr, new RegExp(readManifest(dir).version.replaceAll('.', '\\.')));
    assert.ok(!existsSync(join(dir, 'release')), 'no zip is written');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('npm run build keeps dev files out of dist and stubs read the manifest version', () => {
  const dir = workspace();
  try {
    setVersion(dir, 'manifest.json', '9.8.7');

    const result = run(dir, 'build.mjs');
    assert.equal(result.status, 0, result.stderr);

    for (const devFile of ['demo.js', 'stub.js', 'assets/icon.svg']) {
      assert.ok(!existsSync(join(dir, 'dist', devFile)), `dist has no ${devFile}`);
    }
    for (const stub of ['demo.js', 'stub.js']) {
      const code = readFileSync(join(dir, 'dev-dist', stub), 'utf8');
      assert.match(code, /9\.8\.7/, `${stub} carries the manifest version`);
      assert.doesNotMatch(code, /0\.1\.0/, `${stub} has no hardcoded version`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
