import { describe, it, expect } from 'vitest';
import {
  normalizeZipInput,
  isWashingtonZip,
  lookupZip,
  leader,
  countyLeader,
  raceCountiesInZip,
} from './lookup';
import type { ElectionSnapshot, Race, ZipCrosswalk } from './types';

const race = (over: Partial<Race> = {}): Race => ({
  id: 'r1',
  name: 'State Treasurer',
  contestType: 'Candidate',
  districtName: null,
  totalVotes: 1000,
  options: [
    { id: 'a', name: 'Vega', party: 'D', isWriteIn: false, isWinner: null, votes: 600, pct: 60 },
    { id: 'b', name: 'Whitcomb', party: 'R', isWriteIn: false, isWinner: null, votes: 400, pct: 40 },
  ],
  countyFips: ['53033'],
  byCounty: {
    '53033': {
      totalVotes: 1000,
      options: [
        { name: 'Vega', party: 'D', votes: 600, pct: 60 },
        { name: 'Whitcomb', party: 'R', votes: 400, pct: 40 },
      ],
    },
  },
  ...over,
});

const snapshot = (races: Race[], countyFips: string[]): ElectionSnapshot => ({
  electionId: '20260804',
  electionName: 'Test',
  electionDate: '2026-08-04',
  isOfficial: false,
  isSample: true,
  asOf: null,
  fetchedAt: '2026-08-08T00:00:00Z',
  source: { name: 'test', metaUrl: null, dataUrl: null, publicPage: '' },
  counties: Object.fromEntries(
    countyFips.map((f) => [f, { fips: f, name: `County ${f}`, slug: '', electionId: null }]),
  ),
  races,
});

const crosswalk: ZipCrosswalk = {
  '98101': {
    zip: '98101',
    cities: ['Seattle'],
    primaryCounty: 'King',
    counties: [{ fips: '53033', name: 'King', areaShare: 1 }],
  },
  '98022': {
    zip: '98022',
    cities: ['Enumclaw'],
    primaryCounty: 'King',
    counties: [
      { fips: '53033', name: 'King', areaShare: 0.65 },
      { fips: '53053', name: 'Pierce', areaShare: 0.35 },
    ],
  },
  '99403': {
    zip: '99403',
    cities: ['Clarkston'],
    primaryCounty: 'Asotin',
    counties: [{ fips: '53003', name: 'Asotin', areaShare: 1 }],
  },
};

describe('normalizeZipInput', () => {
  it('accepts a plain 5-digit ZIP', () => {
    expect(normalizeZipInput('98101')).toBe('98101');
  });

  it('accepts ZIP+4 and whitespace, keeping the first five digits', () => {
    expect(normalizeZipInput('  98101-1234 ')).toBe('98101');
    expect(normalizeZipInput('98101 1234')).toBe('98101');
  });

  it('rejects anything shorter than five digits', () => {
    expect(normalizeZipInput('9810')).toBeNull();
    expect(normalizeZipInput('')).toBeNull();
    expect(normalizeZipInput('abcde')).toBeNull();
  });
});

describe('isWashingtonZip', () => {
  it('recognises the Washington range', () => {
    expect(isWashingtonZip('98101')).toBe(true);
    expect(isWashingtonZip('99403')).toBe(true);
  });

  it('rejects out-of-state ZIPs', () => {
    expect(isWashingtonZip('97201')).toBe(false); // Portland, OR
    expect(isWashingtonZip('10001')).toBe(false); // New York, NY
    expect(isWashingtonZip('99501')).toBe(false); // Anchorage, AK
  });
});

describe('lookupZip', () => {
  const snap = snapshot([race()], ['53033']);

  it('resolves a single-county ZIP to its races', () => {
    const result = lookupZip('98101', crosswalk, snap);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reportingCounties.map((c) => c.name)).toEqual(['King']);
    expect(result.races).toHaveLength(1);
  });

  it('reports both counties for a ZIP that straddles a county line', () => {
    const twoCounty = snapshot([race({ countyFips: ['53033', '53053'] })], ['53033', '53053']);
    const result = lookupZip('98022', crosswalk, twoCounty);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reportingCounties.map((c) => c.name)).toEqual(['King', 'Pierce']);
    expect(result.zip.primaryCounty).toBe('King');
  });

  it('separates counties the snapshot does not cover from those it does', () => {
    // Pierce is in the ZIP but did not participate in this election.
    const result = lookupZip('98022', crosswalk, snap);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reportingCounties.map((c) => c.name)).toEqual(['King']);
    expect(result.missingCounties.map((c) => c.name)).toEqual(['Pierce']);
  });

  it('unions races across a ZIP’s counties rather than intersecting them', () => {
    const kingOnly = race({ id: 'king', countyFips: ['53033'] });
    const pierceOnly = race({ id: 'pierce', countyFips: ['53053'], totalVotes: 500 });
    const both = snapshot([kingOnly, pierceOnly], ['53033', '53053']);
    const result = lookupZip('98022', crosswalk, both);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.races.map((r) => r.id).sort()).toEqual(['king', 'pierce']);
  });

  it('excludes races no county in the ZIP votes on', () => {
    const elsewhere = race({ id: 'spokane', countyFips: ['53063'] });
    const both = snapshot([race(), elsewhere], ['53033', '53063']);
    const result = lookupZip('98101', crosswalk, both);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.races.map((r) => r.id)).toEqual(['r1']);
  });

  it('flags malformed input', () => {
    expect(lookupZip('123', crosswalk, snap)).toMatchObject({ ok: false, error: 'invalid' });
  });

  it('distinguishes an out-of-state ZIP from an unknown Washington one', () => {
    expect(lookupZip('97201', crosswalk, snap)).toMatchObject({
      ok: false,
      error: 'not-washington',
    });
    // In the WA range but absent from the crosswalk (e.g. a PO-box-only ZIP).
    expect(lookupZip('98999', crosswalk, snap)).toMatchObject({ ok: false, error: 'no-results' });
  });
});

describe('raceCountiesInZip', () => {
  it('intersects a race’s counties with the ZIP’s', () => {
    const r = race({ countyFips: ['53033', '53053', '53063'] });
    expect(raceCountiesInZip(r, ['53033', '53053'])).toEqual(['53033', '53053']);
  });
});

describe('leader', () => {
  it('returns the top option and its margin', () => {
    expect(leader(race())).toEqual({ name: 'Vega', pct: 60, margin: 20 });
  });

  it('returns null on an exact tie', () => {
    const tied = race({
      options: [
        { id: 'a', name: 'A', party: null, isWriteIn: false, isWinner: null, votes: 500, pct: 50 },
        { id: 'b', name: 'B', party: null, isWriteIn: false, isWinner: null, votes: 500, pct: 50 },
      ],
    });
    expect(leader(tied)).toBeNull();
  });

  it('returns null before any votes are counted', () => {
    expect(leader(race({ totalVotes: 0 }))).toBeNull();
  });

  it('treats a single-option race as a full margin', () => {
    const solo = race({
      options: [
        { id: 'a', name: 'A', party: null, isWriteIn: false, isWinner: null, votes: 10, pct: 100 },
      ],
    });
    expect(leader(solo)).toEqual({ name: 'A', pct: 100, margin: 100 });
  });
});

describe('countyLeader', () => {
  it('reads the leader from that county’s breakdown', () => {
    expect(countyLeader(race(), '53033')).toEqual({ name: 'Vega', pct: 60, margin: 20 });
  });

  it('returns null for a county with no breakdown', () => {
    expect(countyLeader(race(), '53053')).toBeNull();
  });

  it('can differ from the statewide leader', () => {
    const r = race({
      countyFips: ['53033', '53063'],
      byCounty: {
        '53033': {
          totalVotes: 100,
          options: [
            { name: 'Vega', party: 'D', votes: 70, pct: 70 },
            { name: 'Whitcomb', party: 'R', votes: 30, pct: 30 },
          ],
        },
        '53063': {
          totalVotes: 100,
          options: [
            { name: 'Vega', party: 'D', votes: 40, pct: 40 },
            { name: 'Whitcomb', party: 'R', votes: 60, pct: 60 },
          ],
        },
      },
    });
    expect(leader(r)?.name).toBe('Vega');
    expect(countyLeader(r, '53063')?.name).toBe('Whitcomb');
  });
});
