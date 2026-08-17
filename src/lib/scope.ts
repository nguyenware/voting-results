import type { ElectionSnapshot, Race } from './types';

/**
 * Works out which of a county's contests were plausibly on *this ZIP's* ballot.
 *
 * The problem this solves: results are reported per county, but a county runs
 * far more contests than any one voter sees. King County alone covers ~15
 * legislative districts plus dozens of city, school, fire, and water district
 * races. Listing every one of them under a ZIP is technically accurate and
 * practically useless — a voter there saw maybe 8 to 15.
 *
 * The signal is already in the data: how many of a county's ballots recorded a
 * vote in the contest. A countywide race pulls most of them; a single
 * legislative district pulls a small slice. So coverage separates "this was on
 * your ballot" from "this was on some ballots in your county".
 *
 * Note this is inherently a *county-relative* measure, and that is the right
 * behaviour: Legislative District 24 covers essentially all of Clallam County,
 * so for a Clallam ZIP it correctly reads as on-ballot, while an LD inside King
 * County reads as partial.
 */

/** Above this share of a county's ballots, treat a contest as countywide. */
const COUNTYWIDE_COVERAGE = 0.55;

/** Fraction of participating counties a contest must span to read as statewide. */
const STATEWIDE_SPAN = 0.8;

export type RaceScope = 'statewide' | 'countywide' | 'partial';

export interface ScopedRace {
  race: Race;
  scope: RaceScope;
  /** Share of the ZIP's county ballots that recorded a vote, 0-1. Null if unknown. */
  coverage: number | null;
  /** Whether we believe this appeared on the ZIP's ballots. */
  onBallot: boolean;
}

/**
 * Per-county denominator for coverage.
 *
 * Prefers the county's reported ballots cast, but falls back to its
 * biggest contest — the largest race in a county is a good stand-in for its
 * turnout, and it means coverage still works when turnout data is sparse or
 * missing, which it often is at a scope the API does not populate.
 */
export function countyBallotBaseline(snapshot: ElectionSnapshot): Record<string, number> {
  const baseline: Record<string, number> = {};

  for (const fips of Object.keys(snapshot.counties)) {
    let largestRace = 0;
    for (const race of snapshot.races) {
      const votes = race.byCounty[fips]?.totalVotes ?? 0;
      if (votes > largestRace) largestRace = votes;
    }
    const reported = snapshot.counties[fips]?.ballotsCast ?? 0;
    // Ballots cast can never be fewer than the votes in a single contest;
    // taking the max absorbs a stale or absent turnout figure.
    baseline[fips] = Math.max(reported, largestRace);
  }

  return baseline;
}

/** Highest share of any of the ZIP's counties that voted in this race. */
export function raceCoverage(
  race: Race,
  zipFips: string[],
  baseline: Record<string, number>,
): number | null {
  let best: number | null = null;
  for (const fips of zipFips) {
    const votes = race.byCounty[fips]?.totalVotes;
    const total = baseline[fips];
    if (votes === undefined || !total) continue;
    const ratio = votes / total;
    if (best === null || ratio > best) best = ratio;
  }
  return best;
}

/**
 * Splits a ZIP's races into the ones that were on its ballots and the ones
 * that merely happened somewhere in its counties.
 */
export function scopeRaces(
  races: Race[],
  snapshot: ElectionSnapshot,
  zipFips: string[],
): { onBallot: ScopedRace[]; partial: ScopedRace[] } {
  const baseline = countyBallotBaseline(snapshot);
  const participating = Object.keys(snapshot.counties).length;

  const scoped: ScopedRace[] = races.map((race) => {
    const coverage = raceCoverage(race, zipFips, baseline);
    const spansState =
      participating > 1 && race.countyFips.length >= participating * STATEWIDE_SPAN;

    // A statewide contest is on every ballot by definition, so it does not
    // need — and should not be second-guessed by — the coverage test, which
    // undervote alone can drag below any threshold.
    if (spansState) return { race, scope: 'statewide', coverage, onBallot: true };

    const countywide = coverage === null || coverage >= COUNTYWIDE_COVERAGE;
    return {
      race,
      scope: countywide ? 'countywide' : 'partial',
      coverage,
      onBallot: countywide,
    };
  });

  // Unknown coverage lands in onBallot deliberately: without evidence a
  // contest was partial, hiding it behind a "possibly" fold is the worse error.
  return {
    onBallot: scoped.filter((s) => s.onBallot).sort(byProminence),
    partial: scoped.filter((s) => !s.onBallot).sort(byProminence),
  };
}

/** Statewide first, then the races more of the county voted in. */
function byProminence(a: ScopedRace, b: ScopedRace): number {
  if (a.scope === 'statewide' !== (b.scope === 'statewide')) {
    return a.scope === 'statewide' ? -1 : 1;
  }
  const coverageDelta = (b.coverage ?? 0) - (a.coverage ?? 0);
  if (Math.abs(coverageDelta) > 0.02) return coverageDelta;
  return b.race.totalVotes - a.race.totalVotes;
}
