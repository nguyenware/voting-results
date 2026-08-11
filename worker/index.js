/**
 * Cloudflare Worker: serves the site and keeps the results fresh.
 *
 * Two responsibilities, deliberately split by how often each thing changes:
 *
 *  - The app shell and the boundary files are static assets. They are large
 *    (~1.2 MB of geometry) and change only when the pipeline is re-run, so they
 *    are deployed once and cached hard at the edge.
 *  - The results JSON changes every few minutes on election night. It is served
 *    from KV and refreshed by a cron trigger, so new numbers appear without
 *    rebuilding or redeploying anything.
 *
 * That split is the whole point of putting a Worker in front of this. A plain
 * static deploy would have to rebuild and redeploy 1.2 MB of unchanged geometry
 * every time a county reported.
 *
 * The ingest itself is shared verbatim with the CLI (scripts/lib/ingest.mjs),
 * which is why it has no filesystem dependencies.
 */
import { buildSnapshot, buildIndex, fetchElectionMeta } from '../scripts/lib/ingest.mjs';
import censusCounties from '../public/data/geo/wa-county-index.json';

const KEY_INDEX = 'results:index';
const KEY_SNAPSHOT = (id) => `results:snapshot:${id}`;
/** Last upstream `asOf` we ingested, used to skip redundant fan-outs. */
const KEY_ASOF = (id) => `results:asof:${id}`;

/** Matches upstream's own cache policy rather than inventing a longer one. */
const RESULTS_CACHE_CONTROL = 'public, max-age=60, stale-while-revalidate=300';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/__refresh') {
      return handleRefresh(request, env, ctx);
    }

    if (url.pathname.startsWith('/data/results/')) {
      const served = await serveResults(url, env);
      if (served) return served;
      // Fall through to the bundled sample so a fresh deploy is never blank.
    }

    return env.ASSETS.fetch(request);
  },

  /**
   * Cron entry point. Set the schedule in wrangler.jsonc — every 2 minutes
   * while results are moving, far less often the rest of the time.
   */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(refresh(env).catch((err) => console.error('refresh failed:', err.message)));
  },
};

async function serveResults(url, env) {
  const file = url.pathname.slice('/data/results/'.length);
  const key = file === 'index.json' ? KEY_INDEX : KEY_SNAPSHOT(file.replace(/\.json$/, ''));

  const body = await env.RESULTS.get(key, 'text');
  if (!body) return null;

  return new Response(body, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': RESULTS_CACHE_CONTROL,
    },
  });
}

/**
 * Manual refresh, for when you do not want to wait for the next tick.
 * Disabled unless REFRESH_TOKEN is set as a secret:
 *   npx wrangler secret put REFRESH_TOKEN
 *   curl -X POST https://<host>/__refresh -H "Authorization: Bearer <token>"
 */
async function handleRefresh(request, env, ctx) {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  if (!env.REFRESH_TOKEN) return new Response('Refresh endpoint disabled', { status: 404 });

  const auth = request.headers.get('Authorization') ?? '';
  if (auth !== `Bearer ${env.REFRESH_TOKEN}`) return new Response('Unauthorized', { status: 401 });

  const force = new URL(request.url).searchParams.get('force') === '1';
  try {
    const outcome = await refresh(env, { force });
    return Response.json(outcome);
  } catch (err) {
    return Response.json({ ok: false, error: err.message }, { status: 502 });
  } finally {
    void ctx;
  }
}

/**
 * Pulls the current results into KV.
 *
 * The metadata endpoint is checked first because it carries `asOf` and costs
 * one request; when it has not moved we skip the per-county fan-out entirely.
 * On a 2-minute cron that turns most ticks into a single upstream request
 * instead of sixteen.
 */
export async function refresh(env, { force = false } = {}) {
  const electionId = env.ELECTION_ID;
  if (!electionId) throw new Error('ELECTION_ID is not configured');

  const config = {
    electionId,
    ...(env.VOTEWA_API_BASE ? { apiBase: env.VOTEWA_API_BASE } : {}),
    ...(env.VOTEWA_STATE_SLUG ? { stateSlug: env.VOTEWA_STATE_SLUG } : {}),
  };

  const meta = await fetchElectionMeta(config);
  if (!meta) throw new Error(`No election ${electionId} upstream`);

  const previousAsOf = await env.RESULTS.get(KEY_ASOF(electionId));
  if (!force && meta.asOf && previousAsOf === meta.asOf) {
    return { ok: true, skipped: true, reason: 'unchanged', asOf: meta.asOf };
  }

  // Surface the ingest's own progress in `wrangler tail` and the dashboard
  // logs. The county-matching lines are the ones that matter when diagnosing a
  // deploy: if VoteWA ever renames its locality slug field, this is where it
  // shows up as "0 participating counties" rather than as silently empty
  // results.
  const notes = [];
  const snapshot = await buildSnapshot({
    ...config,
    meta,
    censusCounties,
    log: (message) => {
      notes.push(message);
      console.log(`ingest: ${message}`);
    },
  });
  const index = buildIndex(snapshot);

  const countyCount = Object.keys(snapshot.counties).length;
  if (countyCount === 0) {
    throw new Error(
      'Upstream returned no matchable counties — refusing to overwrite good results with an empty snapshot',
    );
  }

  // Snapshot first, then the index that points at it: if the second write
  // fails, readers keep the older but internally consistent pair.
  await env.RESULTS.put(KEY_SNAPSHOT(electionId), JSON.stringify(snapshot));
  await env.RESULTS.put(KEY_INDEX, JSON.stringify(index));
  if (meta.asOf) await env.RESULTS.put(KEY_ASOF(electionId), meta.asOf);

  return {
    ok: true,
    skipped: false,
    electionId,
    electionName: snapshot.electionName,
    asOf: snapshot.asOf,
    isOfficial: snapshot.isOfficial,
    races: snapshot.races.length,
    counties: countyCount,
    notes,
  };
}
