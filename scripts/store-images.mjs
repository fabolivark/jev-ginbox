import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(fileURLToPath(import.meta.url), '..', '..');
const storeDir = join(root, 'dev', 'store');
const rawDir = join(storeDir, 'raw');
const outDir = join(root, 'docs', 'store');

let browser;
try {
  browser = await chromium.launch({ args: ['--hide-scrollbars', '--allow-file-access-from-files'] });
} catch (error) {
  console.error('Playwright Chromium is missing. Run npx playwright install chromium first.');
  throw error;
}

// Waits for web fonts, every image, and two frames, so Material Symbols render as icons
// and scene.html has placed its callout. Playwright screenshots are 8-bit RGB PNGs with
// no alpha channel, which is what the Chrome Web Store asks for.
async function settle(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      Array.from(document.images, (img) =>
        img.complete ? null : new Promise((done) => img.addEventListener('load', done, { once: true }))
      )
    );
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  });
}

async function shoot(url, outPath, width, height, { scale = 1, scheme = 'light', clipToContent = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale, colorScheme: scheme });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'networkidle' });
  await settle(page);
  const options = { path: outPath };
  if (clipToContent) {
    const bottom = await page.evaluate(() =>
      Math.max(
        ...Array.from(document.body.querySelectorAll('*'), (el) =>
          el.getClientRects().length > 0 ? el.getBoundingClientRect().bottom : 0
        )
      )
    );
    options.clip = { x: 0, y: 0, width, height: Math.ceil(bottom) + 16 };
  }
  await page.screenshot(options);
  await context.close();
}

async function downsize(src, out, width, height) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const data = readFileSync(src).toString('base64');
  await page.setContent(
    `<style>html,body{margin:0;background:#fff}img{display:block;width:${width}px;height:${height}px}</style><img src="data:image/png;base64,${data}">`
  );
  await settle(page);
  await page.screenshot({ path: out });
  await context.close();
}

function fileUrl(...segments) {
  return pathToFileURL(join(...segments)).href;
}

const labels = [
  { id: 'visa', name: 'Visa', description: 'Residence permits, IND letters, immigration appointments' },
  { id: 'money', name: 'Money', description: 'Invoices, payments, bank statements' },
  { id: 'home', name: 'Home', description: 'Rent, utilities, landlord and building notices' },
  { id: 'friends', name: 'Friends', description: 'Messages from friends and plans to meet' },
];

if (!existsSync(join(root, 'dist', 'popup.js')) || !existsSync(join(root, 'dev-dist', 'stub.js'))) {
  console.error('dist/ or dev-dist/ is missing. Run npm run build first.');
  process.exit(1);
}

mkdirSync(rawDir, { recursive: true });
mkdirSync(outDir, { recursive: true });

const popupHtml = readFileSync(join(root, 'dist', 'popup.html'), 'utf8');
const storeHtmlPath = join(root, 'dev-dist', 'popup-store.html');
writeFileSync(
  storeHtmlPath,
  popupHtml
    .replace('<meta charset="utf-8" />', '<meta charset="utf-8" />\n    <base href="../dist/" />')
    .replace(
      '<script src="popup.js"></script>',
      '<script src="../dev-dist/stub.js"></script>\n    <script src="popup.js"></script>'
    )
);

async function popupRender(name, state) {
  const encoded = Buffer.from(JSON.stringify(state), 'utf8').toString('base64');
  const out = join(rawDir, `${name}.png`);
  await shoot(`${fileUrl(storeHtmlPath)}?state=${encoded}`, out, 380, 1400, { scale: 2, clipToContent: true });
}

await popupRender('popup-set', { privacyAck: true, provider: 'gateway', apiKeyHint: 'a1b2', threshold: 0.7, labels });
await popupRender('popup-firstrun', { privacyAck: false, provider: 'gateway', labels });
await popupRender('popup-key', { privacyAck: true, provider: 'gateway', apiKeyHint: 'a1b2', threshold: 0.7, labels, crop: 'key' });

const scenes = [
  ['hero', '01-unread-first'],
  ['labels', '02-your-labels'],
  ['dark', '03-dark-theme'],
  ['privacy', '04-privacy'],
  ['search', '05-search-and-key'],
];

for (const [scene, name] of scenes) {
  const raw = join(rawDir, `${scene}@2x.png`);
  await shoot(`${fileUrl(storeDir, 'scene.html')}?scene=${scene}`, raw, 1440, 900, { scale: 2 });
  await downsize(raw, join(outDir, `${name}.png`), 1280, 800);
}

await shoot(`${fileUrl(storeDir, 'scene.html')}?scene=hero&nocallout=1`, join(rawDir, 'hero-clean@2x.png'), 1440, 900, {
  scale: 2,
});

const promos = [
  ['small', 'promo-small.png', 440, 280],
  ['marquee', 'promo-marquee.png', 1400, 560],
];

for (const [size, name, width, height] of promos) {
  const raw = join(rawDir, `promo-${size}@2x.png`);
  await shoot(`${fileUrl(storeDir, 'promo.html')}?size=${size}`, raw, width, height, { scale: 2 });
  await downsize(raw, join(outDir, name), width, height);
}

await browser.close();
console.log('Store images written to docs/store/.');
