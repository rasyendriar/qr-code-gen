import { build } from 'esbuild';
import { fileURLToPath } from 'url';
import path from 'path';
import { rmSync } from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, '..', 'vendor');

rmSync(path.join(outDir, 'libs.bundle.js'), { force: true });

const common = {
  bundle: true,
  minify: true,
  platform: 'browser',
  format: 'iife',
  target: ['es2020'],
};

await build({
  ...common,
  entryPoints: [path.join(__dirname, 'vendor-entry-worker.js')],
  outfile: path.join(outDir, 'qrcode.bundle.js'),
});

await build({
  ...common,
  entryPoints: [path.join(__dirname, 'vendor-entry-main.js')],
  outfile: path.join(outDir, 'main-libs.bundle.js'),
});

console.log('Built web/vendor/qrcode.bundle.js and web/vendor/main-libs.bundle.js');
