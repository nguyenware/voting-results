/**
 * Platform-neutral election ingest.
 *
 * Everything here runs on plain `fetch` and pure data — no filesystem, no Node
 * built-ins — so the same code drives the CLI snapshot (scripts/fetch-results.mjs)
 * and the scheduled Cloudflare Worker (worker/index.js). Callers supply the
 * county index and decide what to do with the returned snapshot.
 */
import { normalizeBallotItems, mergeRaces, buildCountyIndex, pickText, toInt } from './normalize.mjs';

export const DEFAULT_API_BASE = 'https://results.votewa.gov/results/public/api';
export const DEFAULT_STATE_SLUG = 'washington';

/** Counties are fetched in parallel but politely. */
const CONCURRENCY = 4;
const MAX_RETRIES = 3;

export async function fetchJson(url, { retries = MAX_RETRIES, timeoutMs = 60_000 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 2 ** attempt * 500));
    }
    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/json, text/plain, */*' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 404) return null; // an absent county page is not an error
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
 * Reads just the election metadata. This is the cheap change-detector: it
 * carries `asOf`, so a scheduled job can skip the whole county fan-out when
 * nothing upstream has moved.
 */
export function fetchElectionMeta({
  electionId,
  apiBase = DEFAULT_API_BASE,
  stateSlug = DEFAULT_STATE_SLUG,
  get = fetchJson,
}) {
  return get(`${apiBase}/elections/${stateSlug}/${electionId}`, { timeoutMs: 15_000 });
}

/**
 * Fetches and normalizes one election into the snapshot the app consumes.
 *
 * `censusCounties` is [{ fips, name }] — the join target for VoteWA's locality
 * slugs. `log` defaults to a no-op so the Worker stays quiet.
 */
export async function buildSnapshot({
  electionId,
  censusCounties,
  apiBase = DEFAULT_API_BASE,
  stateSlug = DEFAULT_STATE_SLUG,
  isSample = false,
  meta = null,
  get = fetchJson,
  log = () => {},
}) {
  const metaUrl = `${apiBase}/elections/${stateSlug}/${electionId}`;
  const dataUrl = `${metaUrl}/data`;

  const electionMeta = meta ?? (await get(metaUrl, { timeoutMs: 15_000 }));
  if (!electionMeta) throw new Error(`No election found at ${metaUrl}`);

  const stateData = await get(dataUrl);
  if (!stateData) throw new Error(`No results payload at ${dataUrl}`);

  const { counties, unmatched } = buildCountyIndex(
    stateData.localityElections,
    censusCounties,
    stateData.jurisdiction,
  );
  if (unmatched.length) {
    // Cap it: 39 unresolved localities each dumping their key list buries the
    // rest of the log, and the first few say the same thing as all of them.
    const shown = unmatched.slice(0, 3).join(' | ');
    const rest = unmatched.length > 3 ? ` (+${unmatched.length - 3} more)` : '';
    log(`warning: ${unmatched.length} localities did not match a county: ${shown}${rest}`);
  }
  const countySlugs = Object.values(counties).map((c) => c.slug);
  log(`${countySlugs.length} participating counties`);
  if (countySlugs.length > 0) {
    // Confirms the slug form actually used for the county fetches below.
    log(`county slugs e.g. ${countySlugs.slice(0, 3).join(', ')}`);
  }

  const statewideRaces = normalizeBallotItems(stateData.ballotItems);
  log(`${statewideRaces.length} statewide ballot items`);

  const countyList = Object.values(counties);
  const perCounty = await mapLimit(countyList, CONCURRENCY, async (county) => {
    const payload = await get(`${apiBase}/elections/${county.slug}/${electionId}/data`);
    if (!payload) {
      log(`warning: no payload for ${county.slug}`);
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
  log(`${countyRaces.length} county-scoped ballot items`);

  const races = mergeRaces({ statewideRaces, countyRaces });
  log(`${races.length} distinct races after merge`);

  return {
    electionId,
    electionName: pickText(stateData.election?.name) || `Washington ${electionId}`,
    electionDate: `${electionId.slice(0, 4)}-${electionId.slice(4, 6)}-${electionId.slice(6, 8)}`,
    isOfficial: Boolean(electionMeta.isOfficialResults),
    isSample,
    asOf: electionMeta.asOf ?? null,
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
}

/** The listing the app loads first, to discover the newest election. */
export function buildIndex(snapshot) {
  return {
    elections: [
      {
        electionId: snapshot.electionId,
        electionName: snapshot.electionName,
        electionDate: snapshot.electionDate,
        isOfficial: snapshot.isOfficial,
        isSample: snapshot.isSample,
        fetchedAt: snapshot.fetchedAt,
      },
    ],
  };
}
