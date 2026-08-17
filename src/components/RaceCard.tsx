import { useState } from 'react';
import type { Race } from '../lib/types';
import { raceOptionColors, type Mode } from '../lib/colors';
import { formatPct, formatVotes, joinNames } from '../lib/format';

interface Props {
  race: Race;
  mode: Mode;
  /** Counties in the user's ZIP, for the per-county breakdown. */
  zipCounties: Array<{ fips: string; name: string }>;
  selected: boolean;
  onSelect: () => void;
}

/**
 * One contest, as a row of direct-labelled bars.
 *
 * Bars are thin, anchored to a shared baseline, and every one carries the
 * candidate name and percentage as text — identity is never colour-alone, and
 * the sub-3:1 palette slots are legal precisely because these labels exist.
 */
export function RaceCard({ race, mode, zipCounties, selected, onSelect }: Props) {
  const [showCounties, setShowCounties] = useState(false);

  const options = [...race.options].sort((a, b) => b.votes - a.votes);
  // Resolved for the race as a whole: a contest with two same-party candidates
  // cannot use the party hues without them colliding.
  const colors = raceOptionColors(mode, options);
  const countiesWithData = zipCounties.filter((c) => race.byCounty[c.fips]);
  const isLocal = race.countyFips.length < 3;

  return (
    <article className={`panel race-card${selected ? ' race-card--selected' : ''}`}>
      <header className="race-card__header">
        <div>
          <h3 className="race-card__title">{race.name}</h3>
          <p className="race-card__meta">
            {race.contestType === 'BallotMeasure' ? 'Ballot measure' : 'Candidate contest'} ·{' '}
            {formatVotes(race.totalVotes)} votes counted
            {isLocal && race.countyFips.length > 0 && (
              <> · {joinNames(race.countyFips.map((f) => countyName(zipCounties, f)))}</>
            )}
          </p>
        </div>
        <button
          type="button"
          className="race-card__map-button"
          onClick={onSelect}
          aria-pressed={selected}
        >
          {selected ? 'Shown on map' : 'Show on map'}
        </button>
      </header>

      <ul className="bars">
        {options.map((option, index) => {
          const color = colors[index] as string;
          return (
            <li key={`${option.id}-${option.name}`} className="bars__row">
              <div className="bars__label">
                <span className="bars__swatch" style={{ background: color }} aria-hidden="true" />
                <span className="bars__name">
                  {option.name}
                  {option.party && <span className="bars__party"> ({option.party})</span>}
                </span>
              </div>
              <div className="bars__track">
                <div
                  className="bars__fill"
                  style={{ width: `${Math.max(option.pct, 0.4)}%`, background: color }}
                />
              </div>
              <div className="bars__value">
                <strong>{formatPct(option.pct)}</strong>
                <span className="bars__votes">{formatVotes(option.votes)}</span>
              </div>
            </li>
          );
        })}
      </ul>

      {countiesWithData.length > 1 && (
        <>
          <button
            type="button"
            className="race-card__toggle"
            onClick={() => setShowCounties((v) => !v)}
            aria-expanded={showCounties}
          >
            {showCounties ? 'Hide' : 'Show'} this ZIP&rsquo;s counties separately
          </button>
          {showCounties && (
            <div className="county-breakdown">
              {countiesWithData.map((county) => {
                const breakdown = race.byCounty[county.fips];
                if (!breakdown) return null;
                const sorted = [...breakdown.options].sort((a, b) => b.votes - a.votes);
                const countyColors = raceOptionColors(mode, sorted);
                return (
                  <div key={county.fips} className="county-breakdown__block">
                    <h4 className="county-breakdown__title">
                      {county.name} County
                      <span className="county-breakdown__total">
                        {formatVotes(breakdown.totalVotes)} votes
                      </span>
                    </h4>
                    <ul className="bars bars--compact">
                      {sorted.map((option, index) => (
                        <li key={option.name} className="bars__row">
                          <div className="bars__label">
                            <span
                              className="bars__swatch"
                              style={{ background: countyColors[index] as string }}
                              aria-hidden="true"
                            />
                            <span className="bars__name">{option.name}</span>
                          </div>
                          <div className="bars__track">
                            <div
                              className="bars__fill"
                              style={{
                                width: `${Math.max(option.pct, 0.4)}%`,
                                background: countyColors[index] as string,
                              }}
                            />
                          </div>
                          <div className="bars__value">
                            <strong>{formatPct(option.pct)}</strong>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </article>
  );
}

function countyName(counties: Array<{ fips: string; name: string }>, fips: string): string {
  return `${counties.find((c) => c.fips === fips)?.name ?? fips} County`;
}
