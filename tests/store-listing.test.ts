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
  assert.equal(field(listing, 'Support email'), 'support@ab2web.com');
  assert.match(field(listing, 'Support URL'), /support email below is the only contact/);
  assert.doesNotMatch(listing, /\bTODO\b/);
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
  assert.match(privacy, /\bread mail\b/i, 'privacy callout says read mail is sent only when turned on');
});

test('the store listing says read rows are cleared and sent again when read mail is on', () => {
  const listing = read('docs/store-listing.md');
  assert.match(field(listing, 'Storage and deletion'), /read rows when "Also classify read mail" is on/);
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

test('the listing, privacy policy and first-run notice say the sender, subject and date are kept in the browser', () => {
  const listing = read('docs/store-listing.md');
  assert.match(field(listing, '`storage`'), /sender, subject and date of each classified thread/);
  assert.match(field(listing, 'Storage and deletion'), /sender, subject and date of each classified thread/);
  assert.match(field(listing, 'Storage and deletion'), /never sent anywhere/);
  const privacy = read('PRIVACY.md');
  assert.match(privacy, /sender name, sender address, subject and date of the thread/);
  assert.match(privacy, /never sent anywhere/);
  assert.match(privacy, /never deletes, archives or moves mail/);
  const notice = read('src/popup.html').match(/<div id="privacyNotice"[\s\S]*?<\/p>/)?.[0] ?? '';
  assert.match(notice.replace(/\s+/g, ' '), /sender, subject and date of classified emails are kept in this browser/);
});
