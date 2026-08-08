#!/usr/bin/env node
/**
 * Snapshots an election from the VoteWA public results API into the static
 * JSON the app serves.
 *
 *   node scripts/fetch-results.mjs [yyyymmdd] [--out public/data/results]
 *
 * Defaults to the 2026 primary (20260804). Requires `npm run data:geo` to have
 * run first, since county FIPS codes come from the generated county index.
 *
 * This is the Node wrapper: it supplies the county index from disk and writes
 * the result. The fetching and normalizing live in lib/ingest.mjs, which is
 * platform-neutral so the scheduled Cloudflare Worker runs the same code.
 *
 * Why snapshot instead of calling the API from the browser
 * -------------------------------------------------------
 * The API is public and unauthenticated, but it sets no CORS headers we can
 * rely on, and a page that fans out one request per county on every visit
 * would hammer it. VoteWA serves `Cache-Control: public, max-age=60` and its
 * own client polls every two minutes, so a periodic snapshot on the same order
 * is both sufficient and neighbourly.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildSnapshot,
  buildIndex,
  DEFAULT_API_BASE,
  DEFAULT_STATE_SLUG,
} from './lib/ingest.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_ELECTION = '20260804';

const COUNTY_INDEX_PATH = path.join(ROOT, 'public/data/geo/wa-county-index.json');

async function loadCensusCounties() {
  try {
    return JSON.parse(await readFile(COUNTY_INDEX_PATH, 'utf8'));
  } catch {
    throw new Error(
      `Could not read ${path.relative(ROOT, COUNTY_INDEX_PATH)}. Run "npm run data:geo" first.`,
    );
  }
}

export async function ingest({
  electionId = DEFAULT_ELECTION,
  apiBase = process.env.VOTEWA_API_BASE ?? DEFAULT_API_BASE,
  stateSlug = process.env.VOTEWA_STATE_SLUG ?? DEFAULT_STATE_SLUG,
  outDir = path.join(ROOT, 'public/data/results'),
  isSample = false,
} = {}) {
  console.log(`Election ${electionId} from ${apiBase}`);

  const snapshot = await buildSnapshot({
    electionId,
    apiBase,
    stateSlug,
    isSample,
    censusCounties: await loadCensusCounties(),
    log: (message) => console.log(`  ${message}`),
  });

  await mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, `${electionId}.json`);
  await writeFile(outPath, JSON.stringify(snapshot));
  await writeFile(path.join(outDir, 'index.json'), JSON.stringify(buildIndex(snapshot)));

  console.log(`\nWrote ${path.relative(ROOT, outPath)}`);
  return snapshot;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const outFlag = args.indexOf('--out');
  ingest({
    electionId: args.find((a) => /^\d{8}$/.test(a)) ?? DEFAULT_ELECTION,
    ...(outFlag >= 0 && args[outFlag + 1] ? { outDir: path.resolve(ROOT, args[outFlag + 1]) } : {}),
    isSample: args.includes('--sample'),
  }).catch((err) => {
    console.error(`\n${err.message}`);
    process.exit(1);
  });
}
