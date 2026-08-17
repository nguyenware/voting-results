import { describe, it, expect } from 'vitest';
import { countyBallotBaseline, raceCoverage, scopeRaces } from './scope';
import type { ElectionSnapshot, Race } from './types';

/** A race with the given per-county vote totals. */
function race(id: string, byCounty: Record<string, number>, over: Partial<Race> = {}): Race {
  const total = Object.values(byCounty).reduce((s, v) => s + v, 0);
  return {
    id,
    name: id,
    contestType: 'Candidate',
    districtName: null,
    totalVotes: total,
    options: [
      { id: 'a', name: 'A', party: null, isWriteIn: false, isWinner: null, votes: total, pct: 100 },
    ],
    countyFips: Object.keys(byCounty),
    byCounty: Object.fromEntries(
      Object.entries(byCounty).map(([fips, votes]) => [
        fips,
        { totalVotes: votes, options: [{ name: 'A', party: null, votes, pct: 100 }] },
      ]),
    ),
    ...over,
  };
}

function snapshot(races: Race[], counties: Record<string, number | null>): ElectionSnapshot {
  return {
    electionId: '20260804',
    electionName: 'Test',
    electionDate: '2026-08-04',
    isOfficial: false,
    isSample: false,
    asOf: null,
    fetchedAt: '2026-08-11T00:00:00Z',
    source: { name: 't', metaUrl: null, dataUrl: null, publicPage: '' },
    counties: Object.fromEntries(
      Object.entries(counties).map(([fips, ballots]) => [
        fips,
        { fips, name: `C${fips}`, slug: '', electionId: null, ballotsCast: ballots },
      ]),
    ),
    races,
  };
}

describe('countyBallotBaseline', () => {
  it('uses reported ballots cast when present', () => {
    const snap = snapshot([race('r', { '53033': 100 })], { '53033': 500 });
    expect(countyBallotBaseline(snap)['53033']).toBe(500);
  });

  it('falls back to the largest contest when turnout is missing', () => {
    // The API does not populate turnout at every scope; without this fallback
    // coverage would be unavailable exactly where it is most needed.
    const snap = snapshot([race('a', { '53033': 400 }), race('b', { '53033': 90 })], {
      '53033': null,
    });
    expect(countyBallotBaseline(snap)['53033']).toBe(400);
  });

  it('never reports fewer ballots than a single contest received', () => {
    const snap = snapshot([race('a', { '53033': 900 })], { '53033': 100 });
    expect(countyBallotBaseline(snap)['53033']).toBe(900);
  });
});

describe('raceCoverage', () => {
  const snap = snapshot([race('r', { '53033': 250, '53053': 900 })], {
    '53033': 1000,
    '53053': 1000,
  });
  const baseline = countyBallotBaseline(snap);

  it('reports the share of the county that voted', () => {
    expect(raceCoverage(snap.races[0]!, ['53033'], baseline)).toBeCloseTo(0.25);
  });

  it('takes the best county when a ZIP spans several', () => {
    expect(raceCoverage(snap.races[0]!, ['53033', '53053'], baseline)).toBeCloseTo(0.9);
  });

  it('returns null when the race has no data for those counties', () => {
    expect(raceCoverage(snap.races[0]!, ['53061'], baseline)).toBeNull();
  });
});

describe('scopeRaces', () => {
  /** 10 counties, so a statewide race spans at least 8 of them. */
  const allCounties = Object.fromEntries(
    Array.from({ length: 10 }, (_, i) => [`5300${i}`, 1000]),
  ) as Record<string, number>;
  const everywhere = Object.fromEntries(Object.keys(allCounties).map((f) => [f, 800]));

  it('keeps a statewide contest on the ballot regardless of undervote', () => {
    // Undervote alone can push a real statewide race below any coverage bar;
    // spanning the state is the stronger signal and must win.
    const sparse = Object.fromEntries(Object.keys(allCounties).map((f) => [f, 200]));
    const snap = snapshot([race('gov', sparse)], allCounties);
    const { onBallot, partial } = scopeRaces(snap.races, snap, ['53000']);
    expect(onBallot.map((s) => s.race.id)).toEqual(['gov']);
    expect(onBallot[0]!.scope).toBe('statewide');
    expect(partial).toHaveLength(0);
  });

  it('treats a countywide contest as on the ballot', () => {
    const snap = snapshot([race('assessor', { '53000': 850 }), race('gov', everywhere)], allCounties);
    const { onBallot } = scopeRaces(snap.races, snap, ['53000']);
    expect(onBallot.map((s) => s.race.id).sort()).toEqual(['assessor', 'gov']);
  });

  it('files a single legislative district inside a big county as partial', () => {
    // The case that motivated this: ~8% of King County voted in LD 43.
    const snap = snapshot([race('ld43', { '53000': 80 }), race('gov', everywhere)], allCounties);
    const { onBallot, partial } = scopeRaces(snap.races, snap, ['53000']);
    expect(onBallot.map((s) => s.race.id)).toEqual(['gov']);
    expect(partial.map((s) => s.race.id)).toEqual(['ld43']);
    expect(partial[0]!.coverage).toBeCloseTo(0.08);
  });

  it('counts a district that covers a whole small county as on the ballot', () => {
    // LD 24 is essentially all of Clallam. County-relative is the right frame:
    // the same contest is partial in a big county and total in a small one.
    const snap = snapshot([race('ld24', { '53000': 950, '53001': 90 })], allCounties);
    expect(scopeRaces(snap.races, snap, ['53000']).onBallot).toHaveLength(1);
    expect(scopeRaces(snap.races, snap, ['53001']).partial).toHaveLength(1);
  });

  it('keeps a race with unknown coverage visible rather than hiding it', () => {
    const snap = snapshot([race('mystery', { '53005': 10 })], allCounties);
    const { onBallot } = scopeRaces(snap.races, snap, ['53000']);
    expect(onBallot.map((s) => s.race.id)).toEqual(['mystery']);
    expect(onBallot[0]!.coverage).toBeNull();
  });

  it('orders statewide first, then by how much of the county voted', () => {
    const snap = snapshot(
      [
        race('small', { '53000': 700 }),
        race('gov', everywhere),
        race('big', { '53000': 900 }),
      ],
      allCounties,
    );
    const { onBallot } = scopeRaces(snap.races, snap, ['53000']);
    expect(onBallot.map((s) => s.race.id)).toEqual(['gov', 'big', 'small']);
  });

  it('does not call anything statewide in a single-county snapshot', () => {
    // With one participating county every race spans 100% of it; calling that
    // statewide would be meaningless.
    const snap = snapshot([race('local', { '53000': 50 })], { '53000': 1000 });
    const { partial } = scopeRaces(snap.races, snap, ['53000']);
    expect(partial.map((s) => s.race.id)).toEqual(['local']);
  });
});
