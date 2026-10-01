import { build } from 'esbuild';
import { mkdir, readFile } from 'node:fs/promises';

await mkdir('extensions/sales-assistant/assets', { recursive: true });
const shared = {
  bundle: true,
  minify: true,
  target: ['es2022'],
  platform: 'browser',
  legalComments: 'none',
  sourcemap: false,
};
await build({ ...shared, entryPoints: ['apps/widget/src/loader.ts'], outfile: 'extensions/sales-assistant/assets/sales-assistant.js', format: 'iife' });
await build({ ...shared, entryPoints: ['apps/widget/src/index.ts'], outfile: 'extensions/sales-assistant/assets/sales-assistant-ui.js', format: 'esm' });
const loaderBytes = (await readFile('extensions/sales-assistant/assets/sales-assistant.js')).byteLength;
if (loaderBytes > 10_000) throw new Error(`Widget loader exceeds the 10,000-byte budget: ${loaderBytes}`);
