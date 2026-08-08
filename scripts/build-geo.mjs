#!/usr/bin/env node
/**
 * Builds the static geographic assets the app needs:
 *
 *   public/data/geo/wa-counties.geojson  – 39 WA county polygons (simplified)
 *   public/data/geo/wa-zctas.geojson     – WA ZCTA (ZIP) polygons (simplified)
 *   public/data/geo/zip-crosswalk.json   – ZIP -> county coverage, area weighted
 *
 * Why a crosswalk is necessary
 * ----------------------------
 * Washington reports election results by county and precinct. It does not
 * report them by ZIP code, and ZIP codes are USPS delivery constructs that
 * routinely straddle county lines. So "results for a ZIP" is always a join:
 * ZIP polygon -> overlapping counties -> those counties' results. We compute
 * that join geometrically here (not from a name lookup table) so we can also
 * report how much of each ZIP sits in each county, and be explicit in the UI
 * when a ZIP spans more than one.
 *
 * Sources (all public, no auth):
 *   ZCTA polygons   – OpenDataDE/State-zip-code-GeoJSON (Census TIGER derived)
 *   County polygons – loganpowell/census-geojson, Census cartographic boundary
 *                     500k 2018. Chosen over the more commonly used
 *                     plotly/datasets county file because that one is
 *                     generalized ~10x more coarsely, which visibly misplaces
 *                     county borders — it put Sunnyside (98944) mostly in
 *                     Benton County when it is entirely in Yakima County.
 *   ZIP place names – scpike/us-state-county-zip (also used as a QA check)
 *
 * Usage: node scripts/build-geo.mjs [--refresh]
 */
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as turf from '@turf/turf';
import mapshaper from 'mapshaper';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CACHE_DIR = path.join(ROOT, '.cache/geo');
const OUT_DIR = path.join(ROOT, 'public/data/geo');

const WA_STATE_FIPS = '53';

const SOURCES = {
  zcta: {
    url: 'https://raw.githubusercontent.com/OpenDataDE/State-zip-code-GeoJSON/master/wa_washington_zip_codes_geo.min.json',
    file: 'wa-zcta-raw.json',
  },
  counties: {
    url: 'https://raw.githubusercontent.com/loganpowell/census-geojson/master/GeoJSON/500k/2018/county.json',
    file: 'us-counties-500k.json',
  },
  zipNames: {
    url: 'https://raw.githubusercontent.com/scpike/us-state-county-zip/master/geo-data.csv',
    file: 'zip-county-names.csv',
  },
};

/** Fraction of a ZIP's area in a county below which we treat the overlap as a sliver. */
const SLIVER_THRESHOLD = 0.005;

async function download(name, { url, file }) {
  const dest = path.join(CACHE_DIR, file);
  if (existsSync(dest)) {
    console.log(`  ${name}: using cached ${file}`);
    return dest;
  }
  console.log(`  ${name}: downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status} fetching ${url}`);
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
  return dest;
}

/**
 * Runs a GeoJSON FeatureCollection through mapshaper.
 *
 * The raw TIGER ZCTA polygons are ~21 MB, far too much to ship to a browser,
 * so those get Visvalingam simplification. County polygons arrive already
 * generalized at ~57 KB, and simplifying them again collapses the island
 * MultiPolygons (San Juan, Island county) into single blobs — so counties are
 * passed through with coordinate-precision trimming only.
 *
 * `keep-shapes` prevents whole small polygons from being simplified out of
 * existence, which matters for the many small urban ZCTAs.
 */
async function simplify(collection, percentage, label) {
  const before = JSON.stringify(collection).length;
  const commands =
    percentage === null
      ? '-i input.json -o output.json precision=0.00001'
      : `-i input.json -simplify visvalingam ${percentage} keep-shapes -o output.json precision=0.0001`;
  const output = await mapshaper.applyCommands(commands, {
    'input.json': JSON.stringify(collection),
  });
  const simplified = JSON.parse(Buffer.from(output['output.json']).toString('utf8'));
  const after = JSON.stringify(simplified).length;
  console.log(
    `  ${label}: ${(before / 1e6).toFixed(2)} MB -> ${(after / 1e6).toFixed(2)} MB ` +
      `(${((1 - after / before) * 100).toFixed(1)}% smaller, ` +
      `${countRings(simplified)} rings kept)`,
  );
  return simplified;
}

/** Ring count is the guard that simplification did not delete islands. */
function countRings(collection) {
  let rings = 0;
  for (const f of collection.features) {
    const g = f.geometry;
    if (!g) continue;
    if (g.type === 'Polygon') rings += g.coordinates.length;
    else if (g.type === 'MultiPolygon') rings += g.coordinates.reduce((s, p) => s + p.length, 0);
  }
  return rings;
}

/**
 * Minimal CSV reader — the source file has no quoted fields containing commas.
 * Returns per-ZIP city names and the table's single "primary" county, which we
 * use only as an independent check on the geometric result.
 */
function parseZipNames(csv) {
  const [header, ...rows] = csv.trim().split('\n');
  const cols = header.split(',');
  const zipIdx = cols.indexOf('zipcode');
  const cityIdx = cols.indexOf('city');
  const countyIdx = cols.indexOf('county');
  const stateIdx = cols.indexOf('state_abbr');

  /** @type {Map<string, { cities: Set<string>, counties: Set<string> }>} */
  const byZip = new Map();
  for (const row of rows) {
    const parts = row.split(',');
    if (parts[stateIdx] !== 'WA') continue;
    const zip = (parts[zipIdx] ?? '').padStart(5, '0');
    if (!zip) continue;
    if (!byZip.has(zip)) byZip.set(zip, { cities: new Set(), counties: new Set() });
    const entry = byZip.get(zip);
    const city = (parts[cityIdx] ?? '').trim();
    const county = (parts[countyIdx] ?? '').trim();
    if (city) entry.cities.add(city);
    if (county) entry.counties.add(county);
  }
  return byZip;
}

/**
 * Cross-checks the geometric crosswalk against the name-based ZIP->county
 * table. The table lists exactly one county per ZIP, so it cannot describe
 * ZIPs that straddle a border — but the county it names should always be one
 * we found, and should normally be the largest-share one. Disagreement means
 * the county polygons are too coarse for this job, which is exactly the bug
 * the previous (plotly) county source introduced.
 */
function validateCrosswalk(crosswalk, zipNames) {
  const missing = [];
  const areaDisagrees = [];
  let checked = 0;

  for (const [zip, entry] of Object.entries(crosswalk)) {
    const expected = [...(zipNames.get(zip)?.counties ?? [])][0];
    if (!expected) continue;
    checked += 1;
    const found = entry.counties.map((c) => c.name);
    if (!found.includes(expected)) {
      missing.push(`${zip} expected ${expected}, found ${found.join('/')}`);
      continue;
    }
    // Informational: the reference county is present but is not the biggest
    // slice of land. Expected for rural ZIPs; recorded so a future source
    // change that makes these common is visible rather than silent.
    const byArea = [...entry.counties].sort((a, b) => (b.areaShare ?? 0) - (a.areaShare ?? 0));
    if (byArea[0]?.name !== expected) {
      areaDisagrees.push(`${zip} ${entry.cities[0] ?? ''} primary=${expected} largest-area=${byArea[0]?.name}`);
    }
  }

  console.log(`  validation: ${checked} ZIPs cross-checked against the reference table`);
  if (missing.length) {
    console.log(`  ERROR: ${missing.length} ZIPs missing their expected county:`);
    missing.slice(0, 10).forEach((m) => console.log(`    ${m}`));
  }
  console.log(
    `  note: ${areaDisagrees.length} ZIPs where the primary county is not the largest by land area`,
  );
  areaDisagrees.slice(0, 5).forEach((m) => console.log(`    ${m}`));
  return { missing, areaDisagrees, checked };
}

/**
 * Area-weighted ZIP -> county assignment.
 *
 * turf.intersect can throw on self-intersecting TIGER rings, so every pair is
 * guarded; a failed intersection falls back to a bbox-overlap check so we
 * never silently drop a county that genuinely overlaps the ZIP.
 */
function buildCrosswalk(zctas, counties, zipCityNames) {
  const countyEntries = counties.features.map((f) => ({
    fips: f.properties.GEOID,
    name: f.properties.NAME,
    feature: f,
    bbox: turf.bbox(f),
  }));

  const crosswalk = {};
  let multiCounty = 0;

  for (const zip of zctas.features) {
    const zipCode = zip.properties.ZCTA5CE10;
    const zipBbox = turf.bbox(zip);
    const overlaps = [];
    for (const county of countyEntries) {
      if (!bboxesOverlap(zipBbox, county.bbox)) continue;

      let sharedArea = null;
      try {
        const piece = turf.intersect(turf.featureCollection([zip, county.feature]));
        sharedArea = piece ? turf.area(piece) : 0;
      } catch {
        sharedArea = null; // geometry error — fall back to bbox evidence below
      }

      if (sharedArea === null) {
        overlaps.push({ fips: county.fips, name: county.name, area: null });
      } else if (sharedArea > 0) {
        overlaps.push({ fips: county.fips, name: county.name, area: sharedArea });
      }
    }

    if (overlaps.length === 0) continue;

    // Shares are normalized over the ZIP's *land* that falls in some county,
    // not over the raw ZCTA area. ZCTAs include water (Puget Sound, the
    // Columbia) while the county polygons are land-only, so dividing by raw
    // ZCTA area makes coastal ZIPs sum to as little as 0.33 and reads as
    // missing data rather than as water.
    const totalMeasured = overlaps.reduce((sum, o) => sum + (o.area ?? 0), 0);

    let counties_ = overlaps.map((o) => ({
      fips: o.fips,
      name: o.name,
      // null share = geometry error; the UI shows these without a percentage
      share: o.area === null || totalMeasured === 0 ? null : o.area / totalMeasured,
    }));

    // Drop rounding slivers, but never drop the only county we found.
    const substantial = counties_.filter((c) => c.share === null || c.share >= SLIVER_THRESHOLD);
    if (substantial.length > 0) counties_ = substantial;

    counties_.sort((a, b) => (b.share ?? 0) - (a.share ?? 0));
    if (counties_.length > 1) multiCounty += 1;

    // The reference table's county is where the ZIP's post office and
    // population centre sit. That is a better "primary" for an election app
    // than largest land area: ZCTA 98331's town (Forks) is in Clallam County,
    // but 78% of its area is empty rural Jefferson County. Voters are in Forks.
    const referenceCounty = [...(zipCityNames.get(zipCode)?.counties ?? [])][0] ?? null;
    const primaryIdx = counties_.findIndex((c) => c.name === referenceCounty);
    if (primaryIdx > 0) counties_.unshift(...counties_.splice(primaryIdx, 1));

    crosswalk[zipCode] = {
      zip: zipCode,
      cities: [...(zipCityNames.get(zipCode)?.cities ?? [])].sort(),
      primaryCounty: primaryIdx >= 0 ? referenceCounty : (counties_[0]?.name ?? null),
      counties: counties_.map((c) => ({
        fips: c.fips,
        name: c.name,
        areaShare: c.share === null ? null : Number(c.share.toFixed(4)),
      })),
    };
  }

  console.log(
    `  crosswalk: ${Object.keys(crosswalk).length} ZIPs, ` +
      `${multiCounty} span more than one county`,
  );
  return crosswalk;
}

function bboxesOverlap(a, b) {
  return !(a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1]);
}

async function main() {
  const shouldRefresh = process.argv.includes('--refresh');
  if (shouldRefresh && existsSync(CACHE_DIR)) await rm(CACHE_DIR, { recursive: true });
  await mkdir(CACHE_DIR, { recursive: true });
  await mkdir(OUT_DIR, { recursive: true });

  console.log('Downloading sources...');
  const [zctaPath, countiesPath, zipNamesPath] = await Promise.all([
    download('zcta', SOURCES.zcta),
    download('counties', SOURCES.counties),
    download('zipNames', SOURCES.zipNames),
  ]);

  console.log('Filtering to Washington...');
  const allCounties = JSON.parse(await readFile(countiesPath, 'utf8'));
  const waCounties = {
    type: 'FeatureCollection',
    features: allCounties.features
      .filter((f) => f.properties.STATEFP === WA_STATE_FIPS)
      .map((f) => ({
        type: 'Feature',
        properties: { GEOID: f.properties.GEOID, NAME: f.properties.NAME },
        geometry: f.geometry,
      })),
  };
  if (waCounties.features.length !== 39) {
    throw new Error(`Expected 39 WA counties, got ${waCounties.features.length}`);
  }
  console.log(`  counties: ${waCounties.features.length} WA counties`);

  const rawZctas = JSON.parse(await readFile(zctaPath, 'utf8'));
  const waZctas = {
    type: 'FeatureCollection',
    features: rawZctas.features.map((f) => ({
      type: 'Feature',
      properties: { ZCTA5CE10: f.properties.ZCTA5CE10 },
      geometry: f.geometry,
    })),
  };
  console.log(`  zctas: ${waZctas.features.length} WA ZCTAs`);

  // Crosswalk is computed on FULL-resolution geometry, before simplification,
  // so simplification artifacts can never change a ZIP's county assignment.
  console.log('Computing ZIP -> county crosswalk (full resolution)...');
  const zipNames = parseZipNames(await readFile(zipNamesPath, 'utf8'));
  const crosswalk = buildCrosswalk(waZctas, waCounties, zipNames);

  const { missing } = validateCrosswalk(crosswalk, zipNames);
  if (missing.length > 0) {
    throw new Error(
      `${missing.length} ZIPs do not overlap the county the reference table assigns them. ` +
        `The county polygons are likely too generalized — do not ship this crosswalk.`,
    );
  }

  console.log('Simplifying geometry for the browser...');
  const simpleCounties = await simplify(waCounties, null, 'counties');
  const simpleZctas = await simplify(waZctas, '3%', 'zctas');

  await Promise.all([
    writeFile(path.join(OUT_DIR, 'wa-counties.geojson'), JSON.stringify(simpleCounties)),
    writeFile(path.join(OUT_DIR, 'wa-zctas.geojson'), JSON.stringify(simpleZctas)),
    writeFile(path.join(OUT_DIR, 'zip-crosswalk.json'), JSON.stringify(crosswalk)),
  ]);

  console.log(`\nWrote geo assets to ${path.relative(ROOT, OUT_DIR)}/`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
