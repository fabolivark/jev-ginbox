import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  composite,
  contrastRatio,
  parseColor,
  themeFromBackgrounds,
  type GmailTheme,
  type Rgba,
} from '../src/theme';

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

type Tokens = Record<string, string>;

function cssRules(): { selector: string; tokens: Tokens }[] {
  const css = readFileSync('src/section.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: { selector: string; tokens: Tokens }[] = [];
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const tokens: Tokens = {};
    for (const declaration of match[2].split(';')) {
      const at = declaration.indexOf(':');
      if (at === -1) continue;
      const name = declaration.slice(0, at).trim();
      if (name.startsWith('--')) tokens[name] = declaration.slice(at + 1).trim();
    }
    rules.push({ selector: match[1].replace(/\s+/g, ' ').trim(), tokens });
  }
  return rules;
}

function tokensFor(matches: (selector: string) => boolean): Tokens {
  const out: Tokens = {};
  for (const rule of cssRules()) {
    if (rule.selector.split(',').some((part) => matches(part.trim()))) Object.assign(out, rule.tokens);
  }
  return out;
}

function color(tokens: Tokens, name: string, where: string): Rgba {
  const value = tokens[name];
  assert.ok(value !== undefined, `${where} defines ${name}`);
  const parsed = parseColor(value);
  assert.ok(parsed !== null && parsed.a === 1, `${where} ${name} is an opaque color, got ${value}`);
  return parsed;
}

const PAGE_BACKGROUNDS: Record<GmailTheme, string[]> = {
  light: ['#ffffff', '#f6f8fc'],
  dark: ['#202124', '#1f1f1f', '#2d2e30'],
};

const DARK = "[data-gc-theme='dark']";

const CHIP_SCOPES = [
  ...Array.from({ length: 8 }, (_, hue) => `.gc-hue-${hue}`),
  '.gc-badge',
  '.gc-filter-critical',
];

for (const theme of ['light', 'dark'] as const) {
  test(`bar text has AA contrast on a ${theme} Gmail list`, () => {
    const base = tokensFor((part) => part === '.gc-root');
    const tokens =
      theme === 'light' ? base : { ...base, ...tokensFor((part) => part === `.gc-root${DARK}`) };
    for (const name of ['--gc-text', '--gc-muted', '--gc-error']) {
      const fg = color(tokens, name, `${theme} bar`);
      for (const page of PAGE_BACKGROUNDS[theme]) {
        const bg = parseColor(page);
        assert.ok(bg !== null);
        const ratio = contrastRatio(fg, bg);
        assert.ok(ratio >= 4.5, `${theme} ${name} on ${page} is ${ratio.toFixed(2)}`);
      }
    }
  });

  test(`chips and pressed chips have AA contrast in ${theme}`, () => {
    for (const scope of CHIP_SCOPES) {
      const light = tokensFor((part) => part === scope);
      const tokens =
        theme === 'light' ? light : { ...light, ...tokensFor((part) => part === `${DARK} ${scope}`) };
      const where = `${theme} ${scope}`;
      const pairs: [string, string][] = [
        ['--gc-hue-fg', '--gc-hue-bg'],
        ['--gc-hue-on-solid', '--gc-hue-solid'],
      ];
      for (const [fgName, bgName] of pairs) {
        const ratio = contrastRatio(color(tokens, fgName, where), color(tokens, bgName, where));
        assert.ok(ratio >= 4.5, `${where} ${fgName} on ${bgName} is ${ratio.toFixed(2)}`);
      }
    }
  });
}

test('the Finish setup button uses the bar text on the list, like Clear', () => {
  const css = readFileSync('src/section.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const declarations = new Map<string, string>();
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1].split(',').map((part) => part.replace(/\s+/g, ' ').trim());
    if (!selectors.includes('.gc-setup')) continue;
    for (const declaration of match[2].split(';')) {
      const at = declaration.indexOf(':');
      if (at !== -1) declarations.set(declaration.slice(0, at).trim(), declaration.slice(at + 1).trim());
    }
  }
  assert.equal(declarations.get('color'), 'var(--gc-text)', '.gc-setup text is the AA-checked --gc-text');
  assert.equal(declarations.get('background'), 'transparent', '.gc-setup sits on the list background');
});
