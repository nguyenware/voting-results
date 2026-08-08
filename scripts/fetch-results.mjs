#!/usr/bin/env node
/**
 * Snapshots an election from the VoteWA public results API into the static
 * JSON the app serves.
 *
 *   node scripts/fetch-results.mjs [yyyymmdd] [--out public/data/results]
 *
 * Defaults to the 2026 primary (20260804). Requires `npm run data:geo` to have
 * run first, since county FIPS codes come from the generated county GeoJSON.
 *
 * Why snapshot instead of calling the API from the browser
 * -------------------------------------------------------
 * The API is public and unauthenticated, but it sets no CORS headers we can
 * rely on, and a page that fans out one request per county on every visit
 * would hammer it. VoteWA serves `Cache-Control: public, max-age=60` and its
 * own client polls every two minutes, so a periodic snapshot on the same order
 * is both sufficient and neighbourly. Re-run this script to refresh; on
 * election night a cron every 2-5 minutes matches how the data actually moves.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeBallotItems,
  mergeRaces,
  buildCountyIndex,
  pickText,
  toInt,
} from './lib/normalize.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const API_BASE =
  process.env.VOTEWA_API_BASE ?? 'https://results.votewa.gov/results/public/api';
const STATE_SLUG = process.env.VOTEWA_STATE_SLUG ?? 'washington';
const DEFAULT_ELECTION = '20260804';

/** Counties are fetched in parallel but politely. */
const CONCURRENCY = 4;
const MAX_RETRIES = 3;

async function getJson(url, { retries = MAX_RETRIES } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) {
      const backoff = 2 ** attempt * 500;
      await new Promise((r) => setTimeout(r, backoff));
    }
    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/json, text/plain, */*' },
        signal: AbortSignal.timeout(60_000),
      });
      if (res.status === 404) return null; // absent county page is not an error
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`Failed to fetch ${url}: ${lastError?.message ?? 'unknown error'}`);
}

/** Runs `worker` over `items` with a fixed concurrency ceiling. */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

async function loadCensusCounties() {
  const geoPath = path.join(ROOT, 'public/data/geo/wa-counties.geojson');
  let raw;
  try {
    raw = JSON.parse(await readFile(geoPath, 'utf8'));
  } catch {
    throw new Error(
      `Could not read ${path.relative(ROOT, geoPath)}. Run "npm run data:geo" first.`,
    );
  }
  return raw.features.map((f) => ({ fips: f.properties.GEOID, name: f.properties.NAME }));
}

/** Turnout/registration totals, which live in different arrays per scope. */
function extractCountyStats(countyData) {
  const turnout = countyData?.voterTurnout ?? [];
  const ballotsCast = turnout.reduce((sum, row) => sum + toInt(row?.ballotsCast), 0);
  const registered = turnout.reduce((sum, row) => sum + toInt(row?.voterRegistration), 0);
  return {
    ballotsCast: ballotsCast || null,
    registeredVoters: registered || null,
    precinctCount: (countyData?.precincts ?? []).length || null,
  };
}

/**
 * Fetches, normalizes, and writes one election snapshot.
 * Exported so the sample-data generator drives the identical code path.
 */
export async function ingest({
  electionId = DEFAULT_ELECTION,
  apiBase = API_BASE,
  stateSlug = STATE_SLUG,
  outDir = path.join(ROOT, 'public/data/results'),
  isSample = false,
} = {}) {
  console.log(`Election ${electionId} from ${apiBase}`);

  const metaUrl = `${apiBase}/elections/${stateSlug}/${electionId}`;
  const dataUrl = `${metaUrl}/data`;

  const meta = await getJson(metaUrl);
  if (!meta) throw new Error(`No election found at ${metaUrl}`);
  const stateData = await getJson(dataUrl);
  if (!stateData) throw new Error(`No results payload at ${dataUrl}`);

  const censusCounties = await loadCensusCounties();
  const { counties, unmatched } = buildCountyIndex(stateData.localityElections, censusCounties);
  if (unmatched.length) {
    console.warn(`  warning: ${unmatched.length} localities did not match a county: ${unmatched.join(', ')}`);
  }
  console.log(`  ${Object.keys(counties).length} participating counties`);

  const statewideRaces = normalizeBallotItems(stateData.ballotItems);
  console.log(`  ${statewideRaces.length} statewide ballot items`);

  const countyList = Object.values(counties);
  const perCounty = await mapLimit(countyList, CONCURRENCY, async (county) => {
    const url = `${apiBase}/elections/${county.slug}/${electionId}/data`;
    const payload = await getJson(url);
    if (!payload) {
      console.warn(`  warning: no payload for ${county.slug}`);
      return { county, races: [], stats: {} };
    }
    return {
      county,
      races: normalizeBallotItems(payload.ballotItems, { scopeFips: county.fips }),
      stats: extractCountyStats(payload),
    };
  });

  const countyRaces = perCounty.flatMap((r) => r.races);
  for (const { county, stats } of perCounty) Object.assign(counties[county.fips], stats);
  console.log(`  ${countyRaces.length} county-scoped ballot items`);

  const races = mergeRaces({ statewideRaces, countyRaces });
  console.log(`  ${races.length} distinct races after merge`);

  const snapshot = {
    electionId,
    electionName: pickText(stateData.election?.name) || `Washington ${electionId}`,
    electionDate: `${electionId.slice(0, 4)}-${electionId.slice(4, 6)}-${electionId.slice(6, 8)}`,
    isOfficial: Boolean(meta.isOfficialResults),
    isSample,
    asOf: meta.asOf ?? null,
    fetchedAt: new Date().toISOString(),
    source: isSample
      ? {
          name: 'Synthetic sample data generated by scripts/mock-api.mjs — not real results',
          metaUrl: null,
          dataUrl: null,
          publicPage: `https://results.votewa.gov/results/public/${stateSlug}/elections/${electionId}`,
        }
      : {
          name: 'Washington Secretary of State (VoteWA public results API)',
          metaUrl,
          dataUrl,
          publicPage: `https://results.votewa.gov/results/public/${stateSlug}/elections/${electionId}`,
        },
    counties,
    races,
  };

  await mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, `${electionId}.json`);
  await writeFile(outPath, JSON.stringify(snapshot));

  await writeFile(
    path.join(outDir, 'index.json'),
    JSON.stringify({
      elections: [
        {
          electionId,
          electionName: snapshot.electionName,
          electionDate: snapshot.electionDate,
          isOfficial: snapshot.isOfficial,
          isSample: snapshot.isSample,
          fetchedAt: snapshot.fetchedAt,
        },
      ],
    }),
  );

  console.log(`\nWrote ${path.relative(ROOT, outPath)}`);
  return snapshot;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const outFlag = args.indexOf('--out');
  ingest({
    electionId: args.find((a) => /^\d{8}$/.test(a)) ?? DEFAULT_ELECTION,
    ...(outFlag >= 0 && args[outFlag + 1]
      ? { outDir: path.resolve(ROOT, args[outFlag + 1]) }
      : {}),
    isSample: args.includes('--sample'),
  }).catch((err) => {
    console.error(`\n${err.message}`);
    process.exit(1);
  });
}
