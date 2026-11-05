import { DurType, NoteEvent } from './types';

/** Ticks per quarter note. Divisible by 3 (triplets) and by 16 (64th notes). */
export const TPQ = 96;
export const BASE_TICKS: Record<DurType, number> = { w: 384, h: 192, q: 96, '8': 48, '16': 24, '32': 12, '64': 6 };

export function durTicks(dur: DurType, dots = 0, triplet = false): number {
  const base = BASE_TICKS[dur];
  let t = base;
  let add = base;
  for (let i = 0; i < dots; i++) {
    add /= 2;
    t += add;
  }
  return triplet ? Math.round((t * 2) / 3) : t;
}

export function measureTicks(time: [number, number]): number {
  return Math.round((time[0] * 4 * TPQ) / time[1]);
}

export function eventTicks(e: NoteEvent, measureLen: number): number {
  if (e.grace) return 0;
  if (e.fullMeasure) return measureLen;
  return durTicks(e.dur, e.dots, e.triplet);
}

export function voiceTicks(v: NoteEvent[], measureLen: number): number {
  return v.reduce((a, e) => a + eventTicks(e, measureLen), 0);
}

const DECOMP: { dur: DurType; dots: number }[] = [];
for (const d of ['w', 'h', 'q', '8', '16', '32', '64'] as DurType[]) {
  DECOMP.push({ dur: d, dots: 1 });
  DECOMP.push({ dur: d, dots: 0 });
}
DECOMP.sort((a, b) => durTicks(b.dur, b.dots) - durTicks(a.dur, a.dots));

/** Split a tick count into standard (optionally dotted) note values, largest first. */
export interface DurSpec {
  dur: DurType;
  dots: number;
  triplet?: boolean;
}

export function decompose(ticks: number, allowDots = true): DurSpec[] {
  const out: DurSpec[] = [];
  let rest = ticks;
  let guard = 0;
  while (rest > 0 && guard++ < 64) {
    const fit = DECOMP.find((d) => (allowDots || d.dots === 0) && durTicks(d.dur, d.dots) <= rest);
    if (!fit) break;
    out.push(fit);
    rest -= durTicks(fit.dur, fit.dots);
  }
  if (rest > 0) {
    // leftover from triplets etc. – express as triplet values where possible
    for (const d of ['q', '8', '16', '32'] as DurType[]) {
      while (rest >= durTicks(d, 0, true) && durTicks(d, 0, true) > 0) {
        out.push({ dur: d, dots: 0, triplet: true });
        rest -= durTicks(d, 0, true);
      }
    }
  }
  return out;
}

export function durLabel(d: DurType): string {
  return { w: 'Whole', h: 'Half', q: 'Quarter', '8': 'Eighth', '16': 'Sixteenth', '32': '32nd', '64': '64th' }[d];
}
