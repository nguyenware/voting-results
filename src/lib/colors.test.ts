import { describe, it, expect } from 'vitest';
import {
  optionColor,
  raceOptionColors,
  divergingFill,
  divergingScale,
  MARGIN_BUCKET_LABELS,
} from './colors';

/** Relative luminance, for asserting a ramp gets monotonically darker. */
function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

describe('optionColor', () => {
  it('pins Democrats to blue and Republicans to red in both modes', () => {
    expect(optionColor('light', 0, 'D')).toBe('#2a78d6');
    expect(optionColor('light', 1, 'R')).toBe('#e34948');
    expect(optionColor('dark', 0, 'D')).toBe('#3987e5');
    expect(optionColor('dark', 1, 'R')).toBe('#e66767');
  });

  it('applies the party convention regardless of listed order', () => {
    // Republican listed first must still be red, not slot 1's blue.
    expect(optionColor('light', 0, 'R')).toBe('#e34948');
  });

  it('accepts common party abbreviation spellings', () => {
    expect(optionColor('light', 0, 'dem')).toBe(optionColor('light', 0, 'D'));
    expect(optionColor('light', 0, 'GOP')).toBe(optionColor('light', 0, 'R'));
  });

  it('never gives a nonpartisan option a colour reserved for a party', () => {
    const reserved = [optionColor('light', 0, 'D'), optionColor('light', 0, 'R')];
    for (let i = 0; i < 6; i += 1) {
      expect(reserved).not.toContain(optionColor('light', i, null));
    }
  });

  it('assigns distinct colours to distinct nonpartisan options', () => {
    const colors = [0, 1, 2, 3, 4, 5].map((i) => optionColor('light', i, null));
    expect(new Set(colors).size).toBe(colors.length);
  });

  it('falls back to muted ink once slots run out rather than cycling', () => {
    // Cycling would repeat slot 0's colour and imply two options are the same.
    expect(optionColor('light', 99, null)).toBe('#898781');
  });
});

describe('divergingFill', () => {
  it('gets monotonically darker as the margin grows, on both arms', () => {
    for (const mode of ['light', 'dark'] as const) {
      for (const side of ['a', 'b'] as const) {
        const ramp = [1, 10, 20, 50].map((m) => luminance(divergingFill(mode, side, m)));
        const sorted =
          mode === 'light' ? [...ramp].sort((x, y) => y - x) : [...ramp].sort((x, y) => x - y);
        expect(ramp).toEqual(sorted);
      }
    }
  });

  it('gives the two poles clearly different colours at equal margins', () => {
    expect(divergingFill('light', 'a', 20)).not.toBe(divergingFill('light', 'b', 20));
  });

  it('keeps a near-tie visibly signed rather than blank', () => {
    // A 1-point lead must not collapse to the neutral midpoint.
    expect(divergingFill('light', 'a', 1)).not.toBe('#f0efec');
    expect(divergingFill('light', 'a', 1)).not.toBe(divergingFill('light', 'b', 1));
  });

  it('buckets margins rather than shading continuously', () => {
    expect(divergingFill('light', 'a', 6)).toBe(divergingFill('light', 'a', 14));
    expect(divergingFill('light', 'a', 6)).not.toBe(divergingFill('light', 'a', 16));
  });

  it('handles an unopposed 100-point margin', () => {
    expect(divergingFill('light', 'a', 100)).toBe('#2a78d6');
  });
});

describe('divergingScale', () => {
  it('produces one swatch per documented legend label', () => {
    expect(divergingScale('light', 'a')).toHaveLength(MARGIN_BUCKET_LABELS.length);
  });

  it('matches the fills the map actually paints', () => {
    const scale = divergingScale('light', 'b');
    expect(scale[0]).toBe(divergingFill('light', 'b', 2));
    expect(scale[3]).toBe(divergingFill('light', 'b', 40));
  });
});

describe('raceOptionColors', () => {
  const mixed = [{ party: 'D' }, { party: 'R' }, { party: 'I' }];

  it('keeps party convention when each party appears once', () => {
    const [d, r] = raceOptionColors('light', mixed);
    expect(d).toBe('#2a78d6');
    expect(r).toBe('#e34948');
  });

  it('gives two same-party candidates distinct colours', () => {
    // Washington's top-two primary makes this routine, not an edge case.
    const colors = raceOptionColors('light', [{ party: 'D' }, { party: 'D' }, { party: 'R' }]);
    expect(new Set(colors).size).toBe(3);
  });

  it('does so in dark mode too', () => {
    const colors = raceOptionColors('dark', [{ party: 'R' }, { party: 'R' }]);
    expect(new Set(colors).size).toBe(2);
  });

  it('gives every option a distinct colour in a crowded same-party race', () => {
    const options = Array.from({ length: 6 }, () => ({ party: 'D' }));
    expect(new Set(raceOptionColors('light', options)).size).toBe(6);
  });

  it('keeps nonpartisan options distinct from each other', () => {
    const colors = raceOptionColors('light', [{ party: null }, { party: null }, { party: null }]);
    expect(new Set(colors).size).toBe(3);
  });

  it('does not paint a nonpartisan option in a reserved party colour', () => {
    const reserved = ['#2a78d6', '#e34948'];
    for (const c of raceOptionColors('light', [{ party: null }, { party: null }])) {
      expect(reserved).not.toContain(c);
    }
  });

  it('returns one colour per option', () => {
    expect(raceOptionColors('light', mixed)).toHaveLength(3);
  });
});
