import type { Race } from '../lib/types';
import type { County } from '../lib/types';
import { formatPct, formatVotes } from '../lib/format';

interface Props {
  race: Race;
  counties: Record<string, County>;
}

/**
 * The table view. Required, not optional: it is what makes the choropleth's
 * colour encoding non-essential — every number the map encodes is readable
 * here as text, which is also the relief for palette slots that sit below 3:1
 * against the surface.
 */
export function ResultsTable({ race, counties }: Props) {
  const options = [...race.options].sort((a, b) => b.votes - a.votes).slice(0, 4);
  const rows = race.countyFips
    .map((fips) => ({ fips, county: counties[fips], breakdown: race.byCounty[fips] }))
    .filter((r) => r.breakdown)
    .sort((a, b) => (b.breakdown?.totalVotes ?? 0) - (a.breakdown?.totalVotes ?? 0));

  if (rows.length === 0) return null;

  return (
    <details className="panel table-panel">
      <summary className="table-panel__summary">
        County results table for {race.name} ({rows.length} counties)
      </summary>
      <div className="table-scroll">
        <table className="results-table">
          <caption className="visually-hidden">
            Votes and percentage by county for {race.name}.
          </caption>
          <thead>
            <tr>
              <th scope="col">County</th>
              {options.map((o) => (
                <th key={o.name} scope="col" className="results-table__num">
                  {o.name}
                  {o.party ? ` (${o.party})` : ''}
                </th>
              ))}
              <th scope="col" className="results-table__num">
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ fips, county, breakdown }) => (
              <tr key={fips}>
                <th scope="row">{county?.name ?? fips} County</th>
                {options.map((o) => {
                  const match = breakdown?.options.find((x) => x.name === o.name);
                  return (
                    <td key={o.name} className="results-table__num">
                      {match ? (
                        <>
                          {formatPct(match.pct)}
                          <span className="results-table__sub">{formatVotes(match.votes)}</span>
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                  );
                })}
                <td className="results-table__num">{formatVotes(breakdown?.totalVotes ?? 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {race.options.length > options.length && (
        <p className="note">
          Showing the top {options.length} of {race.options.length} options by statewide votes.
        </p>
      )}
    </details>
  );
}
