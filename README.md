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
scripts/lib/normalize.mjs  pure transforms (unit tested)
scripts/lib/ingest.mjs     fetch + normalize, no filesystem — shared by CLI and Worker
scripts/fetch-results.mjs  Node wrapper: writes a snapshot     → public/data/results/
scripts/mock-api.mjs       local stand-in for the VoteWA API
scripts/make-sample.mjs    sample data, via the real ingest path
scripts/build-demo.mjs     single self-contained HTML file
worker/index.js            Cloudflare Worker: assets + KV results + cron ingest
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

`npm run build` emits a fully static `dist/`, so any static host works. The
question worth thinking about is not hosting — it is **how the results get
refreshed**, because that is the only thing that changes after deploy.

### The split that matters

| What | Size | Changes |
|---|---|---|
| App shell + boundaries | ~1.2 MB | only when you re-run the pipeline |
| Results JSON | ~16 KB | every few minutes on election night |

Rebuilding and redeploying 1.2 MB of unchanged geometry every time a county
reports is the thing to avoid. The Cloudflare setup below serves the shell as
static assets and the results from KV, refreshed by a cron trigger — so new
numbers appear with no rebuild and no redeploy.

### Deploying without cloning

You do not need a local checkout. The boundary files and ZIP crosswalk are
committed, so a build is only `npm ci && npm run build` — the heavy
`npm run data:geo` pipeline has already run and its output is in the repo.
`.github/workflows/deploy.yml` runs the tests and deploys on every push.

Entirely from the browser:

1. **Cloudflare dashboard** → Storage & Databases → KV → **Create namespace**,
   name it `RESULTS`, copy the id.
2. **GitHub web editor** → open `wrangler.jsonc`, replace
   `REPLACE_WITH_YOUR_KV_NAMESPACE_ID` with that id, commit.
3. **Cloudflare** → My Profile → API Tokens → **Create Token** → use the
   *Edit Cloudflare Workers* template. Copy the token. Your account id is in
   the dashboard sidebar.
4. **GitHub** → Settings → Secrets and variables → Actions → add
   `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
5. Push anything, or run the workflow manually from the **Actions** tab.

Step 2's commit will itself trigger the deploy once the secrets from step 4
exist, so ordering matters only in that the secrets must land before the run
you expect to succeed.

Cloudflare's own *Workers Builds* (connect the GitHub repo from the Cloudflare
dashboard) is an alternative that skips the Actions workflow entirely; it still
needs steps 1 and 2.

Clone locally only when you want to change the app, or to re-run `data:geo`
because the Census boundaries changed.

### Rehearse it locally first

`wrangler dev` runs the Worker, a local KV, and the cron trigger on your
machine, so you can exercise the entire deploy before it touches a real
account or the live Secretary of State service:

```bash
cp .dev.vars.example .dev.vars        # points the ingest at the local mock
node scripts/mock-api.mjs --port 8791 &
npm run build
npx wrangler dev --port 8790 --test-scheduled
```

Then, in another shell:

```bash
curl localhost:8790/data/results/index.json          # sample, from dist/ — KV is empty
curl localhost:8790/cdn-cgi/handler/scheduled        # fire the cron
curl localhost:8790/data/results/index.json          # now from KV, isSample:false

curl -X POST localhost:8790/__refresh \
  -H "Authorization: Bearer local-dev-token"         # {"skipped":true,"reason":"unchanged"}
curl -X POST "localhost:8790/__refresh?force=1" \
  -H "Authorization: Bearer local-dev-token"         # re-ingests
```

That sequence checks the four things most likely to be wrong in a real
deploy: assets serve, the Worker intercepts `/data/results/*`, the cron
writes KV, and the skip-when-unchanged path works.

### Cloudflare (recommended)

One Worker serves the static assets, answers `/data/results/*` from KV, and
runs the ingest on a schedule. `worker/index.js` imports the *same*
`scripts/lib/ingest.mjs` the CLI uses, which is why that module has no
filesystem dependencies.

```bash
npm install
npm run data:geo                              # build boundaries + crosswalk

npx wrangler kv namespace create RESULTS      # paste the id into wrangler.jsonc
npm run cf:deploy                             # builds, then deploys
```

Then set the election and, optionally, a token for manual refreshes:

```bash
# ELECTION_ID lives in wrangler.jsonc vars — edit it per election
npx wrangler secret put REFRESH_TOKEN         # enables POST /__refresh
curl -X POST https://<your-host>/__refresh -H "Authorization: Bearer <token>"
```

`npm run cf:tail` streams logs, including each cron run's outcome.

**Cron cost is low by design.** The job checks the metadata endpoint first —
it carries `asOf`, so when nothing upstream has moved the per-county fan-out is
skipped entirely and the tick costs one request instead of sixteen. The
default schedule is every 5 minutes; drop to `*/2 * * * *` on election night
and back to hourly once results certify.

Until the first cron fires, the Worker falls through to whatever results JSON
was baked into `dist/`, so a fresh deploy is never blank.

### Simpler: static hosting, no live refresh

If you don't need results to update on their own — an archived election, say —
skip the Worker entirely. `dist/` is plain static output; Cloudflare Pages,
GitHub Pages, Netlify, or S3 all serve it as-is. Refresh by re-running
`npm run data:results` and redeploying. Set `VITE_BASE_PATH` if hosting under a
subpath (e.g. GitHub Pages project sites).

A scheduled GitHub Action can automate that, but note the tradeoff: Actions
cron is best-effort and routinely runs 10–20 minutes late under load, and each
refresh commits results into git history. That is fine for a certified
election, poor for election night.
