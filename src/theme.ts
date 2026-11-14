export type Rgba = { r: number; g: number; b: number; a: number };

export type GmailTheme = 'light' | 'dark';

const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 };
const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 1 };

function channel(value: string, scale: number): number | null {
  const trimmed = value.trim();
  const parsed = Number.parseFloat(trimmed);
  if (Number.isNaN(parsed)) return null;
  return trimmed.endsWith('%') ? (parsed / 100) * scale : parsed;
}

function alphaOf(value: string | undefined): number | null {
  if (value === undefined) return 1;
  return channel(value, 1);
}

function fromParts(parts: string[], scale: number, alpha: string | undefined): Rgba | null {
  if (parts.length !== 3) return null;
  const [r, g, b] = parts.map((part) => channel(part, 255));
  const a = alphaOf(alpha);
  if (r === null || g === null || b === null || a === null) return null;
  return { r: r * scale, g: g * scale, b: b * scale, a };
}

function fromHex(hex: string): Rgba | null {
  const digits = hex.length <= 4 ? [...hex].map((digit) => digit + digit) : hex.match(/../g);
  if (digits === null || (digits.length !== 3 && digits.length !== 4)) return null;
  const [r, g, b, a] = digits.map((pair) => Number.parseInt(pair, 16));
  if ([r, g, b].some(Number.isNaN)) return null;
  return { r, g, b, a: a === undefined ? 1 : a / 255 };
}

export function parseColor(value: string): Rgba | null {
  const text = value.trim().toLowerCase();
  if (text === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(text);
  if (hex !== null) return fromHex(hex[1]);
  const fn = /^(rgba?|color)\((.*)\)$/.exec(text);
  if (fn === null) return null;
  const [body, alpha] = fn[2].split('/');
  if (fn[1] === 'color') {
    const parts = body.trim().split(/\s+/);
    if (parts.shift() !== 'srgb') return null;
    return fromParts(parts, 255, alpha);
  }
  const parts = body.includes(',') ? body.split(',') : body.trim().split(/\s+/);
  if (parts.length === 4 && alpha === undefined) return fromParts(parts.slice(0, 3), 1, parts[3]);
  return fromParts(parts, 1, alpha);
}

function linear(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(color: Rgba): number {
  return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b);
}

export function contrastRatio(a: Rgba, b: Rgba): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export function composite(top: Rgba, bottom: Rgba): Rgba {
  const blend = (front: number, back: number): number => front * top.a + back * (1 - top.a);
  return { r: blend(top.r, bottom.r), g: blend(top.g, bottom.g), b: blend(top.b, bottom.b), a: 1 };
}

export function effectiveBackground(nearestFirst: string[]): Rgba {
  const layers: Rgba[] = [];
  let base = WHITE;
  for (const value of nearestFirst) {
    const color = parseColor(value);
    if (color === null || color.a === 0) continue;
    if (color.a >= 1) {
      base = color;
      break;
    }
    layers.push(color);
  }
  for (let index = layers.length - 1; index >= 0; index--) base = composite(layers[index], base);
  return base;
}

export function themeFromBackgrounds(nearestFirst: string[]): GmailTheme {
  const background = effectiveBackground(nearestFirst);
  return contrastRatio(background, WHITE) > contrastRatio(background, BLACK) ? 'dark' : 'light';
}
