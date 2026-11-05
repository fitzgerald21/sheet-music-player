import { chordIntervals, parseChord } from './chords';
import { TPQ, eventTicks, measureTicks } from './duration';
import { measureLengths, timeAt } from './fix';
import { STEP_SEMI, midiOf } from './pitch';
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
  swing?: boolean;
  /** global staff indices whose notes are highlighted but not played (e.g. the hand you play yourself) */
  mutedStaves?: number[];
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
  const partDyn = score.parts.map(() => DYN_VEL.mf);
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
    m.staves.forEach((sm, si) => {
      const part = staffPart[si] ?? 0;
      sm.voices.forEach((voice, vi) => {
        let tick = 0;
        let inSlur = false;
        const topVoice = vi === 0;
        voice.forEach((e, ei) => {
          const et = eventTicks(e, len);
          if (e.dynamic) partDyn[part] = DYN_VEL[e.dynamic];
          const start = t + tick * secPerTick;
          let durSec = et * secPerTick;
          if (e.grace) {
            durSec = Math.min(0.09, 0.25 * secPerTick * TPQ);
          }
          if (!e.rest) {
            spans.push({ time: e.grace ? start - durSec : start, end: e.grace ? start : start + durSec, eventId: e.id, measure: mi });
            let vel = partDyn[part];
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
        const startTick = ((c.beat - 1) * 4 * TPQ) / unit;
        const endTick = ci + 1 < sorted.length ? ((sorted[ci + 1].beat - 1) * 4 * TPQ) / unit : len;
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
