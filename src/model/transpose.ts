import { transposeChord } from './chords';
import { keyAt } from './fix';
import { letterShiftForKeys, transposeKey, transposePitch } from './pitch';
import { Score, cloneScore, globalStaves } from './types';

export interface TransposeOptions {
  /** limit to these part indices; default all */
  parts?: number[];
}

/** Transpose by semitones, updating key signatures, note spelling and chord symbols. */
export function transposeScore(src: Score, semis: number, opts: TransposeOptions = {}): Score {
  if (!semis) return src;
  const score = cloneScore(src);
  const keys = keyAt(src);
  const staves = globalStaves(src);
  const allParts = !opts.parts || opts.parts.length === score.parts.length;
  const newKeys = keys.map((k) => transposeKey(k, semis));
  const shifts = keys.map((k, i) => letterShiftForKeys(k, newKeys[i], semis));
  if (allParts) {
    score.key = transposeKey(src.key, semis);
  }
  score.measures.forEach((m, mi) => {
    if (allParts && m.key !== undefined) m.key = newKeys[mi];
    m.staves.forEach((sm, si) => {
      if (opts.parts && !opts.parts.includes(staves[si]?.partIndex)) return;
      for (const v of sm.voices)
        for (const e of v) e.pitches = e.pitches.map((p) => transposePitch(p, semis, shifts[mi], newKeys[mi]));
    });
    if (allParts && m.chords) m.chords = m.chords.map((c) => ({ ...c, text: transposeChord(c.text, semis, shifts[mi]) }));
  });
  return score;
}

/** Shift whole parts by octaves (no key change). */
export function octaveShift(src: Score, octaves: number, parts?: number[]): Score {
  const score = cloneScore(src);
  const staves = globalStaves(src);
  for (const m of score.measures)
    m.staves.forEach((sm, si) => {
      if (parts && !parts.includes(staves[si]?.partIndex)) return;
      for (const v of sm.voices) for (const e of v) for (const p of e.pitches) p.octave += octaves;
    });
  return score;
}

export const INTERVAL_NAMES: Record<number, string> = {
  0: 'Unison', 1: 'Minor 2nd', 2: 'Major 2nd', 3: 'Minor 3rd', 4: 'Major 3rd', 5: 'Perfect 4th', 6: 'Tritone',
  7: 'Perfect 5th', 8: 'Minor 6th', 9: 'Major 6th', 10: 'Minor 7th', 11: 'Major 7th', 12: 'Octave',
};
