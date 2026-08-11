import { describe, it, expect } from 'vitest';
import {
  pickText,
  countyKeyFromSlug,
  countyKeyFromName,
  normalizeOptions,
  normalizeBallotItems,
  mergeRaces,
  buildCountyIndex,
} from './normalize.mjs';

/** Shaped after the real Enhanced Voting candidate contest payload. */
function candidateItem(overrides = {}) {
  return {
    id: '01000000-b872-6dac-8b23-08de95a613ed',
    contestType: 'Candidate',
    name: [{ languageId: 'en', text: 'Legislative District 32 Representative Pos. 1' }],
    summaryResults: {
      ballotOptions: [
        {
          id: 'opt-a',
          name: [{ languageId: 'en', text: 'Ada Lovelace' }],
          party: { abbreviation: 'D' },
          voteCount: 6000,
          votePercent: 59.9,
          isWinner: true,
        },
        {
          id: 'opt-b',
          name: [{ languageId: 'en', text: 'Grace Hopper' }],
          party: { abbreviation: 'R' },
          voteCount: 4000,
          votePercent: 40.1,
          isWinner: false,
        },
      ],
    },
    ...overrides,
  };
}

describe('pickText', () => {
  it('prefers the English entry', () => {
    expect(
      pickText([
        { languageId: 'es', text: 'Condado' },
        { languageId: 'en', text: 'County' },
      ]),
    ).toBe('County');
  });

  it('falls back to the first entry when English is absent', () => {
    expect(pickText([{ languageId: 'es', text: 'Condado' }])).toBe('Condado');
  });

  it('tolerates missing, empty, and plain-string values', () => {
    expect(pickText(undefined)).toBe('');
    expect(pickText([])).toBe('');
    expect(pickText('Direct string')).toBe('Direct string');
  });
});

describe('county key joining', () => {
  it('reduces VoteWA slugs and Census names to the same key', () => {
    expect(countyKeyFromSlug('grays-harbor-county-wa')).toBe('graysharbor');
    expect(countyKeyFromName('Grays Harbor')).toBe('graysharbor');
    expect(countyKeyFromSlug('king-county-wa')).toBe(countyKeyFromName('King'));
    expect(countyKeyFromSlug('san-juan-county-wa')).toBe(countyKeyFromName('San Juan'));
  });

  it('handles a Census name that already carries the County suffix', () => {
    expect(countyKeyFromName('Walla Walla County')).toBe('wallawalla');
  });
});

describe('normalizeOptions', () => {
  it('recomputes percentages from vote counts rather than trusting upstream', () => {
    // Upstream says 59.9/40.1; the true split from the counts is 60/40.
    const options = normalizeOptions(candidateItem());
    expect(options.map((o) => o.pct)).toEqual([60, 40]);
    expect(options.reduce((s, o) => s + o.pct, 0)).toBeCloseTo(100, 6);
  });

  it('carries party, winner, and write-in flags through', () => {
    const [first, second] = normalizeOptions(candidateItem());
    expect(first).toMatchObject({ name: 'Ada Lovelace', party: 'D', isWinner: true, votes: 6000 });
    expect(second).toMatchObject({ party: 'R', isWinner: false, isWriteIn: false });
  });

  it('does not divide by zero before any votes are counted', () => {
    const item = candidateItem();
    for (const o of item.summaryResults.ballotOptions) o.voteCount = 0;
    expect(normalizeOptions(item).map((o) => o.pct)).toEqual([0, 0]);
  });

  it('treats a missing party as null instead of an empty string', () => {
    const item = candidateItem();
    delete item.summaryResults.ballotOptions[0].party;
    expect(normalizeOptions(item)[0].party).toBeNull();
  });
});

describe('normalizeBallotItems', () => {
  it('keys a county-local contest by its parent aggregate id', () => {
    const [race] = normalizeBallotItems(
      [candidateItem({ id: 'local-123', parentId: 'aggregate-999' })],
      { scopeFips: '53033' },
    );
    expect(race.raceId).toBe('aggregate-999');
    expect(race.localId).toBe('local-123');
    expect(race.scopeFips).toBe('53033');
  });

  it('keys a contest with no parent by its own id', () => {
    const [race] = normalizeBallotItems([candidateItem({ id: 'solo-1' })]);
    expect(race.raceId).toBe('solo-1');
    expect(race.scopeFips).toBeNull();
  });

  it('classifies ballot measures separately from candidate contests', () => {
    const [measure] = normalizeBallotItems([
      candidateItem({ id: 'm1', contestType: 'BallotMeasure' }),
    ]);
    expect(measure.contestType).toBe('BallotMeasure');
  });

  it('skips items with no usable id', () => {
    expect(normalizeBallotItems([{ contestType: 'Candidate' }])).toHaveLength(0);
  });
});

describe('mergeRaces', () => {
  it('merges a county copy into its statewide aggregate instead of duplicating', () => {
    const statewide = normalizeBallotItems([candidateItem({ id: 'agg-1' })]);
    const king = normalizeBallotItems([candidateItem({ id: 'king-local', parentId: 'agg-1' })], {
      scopeFips: '53033',
    });

    const merged = mergeRaces({ statewideRaces: statewide, countyRaces: king });

    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe('agg-1');
    expect(merged[0].countyFips).toEqual(['53033']);
    expect(merged[0].byCounty['53033'].totalVotes).toBe(10000);
  });

  it('records every county that votes on a race', () => {
    const countyRaces = [
      ...normalizeBallotItems([candidateItem({ id: 'a', parentId: 'agg-1' })], { scopeFips: '53033' }),
      ...normalizeBallotItems([candidateItem({ id: 'b', parentId: 'agg-1' })], { scopeFips: '53061' }),
    ];
    const merged = mergeRaces({ statewideRaces: [], countyRaces });
    expect(merged[0].countyFips).toEqual(['53033', '53061']);
  });

  it('builds statewide totals by summing counties for a county-local contest', () => {
    // A school levy that exists only on two counties' ballots has no statewide
    // aggregate row, so its summary has to be derived.
    const mk = (fips, yes, no) =>
      normalizeBallotItems(
        [
          {
            id: `local-${fips}`,
            contestType: 'BallotMeasure',
            name: [{ languageId: 'en', text: 'North Mason School Levy' }],
            summaryResults: {
              ballotOptions: [
                { id: 'y', name: [{ languageId: 'en', text: 'Yes' }], voteCount: yes },
                { id: 'n', name: [{ languageId: 'en', text: 'No' }], voteCount: no },
              ],
            },
          },
        ],
        { scopeFips: fips },
      );

    // Distinct local ids and no parentId: these must NOT merge into one race.
    const merged = mergeRaces({ countyRaces: [...mk('53045', 300, 200), ...mk('53035', 100, 400)] });
    expect(merged).toHaveLength(2);

    // With a shared parent they do merge, and totals sum across counties.
    const withParent = mergeRaces({
      countyRaces: [
        ...mk('53045', 300, 200).map((r) => ({ ...r, raceId: 'levy', parentId: 'levy' })),
        ...mk('53035', 100, 400).map((r) => ({ ...r, raceId: 'levy', parentId: 'levy' })),
      ],
    });
    expect(withParent).toHaveLength(1);
    expect(withParent[0].totalVotes).toBe(1000);
    const yes = withParent[0].options.find((o) => o.name === 'Yes');
    expect(yes.votes).toBe(400);
    expect(yes.pct).toBe(40);
  });

  it('orders races by total votes, largest first', () => {
    const big = normalizeBallotItems([candidateItem({ id: 'big' })]);
    const small = normalizeBallotItems([
      {
        id: 'small',
        contestType: 'Candidate',
        name: [{ languageId: 'en', text: 'Water District' }],
        summaryResults: {
          ballotOptions: [{ id: 'x', name: [{ languageId: 'en', text: 'X' }], voteCount: 5 }],
        },
      },
    ]);
    const merged = mergeRaces({ statewideRaces: [...small, ...big] });
    expect(merged.map((r) => r.id)).toEqual(['big', 'small']);
  });
});

describe('buildCountyIndex', () => {
  const census = [
    { fips: '53033', name: 'King' },
    { fips: '53027', name: 'Grays Harbor' },
    { fips: '53055', name: 'San Juan' },
  ];

  /**
   * A real localityElections entry: it names its ELECTION, never its county,
   * and points at the county only by GUID.
   */
  const locality = (slug, id) => ({
    id,
    jurisdictionId: `juris-${slug}`,
    name: [{ languageId: 'en', text: '2026 Primary' }],
    isPrimary: true,
  });

  /** The county directory, whose GUIDs upstream returns in a different case. */
  const jurisdiction = (...slugs) => ({
    id: 'juris-wa',
    childLocalities: slugs.map((slug) => ({
      id: `JURIS-${slug.toUpperCase()}`,
      shortName: slug,
      name: [{ languageId: 'en', text: `${slug.split('-county')[0]} County` }],
    })),
  });

  it('joins localities to counties through jurisdiction.childLocalities', () => {
    const { counties, unmatched } = buildCountyIndex(
      [locality('king-county-wa', 'e1'), locality('grays-harbor-county-wa')],
      census,
      jurisdiction('king-county-wa', 'grays-harbor-county-wa'),
    );
    expect(Object.keys(counties).sort()).toEqual(['53027', '53033']);
    expect(counties['53033']).toMatchObject({ name: 'King', slug: 'king-county-wa', electionId: 'e1' });
    expect(unmatched).toEqual([]);
  });

  it('matches GUIDs case-insensitively', () => {
    // The two arrays disagree on case upstream; a case-sensitive join finds
    // nothing at all, which is indistinguishable from the API being down.
    const { counties } = buildCountyIndex(
      [{ id: 'e1', jurisdictionId: 'JuRiS-KiNg-CoUnTy-Wa' }],
      census,
      jurisdiction('king-county-wa'),
    );
    expect(counties['53033']).toMatchObject({ slug: 'king-county-wa' });
  });

  it('keeps the slug form for fetching, not the display name', () => {
    // The slug is used as a URL path segment, so "King County" would 404.
    const { counties } = buildCountyIndex(
      [locality('san-juan-county-wa')],
      census,
      jurisdiction('san-juan-county-wa'),
    );
    expect(counties['53055'].slug).toBe('san-juan-county-wa');
  });

  it('never identifies a county by the entry’s own name', () => {
    // Every entry carries the same election name. Matching on it produced the
    // "39 localities did not match: 2026 Primary, ..." failure — and matching
    // it *successfully* would be worse: 39 counties collapsing into one.
    const { counties, unmatched } = buildCountyIndex(
      [
        { id: 'a', name: [{ languageId: 'en', text: '2026 Primary' }] },
        { id: 'b', name: [{ languageId: 'en', text: '2026 Primary' }] },
      ],
      census,
      jurisdiction('king-county-wa'),
    );
    expect(counties).toEqual({});
    expect(unmatched).toHaveLength(2);
  });

  it('still accepts a flat slug as a fallback', () => {
    const { counties } = buildCountyIndex([{ slug: 'king-county-wa' }], census, null);
    expect(counties['53033']).toMatchObject({ slug: 'king-county-wa' });
  });

  it('reports the jurisdictionId and keys when nothing resolves', () => {
    // So one failed run is enough to locate a field that moved again.
    const { unmatched } = buildCountyIndex([{ id: 'x', jurisdictionId: 'ghost' }], census, null);
    expect(unmatched[0]).toContain('jurisdictionId=ghost');
    expect(unmatched[0]).toContain('keys: id,jurisdictionId');
  });

  it('reports localities it cannot match rather than dropping them silently', () => {
    const { counties, unmatched } = buildCountyIndex(
      [locality('atlantis-county-wa')],
      census,
      jurisdiction('atlantis-county-wa'),
    );
    expect(counties).toEqual({});
    expect(unmatched).toEqual(['atlantis-county-wa']);
  });
});
