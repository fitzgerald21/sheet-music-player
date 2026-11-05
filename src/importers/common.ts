import { decompose, durTicks } from '../model/duration';
import { DurType, NoteEvent, Pitch, newId } from '../model/types';

/** Turn a tick length into one or more events (tied when it is a note). */
export function eventsForTicks(ticks: number, pitches: Pitch[] | null, base: Partial<NoteEvent> = {}): NoteEvent[] {
  // exact single value first (incl. triplets)
  for (const dur of ['w', 'h', 'q', '8', '16', '32', '64'] as DurType[]) {
    for (const dots of [0, 1, 2]) {
      if (durTicks(dur, dots) === ticks) return [mk(dur, dots, false)];
      if (dots === 0 && durTicks(dur, 0, true) === ticks) return [mk(dur, 0, true)];
    }
  }
  const parts = decompose(ticks);
  if (!parts.length) return [];
  return parts.map((p, i) => {
    const e = mk(p.dur, p.dots, !!p.triplet);
    if (pitches && i < parts.length - 1) e.pitches.forEach((pt) => (pt.tie = true));
    if (i > 0) {
      delete e.lyric;
      delete e.dynamic;
      delete e.artic;
      delete e.slurStart;
    }
    if (i < parts.length - 1) delete e.slurEnd;
    return e;
  });

  function mk(dur: DurType, dots: number, triplet: boolean): NoteEvent {
    const e: NoteEvent = {
      ...base,
      id: newId(),
      pitches: pitches ? pitches.map((p) => ({ ...p })) : [],
      dur,
      dots,
      ...(triplet ? { triplet: true } : {}),
    };
    if (!pitches) e.rest = true;
    return e;
  }
}

/** Fractional beat (1-based, in denominator units) for a tick offset. */
export function beatOf(tick: number, den: number): number {
  return Math.round((tick / ((4 * 96) / den) + 1) * 1000) / 1000;
}

export function chordSymbolFromKind(kind: string, text: string | null): string {
  if (text !== null && text !== undefined) return text;
  const map: Record<string, string> = {
    major: '', minor: 'm', augmented: 'aug', diminished: 'dim', dominant: '7', 'major-seventh': 'maj7', 'minor-seventh': 'm7',
    'diminished-seventh': 'dim7', 'augmented-seventh': 'aug7', 'half-diminished': 'm7b5', 'major-minor': 'mMaj7', 'major-sixth': '6',
    'minor-sixth': 'm6', 'dominant-ninth': '9', 'major-ninth': 'maj9', 'minor-ninth': 'm9', 'dominant-11th': '11', 'major-11th': 'maj11',
    'minor-11th': 'm11', 'dominant-13th': '13', 'major-13th': 'maj13', 'minor-13th': 'm13', 'suspended-second': 'sus2',
    'suspended-fourth': 'sus4', power: '5', none: 'N.C.',
  };
  return map[kind] ?? '';
}
