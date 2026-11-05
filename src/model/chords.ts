import { STEPS, Step } from './types';
import { STEP_SEMI } from './pitch';

export interface ParsedChord {
  root: Step;
  rootAlter: number;
  quality: string;
  bass?: Step;
  bassAlter?: number;
}

const CHORD_RE = /^([A-G])([#b♯♭]?)([^/]*)(?:\/([A-G])([#b♯♭]?))?$/;

export function parseChord(text: string): ParsedChord | null {
  const m = CHORD_RE.exec(text.trim());
  if (!m) return null;
  const alt = (s: string) => (s === '#' || s === '♯' ? 1 : s === 'b' || s === '♭' ? -1 : 0);
  return {
    root: m[1] as Step,
    rootAlter: alt(m[2]),
    quality: m[3],
    ...(m[4] ? { bass: m[4] as Step, bassAlter: alt(m[5]) } : {}),
  };
}

function noteName(step: Step, alter: number): string {
  return step + (alter === 1 ? '#' : alter === -1 ? 'b' : alter === 2 ? '##' : alter === -2 ? 'bb' : '');
}

function shiftName(step: Step, alter: number, semis: number, letterShift: number): { step: Step; alter: number } {
  const idx = STEPS.indexOf(step) + letterShift;
  const ns = STEPS[((idx % 7) + 7) % 7];
  let a = STEP_SEMI[step] + alter + semis - STEP_SEMI[ns];
  a = ((((a + 6) % 12) + 12) % 12) - 6;
  return { step: ns, alter: a };
}

export function transposeChord(text: string, semis: number, letterShift: number): string {
  const c = parseChord(text);
  if (!c) return text;
  const r = shiftName(c.root, c.rootAlter, semis, letterShift);
  let out = noteName(r.step, r.alter) + c.quality;
  if (c.bass) {
    const b = shiftName(c.bass, c.bassAlter ?? 0, semis, letterShift);
    out += '/' + noteName(b.step, b.alter);
  }
  return out;
}

/** Pitch classes (relative to root) of a chord quality, for optional chord playback. */
export function chordIntervals(quality: string): number[] {
  const q = quality.replace(/[()]/g, '');
  if (/^(m7b5|ø)/.test(q)) return [0, 3, 6, 10];
  if (/^(dim7|°7|o7)/.test(q)) return [0, 3, 6, 9];
  if (/^(dim|°|o)/.test(q)) return [0, 3, 6];
  if (/^(aug|\+)/.test(q)) return [0, 4, 8];
  if (/^(maj7|M7|Δ|ma7|maj9|maj)/.test(q)) return [0, 4, 7, 11];
  if (/^(m|min|-)/.test(q)) {
    if (/7|9|11/.test(q)) return [0, 3, 7, 10];
    if (/6/.test(q)) return [0, 3, 7, 9];
    return [0, 3, 7];
  }
  if (/sus2/.test(q)) return [0, 2, 7];
  if (/sus/.test(q)) return /7|9|11/.test(q) ? [0, 5, 7, 10] : [0, 5, 7];
  if (/^11/.test(q)) return [0, 5, 7, 10];
  if (/^(7|9|13)/.test(q)) return [0, 4, 7, 10];
  if (/^6/.test(q)) return [0, 4, 7, 9];
  return [0, 4, 7];
}

/** MusicXML <kind> value for a quality string. */
export function musicXmlKind(quality: string): string {
  const q = quality.replace(/[()]/g, '');
  const table: [RegExp, string][] = [
    [/^$/, 'major'],
    [/^(m7b5|ø7?|min7b5|-7b5)$/, 'half-diminished'],
    [/^(dim7|°7|o7)$/, 'diminished-seventh'],
    [/^(dim|°|o)$/, 'diminished'],
    [/^(aug|\+)$/, 'augmented'],
    [/^(aug7|\+7|7#5)$/, 'augmented-seventh'],
    [/^(maj7|M7|Δ7?|ma7)$/, 'major-seventh'],
    [/^(maj9|M9|Δ9)$/, 'major-ninth'],
    [/^(m|min|-)$/, 'minor'],
    [/^(m7|min7|-7)$/, 'minor-seventh'],
    [/^(m9|min9|-9)$/, 'minor-ninth'],
    [/^(m11|min11|-11)$/, 'minor-11th'],
    [/^(m6|min6|-6)$/, 'minor-sixth'],
    [/^(mMaj7|m\(maj7\)|mM7|-maj7)$/, 'major-minor'],
    [/^7$/, 'dominant'],
    [/^9$/, 'dominant-ninth'],
    [/^11$/, 'dominant-11th'],
    [/^13$/, 'dominant-13th'],
    [/^6$/, 'major-sixth'],
    [/^(sus|sus4)$/, 'suspended-fourth'],
    [/^sus2$/, 'suspended-second'],
    [/^5$/, 'power'],
  ];
  for (const [re, k] of table) if (re.test(q)) return k;
  return 'other';
}
