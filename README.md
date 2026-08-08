# Washington election results by ZIP code

A static site that takes a Washington ZIP code and shows the contests that were
on that ZIP's ballots, with a county choropleth of the results.

```bash
npm install
npm run data:geo       # build the boundary + crosswalk files (~2 min, one time)
npm run data:sample    # generate demo data so the app runs offline
npm run dev
```

To load real results instead of the sample:

```bash
npm run data:results            # defaults to the 2026 primary, 20260804
npm run data:results 20261103   # any election, as yyyymmdd
```

## The thing to understand first

**Washington does not report election results by ZIP code.** It reports them by
county and precinct. ZIP codes are USPS delivery routes, not electoral
geography, and they cross county lines routinely — 83 of Washington's 598 ZIP
areas sit in more than one county.

So "results for a ZIP" is necessarily a join, and this site is explicit about
it rather than papering over it:

- A ZIP resolves to **every county it overlaps**, with each county's share of
  the ZIP's land area.
- The contests shown are the **union** of those counties' ballots, because from
  a ZIP alone you cannot tell which county a given voter is in.
- The vote totals are **county totals**, not ZIP totals. Nobody publishes
  results at ZIP granularity, and this site does not invent them.

For a split ZIP the UI names the most likely county and lets you expand each
race to see the counties separately.

### Why "most likely county" is not just the biggest one

The primary county comes from the USPS/Census reference table, which reflects
where the ZIP's post office and population sit — not which county holds the
most acreage. ZCTA 98331 is a good example: the town (Forks) is in Clallam
County, but 82% of the ZIP's *area* is empty rural Jefferson County. Voters are
in Forks. Ten of Washington's ZIPs have this split, and the build logs them.

## Where the data comes from

| Data | Source | Notes |
|---|---|---|
| Election results | [VoteWA public results API](https://results.votewa.gov/results/public/washington/elections/20260804) | `results.votewa.gov/results/public/api` — public, unauthenticated |
| County boundaries | Census cartographic boundary 500k (2018), via `loganpowell/census-geojson` | |
| ZIP (ZCTA) boundaries | Census TIGER ZCTAs, via `OpenDataDE/State-zip-code-GeoJSON` | |
| ZIP → county reference | `scpike/us-state-county-zip` | cross-check only, see below |

Results are unofficial until each county's canvass is certified; the header
badge reflects the API's `isOfficialResults` flag.

## How it is put together

```
scripts/build-geo.mjs      boundaries + ZIP→county crosswalk  → public/data/geo/
scripts/fetch-results.mjs  VoteWA snapshot                    → public/data/results/
scripts/lib/normalize.mjs  pure transforms (unit tested)
scripts/mock-api.mjs       local stand-in for the VoteWA API
scripts/make-sample.mjs    sample data, via the real ingest path
src/                       the React app
```

### The crosswalk is computed, not looked up

`build-geo.mjs` intersects every ZCTA polygon with every county polygon at full
resolution and records the area of each overlap. A name-based lookup table
cannot express a split ZIP at all — the reference table lists exactly one
county per ZIP — so geometry is the only way to know a ZIP straddles a line.

Simplification for the browser happens *after* the intersection, so it can
never change a county assignment.

The build then cross-checks every ZIP against the reference table and **fails**
if any ZIP does not overlap the county the table assigns it. That gate is not
theoretical: the commonly used `plotly/datasets` county file is generalized
coarsely enough to place Sunnyside (98944) mostly in Benton County when it is
entirely in Yakima County. The gate caught it, which is why this repo uses the
Census 500k boundaries instead.

### Results ingestion

The API is a single JSON call per jurisdiction:

```
GET /results/public/api/elections/washington/{yyyymmdd}          → asOf, isOfficialResults
GET /results/public/api/elections/washington/{yyyymmdd}/data     → statewide ballotItems
GET /results/public/api/elections/{county-slug}/{yyyymmdd}/data  → that county's ballotItems
```

Two upstream behaviours shape the normalizer:

- **Contest IDs are scope-relative.** A statewide aggregate contest and the
  county-local contests rolling into it have different `id`s; the local one
  carries `parentId`. Races are keyed on the aggregate id so a county's copy
  merges rather than duplicating.
- **Summary scalars are unreliable.** The statewide payload has been observed
  reporting `ballotItemCount: 1` against three ballot items, and
  `ballotsCast: 0` while its counties summed to 127,800. Only the concrete
  arrays are trusted; percentages are recomputed from vote counts.

We snapshot rather than calling the API from the browser: it publishes
`Cache-Control: max-age=60` and its own client polls every two minutes, so
re-running the script on that order is both sufficient and neighbourly. On
election night, a cron every 2–5 minutes tracks how the data actually moves.

## Charts

The map is a **diverging** encoding — each county shaded toward whichever of the
contest's top two options led there, stepped by margin, with a neutral midpoint
so a near-tie reads as "nothing". Result bars are categorical, with US party
convention pinned (blue Democratic, red Republican) and the party letter always
rendered as text so colour is never the only signal.

Every palette value is a documented step, and the blue/red pole pair validates
all-pairs in both light and dark modes (protanopia ΔE 21.6 / 19.2). Bars are
direct-labelled, the map has a legend naming both poles plus a per-county
tooltip, and a county results table is available for every race — so nothing on
the page depends on colour alone.

No map tiles are used. A basemap adds nothing to a county choropleth and would
make the page depend on a third-party tile host at runtime.

## Tests

```bash
npm test        # 52 tests
npm run build   # typecheck + production build
```

The normalizer, the ZIP lookup rules, and the colour scales are unit tested.
The ingest is exercised end to end against `scripts/mock-api.mjs`, which serves
the same payload shapes as the real API — including the `parentId` merge and
the deliberately-wrong summary scalars.

## Sample data

`npm run data:sample` writes a dataset marked `isSample: true`, which the app
labels with a banner. **The candidates and numbers in it are invented.** It
exists so the app runs and can be reviewed without hitting the live Secretary
of State service. Replace it with `npm run data:results`.

## Deploying

`npm run build` emits a fully static `dist/`. Set `VITE_BASE_PATH` if hosting
under a subpath (e.g. GitHub Pages project sites).
