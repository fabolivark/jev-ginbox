import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(import.meta.url), '..', '..');
const assets = join(root, 'assets');
const svg = readFileSync(join(assets, 'icon.svg'), 'utf8');
const [, logoWidth, logoHeight] = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/).map(Number);
const source = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;

// Transparent padding on each side. 128 follows Chrome's 96px artwork inside a 128px canvas.
const PADDING = { 16: 1, 32: 2, 48: 4, 128: 16 };

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const [size, padding] of Object.entries(PADDING).map(([s, p]) => [Number(s), p])) {
    const width = size - 2 * padding;
    const height = Math.round((width * logoHeight) / logoWidth);
    const left = padding;
    const top = Math.round((size - height) / 2);
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<html><body style="margin:0;background:transparent">` +
        `<img src="${source}" style="position:absolute;left:${left}px;top:${top}px;width:${width}px;height:${height}px">` +
        `</body></html>`
    );
    await page.locator('img').evaluate((image) => image.decode());
    const out = join(assets, `icon-${size}.png`);
    await page.screenshot({ path: out, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    console.log(`${out} ${width}x${height}+${left}+${top}`);
  }

  // Preview sheet: each size at 1x and enlarged to about 256px, on a light and a dark toolbar colour.
  const sizes = Object.keys(PADDING);
  const png = (size) => `data:image/png;base64,${readFileSync(join(assets, `icon-${size}.png`)).toString('base64')}`;
  const zoom = (size) => Math.max(2, Math.floor(256 / size));
  const cell = (size) =>
    `<figure><div class="frame"><img src="${png(size)}" width="${size}" height="${size}"></div>` +
    `<div class="frame"><img class="big" src="${png(size)}" width="${size * zoom(size)}" height="${size * zoom(size)}"></div>` +
    `<figcaption>${size}px, 1x and ${zoom(size)}x</figcaption></figure>`;
  const panel = (theme) => `<section class="${theme}">${sizes.map(cell).join('')}</section>`;
  const preview = join(root, 'docs', 'icons-preview.png');
  await page.setViewportSize({ width: 1400, height: 800 });
  await page.setContent(
    `<html><head><style>
      body { margin: 0; width: max-content; font: 13px system-ui, sans-serif; }
      section { display: flex; align-items: flex-end; gap: 32px; padding: 24px; }
      .light { background: #f1f3f4; color: #202124; }
      .dark { background: #202124; color: #e8eaed; }
      figure { margin: 0; display: flex; flex-direction: column; align-items: center; gap: 12px; }
      .frame { outline: 1px dashed currentColor; line-height: 0; }
      .big { image-rendering: pixelated; }
    </style></head><body>${panel('light')}${panel('dark')}</body></html>`
  );
  await page.evaluate(() => Promise.all([...document.images].map((image) => image.decode())));
  const { width, height } = await page.evaluate(() => document.body.getBoundingClientRect().toJSON());
  await page.screenshot({ path: preview, fullPage: true, clip: { x: 0, y: 0, width, height } });
  console.log(preview);
} finally {
  await browser.close();
}
