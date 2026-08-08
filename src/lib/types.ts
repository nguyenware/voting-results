/** Shapes of the static JSON produced by scripts/ and served from public/data. */

export type ContestType = 'Candidate' | 'BallotMeasure';

export interface RaceOption {
  id: string;
  name: string;
  party: string | null;
  isWriteIn: boolean;
  isWinner: boolean | null;
  votes: number;
  /** Recomputed at ingest from vote counts, so options always sum to 100. */
  pct: number;
}

export interface CountyBreakdown {
  totalVotes: number;
  options: Array<Pick<RaceOption, 'name' | 'party' | 'votes' | 'pct'>>;
}

export interface Race {
  id: string;
  name: string;
  contestType: ContestType;
  districtName: string | null;
  totalVotes: number;
  options: RaceOption[];
  /** Every county whose ballots included this contest. */
  countyFips: string[];
  byCounty: Record<string, CountyBreakdown>;
}

export interface County {
  fips: string;
  name: string;
  slug: string;
  electionId: string | null;
  ballotsCast?: number | null;
  registeredVoters?: number | null;
  precinctCount?: number | null;
}

export interface ElectionSnapshot {
  electionId: string;
  electionName: string;
  electionDate: string;
  isOfficial: boolean;
  /** True for the generated demo dataset; the UI must say so loudly. */
  isSample: boolean;
  asOf: string | null;
  fetchedAt: string;
  source: {
    name: string;
    metaUrl: string | null;
    dataUrl: string | null;
    publicPage: string;
  };
  counties: Record<string, County>;
  races: Race[];
}

export interface ElectionIndexEntry {
  electionId: string;
  electionName: string;
  electionDate: string;
  isOfficial: boolean;
  isSample: boolean;
  fetchedAt: string;
}

/** One county's slice of a ZIP, by land area. */
export interface ZipCountyShare {
  fips: string;
  name: string;
  /** Share of the ZIP's land area, 0-1. Null when geometry could not be measured. */
  areaShare: number | null;
}

export interface ZipEntry {
  zip: string;
  cities: string[];
  /**
   * The county the USPS/Census reference table assigns this ZIP — where its
   * post office and population centre are. Preferred over largest-area for
   * rural ZIPs whose area sprawls into an empty neighbouring county.
   */
  primaryCounty: string | null;
  counties: ZipCountyShare[];
}

export type ZipCrosswalk = Record<string, ZipEntry>;

export interface CountyFeatureProps {
  GEOID: string;
  NAME: string;
}

export interface ZctaFeatureProps {
  ZCTA5CE10: string;
}
