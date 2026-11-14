import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(import.meta.url), '..', '..');
const dist = join(root, 'dist');
const outDir = join(root, 'e2e-results');
const GMAIL_URL = 'https://mail.google.com/mail/u/0/#inbox';
const WIDTHS = [1440, 768, 390, 320];
const THEMES = ['light', 'dark'];

const LABELS = [
  { id: 'visa', name: 'Visa', description: 'Residence permits, IND letters, immigration appointments' },
  { id: 'money', name: 'Money', description: 'Invoices, payments, bank statements' },
  { id: 'home', name: 'Home', description: 'Rent, utilities, landlord and building notices' },
];

function fixtureHtml() {
  return readFileSync(join(root, 'dev', 'demo.html'), 'utf8')
    .replace(/<link rel="stylesheet" href="..\/dist\/section.css" \/>/, '')
    .replace(/<script src="..\/dist\/[a-z]+\.js"><\/script>/g, '');
}

function unreadRows(html) {
  const rows = [];
  const pattern =
    /<tr class="zA zE">[\s\S]*?data-thread-id="([^"]+)"[\s\S]*?data-legacy-last-message-id="([^"]+)"/g;
  for (const match of html.matchAll(pattern)) rows.push({ threadId: match[1], lastMessageId: match[2] });
  return rows;
}

async function isolatedWorld(cdp, extensionId) {
  const contexts = [];
  cdp.on('Runtime.executionContextCreated', ({ context }) => contexts.push(context));
  await cdp.send('Runtime.enable');
  return async () => {
    for (let i = 0; i < 50; i++) {
      const found = contexts.find(
        (context) => context.auxData?.type === 'isolated' && context.origin.includes(extensionId)
      );
      if (found !== undefined) return found.id;
      await new Promise((done) => setTimeout(done, 100));
    }
    throw new Error('content script world not found');
  };
}

async function evaluateIn(cdp, contextId, expression) {
  const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
    contextId,
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (exceptionDetails !== undefined) throw new Error(exceptionDetails.text);
  return result.value;
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const context = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
});

const providerCalls = [];
await context.route(/^https:\/\/(ai-gateway\.vercel\.sh|api\.typesafe\.ai)\//, (route) => {
  providerCalls.push(route.request().url());
  return route.abort();
});
const html = fixtureHtml();
await context.route('https://mail.google.com/**', (route) =>
  route.fulfill({ status: 200, contentType: 'text/html', body: html })
);

try {
  let [worker] = context.serviceWorkers();
  if (worker === undefined) worker = await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;

  const rows = unreadRows(html);
  assert.ok(rows.length > 0, 'fixture has unread rows');
  const { cacheVersion, threadKey } = await import(join(root, 'src', 'shared.ts'));
  const version = cacheVersion(LABELS, 'gateway');
  const seed = {
    provider: 'gateway',
    apiKey: 'e2e-placeholder-key',
    enabled: true,
    threshold: 0.7,
    privacyAck: true,
    labels: LABELS,
    viewInbox: true,
  };
  rows.forEach((row, index) => {
    const key = threadKey({ ...row, legacyThreadId: '', fromName: '', fromEmail: '', subject: '', snippet: '', date: '' }, version);
    seed[`crit:${key}`] = {
      criticalProbability: index === 0 ? 0.95 : 0.1,
      urgencyScore: index === 0 ? 3 : 0,
      labels: { visa: index === 0 ? 0.9 : 0.05, money: 0.05, home: 0.05 },
      ts: Date.now(),
    };
  });
  await worker.evaluate((items) => chrome.storage.local.set(items), seed);

  const page = await context.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  const cdp = await context.newCDPSession(page);
  const contentWorld = await isolatedWorld(cdp, extensionId);
  await page.goto(GMAIL_URL);
  await page.waitForSelector('.gc-badge', { timeout: 15000 });
  const badges = await page.locator('.gc-badge').count();
  const chips = await page.locator('.gc-chip').count();
  assert.equal(badges, 1, 'one critical badge from the seeded cache');
  assert.ok(chips >= 1, 'label chips from the seeded cache');
  await page.screenshot({ path: join(outDir, 'gmail-fixture-1440.png') });

  const worldId = await contentWorld();
  const storageRead = await evaluateIn(
    cdp,
    worldId,
    `chrome.storage.local.get(null).then(() => 'read', (error) => 'denied: ' + error.message)`
  );
  assert.match(storageRead, /^denied/, 'content script cannot read storage');

  const testFromTab = await evaluateIn(cdp, worldId, `chrome.runtime.sendMessage({ type: 'test' })`);
  assert.deepEqual(testFromTab, { ok: false, error: 'failed' }, 'test is refused from Gmail');
  const oversized = await evaluateIn(
    cdp,
    worldId,
    `chrome.runtime.sendMessage({ type: 'classify', labels: [], emails: Array.from({ length: 21 }, (_, i) => ({ threadId: 't' + i, legacyThreadId: 'l', lastMessageId: 'm', fromName: '', fromEmail: '', subject: '', snippet: '', date: '' })) })`
  );
  assert.deepEqual(oversized, { ok: false, error: 'failed' }, 'oversized batch is refused');
  const state = await evaluateIn(cdp, worldId, `chrome.runtime.sendMessage({ type: 'state' })`);
  assert.equal(JSON.stringify(state).includes('e2e-placeholder-key'), false, 'state carries no key');

  await worker.evaluate(() => chrome.storage.local.set({ enabled: false }));
  await page.waitForSelector('.gc-badge', { state: 'detached', timeout: 10000 });
  await worker.evaluate(() => chrome.storage.local.set({ enabled: true }));
  await page.waitForSelector('.gc-badge', { timeout: 10000 });

  assert.deepEqual(providerCalls, [], 'no provider call with a warm cache');

  const popup = await context.newPage();
  for (const theme of THEMES) {
    await popup.emulateMedia({ colorScheme: theme });
    for (const width of WIDTHS) {
      await popup.setViewportSize({ width, height: 900 });
      await popup.goto(`chrome-extension://${extensionId}/popup.html`);
      await popup.waitForFunction(() => document.getElementById('version')?.textContent !== '');
      await popup.waitForFunction(() => document.getAnimations().length === 0);
      await popup.screenshot({ path: join(outDir, `popup-${theme}-${width}.png`), fullPage: true });
    }
  }
  const searchChecked = await popup.locator('#viewSearch').isChecked();
  assert.equal(searchChecked, false, 'Search is off by default in the popup');
  assert.equal(await popup.locator('#viewInbox').isChecked(), true, 'popup still reads storage');

  console.log(
    JSON.stringify(
      { badges, chips, storageRead, testFromTab, oversized, providerCalls, searchChecked, outDir },
      null,
      2
    )
  );
} finally {
  await context.close();
}
