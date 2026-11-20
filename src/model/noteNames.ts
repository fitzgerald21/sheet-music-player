// Small letter names next to notes that sit far above or below the staff, for players who lose
// count of ledger lines. Works from where a note is drawn: an 8va line or a treble-8vb clef moves
// the note on the page, so it also changes how many ledger lines it needs.
import { measureLengths } from './fix';
import { ottavaSemitones, ottavaSpans, staffEvents } from './spans';
import { Clef, Pitch, Score, STEPS } from './types';

export interface NoteNameOptions {
  on: boolean;
  /**
   * name notes at least this many lines and spaces past the outer staff line, so 2 = on the first
   * ledger line, 3 = in the space past it, 4 = on the second; 0 = every note
   */
  steps: number;
  /** which staves to name: every staff, treble clef staves or bass clef staves */
  staves: 'all' | 'treble' | 'bass';
  /** add the octave number (C6) */
  octave: boolean;
}

export interface NoteName {
  /** position of the pitch among the event's pitches, lowest first (the order noteheads are drawn) */
  rank: number;
  text: string;
}

/** The note on the bottom line of each clef, as a diatonic number (octave × 7 + step), as it sounds. */
const BOTTOM_LINE: Record<Clef, number> = {
  treble: 4 * 7 + 2, // E4
  treble8vb: 3 * 7 + 2, // E3, drawn as E4
  bass: 2 * 7 + 4, // G2
  alto: 3 * 7 + 3, // F3
  tenor: 3 * 7 + 1, // D3
};

const diatonic = (p: Pitch) => p.octave * 7 + STEPS.indexOf(p.step);

/** Lines and spaces a note is past the outer line of a staff whose bottom line is `bottom` (both diatonic numbers). */
export function stepsOff(d: number, bottom: number): number {
  const top = bottom + 8;
  if (d > top) return d - top;
  if (d < bottom) return bottom - d;
  return 0;
}

const ACC: Record<number, string> = { 2: '𝄪', 1: '♯', 0: '', '-1': '♭', '-2': '𝄫' } as never;

export function noteNameText(p: Pitch, octave: boolean): string {
  return `${p.step}${ACC[p.alter] ?? ''}${octave ? p.octave : ''}`;
}

/** Which pitches to name, by event id. */
export function noteNames(score: Score, opts: NoteNameOptions): Map<string, NoteName[]> {
  const out = new Map<string, NoteName[]>();
  if (!opts.on) return out;
  const lens = measureLengths(score);
  // diatonic steps a note is moved on the page by the octave line over it
  const shift = new Map<string, number>();
  const spans = ottavaSpans(score);
  let staff = 0;
  for (const part of score.parts) {
    for (const st of part.staves) {
      const clef = st.clef;
      const named = opts.staves === 'all' || (opts.staves === 'treble' ? clef === 'treble' || clef === 'treble8vb' : clef === 'bass');
      if (named) {
        const events = staffEvents(score, staff, lens);
        for (const sp of spans.filter((s) => s.staff === staff)) {
          let inside = false;
          for (const p of events) {
            if (p.e.id === sp.from) inside = true;
            if (inside) shift.set(p.e.id, -(ottavaSemitones(sp.value) / 12) * 7);
            if (p.e.id === sp.to) break;
          }
        }
        for (const { e } of events) {
          if (e.rest || !e.pitches.length) continue;
          const move = shift.get(e.id) ?? 0;
          const order = e.pitches.map((p, i) => ({ p, i, d: diatonic(p) })).sort((a, b) => a.d - b.d || a.p.alter - b.p.alter);
          const names: NoteName[] = [];
          order.forEach(({ p, d }, rank) => {
            if (opts.steps === 0 || stepsOff(d + move, BOTTOM_LINE[clef]) >= opts.steps) names.push({ rank, text: noteNameText(p, opts.octave) });
          });
          if (names.length) out.set(e.id, names);
        }
      }
      staff++;
    }
  }
  return out;
}
