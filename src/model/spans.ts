// Marks that run over several notes: hairpins, octave lines and triplet groups. Each is stored as a
// start mark and an end mark on notes; here they are paired up, so that drawing and playback agree
// and a missing or doubled mark never leaves a line running to the end of the piece.
import { eventTicks } from './duration';
import { measureLengths } from './fix';
import { Hairpin, NoteEvent, Ottava, Score } from './types';

export interface Span<T> {
  staff: number;
  value: T;
  /** note the line starts at / the last note under it */
  from: string;
  to: string;
  /** ticks from the start of the piece, in written order; `b` is where the last note ends */
  a: number;
  b: number;
}

export interface Placed {
  e: NoteEvent;
  measure: number;
  /** ticks from the start of the piece */
  at: number;
  end: number;
}

/** Every event of one staff in the order it is heard (grace notes just before the note they lead to). */
export function staffEvents(score: Score, staff: number, lens: number[]): Placed[] {
  const out: Placed[] = [];
  let base = 0;
  score.measures.forEach((m, mi) => {
    const here: (Placed & { order: number })[] = [];
    (m.staves[staff]?.voices ?? []).forEach((voice, vi) => {
      let tick = 0;
      voice.forEach((e, ei) => {
        const t = eventTicks(e, lens[mi]);
        here.push({ e, measure: mi, at: base + tick, end: base + tick + t, order: vi * 1000 + ei });
        tick += t;
      });
    });
    here.sort((x, y) => x.at - y.at || x.order - y.order);
    out.push(...here);
    base += lens[mi];
  });
  return out;
}

function staffCount(score: Score): number {
  return score.parts.reduce((n, p) => n + p.staves.length, 0);
}

/**
 * Hairpins as drawn and played. A hairpin that is never closed ends at the next dynamic mark, at the
 * next hairpin, or at the end of the measure after the one it starts in – whichever comes first.
 */
export function hairpinSpans(score: Score): Span<Hairpin>[] {
  const lens = measureLengths(score);
  const spans: Span<Hairpin>[] = [];
  for (let staff = 0; staff < staffCount(score); staff++) {
    let open: { value: Hairpin; first: Placed; last: Placed } | null = null;
    const close = () => {
      if (open && open.last.end > open.first.at) spans.push({ staff, value: open.value, from: open.first.e.id, to: open.last.e.id, a: open.first.at, b: open.last.end });
      open = null;
    };
    for (const p of staffEvents(score, staff, lens)) {
      const o = open as { value: Hairpin; first: Placed; last: Placed } | null;
      if (o && p.e !== o.first.e && (p.e.hairpin || (p.e.dynamic && p.at > o.first.at) || p.measure > o.first.measure + 1)) close();
      if (open) open.last = p;
      if (p.e.hairpin && !p.e.rest) open = { value: p.e.hairpin, first: p, last: p };
      if (p.e.hairpinEnd) close();
    }
    close();
  }
  return spans;
}

/** Octave lines as drawn. A line that is never closed runs to the last note of the staff. */
export function ottavaSpans(score: Score): Span<Ottava>[] {
  const lens = measureLengths(score);
  const spans: Span<Ottava>[] = [];
  for (let staff = 0; staff < staffCount(score); staff++) {
    let open: { value: Ottava; first: Placed; last: Placed } | null = null;
    const close = () => {
      if (open) spans.push({ staff, value: open.value, from: open.first.e.id, to: open.last.e.id, a: open.first.at, b: open.last.end });
      open = null;
    };
    for (const p of staffEvents(score, staff, lens)) {
      if (p.e.rest && !open) continue;
      const o = open as { value: Ottava; first: Placed; last: Placed } | null;
      if (p.e.ottava && o && o.value !== p.e.ottava) close();
      if (p.e.ottava && !open && !p.e.rest) open = { value: p.e.ottava, first: p, last: p };
      // the line ends over a note, not over the rests that follow it
      if (open && !p.e.rest) open.last = p;
      if (p.e.ottavaEnd) close();
    }
    close();
  }
  return spans;
}

/** Semitones between how a note under an octave line sounds and how it is drawn. */
export function ottavaSemitones(o: Ottava): number {
  return o === 8 ? 12 : o === -8 ? -12 : o === 15 ? 24 : -24;
}

export interface TripletMark {
  /** first note of a group; `bracket` when the group is not held together by one beam */
  start?: boolean;
  bracket?: boolean;
  stop?: boolean;
}

/**
 * Groups the triplet notes of one voice. A group is closed as soon as it fills a whole plain note
 * value (three triplet eighths, or a triplet quarter and eighth, fill one quarter).
 */
export function tripletGroups(voice: NoteEvent[], measureLen: number): Map<number, TripletMark> {
  const marks = new Map<number, TripletMark>();
  let group: number[] = [];
  let acc = 0;
  let longest = 0;
  const close = () => {
    if (group.length) {
      const members = group.map((i) => voice[i]);
      // eighths and shorter are beamed together unless a rest breaks the beam
      const beamed = members.length > 1 && members.every((e) => !e.rest && e.dur !== 'q' && e.dur !== 'h' && e.dur !== 'w');
      marks.set(group[0], { ...marks.get(group[0]), start: true, bracket: !beamed });
      const last = group[group.length - 1];
      marks.set(last, { ...marks.get(last), stop: true });
    }
    group = [];
    acc = 0;
    longest = 0;
  };
  voice.forEach((e, i) => {
    if (e.grace) return;
    if (!e.triplet) {
      close();
      return;
    }
    const t = eventTicks(e, measureLen);
    group.push(i);
    acc += t;
    longest = Math.max(longest, t);
    const least = longest >= 32 ? Math.max(96, Math.round(longest * 1.5)) : 48;
    const whole = [48, 96, 192, 384, 768].some((v) => Math.abs(acc - v) <= 1);
    if (whole && acc >= least - 1) close();
  });
  close();
  return marks;
}
