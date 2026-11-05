import { Pitch, Step, STEPS } from './types';

export const STEP_SEMI: Record<Step, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const SHARP_ORDER: Step[] = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
const FLAT_ORDER: Step[] = ['B', 'E', 'A', 'D', 'G', 'C', 'F'];

export function midiOf(p: Pitch): number {
  return 12 * (p.octave + 1) + STEP_SEMI[p.step] + p.alter;
}

/** Alteration the key signature gives to a step. */
export function keyAlter(fifths: number, step: Step): number {
  if (fifths > 0) return SHARP_ORDER.slice(0, fifths).includes(step) ? 1 : 0;
  if (fifths < 0) return FLAT_ORDER.slice(0, -fifths).includes(step) ? -1 : 0;
  return 0;
}

const PITCH_RE = /^([A-Ga-g])(##|#|x|bb|b|n|)(-?\d)$/;

/** Parse "C#4", "Bb3", "F##5", "Ebb4", "Cn4" (also accepts ♯ ♭ ♮). */
export function parsePitch(raw: string): Pitch | null {
  const s = raw.replace(/♯/g, '#').replace(/♭/g, 'b').replace(/♮/g, 'n').replace(/𝄪/g, '##').replace(/𝄫/g, 'bb');
  const m = PITCH_RE.exec(s);
  if (!m) return null;
  const step = m[1].toUpperCase() as Step;
  const acc = m[2];
  const alter = acc === '#' ? 1 : acc === '##' || acc === 'x' ? 2 : acc === 'b' ? -1 : acc === 'bb' ? -2 : 0;
  return { step, alter, octave: parseInt(m[3], 10) };
}

export function pitchToString(p: Pitch): string {
  const acc = p.alter === 1 ? '#' : p.alter === 2 ? '##' : p.alter === -1 ? 'b' : p.alter === -2 ? 'bb' : '';
  return `${p.step}${acc}${p.octave}`;
}

/** Tone.js style note name (e.g. "C#4", "Bb3"). Double accidentals are converted to the enharmonic. */
export function toneName(midi: number): string {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  return `${names[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

/** Spell a MIDI number as a pitch, preferring notes of the key, then sharps/flats by key direction. */
export function spellMidi(midi: number, fifths: number, preferFlats?: boolean): Pitch {
  const pc = ((midi % 12) + 12) % 12;
  const octaveBase = Math.floor(midi / 12) - 1;
  const candidates: Pitch[] = [];
  for (const step of STEPS) {
    for (const alter of [0, 1, -1, 2, -2]) {
      if ((((STEP_SEMI[step] + alter) % 12) + 12) % 12 === pc) {
        // octave correction for B# / Cb
        let octave = octaveBase;
        const raw = STEP_SEMI[step] + alter;
        if (raw < 0) octave = octaveBase + 1;
        if (raw > 11) octave = octaveBase - 1;
        candidates.push({ step, alter, octave });
      }
    }
  }
  const flats = preferFlats ?? fifths < 0;
  const score = (p: Pitch) => {
    if (p.alter === keyAlter(fifths, p.step)) return 0;
    if (Math.abs(p.alter) === 2) return 10;
    if (p.alter === 0) return 1;
    if ((p.alter < 0) === flats) return 2;
    return 3;
  };
  candidates.sort((a, b) => score(a) - score(b));
  return candidates[0];
}

/** Move a pitch by diatonic steps within the key signature. */
export function diatonicShift(p: Pitch, steps: number, fifths: number): Pitch {
  const idx = STEPS.indexOf(p.step) + steps;
  const octave = p.octave + Math.floor(idx / 7);
  const step = STEPS[((idx % 7) + 7) % 7];
  return { step, alter: keyAlter(fifths, step), octave, tie: p.tie };
}

/** Move by semitones, re-spelling with the key. */
export function chromaticShift(p: Pitch, semis: number, fifths: number): Pitch {
  const sp = spellMidi(midiOf(p) + semis, fifths, semis < 0 ? true : semis > 0 ? fifths < 0 : undefined);
  return { ...sp, tie: p.tie };
}

// ---- keys ----
const MAJOR_TONICS = ['Cb', 'Gb', 'Db', 'Ab', 'Eb', 'Bb', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#'];

export function keyName(fifths: number): string {
  const major = MAJOR_TONICS[fifths + 7] ?? 'C';
  const minorList = ['Ab', 'Eb', 'Bb', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#', 'G#', 'D#', 'A#'];
  const minor = minorList[fifths + 7] ?? 'A';
  return `${major.replace('b', '♭').replace('#', '♯')} major / ${minor.replace('b', '♭').replace('#', '♯')} minor`;
}

export function keyTonicPitchClass(fifths: number): number {
  return (((fifths * 7) % 12) + 12) % 12;
}

/** Key signature after transposing by `semis` semitones; picks the spelling with the fewest accidentals. */
export function transposeKey(fifths: number, semis: number): number {
  const target = (((keyTonicPitchClass(fifths) + semis) % 12) + 12) % 12;
  const options: number[] = [];
  for (let f = -7; f <= 7; f++) if (keyTonicPitchClass(f) === target) options.push(f);
  options.sort((a, b) => Math.abs(a) - Math.abs(b) || (fifths < 0 ? a - b : b - a));
  return options[0];
}

/** Letter (diatonic) distance between the tonics of two keys, chosen to match the semitone direction. */
export function letterShiftForKeys(fromFifths: number, toFifths: number, semis: number): number {
  const a = STEPS.indexOf(MAJOR_TONICS[fromFifths + 7][0] as Step);
  const b = STEPS.indexOf(MAJOR_TONICS[toFifths + 7][0] as Step);
  const base = (((b - a) % 7) + 7) % 7;
  const ideal = (semis * 7) / 12;
  let best = base;
  for (const c of [base - 14, base - 7, base, base + 7, base + 14]) if (Math.abs(c - ideal) < Math.abs(best - ideal)) best = c;
  return best;
}

/** Transpose a pitch by semitones, using a letter shift so spelling follows the new key. */
export function transposePitch(p: Pitch, semis: number, letterShift: number, newFifths: number): Pitch {
  const target = midiOf(p) + semis;
  const idx = STEPS.indexOf(p.step) + letterShift;
  const octave = p.octave + Math.floor(idx / 7);
  const step = STEPS[((idx % 7) + 7) % 7];
  const natural = midiOf({ step, alter: 0, octave });
  const alter = target - natural;
  if (Math.abs(alter) > 2) return { ...spellMidi(target, newFifths), tie: p.tie };
  return { step, alter, octave, tie: p.tie };
}

export function accidentalSymbol(alter: number): string {
  return alter === 1 ? '♯' : alter === 2 ? '𝄪' : alter === -1 ? '♭' : alter === -2 ? '𝄫' : '♮';
}
