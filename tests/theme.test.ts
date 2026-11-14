import assert from 'node:assert/strict';
import { test } from 'node:test';
import { composite, contrastRatio, parseColor, themeFromBackgrounds } from '../src/theme';

test('parseColor reads the forms getComputedStyle and the stylesheet use', () => {
  assert.deepEqual(parseColor('rgb(32, 33, 36)'), { r: 32, g: 33, b: 36, a: 1 });
  assert.deepEqual(parseColor('rgba(0, 0, 0, 0)'), { r: 0, g: 0, b: 0, a: 0 });
  assert.deepEqual(parseColor('rgb(32 33 36 / 0.5)'), { r: 32, g: 33, b: 36, a: 0.5 });
  assert.deepEqual(parseColor('color(srgb 1 0.5 0)'), { r: 255, g: 127.5, b: 0, a: 1 });
  assert.deepEqual(parseColor('color(srgb 0 0 0 / 0.25)'), { r: 0, g: 0, b: 0, a: 0.25 });
  assert.deepEqual(parseColor('#202124'), { r: 32, g: 33, b: 36, a: 1 });
  assert.deepEqual(parseColor('#fff'), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(parseColor('transparent'), { r: 0, g: 0, b: 0, a: 0 });
  assert.equal(parseColor('currentcolor'), null);
});

test('contrastRatio follows WCAG 2 relative luminance', () => {
  const white = { r: 255, g: 255, b: 255, a: 1 };
  const black = { r: 0, g: 0, b: 0, a: 1 };
  assert.equal(Math.round(contrastRatio(white, black) * 100) / 100, 21);
  assert.equal(contrastRatio(white, white), 1);
  const grey = parseColor('#767676');
  assert.ok(grey !== null);
  assert.ok(contrastRatio(grey, white) >= 4.5 && contrastRatio(grey, white) < 4.6);
});

test('composite blends a translucent color over an opaque one', () => {
  assert.deepEqual(composite({ r: 0, g: 0, b: 0, a: 0.5 }, { r: 255, g: 255, b: 255, a: 1 }), {
    r: 127.5,
    g: 127.5,
    b: 127.5,
    a: 1,
  });
});

test('themeFromBackgrounds reads the first background that shows, nearest first', () => {
  assert.equal(themeFromBackgrounds(['rgba(0, 0, 0, 0)', 'rgb(32, 33, 36)']), 'dark');
  assert.equal(themeFromBackgrounds(['rgba(0, 0, 0, 0)', 'rgb(255, 255, 255)']), 'light');
  assert.equal(themeFromBackgrounds(['rgb(31, 31, 31)', 'rgb(255, 255, 255)']), 'dark');
  assert.equal(themeFromBackgrounds(['rgb(246, 248, 252)', 'rgb(32, 33, 36)']), 'light');
  assert.equal(themeFromBackgrounds(['rgba(0, 0, 0, 0.7)', 'rgb(255, 255, 255)']), 'dark');
  assert.equal(themeFromBackgrounds([]), 'light');
  assert.equal(themeFromBackgrounds(['rgba(0, 0, 0, 0)', 'bogus']), 'light');
});
