/**
 * Builds build/web/index.js: one file with every dependency inside, including the
 * AWS SDK clients. The Web Function runtime loads index.js from the package root.
 * CDK zips build/web and uploads it.
 */
import { rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { buildSync } from 'esbuild';

const root = path.join(__dirname, '..');
const outdir = path.join(root, 'build', 'web');

rmSync(outdir, { recursive: true, force: true });
const result = buildSync({
  entryPoints: [path.join(root, 'app', 'src', 'server.ts')],
  outfile: path.join(outdir, 'index.js'),
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  minify: true,
  sourcemap: true,
  legalComments: 'none',
  metafile: true,
});

// Kept outside build/web so it isn't deployed. The bundle test reads it.
writeFileSync(path.join(root, 'build', 'meta.json'), JSON.stringify(result.metafile));

const bytes = Object.values(result.metafile.outputs).reduce((sum, o) => sum + o.bytes, 0);
console.log(`bundled ${path.relative(root, outdir)}/index.js (${(bytes / 1024).toFixed(0)} KiB with source map)`);
