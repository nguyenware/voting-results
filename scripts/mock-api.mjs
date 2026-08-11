#!/usr/bin/env node
/**
 * A local stand-in for the VoteWA public results API.
 *
 * It serves payloads in the same shape as the real endpoints so that
 * `fetch-results.mjs` can be exercised end to end — including the county
 * fan-out, the parentId race merge, and the output file layout — without
 * touching the live Secretary of State service.
 *
 * Two uses:
 *   1. Verification. Point the real ingest script at it:
 *        node scripts/mock-api.mjs --port 8787 &
 *        VOTEWA_API_BASE=http://127.0.0.1:8787/results/public/api \
 *          node scripts/fetch-results.mjs 20260804
 *   2. Sample data. `npm run data:sample` does exactly that and marks the
 *      resulting snapshot isSample:true so the UI can label it loudly.
 *
 * EVERY NAME AND NUMBER BELOW IS INVENTED. These are not real candidates and
 * not real results. The point is to exercise the pipeline, not to depict an
 * election.
 */
import { createServer } from 'node:http';

const PORT = Number(process.argv[process.argv.indexOf('--port') + 1]) || 8787;
const ELECTION = '20260804';

/** Counties the mock election "participates" in, as VoteWA slugs. */
const COUNTIES = [
  { slug: 'king-county-wa', name: 'King County', weight: 1.0 },
  { slug: 'pierce-county-wa', name: 'Pierce County', weight: 0.42 },
  { slug: 'snohomish-county-wa', name: 'Snohomish County', weight: 0.38 },
  { slug: 'spokane-county-wa', name: 'Spokane County', weight: 0.3 },
  { slug: 'clark-county-wa', name: 'Clark County', weight: 0.28 },
  { slug: 'thurston-county-wa', name: 'Thurston County', weight: 0.17 },
  { slug: 'kitsap-county-wa', name: 'Kitsap County', weight: 0.15 },
  { slug: 'yakima-county-wa', name: 'Yakima County', weight: 0.13 },
  { slug: 'whatcom-county-wa', name: 'Whatcom County', weight: 0.12 },
  { slug: 'benton-county-wa', name: 'Benton County', weight: 0.11 },
  { slug: 'skagit-county-wa', name: 'Skagit County', weight: 0.08 },
  { slug: 'grays-harbor-county-wa', name: 'Grays Harbor County', weight: 0.05 },
  { slug: 'mason-county-wa', name: 'Mason County', weight: 0.04 },
  { slug: 'san-juan-county-wa', name: 'San Juan County', weight: 0.02 },
];

const en = (text) => [{ languageId: 'en', text }];

/**
 * Statewide contests, each with a per-county lean so the choropleth shows
 * real variation rather than a flat map. `lean` shifts the first option's
 * share up or down in that county.
 */
const STATEWIDE = [
  {
    id: 'agg-treasurer',
    contestType: 'Candidate',
    name: 'State Treasurer',
    options: [
      { id: 'o1', name: 'Marisol Vega', party: 'D', base: 0.53 },
      { id: 'o2', name: 'Dale Whitcomb', party: 'R', base: 0.41 },
      { id: 'o3', name: 'Junia Park', party: 'I', base: 0.06 },
    ],
    leans: {
      'king-county-wa': 0.16,
      'spokane-county-wa': -0.13,
      'yakima-county-wa': -0.18,
      'benton-county-wa': -0.15,
      'san-juan-county-wa': 0.19,
      'whatcom-county-wa': 0.05,
      'grays-harbor-county-wa': -0.08,
    },
  },
  {
    id: 'agg-commissioner',
    contestType: 'Candidate',
    name: 'Commissioner of Public Lands',
    options: [
      { id: 'p1', name: 'Rosalind Ferrer', party: 'D', base: 0.48 },
      { id: 'p2', name: 'Owen Brackett', party: 'R', base: 0.44 },
      { id: 'p3', name: 'Write-in', party: null, base: 0.08, isWriteIn: true },
    ],
    leans: {
      'king-county-wa': 0.14,
      'snohomish-county-wa': 0.03,
      'spokane-county-wa': -0.1,
      'yakima-county-wa': -0.16,
      'benton-county-wa': -0.12,
    },
  },
  {
    id: 'agg-initiative',
    contestType: 'BallotMeasure',
    name: 'Initiative Measure No. 2201 — Transportation Funding',
    options: [
      { id: 'y', name: 'Yes', party: null, base: 0.47 },
      { id: 'n', name: 'No', party: null, base: 0.53 },
    ],
    leans: {
      'king-county-wa': 0.12,
      'thurston-county-wa': 0.04,
      'spokane-county-wa': -0.07,
      'benton-county-wa': -0.11,
      'yakima-county-wa': -0.09,
    },
  },
];

/** Contests that appear on only some counties' ballots (no statewide row). */
const LOCAL = [
  {
    id: 'local-nm-levy',
    contestType: 'BallotMeasure',
    name: 'North Mason School District No. 403 — Capital Levy',
    counties: ['mason-county-wa', 'kitsap-county-wa'],
    options: [
      { id: 'ly', name: 'Yes', party: null, base: 0.51 },
      { id: 'ln', name: 'No', party: null, base: 0.49 },
    ],
  },
  {
    id: 'local-sj-hospital',
    contestType: 'BallotMeasure',
    name: 'San Juan County Public Hospital District No. 1 — Operations Levy',
    counties: ['san-juan-county-wa'],
    options: [
      { id: 'hy', name: 'Yes', party: null, base: 0.62 },
      { id: 'hn', name: 'No', party: null, base: 0.38 },
    ],
  },
  {
    id: 'local-king-council',
    contestType: 'Candidate',
    name: 'King County Council District 4',
    counties: ['king-county-wa'],
    options: [
      { id: 'k1', name: 'Theo Nakamura', party: null, base: 0.44 },
      { id: 'k2', name: 'Priya Raghunathan', party: null, base: 0.39 },
      { id: 'k3', name: 'Bert Sandoval', party: null, base: 0.17 },
    ],
  },
];

/** Deterministic pseudo-random so repeated runs produce identical files. */
function hashFloat(seed) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

const BASE_TURNOUT = 240_000;

function countyBallots(slug) {
  const county = COUNTIES.find((c) => c.slug === slug);
  const jitter = 0.85 + hashFloat(`ballots:${slug}`) * 0.3;
  return Math.round(BASE_TURNOUT * (county?.weight ?? 0.1) * jitter);
}

/** Splits a county's ballots across a contest's options, applying its lean. */
function buildOptions(contest, slug, totalBallots) {
  const lean = contest.leans?.[slug] ?? 0;
  const jitter = (id) => (hashFloat(`${contest.id}:${slug}:${id}`) - 0.5) * 0.04;

  const shares = contest.options.map((opt, index) => {
    const adjusted = opt.base + (index === 0 ? lean : -lean / (contest.options.length - 1));
    return Math.max(0.01, adjusted + jitter(opt.id));
  });
  const sum = shares.reduce((a, b) => a + b, 0);

  let allocated = 0;
  return contest.options.map((opt, index) => {
    const isLast = index === contest.options.length - 1;
    const votes = isLast
      ? totalBallots - allocated
      : Math.round((shares[index] / sum) * totalBallots);
    allocated += votes;
    return {
      id: `${opt.id}-${slug}`,
      nativeId: opt.id,
      name: en(opt.name),
      party: opt.party ? { abbreviation: opt.party } : null,
      isWriteIn: Boolean(opt.isWriteIn),
      isWinner: null,
      voteCount: votes,
      // Deliberately slightly wrong, to prove the normalizer recomputes it.
      votePercent: Math.round((votes / totalBallots) * 1000) / 10 + 0.1,
    };
  });
}

function ballotItemsFor(slug) {
  const totalBallots = countyBallots(slug);
  const items = [];

  for (const contest of STATEWIDE) {
    // ~92% of ballots record a vote in any given contest (undervote).
    const cast = Math.round(totalBallots * 0.92);
    items.push({
      id: `${contest.id}-${slug}`,
      parentId: contest.id,
      contestType: contest.contestType,
      name: en(contest.name),
      summaryResults: { ballotOptions: buildOptions(contest, slug, cast) },
    });
  }

  for (const contest of LOCAL) {
    if (!contest.counties.includes(slug)) continue;
    const cast = Math.round(totalBallots * 0.6);
    items.push({
      id: `${contest.id}-${slug}`,
      parentId: contest.id,
      contestType: contest.contestType,
      name: en(contest.name),
      summaryResults: { ballotOptions: buildOptions(contest, slug, cast) },
    });
  }

  return items;
}

/** Statewide aggregate rows: the sum of every county's copy of the contest. */
function statewideBallotItems() {
  return STATEWIDE.map((contest) => {
    const totals = new Map();
    for (const county of COUNTIES) {
      const item = ballotItemsFor(county.slug).find((i) => i.parentId === contest.id);
      for (const opt of item?.summaryResults.ballotOptions ?? []) {
        const prev = totals.get(opt.nativeId) ?? { ...opt, voteCount: 0 };
        totals.set(opt.nativeId, { ...prev, voteCount: prev.voteCount + opt.voteCount });
      }
    }
    const rows = [...totals.values()];
    const sum = rows.reduce((s, r) => s + r.voteCount, 0);
    return {
      id: contest.id,
      contestType: contest.contestType,
      name: en(contest.name),
      summaryResults: {
        ballotOptions: rows.map((r) => ({
          ...r,
          id: r.nativeId,
          votePercent: Math.round((r.voteCount / sum) * 1000) / 10,
        })),
      },
    };
  });
}

function precinctsFor(slug) {
  const count = slug === 'king-county-wa' ? 24 : 12;
  return Array.from({ length: count }, (_, i) => ({
    id: `${slug}-p${i}`,
    name: String(100 + i),
    order: i + 1,
    reportingStatus: 3,
  }));
}

function turnoutFor(slug) {
  const precincts = precinctsFor(slug);
  const ballots = countyBallots(slug);
  const per = Math.floor(ballots / precincts.length);
  return precincts.map((p, i) => ({
    id: p.id,
    precinctName: p.name,
    ballotsCast: i === precincts.length - 1 ? ballots - per * (precincts.length - 1) : per,
    voterTurnout: per,
    voterRegistration: Math.round(per / 0.41),
  }));
}

const META = {
  asOf: '2026-08-08T02:15:00.0000000Z',
  isOfficialResults: false,
  lastUpdated: '2026-08-08T02:15:00Z',
};

function stateDataPayload() {
  return {
    // The county directory lives here, NOT on the localityElections entries.
    // Note the deliberately UPPERCASE ids: upstream returns these GUIDs in a
    // different case than localityElections[].jurisdictionId does, so a
    // case-sensitive join silently finds zero counties.
    jurisdiction: {
      id: 'juris-wa',
      shortName: 'washington',
      name: en('Washington'),
      childLocalities: COUNTIES.map((c) => ({
        id: `JURIS-${c.slug.toUpperCase()}`,
        shortName: c.slug,
        name: en(c.name),
      })),
    },
    election: {
      id: 'election-wa-20260804',
      name: en('2026 Primary (SAMPLE DATA — NOT REAL RESULTS)'),
      // Deliberately wrong, mirroring the real API's unreliable summary
      // scalars, to confirm the ingest ignores them.
      ballotItemCount: 1,
      ballotsCast: 0,
    },
    // Mirrors the real payload exactly, which matters more than it looks: two
    // earlier versions of this mock invented a county name or slug on these
    // entries, so the tests passed while production matched zero counties.
    //
    // A real entry names its ELECTION, never its county — `name` is
    // "2026 Primary" for all 39 — and points at the county only by GUID.
    // Resolving that GUID against jurisdiction.childLocalities[] is the only
    // way to learn which county this is.
    localityElections: COUNTIES.map((c) => ({
      id: `le-${c.slug}`,
      jurisdictionId: `juris-${c.slug}`, // lowercase here, UPPERCASE above
      name: en('2026 Primary'),
      isPrimary: true,
      ballotItemCount: 1,
      totalVoters: 0,
    })),
    ballotItems: statewideBallotItems(),
    precincts: [],
    pollingPlaces: [],
    statistics: [],
    voterRegistration: [],
    voterTurnout: [],
    ballotItemWithBreakdown: null,
  };
}

function countyDataPayload(slug) {
  const county = COUNTIES.find((c) => c.slug === slug);
  if (!county) return null;
  return {
    jurisdiction: { id: `juris-${slug}`, shortName: county.name, name: en(county.name) },
    election: { id: `le-${slug}`, name: en('2026 Primary (SAMPLE DATA)') },
    localityElections: [],
    ballotItems: ballotItemsFor(slug),
    precincts: precinctsFor(slug),
    pollingPlaces: [],
    statistics: [],
    voterRegistration: [],
    voterTurnout: turnoutFor(slug),
    ballotItemWithBreakdown: null,
  };
}

export function createMockApi() {
  return createServer(handler);
}

/** Starts the mock on an ephemeral port; resolves with { port, close }. */
export function startMockApi(port = 0) {
  return new Promise((resolve) => {
    const server = createMockApi();
    server.listen(port, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const parts = url.pathname.replace(/^\/+|\/+$/g, '').split('/');
  // .../api/elections/{slug}/{electionId}[/data]
  const idx = parts.indexOf('elections');

  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };

  if (idx === -1 || parts.length < idx + 3) return send(404, { error: 'not found' });

  const slug = parts[idx + 1];
  const electionId = parts[idx + 2];
  const isData = parts[idx + 3] === 'data';

  if (electionId !== ELECTION) return send(404, { error: 'unknown election' });

  if (!isData) return send(200, META);
  if (slug === 'washington') return send(200, stateDataPayload());

  const payload = countyDataPayload(slug);
  return payload ? send(200, payload) : send(404, { error: 'unknown locality' });
}

// Run standalone only when invoked directly, not when imported.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { port } = await startMockApi(PORT);
  console.log(`mock VoteWA API on http://127.0.0.1:${port}/results/public/api`);
}
