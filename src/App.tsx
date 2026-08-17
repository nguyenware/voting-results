import { useEffect, useMemo, useState } from 'react';
import { ZipSearch } from './components/ZipSearch';
import { ZipSummary } from './components/ZipSummary';
import { RaceCard } from './components/RaceCard';
import { ResultsMap } from './components/ResultsMap';
import { ResultsTable } from './components/ResultsTable';
import { useColorMode } from './hooks/useColorMode';
import { loadCrosswalk, loadElectionIndex, loadSnapshot } from './lib/data';
import { lookupZip, type ZipLookupResult } from './lib/lookup';
import { scopeRaces } from './lib/scope';
import { formatDate, formatTimestamp, joinNames } from './lib/format';
import type { ElectionSnapshot, ZipCrosswalk } from './lib/types';

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; snapshot: ElectionSnapshot; crosswalk: ZipCrosswalk };

/**
 * Keeps the looked-up ZIP in the URL so a result is linkable and reloadable.
 * Both directions are guarded: an embedded or sandboxed host can refuse
 * History access, and losing a deep link must never break the lookup itself.
 */
function zipFromUrl(): string {
  try {
    return new URLSearchParams(window.location.search).get('zip') ?? '';
  } catch {
    return '';
  }
}

function writeZipToUrl(zip: string) {
  try {
    const params = new URLSearchParams(window.location.search);
    if (zip) params.set('zip', zip);
    else params.delete('zip');
    const next = params.toString();
    window.history.replaceState(null, '', next ? `?${next}` : window.location.pathname);
  } catch {
    /* deep linking is a nicety; the lookup works without it */
  }
}

export function App() {
  const mode = useColorMode();
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [query, setQuery] = useState<string>(zipFromUrl);
  const [selectedRaceId, setSelectedRaceId] = useState<string | null>(null);

  useEffect(() => {
    async function boot() {
      try {
        const index = await loadElectionIndex();
        const latest = index.elections[0];
        if (!latest) throw new Error('No elections have been ingested yet.');
        const [snapshot, crosswalk] = await Promise.all([
          loadSnapshot(latest.electionId),
          loadCrosswalk(),
        ]);
        setState({ status: 'ready', snapshot, crosswalk });
      } catch (err) {
        setState({
          status: 'error',
          message:
            err instanceof Error
              ? `${err.message} Run "npm run data:geo" and "npm run data:sample" to generate the data files.`
              : 'Unknown error',
        });
      }
    }
    void boot();
  }, []);

  const result: ZipLookupResult | null = useMemo(() => {
    if (state.status !== 'ready' || !query.trim()) return null;
    return lookupZip(query, state.crosswalk, state.snapshot);
  }, [state, query]);

  const scoped = useMemo(() => {
    if (state.status !== 'ready' || !result?.ok) return { onBallot: [], partial: [] };
    return scopeRaces(
      result.races,
      state.snapshot,
      result.reportingCounties.map((c) => c.fips),
    );
  }, [state, result]);

  // Default the map to the most prominent race actually on this ZIP's ballot.
  useEffect(() => {
    const preferred = scoped.onBallot[0]?.race.id ?? scoped.partial[0]?.race.id ?? null;
    if (!preferred) return;
    const stillValid = [...scoped.onBallot, ...scoped.partial].some(
      (s) => s.race.id === selectedRaceId,
    );
    if (!stillValid) setSelectedRaceId(preferred);
  }, [scoped, selectedRaceId]);

  function search(value: string) {
    setQuery(value);
    writeZipToUrl(value.trim());
  }

  if (state.status === 'loading') {
    return (
      <main className="app">
        <p className="loading">Loading election data…</p>
      </main>
    );
  }

  if (state.status === 'error') {
    return (
      <main className="app">
        <div className="panel note note--warn">{state.message}</div>
      </main>
    );
  }

  const { snapshot } = state;
  const selectedRace =
    (result?.ok ? result.races : snapshot.races).find((r) => r.id === selectedRaceId) ?? null;

  return (
    <div className="app">
      {snapshot.isSample && (
        <div className="banner banner--sample" role="alert">
          <strong>Sample data.</strong> These are invented numbers for fictional candidates, used to
          demonstrate the site. They are not election results. Run{' '}
          <code>npm run data:results</code> to load the real results from the Washington Secretary
          of State.
        </div>
      )}

      <header className="app__header">
        <h1 className="app__title">Washington election results by ZIP code</h1>
        <p className="app__sub">
          {snapshot.electionName} · {formatDate(snapshot.electionDate)} ·{' '}
          <span className={snapshot.isOfficial ? 'tag tag--official' : 'tag tag--unofficial'}>
            {snapshot.isOfficial ? 'Official' : 'Unofficial'}
          </span>
        </p>
      </header>

      <ZipSearch onSearch={search} initialValue={query} />

      {result && !result.ok && (
        <div className="panel note note--warn">
          {result.error === 'invalid' && 'Please enter a five-digit ZIP code.'}
          {result.error === 'not-washington' &&
            `${result.detail} is not a Washington ZIP code. This site only covers Washington State.`}
          {result.error === 'no-results' &&
            'No Washington ZIP code area matches that code. Some ZIPs cover only PO boxes and have no mapped area.'}
        </div>
      )}

      {result?.ok && (
        <>
          <ZipSummary result={result} />

          {result.races.length === 0 ? (
            <div className="panel note note--warn">
              No contests were on the ballot in this ZIP&rsquo;s counties for this election.
            </div>
          ) : (
            <div className="layout">
              <div className="layout__main">
                <h2 className="section-heading">
                  {scoped.onBallot.length} contest{scoped.onBallot.length === 1 ? '' : 's'} on this
                  ZIP&rsquo;s ballots
                </h2>
                {scoped.onBallot.map(({ race }) => (
                  <RaceCard
                    key={race.id}
                    race={race}
                    mode={mode}
                    zipCounties={result.reportingCounties}
                    selected={race.id === selectedRaceId}
                    onSelect={() => setSelectedRaceId(race.id)}
                  />
                ))}

                {scoped.partial.length > 0 && (
                  <details className="partial-races">
                    <summary className="partial-races__summary">
                      {scoped.partial.length} more contest
                      {scoped.partial.length === 1 ? '' : 's'} held in{' '}
                      {joinNames(result.reportingCounties.map((c) => `${c.name} County`))}, only
                      some of which reached this ZIP
                    </summary>
                    <p className="note">
                      These ran in part of the county — a single legislative district, city, or
                      school district. Results are only published per county, so we cannot tell
                      which of them were on your specific ballot. The share shows how much of the
                      county voted in each.
                    </p>
                    {scoped.partial.map(({ race, coverage }) => (
                      <div key={race.id} className="partial-races__item">
                        {coverage !== null && (
                          <span className="coverage-tag">
                            {coverage < 0.01 ? '<1' : Math.round(coverage * 100)}% of county voters
                          </span>
                        )}
                        <RaceCard
                          race={race}
                          mode={mode}
                          zipCounties={result.reportingCounties}
                          selected={race.id === selectedRaceId}
                          onSelect={() => setSelectedRaceId(race.id)}
                        />
                      </div>
                    ))}
                  </details>
                )}
              </div>

              <aside className="layout__side">
                <ResultsMap race={selectedRace} mode={mode} highlightZip={result.zip.zip} />
                {selectedRace && (
                  <ResultsTable race={selectedRace} counties={snapshot.counties} />
                )}
              </aside>
            </div>
          )}
        </>
      )}

      {!result && (
        <section className="panel intro">
          <h2 className="panel__title">How this works</h2>
          <p>
            Washington counts and reports votes by <strong>county and precinct</strong>. It does not
            report them by ZIP code, and ZIP codes regularly cross county lines — 83 of
            Washington&rsquo;s 598 ZIP areas sit in more than one county.
          </p>
          <p>
            So this site maps your ZIP to the counties it overlaps, then shows the contests that
            appeared on those counties&rsquo; ballots along with each county&rsquo;s reported
            results. The numbers are county totals, not ZIP totals — no one publishes results at
            ZIP granularity.
          </p>
        </section>
      )}

      <footer className="app__footer">
        <p>
          Results from{' '}
          <a href={snapshot.source.publicPage} rel="noreferrer noopener" target="_blank">
            {snapshot.source.name}
          </a>
          . Snapshot taken {formatTimestamp(snapshot.fetchedAt)}
          {snapshot.asOf && <> · upstream data as of {formatTimestamp(snapshot.asOf)}</>}.
        </p>
        <p>
          Boundaries from US Census TIGER/cartographic files. Results are unofficial until the
          county canvass is certified.
        </p>
      </footer>
    </div>
  );
}
