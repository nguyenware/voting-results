import type { ZipLookupSuccess } from '../lib/lookup';
import { formatShare, joinNames } from '../lib/format';

interface Props {
  result: ZipLookupSuccess;
}

/**
 * Explains what the ZIP actually resolved to. This panel carries the honesty
 * burden of the whole site: a ZIP is not a voting district, so the user needs
 * to see which counties their ZIP touches and that results are county figures,
 * not figures for their ZIP.
 */
export function ZipSummary({ result }: Props) {
  const { zip, reportingCounties, missingCounties } = result;
  const isSplit = zip.counties.length > 1;

  return (
    <section className="panel zip-summary" aria-labelledby="zip-summary-heading">
      <h2 id="zip-summary-heading" className="panel__title">
        ZIP {zip.zip}
        {zip.cities.length > 0 && <span className="zip-summary__cities"> · {joinNames(zip.cities)}</span>}
      </h2>

      {isSplit ? (
        <>
          <p className="zip-summary__lede">
            This ZIP code spans <strong>{zip.counties.length} counties</strong>. Your ballot came
            from whichever one your address sits in — most likely{' '}
            <strong>{zip.primaryCounty} County</strong>.
          </p>
          <ul className="county-list">
            {zip.counties.map((county) => (
              <li key={county.fips} className="county-list__item">
                <span className="county-list__name">
                  {county.name} County
                  {county.name === zip.primaryCounty && (
                    <span className="tag tag--primary">most likely</span>
                  )}
                </span>
                <span className="county-list__share">{formatShare(county.areaShare)} of ZIP area</span>
              </li>
            ))}
          </ul>
          <p className="note">
            Percentages are shares of the ZIP&rsquo;s <em>land area</em>, not of its population. A
            county holding a small slice of a rural ZIP may still hold most of its voters, or none.
          </p>
        </>
      ) : (
        <p className="zip-summary__lede">
          This ZIP code sits entirely within <strong>{zip.counties[0]?.name} County</strong>.
        </p>
      )}

      {missingCounties.length > 0 && (
        <p className="note note--warn">
          No results in this election for{' '}
          {joinNames(missingCounties.map((c) => `${c.name} County`))} — {missingCounties.length === 1 ? 'it did' : 'they did'}{' '}
          not have contests on this ballot.
        </p>
      )}

      {reportingCounties.length === 0 && (
        <p className="note note--warn">
          None of this ZIP&rsquo;s counties reported results for this election.
        </p>
      )}
    </section>
  );
}
