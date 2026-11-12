import { chordIntervals, parseChord } from './chords';
import { TPQ, eventTicks, measureTicks } from './duration';
import { measureLengths, timeAt } from './fix';
import { STEP_SEMI, midiOf } from './pitch';
import { hairpinSpans } from './spans';
import { Dynamic, Score } from './types';

/** Order in which measures are played, following repeats, voltas, D.C./D.S., Fine and Coda. */
export function playbackOrder(score: Score, opts: { followRepeats?: boolean } = {}): number[] {
  const ms = score.measures;
  const n = ms.length;
  if (opts.followRepeats === false) return ms.map((_, i) => i);
  const order: number[] = [];
  const passes = new Map<number, number>();
  let repeatStart = 0;
  let pass = 1;
  let jumped = false;
  let jumpUsed = false;
  let i = 0;
  const segnoIdx = ms.findIndex((m) => m.segno);
  const codaIdx = ms.findIndex((m) => m.coda);
  let guard = 0;
  while (i < n && guard++ < 5000) {
    const m = ms[i];
    if (m.repeatStart) repeatStart = i;
    if (m.ending && !playEnding(ms, i, pass, jumped)) {
      i++;
      continue;
    }
    order.push(i);
    if (jumped && m.fine) break;
    if (jumped && m.toCoda && codaIdx > i) {
      i = codaIdx;
      continue;
    }
    if (m.repeatEnd && !jumped) {
      const times = m.repeatEnd || 2;
      const count = passes.get(i) ?? 1;
      if (count < times) {
        passes.set(i, count + 1);
        pass = count + 1;
        i = repeatStart;
        continue;
      }
      pass = 1;
    }
    if (m.navigation && !jumpUsed) {
      jumpUsed = true;
      jumped = true;
      pass = 1;
      i = m.navigation.startsWith('DC') ? 0 : Math.max(0, segnoIdx);
      repeatStart = i;
      continue;
    }
    i++;
  }
  return order;
}

/** Measures of the contiguous volta block containing measure i. */
function endingBlock(ms: Score['measures'], i: number): number[] {
  let a = i;
  while (a > 0 && ms[a - 1].ending) a--;
  let b = i;
  while (b < ms.length - 1 && ms[b + 1].ending) b++;
  const out: number[] = [];
  for (let k = a; k <= b; k++) out.push(k);
  return out;
}

/** Whether the volta at measure i is played on this pass. After a D.C./D.S. jump only the last ending is played. */
function playEnding(ms: Score['measures'], i: number, pass: number, jumped: boolean): boolean {
  const block = endingBlock(ms, i);
  const maxNum = Math.max(...block.flatMap((k) => ms[k].ending ?? [0]));
  const mine = ms[i].ending ?? [];
  if (jumped) return mine.includes(maxNum);
  if (mine.includes(pass)) return true;
  const anyMatches = block.some((k) => ms[k].ending?.includes(pass));
  return !anyMatches && mine.includes(maxNum);
}

export interface PlayNote {
  /** seconds at 100% speed */
  time: number;
  dur: number;
  midi: number;
  velocity: number;
  part: number;
  /** event id for highlighting */
  eventId: string;
  staff: number;
}

export interface PlayEventSpan {
  time: number;
  end: number;
  eventId: string;
  measure: number;
}

export interface MeasureSpan {
  measure: number;
  time: number;
  end: number;
  beats: number;
  beatUnit: number;
  /** seconds per beat */
  beatDur: number;
  /** tempo, quarter notes per minute */
  qpm: number;
}

export interface PlaybackPlan {
  notes: PlayNote[];
  spans: PlayEventSpan[];
  measures: MeasureSpan[];
  duration: number;
}

const DYN_VEL: Record<Dynamic, number> = {
  ppp: 0.22, pp: 0.3, p: 0.4, mp: 0.5, mf: 0.6, f: 0.72, ff: 0.84, fff: 0.95, sfz: 0.9, fp: 0.75,
};

export interface PlanOptions {
  followRepeats?: boolean;
  /** play only these measure indices (in order) – used for looping a selection */
  range?: [number, number];
  humanize?: boolean;
  playChords?: boolean;
  /** force swing on or off; by default it follows "Swing" / "Straight" in the measure texts */
  swing?: boolean;
  /** false: a tremolo is one held note, not repeated strokes (for stepping through the notes to play) */
  tremolo?: boolean;
  /** global staff indices whose notes are highlighted but not played (e.g. the hand you play yourself) */
  mutedStaves?: number[];
}

/**
 * Whether eighth notes are swung in each measure. "Swing" in a measure's text turns it on from
 * there; "Straight" (or "Even eighths") turns it off again.
 */
export function swingAt(score: Score): boolean[] {
  let on = false;
  return score.measures.map((m) => {
    const text = (m.text ?? '').toLowerCase();
    if (/straight|even (eighths|8ths)|no swing/.test(text)) on = false;
    else if (/swing|shuffle/.test(text)) on = true;
    return on;
  });
}

/** In swing the eighth note off the beat is played late, as the last note of a triplet. */
const swung = (tick: number) => (tick % TPQ === TPQ / 2 ? tick + TPQ / 6 : tick);

/**
 * How loud each part is at any point of the piece (ticks in written order). A dynamic mark sets the
 * level; a hairpin moves it gradually to the next dynamic mark, or by one step if none follows.
 */
function loudness(score: Score, lens: number[], staffPart: number[]): (part: number, at: number) => number {
  const marks: { at: number; level: number }[][] = score.parts.map(() => []);
  let base = 0;
  score.measures.forEach((m, mi) => {
    m.staves.forEach((sm, si) =>
      sm.voices.forEach((voice) => {
        let tick = 0;
        for (const e of voice) {
          if (e.dynamic) marks[staffPart[si] ?? 0].push({ at: base + tick, level: DYN_VEL[e.dynamic] });
          tick += eventTicks(e, lens[mi]);
        }
      }),
    );
    base += lens[mi];
  });
  for (const list of marks) list.sort((x, y) => x.at - y.at);
  const ramps: { a: number; b: number; from: number; to: number }[][] = score.parts.map(() => []);
  const level = (part: number, at: number): number => {
    let mark = { at: -1, level: DYN_VEL.mf };
    for (const k of marks[part]) {
      if (k.at > at) break;
      mark = k;
    }
    let ramp: { a: number; b: number; from: number; to: number } | undefined;
    for (const r of ramps[part]) if (r.a <= at) ramp = r;
    if (!ramp || ramp.b <= mark.at) return mark.level;
    if (at >= ramp.b) return ramp.to;
    return ramp.from + ((ramp.to - ramp.from) * (at - ramp.a)) / (ramp.b - ramp.a);
  };
  for (const h of hairpinSpans(score).sort((x, y) => x.a - y.a)) {
    const part = staffPart[h.staff] ?? 0;
    const from = level(part, h.a);
    const up = h.value === 'cresc';
    const goal = marks[part].find((k) => k.at > h.a && k.at <= h.b + 4 * TPQ && (up ? k.level > from : k.level < from));
    const to = goal ? goal.level : Math.max(0.2, Math.min(0.95, from + (up ? 0.14 : -0.14)));
    ramps[part].push({ a: h.a, b: goal ? Math.min(Math.max(h.b, h.a + 1), Math.max(goal.at, h.a + 1)) : h.b, from, to });
  }
  return level;
}

export function buildPlan(score: Score, opts: PlanOptions = {}): PlaybackPlan {
  const times = timeAt(score);
  const lens = measureLengths(score);
  let order = playbackOrder(score, { followRepeats: opts.followRepeats });
  if (opts.range) {
    const [a, b] = opts.range;
    order = [];
    for (let i = a; i <= b; i++) order.push(i);
  }
  const notes: PlayNote[] = [];
  const spans: PlayEventSpan[] = [];
  const measures: MeasureSpan[] = [];

  // staff -> part
  const staffPart: number[] = [];
  score.parts.forEach((p, pi) => p.staves.forEach(() => staffPart.push(pi)));

  let tempo = score.tempo;
  // tempo in effect at each measure index (written order)
  const tempoAt: number[] = [];
  for (const m of score.measures) {
    if (m.tempo) tempo = m.tempo;
    tempoAt.push(tempo);
  }
  let t = 0;
  const level = loudness(score, lens, staffPart);
  const swing = swingAt(score);
  const measureStart: number[] = [];
  lens.reduce((sum, l, i) => ((measureStart[i] = sum), sum + l), 0);
  // open ties: key staff|voice|midi -> note
  const openTies = new Map<string, PlayNote>();
  let rand = 12345;
  const rnd = () => {
    rand = (rand * 1103515245 + 12345) & 0x7fffffff;
    return rand / 0x7fffffff - 0.5;
  };

  for (const mi of order) {
    const m = score.measures[mi];
    const len = lens[mi];
    const secPerTick = 60 / tempoAt[mi] / TPQ;
    const [beats, unit] = times[mi];
    const compound = unit === 8 && beats % 3 === 0 && beats > 3;
    const beatTicks = compound ? (3 * 4 * TPQ) / 8 : (4 * TPQ) / unit;
    measures.push({
      measure: mi,
      time: t,
      end: t + len * secPerTick,
      beats: Math.round(len / beatTicks) || 1,
      beatUnit: unit,
      beatDur: beatTicks * secPerTick,
      qpm: tempoAt[mi],
    });
    const stillOpen = new Set<string>();
    const warp = (opts.swing ?? swing[mi]) && (unit === 4 || unit === 2) ? swung : (tick: number) => tick;
    m.staves.forEach((sm, si) => {
      const part = staffPart[si] ?? 0;
      sm.voices.forEach((voice, vi) => {
        let tick = 0;
        let inSlur = false;
        const topVoice = vi === 0;
        voice.forEach((e, ei) => {
          const et = eventTicks(e, len);
          const start = t + warp(tick) * secPerTick;
          let durSec = (warp(tick + et) - warp(tick)) * secPerTick;
          if (e.grace) {
            durSec = Math.min(0.09, 0.25 * secPerTick * TPQ);
          }
          if (!e.rest) {
            spans.push({ time: e.grace ? start - durSec : start, end: e.grace ? start : start + durSec, eventId: e.id, measure: mi });
            let vel = level(part, measureStart[mi] + tick);
            if (e.artic?.includes('accent')) vel += 0.14;
            if (e.artic?.includes('marcato')) vel += 0.2;
            if (e.dynamic === 'sfz') vel = 0.92;
            // gentle metric accent on downbeats
            if (tick === 0) vel += 0.04;
            else if (tick % beatTicks === 0) vel += 0.015;
            if (topVoice && si === 0) vel += 0.02;
            if (opts.humanize !== false) vel += rnd() * 0.06;
            vel = Math.max(0.08, Math.min(1, vel));
            let lengthFactor = 0.96;
            if (e.artic?.includes('staccato')) lengthFactor = 0.42;
            else if (e.artic?.includes('tenuto') || e.slurStart) lengthFactor = 1.0;
            if (e.slurStart) inSlur = true;
            if (inSlur && !e.slurEnd && !e.artic?.includes('staccato')) lengthFactor = 1.02;
            if (e.slurEnd) inSlur = false;
            const humanT = opts.humanize !== false && !e.grace ? rnd() * 0.008 : 0;
            for (const p of e.pitches) {
              const midi = midiOf(p);
              const key = `${si}|${vi}|${midi}`;
              const open = openTies.get(key);
              if (open && !e.grace) {
                open.dur = start + durSec * (p.tie ? 1 : lengthFactor) - open.time;
                if (p.tie) stillOpen.add(key);
                else openTies.delete(key);
                continue;
              }
              if (e.tremolo && opts.tremolo !== false && !e.grace && !opts.mutedStaves?.includes(si)) {
                // repeated strokes; a fast tremolo on a chord rocks between its lower and upper notes
                const idx = e.pitches.indexOf(p);
                const rock = e.tremolo === 3 && e.pitches.length > 1;
                const strokeSec = Math.max(0.06, (TPQ / (e.tremolo === 1 ? 2 : e.tremolo === 2 ? 4 : 8)) * secPerTick);
                const count = Math.max(2, Math.round(durSec / strokeSec));
                const step = durSec / count;
                const upper = rock && idx >= Math.ceil(e.pitches.length / 2) ? 1 : 0;
                for (let k = upper; k < count; k += rock ? 2 : 1)
                  notes.push({ time: start + k * step, dur: step * (rock ? 2 : 1.05), midi, velocity: vel * (k === 0 ? 1 : 0.82), part, eventId: e.id, staff: si });
                continue;
              }
              const note: PlayNote = {
                time: (e.grace ? start - durSec : start) + humanT,
                dur: e.grace ? durSec : durSec * (p.tie ? 1 : lengthFactor),
                midi,
                velocity: e.grace ? vel * 0.85 : vel,
                part,
                eventId: e.id,
                staff: si,
              };
              if (!opts.mutedStaves?.includes(si)) notes.push(note);
              if (p.tie && !e.grace) {
                openTies.set(key, note);
                stillOpen.add(key);
              }
            }
          }
          tick += et;
        });
      });
    });
    // ties that were not continued are closed
    for (const k of [...openTies.keys()]) if (!stillOpen.has(k)) openTies.delete(k);

    if (opts.playChords && m.chords?.length) {
      const sorted = [...m.chords].sort((a, b) => a.beat - b.beat);
      sorted.forEach((c, ci) => {
        const pc = parseChord(c.text);
        if (!pc) return;
        const startTick = warp(Math.round(((c.beat - 1) * 4 * TPQ) / unit));
        const endTick = ci + 1 < sorted.length ? warp(Math.round(((sorted[ci + 1].beat - 1) * 4 * TPQ) / unit)) : len;
        const root = 48 + ((STEP_SEMI[pc.root] + pc.rootAlter + 12) % 12);
        const bass = pc.bass ? 36 + ((STEP_SEMI[pc.bass] + (pc.bassAlter ?? 0) + 12) % 12) : root - 12;
        const tones = [bass, ...chordIntervals(pc.quality).map((iv) => root + iv)];
        for (const midi of tones)
          notes.push({ time: t + startTick * secPerTick, dur: (endTick - startTick) * secPerTick * 0.98, midi, velocity: 0.35, part: -1, eventId: '', staff: -1 });
      });
    }
    t += len * secPerTick;
  }
  notes.sort((a, b) => a.time - b.time);
  spans.sort((a, b) => a.time - b.time);
  void measureTicks;
  return { notes, spans, measures, duration: t };
}
