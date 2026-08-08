import type { ElectionSnapshot, Race, ZipCrosswalk, ZipEntry } from './types';

export type ZipLookupError = 'invalid' | 'not-washington' | 'no-results';

export interface ZipLookupSuccess {
  ok: true;
  zip: ZipEntry;
  /** Counties in this ZIP that the election snapshot actually reports on. */
  reportingCounties: Array<{ fips: string; name: string; areaShare: number | null }>;
  /** Counties in this ZIP with no results in this snapshot (didn't participate). */
  missingCounties: Array<{ fips: string; name: string; areaShare: number | null }>;
  /** Races on the ballot somewhere in this ZIP, most-voted first. */
  races: Race[];
}

export interface ZipLookupFailure {
  ok: false;
  error: ZipLookupError;
  /** Present for 'not-washington' so the UI can name the state prefix. */
  detail?: string;
}

export type ZipLookupResult = ZipLookupSuccess | ZipLookupFailure;

/** Washington ZIP codes occupy 980xx-994xx. */
const WA_ZIP_MIN = 98001;
const WA_ZIP_MAX = 99403;

export function normalizeZipInput(raw: string): string | null {
  // Accept "98101", "98101-1234", and stray whitespace.
  const digits = raw.trim().replace(/[^0-9]/g, '');
  if (digits.length < 5) return null;
  return digits.slice(0, 5);
}

export function isWashingtonZip(zip: string): boolean {
  const n = Number(zip);
  return Number.isInteger(n) && n >= WA_ZIP_MIN && n <= WA_ZIP_MAX;
}

/**
 * Resolves a ZIP to the counties it covers and the races on its ballots.
 *
 * A ZIP's races are the union of its counties' races, not an intersection:
 * a voter in a border ZIP is in exactly one county, but from the ZIP alone we
 * cannot tell which, so we surface everything anyone in that ZIP could have
 * voted on and let the UI attribute each race to its county.
 */
export function lookupZip(
  rawZip: string,
  crosswalk: ZipCrosswalk,
  snapshot: ElectionSnapshot,
): ZipLookupResult {
  const zipCode = normalizeZipInput(rawZip);
  if (!zipCode) return { ok: false, error: 'invalid' };

  const entry = crosswalk[zipCode];
  if (!entry) {
    return isWashingtonZip(zipCode)
      ? { ok: false, error: 'no-results' }
      : { ok: false, error: 'not-washington', detail: zipCode };
  }

  type ResolvedCounty = ZipLookupSuccess['reportingCounties'][number];
  const reportingCounties: ResolvedCounty[] = [];
  const missingCounties: ResolvedCounty[] = [];
  for (const county of entry.counties) {
    const target = snapshot.counties[county.fips] ? reportingCounties : missingCounties;
    target.push({ fips: county.fips, name: county.name, areaShare: county.areaShare });
  }

  const fipsInZip = new Set(reportingCounties.map((c) => c.fips));
  const races = snapshot.races.filter((race) => race.countyFips.some((f) => fipsInZip.has(f)));

  return { ok: true, zip: entry, reportingCounties, missingCounties, races };
}

/**
 * Which of a race's counties overlap this ZIP. Used to caption a race with the
 * county its numbers came from when a ZIP straddles a line.
 */
export function raceCountiesInZip(race: Race, zipFips: string[]): string[] {
  const inZip = new Set(zipFips);
  return race.countyFips.filter((f) => inZip.has(f));
}

/** Leading option, or null for a tie or an empty race. */
export function leader(race: Race): { name: string; pct: number; margin: number } | null {
  if (race.options.length === 0 || race.totalVotes === 0) return null;
  const sorted = [...race.options].sort((a, b) => b.votes - a.votes);
  const first = sorted[0];
  if (!first) return null;
  const second = sorted[1];
  if (second && second.votes === first.votes) return null;
  return { name: first.name, pct: first.pct, margin: first.pct - (second?.pct ?? 0) };
}

/** Leading option within one county, for colouring the map. */
export function countyLeader(
  race: Race,
  fips: string,
): { name: string; pct: number; margin: number } | null {
  const breakdown = race.byCounty[fips];
  if (!breakdown || breakdown.totalVotes === 0) return null;
  const sorted = [...breakdown.options].sort((a, b) => b.votes - a.votes);
  const first = sorted[0];
  if (!first) return null;
  const second = sorted[1];
  if (second && second.votes === first.votes) return null;
  return { name: first.name, pct: first.pct, margin: first.pct - (second?.pct ?? 0) };
}
