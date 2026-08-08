#!/usr/bin/env node
/**
 * Packs the built app into one self-contained HTML file.
 *
 *   npm run build && node scripts/build-demo.mjs
 *
 * The output inlines the stylesheet, the JS bundle, and every data file, so it
 * runs with no network access at all — which is what lets it be published as an
 * artifact, where a strict CSP blocks requests to any host.
 *
 * The fragment deliberately omits <!doctype>, <html>, <head>, and <body>: the
 * artifact host supplies that skeleton. Pass --standalone for a complete
 * document you can open with file:// instead.
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

/** Inlined under the same paths the app's loaders already request. */
const DATA_FILES = [
  'data/results/index.json',
  'data/results/20260804.json',
  'data/geo/zip-crosswalk.json',
  'data/geo/wa-counties.geojson',
  'data/geo/wa-zctas.geojson',
];

const TITLE = 'Washington election results by ZIP code';

async function main() {
  const standalone = process.argv.includes('--standalone');

  let assets;
  try {
    assets = await readdir(path.join(DIST, 'assets'));
  } catch {
    throw new Error('No dist/ found. Run "npm run build" first.');
  }

  const cssName = assets.find((f) => f.endsWith('.css'));
  const jsName = assets.find((f) => f.endsWith('.js'));
  if (!cssName || !jsName) throw new Error('Could not find built CSS/JS in dist/assets.');

  const css = await readFile(path.join(DIST, 'assets', cssName), 'utf8');
  const js = await readFile(path.join(DIST, 'assets', jsName), 'utf8');

  const data = {};
  for (const file of DATA_FILES) {
    data[file] = JSON.parse(await readFile(path.join(DIST, file), 'utf8'));
  }

  // The data blob goes in a JSON script tag rather than a JS literal so that
  // nothing in the geometry can terminate the script early or be parsed as code.
  const dataJson = JSON.stringify(data).replace(/</g, '\\u003c');

  const body = `<title>${TITLE}</title>
<style>
${css}
</style>
<div id="root"></div>
<script type="application/json" id="wa-embedded-data">${dataJson}</script>
<script>
  window.__WA_EMBEDDED_DATA__ = JSON.parse(
    document.getElementById('wa-embedded-data').textContent
  );
</script>
<script type="module">
${js}
</script>`;

  const html = standalone
    ? `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n</head>\n<body>\n${body}\n</body>\n</html>\n`
    : `${body}\n`;

  const outDir = path.join(ROOT, 'dist-demo');
  await mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, standalone ? 'demo-standalone.html' : 'demo.html');
  await writeFile(outPath, html);

  const mb = (Buffer.byteLength(html) / 1e6).toFixed(2);
  console.log(`Wrote ${path.relative(ROOT, outPath)} (${mb} MB, no external requests)`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
