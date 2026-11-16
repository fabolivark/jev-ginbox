import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const REPO = 'https://github.com/fabolivark/jev-ginbox';
const read = (path: string): string => readFileSync(path, 'utf8');

function field(markdown: string, name: string): string {
  const match = markdown.match(new RegExp(`^- ${name}: (.+)$`, 'm'));
  assert.ok(match?.[1], `listing has a ${name} line`);
  return match[1];
}

test('the store listing names its category, language, homepage, privacy policy and support contact', () => {
  const listing = read('docs/store-listing.md');
  assert.match(field(listing, 'Category'), /Productivity/);
  assert.match(field(listing, 'Language'), /English/);
  assert.equal(field(listing, 'Homepage URL'), REPO);
  assert.equal(field(listing, 'Privacy policy URL'), `${REPO}/blob/main/PRIVACY.md`);
  assert.match(field(listing, 'Support email'), /^TODO/);
});

test('the store listing never says message content stays unread', () => {
  const listing = read('docs/store-listing.md');
  assert.doesNotMatch(listing, /content is not read/i);
  assert.match(field(listing, 'Personal communications'), /first part of the (email )?body/i);
});

test('the privacy screenshot callout says the snippet is body text', () => {
  const scene = read('dev/store/scene.html');
  const privacy = scene.match(/^\s*privacy: .+\n.+$/m)?.[0] ?? '';
  assert.match(privacy, /callout/, 'privacy scene has a callout');
  assert.doesNotMatch(privacy, /never bodies/i);
  assert.match(privacy, /first part of the (email )?body/i);
});

test('the repository links point to the fork, and only the README credits upstream', () => {
  for (const path of ['src/popup.html', 'PRIVACY.md', 'docs/store-listing.md', 'package.json']) {
    assert.doesNotMatch(read(path), /iamomiid/, `${path} has no upstream link`);
  }
  const readme = read('README.md');
  assert.match(readme, new RegExp(`git clone ${REPO}\\.git\\ncd jev-ginbox\\n`));
  assert.match(readme, /iamomiid\/jev-inbox/, 'README credits the upstream project');
  assert.match(read('PRIVACY.md'), new RegExp(REPO));
});
