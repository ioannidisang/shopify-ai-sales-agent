import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';

await mkdir('extensions/sales-assistant/assets', { recursive: true });
await build({
  entryPoints: ['apps/widget/src/index.ts'],
  outfile: 'extensions/sales-assistant/assets/sales-assistant.js',
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['es2022'],
  platform: 'browser',
  legalComments: 'none',
  sourcemap: false,
});
