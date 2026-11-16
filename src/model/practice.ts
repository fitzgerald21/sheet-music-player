// What the play-along view needs to follow and mark someone playing: the notes they are expected
// to play, the stretch of music being practised, and how well they kept up.
import { PlaybackPlan } from './playback';

/** Everything the player has to press at one moment. */
export interface Step {
  time: number;
  midis: number[];
  ids: string[];
}

/** The player's notes (those on `staves`) between two score times, grouped into chords. */
export function buildSteps(plan: PlaybackPlan, staves: number[], start = 0, end = Infinity): Step[] {
  const out: Step[] = [];
  for (const n of plan.notes) {
    if (!staves.includes(n.staff) || n.time < start - 0.001 || n.time >= end - 0.001) continue;
    const last = out[out.length - 1];
    if (last && Math.abs(last.time - n.time) < 0.02) {
      if (!last.midis.includes(n.midi)) last.midis.push(n.midi);
      if (n.eventId && !last.ids.includes(n.eventId)) last.ids.push(n.eventId);
    } else out.push({ time: n.time, midis: [n.midi], ids: n.eventId ? [n.eventId] : [] });
  }
  return out;
}

/**
 * Score time from the start of measure `from` to the end of measure `to` (both 0-based). Repeats are
 * unrolled in a plan, so a measure can come round more than once: the first time is used. A section
 * that runs to the last measure runs to the very end, through any D.C. or repeat still to come.
 */
export function sectionSpan(plan: PlaybackPlan, from: number, to: number): { start: number; end: number } {
  const start = plan.measures.find((m) => m.measure === from)?.time ?? 0;
  const last = Math.max(...plan.measures.map((m) => m.measure));
  if (to >= last) return { start, end: plan.duration };
  const end = plan.measures.find((m) => m.measure === to && m.time >= start - 0.001)?.end ?? plan.duration;
  return { start, end };
}

export interface Tally {
  /** notes that have come up so far */
  total: number;
  hit: number;
  /** keys pressed that matched nothing */
  extra: number;
  percent: number;
}

/** Marks playing in time with the app: a key counts if its note is within `tolerance` of now. */
export class TimingScore {
  private notes: { time: number; midi: number; hit: boolean }[] = [];
  private extra = 0;
  presses = 0;

  constructor(steps: Step[]) {
    for (const s of steps) for (const midi of s.midis) this.notes.push({ time: s.time, midi, hit: false });
  }

  /** A key went down at score time `pos`; `tolerance` is in score seconds. */
  press(midi: number, pos: number, tolerance: number): 'hit' | 'extra' {
    this.presses++;
    let best: (typeof this.notes)[number] | null = null;
    for (const n of this.notes) {
      if (n.time > pos + tolerance) break;
      if (n.hit || n.midi !== midi || n.time < pos - tolerance) continue;
      if (!best || Math.abs(n.time - pos) < Math.abs(best.time - pos)) best = n;
    }
    if (best) {
      best.hit = true;
      return 'hit';
    }
    this.extra++;
    return 'extra';
  }

  /** The tally for the notes up to score time `upTo`. */
  result(upTo = Infinity): Tally {
    const due = this.notes.filter((n) => n.time <= upTo);
    const hit = due.filter((n) => n.hit).length;
    return { total: due.length, hit, extra: this.extra, percent: due.length ? Math.round((hit / due.length) * 100) : 0 };
  }
}
