/**
 * Chart colour, computed rather than eyeballed.
 *
 * Two encodings are in play, each doing exactly one job:
 *
 *  - Categorical (result bars): identity — which candidate. Fixed slot order,
 *    assigned in sequence, never cycled. Past the last slot, remaining options
 *    fold into a muted "other" rather than inventing hues.
 *  - Diverging (choropleth): polarity — which of the top two options leads a
 *    county, and by how much. Two poles with a neutral midpoint, so a near-tie
 *    reads as "nothing" rather than as a weak colour.
 *
 * Every hex below is a documented palette value. The intermediate ramp steps
 * are interpolated in OKLab from those anchors, which keeps lightness monotonic
 * along each arm. The blue/red pole pair validates all-pairs in both modes
 * (protan ΔE 21.6 light / 19.2 dark, normal-vision 32.3 / 29.0).
 *
 * Colour never carries meaning alone here: bars are direct-labelled with the
 * candidate name and percentage, the map has a legend naming both poles plus a
 * per-county tooltip, and a table view of every race is always available.
 */

export type Mode = 'light' | 'dark';

/** Categorical slots, in the fixed order that makes the palette CVD-safe. */
const CATEGORICAL: Record<Mode, string[]> = {
  light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'],
  dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
};

/** Muted ink for options past the last slot, and for "no data". */
const MUTED = '#898781';

/** Diverging anchors: neutral midpoint and the two poles. */
const DIVERGING: Record<Mode, { neutral: string; poleA: string; poleB: string }> = {
  light: { neutral: '#f0efec', poleA: '#2a78d6', poleB: '#e34948' },
  dark: { neutral: '#383835', poleA: '#3987e5', poleB: '#e66767' },
};

/**
 * US party convention pins blue to Democratic and red to Republican. Ignoring
 * it would actively mislead, so parties take fixed slots rather than sequence
 * position; unlisted parties fall through to the normal slot order. The party
 * letter is always rendered as text beside the swatch, so the convention is a
 * reinforcement and never the only signal.
 */
const PARTY_SLOT: Record<string, number> = {
  D: 0, // blue
  DEM: 0,
  R: 7, // red
  GOP: 7,
  REP: 7,
};

// --- sRGB <-> OKLab -------------------------------------------------------

type Triplet = [number, number, number];

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linearToSrgb = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

function hexToRgb(hex: string): Triplet {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}

function rgbToHex([r, g, b]: Triplet): string {
  const clamp = (v: number) =>
    Math.round(Math.max(0, Math.min(1, v)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${clamp(r)}${clamp(g)}${clamp(b)}`;
}

function rgbToOklab(rgb: Triplet): Triplet {
  const r = srgbToLinear(rgb[0]);
  const g = srgbToLinear(rgb[1]);
  const b = srgbToLinear(rgb[2]);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklabToRgb([L, a, bb]: Triplet): Triplet {
  const l = (L + 0.3963377774 * a + 0.2158037573 * bb) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * bb) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * bb) ** 3;
  return [
    linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

function mixOklab(fromHex: string, toHex: string, t: number): string {
  const from = rgbToOklab(hexToRgb(fromHex));
  const to = rgbToOklab(hexToRgb(toHex));
  return rgbToHex(oklabToRgb([
    from[0] + (to[0] - from[0]) * t,
    from[1] + (to[1] - from[1]) * t,
    from[2] + (to[2] - from[2]) * t,
  ]));
}

// --- Public API -----------------------------------------------------------

export const MUTED_INK = MUTED;

/** Colour for option `index` of a race, honouring party convention. */
export function optionColor(mode: Mode, index: number, party: string | null): string {
  const slots = CATEGORICAL[mode];
  const partySlot = party ? PARTY_SLOT[party.toUpperCase()] : undefined;
  if (partySlot !== undefined) return slots[partySlot] as string;

  // Skip slots reserved by party convention so a nonpartisan third candidate
  // is never painted the same blue as the Democrat above it.
  const reserved = new Set(Object.values(PARTY_SLOT));
  const available = slots.filter((_, i) => !reserved.has(i));
  return (available[index] ?? MUTED) as string;
}

/**
 * Colours for every option in one race, resolved together.
 *
 * Pinning parties to fixed hues breaks down in Washington, whose top-two
 * primary routinely puts two candidates of the same party in one contest — two
 * Democrats would both come out blue and become indistinguishable.
 *
 * Lightness variants of the party hue do not rescue it: stepping blue and red
 * toward the neutral to separate same-party candidates drives the *cross*-party
 * pastels together instead, and no step passes the normal-vision floor in both
 * modes (measured: 13.8-14.4 ΔE dark, against a floor of 15).
 *
 * So when a party repeats, that race drops party colouring entirely and takes
 * the plain categorical order, where every option is a distinct validated hue.
 * Party identity is not lost — the party letter is rendered as text beside each
 * name, which is the encoding that has to carry it anyway for a reader who
 * cannot rely on colour.
 */
export function raceOptionColors(
  mode: Mode,
  options: Array<{ party: string | null }>,
): string[] {
  const counts = new Map<string, number>();
  for (const option of options) {
    const key = option.party?.toUpperCase();
    if (key && PARTY_SLOT[key] !== undefined) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const partyRepeats = [...counts.values()].some((n) => n > 1);

  if (partyRepeats) {
    const slots = CATEGORICAL[mode];
    return options.map((_, i) => (slots[i] ?? MUTED) as string);
  }

  let nonPartisan = 0;
  return options.map((option) => {
    const key = option.party?.toUpperCase();
    if (key && PARTY_SLOT[key] !== undefined) return optionColor(mode, 0, option.party);
    return optionColor(mode, nonPartisan++, null);
  });
}

/**
 * Margin buckets for the choropleth, in percentage points. The first bucket
 * starts well up the ramp so that *any* lead is still visibly signed — a
 * near-tie should read as pale, not as invisible.
 */
const MARGIN_BUCKETS: Array<{ maxMargin: number; t: number }> = [
  { maxMargin: 5, t: 0.45 },
  { maxMargin: 15, t: 0.65 },
  { maxMargin: 30, t: 0.82 },
  { maxMargin: Infinity, t: 1 },
];

export const MARGIN_BUCKET_LABELS = ['under 5 pts', '5–15 pts', '15–30 pts', '30+ pts'];

/**
 * Fill for a county on the choropleth.
 * `side` is 'a' or 'b' for the two poles; margin is in percentage points.
 */
export function divergingFill(mode: Mode, side: 'a' | 'b', margin: number): string {
  const { neutral, poleA, poleB } = DIVERGING[mode];
  const bucket = MARGIN_BUCKETS.find((b) => margin < b.maxMargin) ?? MARGIN_BUCKETS[3];
  return mixOklab(neutral, side === 'a' ? poleA : poleB, (bucket as { t: number }).t);
}

/** The legend's swatch row for one pole, palest to strongest. */
export function divergingScale(mode: Mode, side: 'a' | 'b'): string[] {
  return MARGIN_BUCKETS.map((b) => {
    const { neutral, poleA, poleB } = DIVERGING[mode];
    return mixOklab(neutral, side === 'a' ? poleA : poleB, b.t);
  });
}

export function neutralFill(mode: Mode): string {
  return DIVERGING[mode].neutral;
}
