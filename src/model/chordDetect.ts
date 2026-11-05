// Algorithmic chord recognition: for each time window, weigh the sounding pitch classes by
// duration (bass notes count extra), score every root × chord-type template, and name the best.
import { TPQ, eventTicks } from './duration';
import { keyAt, measureLengths, timeAt } from './fix';
import { keyAlter, midiOf, spellMidi } from './pitch';
import { ChordSymbol, Score, cloneScore } from './types';

interface Template {
  suffix: string;
  tones: number[];
  /** index (in tones) of the defining "colour" tones that must be present */
  needs: number[];
  penalty: number;
}

const TEMPLATES: Template[] = [
  { suffix: '', tones: [0, 4, 7], needs: [], penalty: 0 },
  { suffix: 'm', tones: [0, 3, 7], needs: [1], penalty: 0.01 },
  { suffix: '7', tones: [0, 4, 7, 10], needs: [1, 3], penalty: 0.03 },
  { suffix: 'maj7', tones: [0, 4, 7, 11], needs: [1, 3], penalty: 0.09 },
  { suffix: 'm7', tones: [0, 3, 7, 10], needs: [1, 3], penalty: 0.04 },
  { suffix: 'dim', tones: [0, 3, 6], needs: [1, 2], penalty: 0.06 },
  { suffix: 'dim7', tones: [0, 3, 6, 9], needs: [1, 2, 3], penalty: 0.06 },
  { suffix: 'm7b5', tones: [0, 3, 6, 10], needs: [1, 2, 3], penalty: 0.07 },
  { suffix: 'aug', tones: [0, 4, 8], needs: [1, 2], penalty: 0.1 },
  { suffix: 'sus4', tones: [0, 5, 7], needs: [1, 2], penalty: 0.08 },
  { suffix: 'sus2', tones: [0, 2, 7], needs: [1, 2], penalty: 0.1 },
  { suffix: '7sus4', tones: [0, 5, 7, 10], needs: [1, 3], penalty: 0.1 },
  { suffix: '6', tones: [0, 4, 7, 9], needs: [1, 3], penalty: 0.08 },
  { suffix: 'm6', tones: [0, 3, 7, 9], needs: [1, 3], penalty: 0.09 },
];

export interface ChordGuess {
  text: string;
  root: number;
  confidence: number;
}

const STEPS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const STEP_PC = [0, 2, 4, 5, 7, 9, 11];
const accName = (a: number) => (a === 1 ? '#' : a === -1 ? 'b' : a === 2 ? '##' : a === -2 ? 'bb' : '');

function noteName(pc: number, fifths: number): string {
  const p = spellMidi(60 + pc, fifths);
  return p.step + accName(p.alter);
}

/** Spell a chord tone relative to the spelled root (so D7's third is F#, not Gb). */
function toneName(rootName: string, interval: number): string {
  const LETTER_OFFSET = [0, 1, 1, 2, 2, 3, 4, 4, 5, 5, 6, 6];
  const ri = STEPS.indexOf(rootName[0]);
  const rootAlter = rootName.slice(1) === '#' ? 1 : rootName.slice(1) === 'b' ? -1 : 0;
  const li = (ri + LETTER_OFFSET[interval]) % 7;
  const target = (STEP_PC[ri] + rootAlter + interval) % 12;
  let alter = (((target - STEP_PC[li]) % 12) + 12) % 12;
  if (alter > 6) alter -= 12;
  return STEPS[li] + accName(alter);
}

/** Name the chord for a pitch-class weight vector. `bassPc` is the lowest sounding note, if known. */
export function nameChord(weights: number[], bassPc: number | null, fifths = 0): ChordGuess | null {
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  const w = weights.map((x) => x / total);
  const present = w.filter((x) => x > 0.02).length;
  let best: { score: number; root: number; t: Template } | null = null;
  for (let root = 0; root < 12; root++) {
    for (const t of TEMPLATES) {
      if (present <= 2 && t.tones.length > 3) continue;
      const pcs = t.tones.map((iv) => (root + iv) % 12);
      let inside = 0;
      for (const pc of pcs) inside += w[pc];
      const outside = 1 - inside;
      let score = inside - 1.1 * outside - t.penalty;
      for (const n of t.needs) if (w[pcs[n]] < 0.03) score -= 0.3;
      // a seventh/sixth has to be clearly there, not just a passing note
      if (t.tones.length === 4 && w[pcs[3]] < 0.1) score -= 0.3;
      const fifth = t.tones.indexOf(7);
      if (fifth >= 0 && w[pcs[fifth]] < 0.03) score -= 0.08;
      if (w[root] < 0.08) score -= 0.25;
      score += 0.3 * w[root];
      if (bassPc === root) score += 0.12;
      else if (bassPc !== null && pcs.includes(bassPc)) score += 0.02;
      // mild preference for chords built on scale degrees of the key
      if (keyAlter(fifths, spellMidi(60 + root, fifths).step) === spellMidi(60 + root, fifths).alter) score += 0.03;
      if (!best || score > best.score) best = { score, root, t };
    }
  }
  if (!best || best.score < 0.25) return null;
  const rootName = noteName(best.root, fifths);
  let text = rootName + best.t.suffix;
  if (bassPc !== null && bassPc !== best.root && best.t.tones.map((iv) => (best!.root + iv) % 12).includes(bassPc)) {
    text += '/' + toneName(rootName, (bassPc - best.root + 12) % 12);
  }
  return { text, root: best.root, confidence: Math.max(0, Math.min(1, best.score)) };
}

/** Chord name for a set of MIDI notes being held (e.g. from a MIDI keyboard). */
export function chordFromMidis(midis: number[], fifths = 0): string | null {
  if (midis.length < 2) return null;
  const w = new Array(12).fill(0);
  for (const m of midis) w[m % 12] += 1;
  const bass = Math.min(...midis) % 12;
  w[bass] += 0.5;
  return nameChord(w, bass, fifths)?.text ?? null;
}

export interface DetectOptions {
  granularity: 'auto' | 'measure' | 'half' | 'beat';
  /** replace existing chord symbols */
  overwrite: boolean;
}

/** Add chord symbols to a score from its notes. */
export function detectChords(src: Score, opts: DetectOptions): { score: Score; added: number } {
  const score = cloneScore(src);
  const lens = measureLengths(score);
  const times = timeAt(score);
  const keys = keyAt(score);
  let added = 0;
  let prev: string | null = null;
  score.measures.forEach((m, mi) => {
    if (!opts.overwrite && m.chords?.length) {
      prev = m.chords[m.chords.length - 1].text;
      return;
    }
    const len = lens[mi];
    const [num, den] = times[mi];
    const beat = (4 * TPQ) / den;
    const compound = den === 8 && num % 3 === 0 && num > 3;
    const unit = compound ? beat * 3 : beat;
    const units = Math.max(1, Math.round(len / unit));
    let windows: [number, number][];
    if (opts.granularity === 'measure') windows = [[0, len]];
    else if (opts.granularity === 'beat') windows = Array.from({ length: units }, (_, i) => [i * unit, Math.min(len, (i + 1) * unit)]);
    else {
      const halves = units % 2 === 0 && units >= 2 ? 2 : units === 3 && !compound ? 1 : units >= 2 ? units : 1;
      const size = len / halves;
      windows = Array.from({ length: halves }, (_, i) => [i * size, (i + 1) * size]);
    }
    const guesses = windows.map(([a, b]) => {
      const w = new Array(12).fill(0);
      let lowest = Infinity;
      let lowestWeight = 0;
      m.staves.forEach((st) =>
        st.voices.forEach((v) => {
          let t = 0;
          for (const e of v) {
            const d = eventTicks(e, len);
            const s = Math.max(a, t);
            const f = Math.min(b, t + d);
            if (!e.rest && !e.grace && f > s) {
              const share = (f - s) / TPQ;
              // notes on the window's first beat count a little more
              const onset = t >= a && t < a + beat ? 1.25 : 1;
              for (const p of e.pitches) {
                const midi = midiOf(p);
                w[((midi % 12) + 12) % 12] += share * onset;
                if (midi < lowest) {
                  lowest = midi;
                  lowestWeight = share;
                }
              }
            }
            t += d;
          }
        }),
      );
      if (lowest < Infinity) w[lowest % 12] += lowestWeight * 0.75;
      return nameChord(w, lowest < Infinity ? lowest % 12 : null, keys[mi]);
    });
    // auto: merge halves that agree, or where a half is too thin to judge
    const chords: ChordSymbol[] = [];
    guesses.forEach((g, i) => {
      if (!g) return;
      const last = chords.length ? chords[chords.length - 1].text : prev;
      if (g.text === last) return;
      if (opts.granularity === 'auto' && i > 0 && g.confidence < 0.4) return;
      chords.push({ beat: Math.round(((windows[i][0] / beat) + 1) * 1000) / 1000, text: g.text });
    });
    if (opts.overwrite || !m.chords?.length) {
      if (chords.length) {
        m.chords = chords;
        added += chords.length;
        prev = chords[chords.length - 1].text;
      } else if (opts.overwrite) delete m.chords;
    }
  });
  score.updated = Date.now();
  return { score, added };
}

export function removeChords(src: Score): Score {
  const s = cloneScore(src);
  for (const m of s.measures) delete m.chords;
  return s;
}
