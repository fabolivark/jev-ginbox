import { context, build } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

const watch = process.argv.includes('--watch');

for (const dir of ['dist', 'dev-dist']) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir);
}

const common = {
  bundle: true,
  sourcemap: false,
  target: ['chrome114'],
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': '"production"' },
};

const entry = (entryPoints, format, outdir) => ({ entryPoints, format, outdir });

const runs = [
  entry(['src/content.ts'], 'iife', 'dist'),
  entry(['src/background.ts'], 'esm', 'dist'),
  entry(['src/popup.ts'], 'iife', 'dist'),
  entry(['dev/demo.ts'], 'iife', 'dev-dist'),
  entry(['dev/store/stub.ts'], 'iife', 'dev-dist'),
];

if (watch) {
  for (const opts of runs) {
    const ctx = await context({ ...common, ...opts });
    await ctx.watch();
  }
  console.log('watching...');
} else {
  await Promise.all(runs.map((opts) => build({ ...common, ...opts })));
}

cpSync('manifest.json', 'dist/manifest.json');
cpSync('src/popup.html', 'dist/popup.html');
cpSync('src/section.css', 'dist/section.css');
cpSync('assets', 'dist/assets', { recursive: true, filter: (src) => !src.endsWith('.svg') });
