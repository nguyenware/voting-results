import type { ElectionIndexEntry, ElectionSnapshot, ZipCrosswalk } from './types';

const BASE = import.meta.env.BASE_URL;

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`.replace(/\/{2,}/g, '/'));
  if (!res.ok) throw new Error(`Could not load ${path} (HTTP ${res.status})`);
  return (await res.json()) as T;
}

export function loadElectionIndex(): Promise<{ elections: ElectionIndexEntry[] }> {
  return getJson('data/results/index.json');
}

export function loadSnapshot(electionId: string): Promise<ElectionSnapshot> {
  return getJson(`data/results/${electionId}.json`);
}

export function loadCrosswalk(): Promise<ZipCrosswalk> {
  return getJson('data/geo/zip-crosswalk.json');
}

/**
 * County outlines are needed for the first paint of the map; the much larger
 * ZCTA file is only needed once a ZIP is actually looked up, so it is fetched
 * lazily and memoized.
 */
export function loadCounties(): Promise<GeoJSON.FeatureCollection> {
  return getJson('data/geo/wa-counties.geojson');
}

let zctaPromise: Promise<GeoJSON.FeatureCollection> | null = null;
export function loadZctas(): Promise<GeoJSON.FeatureCollection> {
  zctaPromise ??= getJson<GeoJSON.FeatureCollection>('data/geo/wa-zctas.geojson');
  return zctaPromise;
}
