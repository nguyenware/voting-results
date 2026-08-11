#!/usr/bin/env node
/**
 * Runs the ingest and writes the result straight into Cloudflare KV over the
 * REST API, so the Worker never has to do the expensive part.
 *
 * Why this exists
 * ---------------
 * Workers' free plan allows 10 ms of CPU per invocation. Parsing ~40 county
 * payloads and normalizing them costs well over 100 ms, so the in-Worker cron
 * only fits on a paid plan. Moving just the ingest to a runner with no CPU
 * ceiling keeps the whole stack on free tiers: the Worker is left doing what it
 * is cheap at — reading a value out of KV and returning it.
 *
 * It is the same ingest either way; scripts/lib/ingest.mjs is shared with the
 * Worker, so the two cannot produce different results.
 *
 *   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... node scripts/push-to-kv.mjs
 *
 * The API token needs Workers KV Storage: Edit.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSnapshot, buildIndex, fetchElectionMeta } from './lib/ingest.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CF_API = 'https://api.cloudflare.com/client/v4';

const KEY_INDEX = 'results:index';
const KEY_SNAPSHOT = (id) => `results:snapshot:${id}`;
const KEY_ASOF = (id) => `results:asof:${id}`;

/**
 * Strips comments from JSONC without mangling comment-like sequences inside
 * strings (a URL's "//" being the obvious trap).
 */
export function stripJsonComments(text) {
  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];

    if (inLine) {
      if (ch === '\n') {
        inLine = false;
        out += ch;
      }
      continue;
    }
    if (inBlock) {
      if (ch === '*' && next === '/') {
        inBlock = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i += 1;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLine = true;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlock = true;
      i += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

/** Pulls the KV namespace id and election id out of wrangler.jsonc. */
export function parseWranglerConfig(text) {
  const config = JSON.parse(stripJsonComments(text));
  const namespace = (config.kv_namespaces ?? []).find((n) => n.binding === 'RESULTS');
  if (!namespace?.id) throw new Error('No kv_namespaces entry with binding "RESULTS" in wrangler.jsonc');
  if (namespace.id.startsWith('REPLACE_')) {
    throw new Error('wrangler.jsonc still has the placeholder KV namespace id');
  }
  const electionId = config.vars?.ELECTION_ID;
  if (!electionId) throw new Error('No vars.ELECTION_ID in wrangler.jsonc');
  return { namespaceId: namespace.id, electionId };
}

async function kvGet({ accountId, apiToken, namespaceId, key, fetchImpl }) {
  const res = await fetchImpl(
    `${CF_API}/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(key)}`,
    { headers: { Authorization: `Bearer ${apiToken}` } },
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`KV read failed: HTTP ${res.status}`);
  return res.text();
}

/** One bulk call rather than three round trips. */
async function kvPutBulk({ accountId, apiToken, namespaceId, entries, fetchImpl }) {
  const res = await fetchImpl(
    `${CF_API}/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/bulk`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(entries),
    },
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`KV write failed: HTTP ${res.status} ${detail.slice(0, 300)}`);
  }
  return res.json().catch(() => ({}));
}

export async function pushToKv({
  accountId,
  apiToken,
  namespaceId,
  electionId,
  censusCounties,
  apiBase,
  force = false,
  fetchImpl = fetch,
  log = console.log,
}) {
  if (!accountId) throw new Error('CLOUDFLARE_ACCOUNT_ID is not set');
  if (!apiToken) throw new Error('CLOUDFLARE_API_TOKEN is not set');

  const config = { electionId, ...(apiBase ? { apiBase } : {}) };

  // Cheap change-detector: one upstream request. When nothing has moved we
  // skip both the county fan-out and the KV writes, which is what keeps this
  // inside the free KV write allowance.
  const meta = await fetchElectionMeta(config);
  if (!meta) throw new Error(`No election ${electionId} upstream`);

  const previousAsOf = await kvGet({
    accountId,
    apiToken,
    namespaceId,
    key: KEY_ASOF(electionId),
    fetchImpl,
  });
  if (!force && meta.asOf && previousAsOf === meta.asOf) {
    log(`unchanged (asOf ${meta.asOf}) — nothing written`);
    return { ok: true, skipped: true, asOf: meta.asOf };
  }

  const snapshot = await buildSnapshot({
    ...config,
    meta,
    censusCounties,
    log: (m) => log(`  ${m}`),
  });
  const countyCount = Object.keys(snapshot.counties).length;
  if (countyCount === 0) {
    throw new Error(
      'Upstream returned no matchable counties — refusing to overwrite good results with an empty snapshot',
    );
  }

  await kvPutBulk({
    accountId,
    apiToken,
    namespaceId,
    fetchImpl,
    entries: [
      { key: KEY_SNAPSHOT(electionId), value: JSON.stringify(snapshot) },
      { key: KEY_INDEX, value: JSON.stringify(buildIndex(snapshot)) },
      ...(meta.asOf ? [{ key: KEY_ASOF(electionId), value: meta.asOf }] : []),
    ],
  });

  log(`wrote ${countyCount} counties, ${snapshot.races.length} races (asOf ${snapshot.asOf})`);
  return {
    ok: true,
    skipped: false,
    asOf: snapshot.asOf,
    counties: countyCount,
    races: snapshot.races.length,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const wrangler = await readFile(path.join(ROOT, 'wrangler.jsonc'), 'utf8');
  const { namespaceId, electionId } = parseWranglerConfig(wrangler);
  const censusCounties = JSON.parse(
    await readFile(path.join(ROOT, 'public/data/geo/wa-county-index.json'), 'utf8'),
  );

  pushToKv({
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: process.env.CLOUDFLARE_API_TOKEN,
    namespaceId,
    censusCounties,
    electionId: process.env.ELECTION_ID ?? electionId,
    ...(process.env.VOTEWA_API_BASE ? { apiBase: process.env.VOTEWA_API_BASE } : {}),
    force: process.argv.includes('--force'),
  })
    .then((outcome) => {
      if (!outcome.skipped) console.log('done');
    })
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
