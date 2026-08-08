import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import type { Race } from '../lib/types';
import { countyLeader } from '../lib/lookup';
import {
  divergingFill,
  divergingScale,
  neutralFill,
  MARGIN_BUCKET_LABELS,
  MUTED_INK,
  type Mode,
} from '../lib/colors';
import { formatPct, formatVotes } from '../lib/format';
import { loadCounties, loadZctas } from '../lib/data';

interface Props {
  race: Race | null;
  mode: Mode;
  /** ZCTA to outline, once the user has looked one up. */
  highlightZip: string | null;
}

/**
 * County choropleth for one contest.
 *
 * The encoding is diverging, not categorical: each county is coloured by which
 * of the contest's top two options led there and by how far, with a neutral
 * midpoint so a near-tie reads as "nothing". That is the right job for this
 * data, and it also sidesteps the series cap that an all-pairs categorical map
 * would run into once a contest has more than three candidates.
 *
 * No tile layer is used. The basemap would add nothing to a county choropleth
 * and would make the page depend on a third-party tile host at runtime.
 */
export function ResultsMap({ race, mode, highlightZip }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const countyLayerRef = useRef<L.GeoJSON | null>(null);
  const zipLayerRef = useRef<L.GeoJSON | null>(null);
  const [counties, setCounties] = useState<GeoJSON.FeatureCollection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hovered, setHovered] = useState<{ name: string; body: string } | null>(null);
  // Default to the whole state: a statewide contest is unreadable when the
  // view is cropped to one ZIP, and the ZIP outline is still findable at this
  // zoom. Users who want the local picture can switch.
  const [view, setView] = useState<'state' | 'zip'>('state');
  /** Flips once the ZIP outline is on the map, so framing can react to it. */
  const [zipReady, setZipReady] = useState(false);

  // Top two options define the two poles of the diverging scale.
  const poles = race ? [...race.options].sort((a, b) => b.votes - a.votes).slice(0, 2) : [];
  const poleA = poles[0]?.name ?? null;
  const poleB = poles[1]?.name ?? null;

  useEffect(() => {
    loadCounties().then(setCounties).catch((e: Error) => setError(e.message));
  }, []);

  // Create the map once the container and county geometry are both ready.
  useEffect(() => {
    if (!containerRef.current || !counties || mapRef.current) return;

    const map = L.map(containerRef.current, {
      zoomControl: true,
      attributionControl: false,
      scrollWheelZoom: false,
    });
    mapRef.current = map;

    const layer = L.geoJSON(counties, {
      style: () => ({ weight: 1, color: MUTED_INK, fillOpacity: 1, fillColor: neutralFill(mode) }),
    }).addTo(map);
    countyLayerRef.current = layer;

    map.fitBounds(layer.getBounds(), { padding: [8, 8] });
    return () => {
      map.remove();
      mapRef.current = null;
      countyLayerRef.current = null;
      zipLayerRef.current = null;
    };
  }, [counties, mode]);

  // Repaint counties whenever the selected race or colour mode changes.
  // `counties` is in the dependency list because the layer is created by the
  // effect above: without it this would run once before the map exists and
  // never again, leaving every county unshaded.
  useEffect(() => {
    const layer = countyLayerRef.current;
    if (!layer) return;

    layer.eachLayer((child) => {
      const feature = (child as L.GeoJSON).feature as GeoJSON.Feature | undefined;
      const props = feature?.properties as { GEOID: string; NAME: string } | undefined;
      if (!props) return;

      const path = child as L.Path;
      const lead = race ? countyLeader(race, props.GEOID) : null;
      const fill = !lead
        ? neutralFill(mode)
        : divergingFill(mode, lead.name === poleA ? 'a' : 'b', lead.margin);

      path.setStyle({ fillColor: fill, weight: 1, color: MUTED_INK, fillOpacity: 1 });

      const breakdown = race?.byCounty[props.GEOID];
      const body = !breakdown
        ? 'No results reported'
        : [...breakdown.options]
            .sort((a, b) => b.votes - a.votes)
            .slice(0, 3)
            .map((o) => `${o.name} ${formatPct(o.pct)} (${formatVotes(o.votes)})`)
            .join(' · ');

      path.off('mouseover mouseout focus blur');
      path.on('mouseover focus', () => {
        setHovered({ name: `${props.NAME} County`, body });
        path.setStyle({ weight: 2.5, color: mode === 'dark' ? '#ffffff' : '#0b0b0b' });
        path.bringToFront();
      });
      path.on('mouseout blur', () => {
        setHovered(null);
        path.setStyle({ weight: 1, color: MUTED_INK });
        zipLayerRef.current?.bringToFront();
      });
    });
  }, [race, mode, poleA, counties]);

  // Outline the looked-up ZIP over the choropleth.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (zipLayerRef.current) {
      zipLayerRef.current.remove();
      zipLayerRef.current = null;
    }
    setZipReady(false);
    if (!highlightZip) return;

    let cancelled = false;
    loadZctas()
      .then((zctas) => {
        if (cancelled || !mapRef.current) return;
        const match = zctas.features.filter(
          (f) => (f.properties as { ZCTA5CE10?: string } | null)?.ZCTA5CE10 === highlightZip,
        );
        if (match.length === 0) return;

        const layer = L.geoJSON(
          { type: 'FeatureCollection', features: match } as GeoJSON.FeatureCollection,
          {
            interactive: false,
            style: {
              weight: 3,
              color: mode === 'dark' ? '#ffffff' : '#0b0b0b',
              fill: false,
              dashArray: '4 3',
            },
          },
        ).addTo(mapRef.current);
        zipLayerRef.current = layer;
        layer.bringToFront();
        setZipReady(true);
      })
      .catch(() => {
        /* the outline is an enhancement; the choropleth still stands without it */
      });

    return () => {
      cancelled = true;
    };
    // `counties` again gates on the map existing at all.
  }, [highlightZip, mode, counties]);

  // Framing is its own effect so toggling the view never refetches geometry.
  useEffect(() => {
    const map = mapRef.current;
    const countyLayer = countyLayerRef.current;
    if (!map || !countyLayer) return;

    if (view === 'zip' && zipLayerRef.current) {
      map.fitBounds(zipLayerRef.current.getBounds().pad(1.2), { maxZoom: 10 });
    } else {
      map.fitBounds(countyLayer.getBounds(), { padding: [8, 8] });
    }
  }, [view, counties, highlightZip, zipReady]);

  if (error) {
    return (
      <section className="panel">
        <p className="note note--warn">Map unavailable: {error}</p>
      </section>
    );
  }

  return (
    <section className="panel map-panel" aria-labelledby="map-heading">
      <div className="map-panel__header">
        <div>
          <h2 id="map-heading" className="panel__title">
            {race ? race.name : 'Washington counties'}
          </h2>
          <p className="panel__subtitle">
            {race
              ? 'Each county is shaded toward whichever of the two leading options won it.'
              : 'Choose a contest to shade the map by its county results.'}
          </p>
        </div>
        {highlightZip && (
          <div className="view-toggle" role="group" aria-label="Map framing">
            <button
              type="button"
              onClick={() => setView('state')}
              aria-pressed={view === 'state'}
            >
              Whole state
            </button>
            <button type="button" onClick={() => setView('zip')} aria-pressed={view === 'zip'}>
              Near {highlightZip}
            </button>
          </div>
        )}
      </div>

      <div className="map-wrap">
        <div ref={containerRef} className="map" role="img" aria-label={mapAltText(race, poleA, poleB)} />
        {hovered && (
          <div className="map-tooltip" role="status">
            <strong>{hovered.name}</strong>
            <span>{hovered.body}</span>
          </div>
        )}
      </div>

      {race && poleA && (
        <div className="legend">
          <div className="legend__arm">
            <span className="legend__name">{poleA}</span>
            <div className="legend__swatches">
              {divergingScale(mode, 'a')
                .slice()
                .reverse()
                .map((hex, i) => (
                  <span
                    key={hex}
                    className="legend__swatch"
                    style={{ background: hex }}
                    title={`${poleA} leads by ${[...MARGIN_BUCKET_LABELS].reverse()[i]}`}
                  />
                ))}
            </div>
          </div>
          <span className="legend__mid">tie</span>
          <div className="legend__arm legend__arm--right">
            <div className="legend__swatches">
              {divergingScale(mode, 'b').map((hex, i) => (
                <span
                  key={hex}
                  className="legend__swatch"
                  style={{ background: hex }}
                  title={`${poleB} leads by ${MARGIN_BUCKET_LABELS[i]}`}
                />
              ))}
            </div>
            <span className="legend__name">{poleB ?? '—'}</span>
          </div>
        </div>
      )}
      {race && (
        <p className="legend__scale-note">
          Shading steps at {MARGIN_BUCKET_LABELS.join(', ')}. Counties with no results in this
          contest are left unshaded.
        </p>
      )}
    </section>
  );
}

function mapAltText(race: Race | null, poleA: string | null, poleB: string | null): string {
  if (!race || !poleA) return 'Map of Washington counties.';
  const wins = (name: string) =>
    race.countyFips.filter((f) => countyLeader(race, f)?.name === name).length;
  return (
    `Map of Washington counties shaded by results for ${race.name}. ` +
    `${poleA} leads in ${wins(poleA)} of ${race.countyFips.length} reporting counties` +
    (poleB ? `, ${poleB} in ${wins(poleB)}.` : '.') +
    ' The same figures are in the results table below.'
  );
}
