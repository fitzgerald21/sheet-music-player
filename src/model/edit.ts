// Editing operations. Every function takes a score and returns a NEW score (for undo history).
import { decompose, durTicks, eventTicks, voiceTicks } from './duration';
import { fitMeasure, fullRest, keyAt, measureLengths, restsFor } from './fix';
import { chromaticShift, diatonicShift, keyAlter, midiOf } from './pitch';
import { Articulation, DurType, Dynamic, Measure, NoteEvent, Pitch, Score, Step, cloneScore, newId } from './types';

export interface EventLoc {
  m: number;
  s: number;
  v: number;
  i: number;
}

export function findEvent(score: Score, id: string): EventLoc | null {
  for (let m = 0; m < score.measures.length; m++) {
    const ms = score.measures[m];
    for (let s = 0; s < ms.staves.length; s++) {
      const vs = ms.staves[s].voices;
      for (let v = 0; v < vs.length; v++) {
        const i = vs[v].findIndex((e) => e.id === id);
        if (i >= 0) return { m, s, v, i };
      }
    }
  }
  return null;
}

export function getEvent(score: Score, loc: EventLoc): NoteEvent | undefined {
  return score.measures[loc.m]?.staves[loc.s]?.voices[loc.v]?.[loc.i];
}

function staffCount(score: Score) {
  return score.parts.reduce((a, p) => a + p.staves.length, 0);
}

function mutate(score: Score, id: string, fn: (e: NoteEvent, loc: EventLoc, s: Score) => void): Score {
  const s = cloneScore(score);
  const loc = findEvent(s, id);
  if (!loc) return score;
  fn(getEvent(s, loc)!, loc, s);
  s.updated = Date.now();
  return s;
}

/** Next / previous event in the same staff & voice, across measures. */
export function neighborEvent(score: Score, id: string, dir: 1 | -1): string | null {
  const loc = findEvent(score, id);
  if (!loc) return null;
  let { m, i } = loc;
  i += dir;
  while (m >= 0 && m < score.measures.length) {
    const voice = score.measures[m].staves[loc.s]?.voices[Math.min(loc.v, score.measures[m].staves[loc.s].voices.length - 1)];
    if (voice && i >= 0 && i < voice.length) return voice[i].id;
    m += dir;
    if (m < 0 || m >= score.measures.length) break;
    const nv = score.measures[m].staves[loc.s].voices;
    const v2 = nv[Math.min(loc.v, nv.length - 1)];
    i = dir === 1 ? 0 : v2.length - 1;
  }
  return null;
}

/** Event in the staff above/below at roughly the same time. */
export function verticalNeighbor(score: Score, id: string, dir: 1 | -1): string | null {
  const loc = findEvent(score, id);
  if (!loc) return null;
  const s2 = loc.s + dir;
  const ms = score.measures[loc.m];
  if (s2 < 0 || s2 >= ms.staves.length) return null;
  const len = measureLengths(score)[loc.m];
  const voice = ms.staves[loc.s].voices[loc.v];
  const tick = voiceTicks(voice.slice(0, loc.i), len);
  const target = ms.staves[s2].voices[0];
  let acc = 0;
  for (const e of target) {
    const t = eventTicks(e, len);
    if (acc + t > tick) return e.id;
    acc += t;
  }
  return target[target.length - 1]?.id ?? null;
}

export function changePitch(score: Score, id: string, pitchIdx: number | null, mode: 'diatonic' | 'chromatic' | 'octave', amount: number): Score {
  return mutate(score, id, (e, loc, s) => {
    if (e.rest) return;
    const key = keyAt(s)[loc.m];
    const apply = (p: Pitch) =>
      mode === 'octave' ? { ...p, octave: p.octave + amount } : mode === 'diatonic' ? diatonicShift(p, amount, key) : chromaticShift(p, amount, key);
    e.pitches = e.pitches.map((p, i) => (pitchIdx === null || pitchIdx === i ? apply(p) : p));
    sortPitches(e);
  });
}

function sortPitches(e: NoteEvent) {
  e.pitches.sort((a, b) => midiOf(a) - midiOf(b));
  // remove duplicates
  e.pitches = e.pitches.filter((p, i, arr) => i === 0 || midiOf(p) !== midiOf(arr[i - 1]));
}

export function setAccidental(score: Score, id: string, pitchIdx: number | null, alter: number): Score {
  return mutate(score, id, (e) => {
    e.pitches.forEach((p, i) => {
      if (pitchIdx === null || pitchIdx === i) p.alter = alter;
    });
  });
}

/** Set a note letter (A–G). Turns rests into notes. Chooses the octave nearest to `nearMidi`. */
export function setLetter(score: Score, id: string, pitchIdx: number | null, step: Step, nearMidi: number, addToChord = false): Score {
  return mutate(score, id, (e, loc, s) => {
    const key = keyAt(s)[loc.m];
    const alter = keyAlter(key, step);
    let best: Pitch = { step, alter, octave: 4 };
    let bestDist = Infinity;
    const ref = addToChord && e.pitches.length ? midiOf(e.pitches[e.pitches.length - 1]) : nearMidi;
    for (let o = 0; o <= 8; o++) {
      const p = { step, alter, octave: o };
      const d = addToChord ? midiOf(p) - ref : Math.abs(midiOf(p) - ref);
      if (addToChord ? d > 0 && d < bestDist : d < bestDist) {
        best = p;
        bestDist = d;
      }
    }
    if (e.rest || e.fullMeasure) {
      const len = measureLengths(s)[loc.m];
      if (e.fullMeasure) {
        const parts = decompose(len);
        e.dur = parts[0]?.dur ?? 'w';
        e.dots = parts[0]?.dots ?? 0;
        e.fullMeasure = false;
        const rest = restsFor(len - durTicks(e.dur, e.dots));
        s.measures[loc.m].staves[loc.s].voices[loc.v].splice(loc.i + 1, 0, ...rest);
      }
      e.rest = false;
      e.pitches = [best];
    } else if (addToChord) {
      e.pitches.push(best);
    } else {
      const idx = pitchIdx ?? e.pitches.length - 1;
      e.pitches[idx] = { ...best, tie: e.pitches[idx]?.tie };
    }
    sortPitches(e);
  });
}

export function addInterval(score: Score, id: string, steps: number): Score {
  return mutate(score, id, (e, loc, s) => {
    if (e.rest || !e.pitches.length) return;
    const key = keyAt(s)[loc.m];
    const base = steps > 0 ? e.pitches[e.pitches.length - 1] : e.pitches[0];
    e.pitches.push({ ...diatonicShift(base, steps, key), tie: false });
    sortPitches(e);
  });
}

export function removePitch(score: Score, id: string, pitchIdx: number): Score {
  return mutate(score, id, (e) => {
    if (e.pitches.length <= 1) {
      e.pitches = [];
      e.rest = true;
      return;
    }
    e.pitches.splice(pitchIdx, 1);
  });
}

export function toRest(score: Score, id: string): Score {
  return mutate(score, id, (e) => {
    e.rest = true;
    e.pitches = [];
    delete e.lyric;
    delete e.artic;
    delete e.slurStart;
    delete e.slurEnd;
    if (e.grace) e.pitches = [];
  });
}

export function deleteEvent(score: Score, id: string): Score {
  return mutate(score, id, (e, loc, s) => {
    const voice = s.measures[loc.m].staves[loc.s].voices[loc.v];
    if (e.grace) {
      voice.splice(loc.i, 1);
      return;
    }
    if (e.rest && loc.v > 0) {
      // deleting rests in a 2nd voice removes the voice if it becomes empty
      e.rest = true;
    }
    e.rest = true;
    e.pitches = [];
    delete e.lyric;
    delete e.artic;
  });
}

/** Change duration in "overwrite" mode: following events in the measure are shortened or filled with rests. */
export function setDuration(score: Score, id: string, dur: DurType, dots: number, triplet = false): Score {
  return mutate(score, id, (e, loc, s) => {
    const len = measureLengths(s)[loc.m];
    const voice = s.measures[loc.m].staves[loc.s].voices[loc.v];
    if (e.grace) {
      e.dur = dur;
      e.dots = 0;
      return;
    }
    const start = voiceTicks(voice.slice(0, loc.i), len);
    const oldT = eventTicks(e, len);
    let newT = durTicks(dur, dots, triplet);
    if (start + newT > len) {
      // clamp to what fits
      const fit = decompose(len - start);
      if (!fit.length) return;
      dur = fit[0].dur;
      dots = fit[0].dots;
      triplet = !!fit[0].triplet;
      newT = durTicks(dur, dots, triplet);
    }
    e.fullMeasure = false;
    e.dur = dur;
    e.dots = dots;
    e.triplet = triplet || undefined;
    if (newT < oldT) {
      voice.splice(loc.i + 1, 0, ...restsFor(oldT - newT));
    } else if (newT > oldT) {
      let need = newT - oldT;
      let j = loc.i + 1;
      while (need > 0 && j < voice.length) {
        const nt = eventTicks(voice[j], len);
        if (voice[j].grace) {
          j++;
          continue;
        }
        if (nt <= need) {
          voice.splice(j, 1);
          need -= nt;
        } else {
          // shorten the event that we bite into: replace by rests covering the remainder
          voice.splice(j, 1, ...restsFor(nt - need));
          need = 0;
        }
      }
    }
    fitMeasure(s.measures[loc.m], len, staffCount(s));
  });
}

export function toggleDot(score: Score, id: string): Score {
  const loc = findEvent(score, id);
  if (!loc) return score;
  const e = getEvent(score, loc)!;
  return setDuration(score, id, e.dur, e.dots ? 0 : 1, !!e.triplet);
}

export function toggleTie(score: Score, id: string): Score {
  return mutate(score, id, (e) => {
    const all = e.pitches.every((p) => p.tie);
    e.pitches.forEach((p) => (p.tie = !all));
  });
}

export function toggleArtic(score: Score, id: string, a: Articulation): Score {
  return mutate(score, id, (e) => {
    const set = new Set(e.artic ?? []);
    if (set.has(a)) set.delete(a);
    else {
      set.add(a);
      if (a === 'staccato') set.delete('tenuto');
      if (a === 'tenuto') set.delete('staccato');
    }
    e.artic = set.size ? [...set] : undefined;
  });
}

export function setDynamic(score: Score, id: string, d: Dynamic | undefined): Score {
  return mutate(score, id, (e) => {
    e.dynamic = d;
  });
}

export function setLyric(score: Score, id: string, text: string): Score {
  return mutate(score, id, (e) => {
    e.lyric = text.trim() || undefined;
  });
}

export function toggleSlur(score: Score, id: string, which: 'start' | 'end'): Score {
  return mutate(score, id, (e) => {
    if (which === 'start') e.slurStart = !e.slurStart || undefined;
    else e.slurEnd = !e.slurEnd || undefined;
  });
}

// ---- measures ----

export function emptyMeasureLike(score: Score, ref: Measure | undefined): Measure {
  const n = staffCount(score);
  void ref;
  return { staves: Array.from({ length: n }, () => ({ voices: [[fullRest()]] })) };
}

export function insertMeasures(score: Score, at: number, count = 1): Score {
  const s = cloneScore(score);
  const ms = Array.from({ length: count }, () => emptyMeasureLike(s, s.measures[at]));
  s.measures.splice(at, 0, ...ms);
  s.updated = Date.now();
  return s;
}

export function deleteMeasures(score: Score, from: number, to: number): Score {
  const s = cloneScore(score);
  if (s.measures.length <= to - from + 1) return score;
  const removed = s.measures.splice(from, to - from + 1);
  // keep key/time/tempo changes that were attached to a deleted first measure
  const first = removed[0];
  const next = s.measures[from];
  if (next && first) {
    if (first.key !== undefined && next.key === undefined) next.key = first.key;
    if (first.time && !next.time) next.time = first.time;
    if (first.tempo && !next.tempo) next.tempo = first.tempo;
  }
  if (from === 0 && s.measures[0]) s.measures[0].pickup = s.measures[0].pickup && false;
  s.updated = Date.now();
  return s;
}

export function clearMeasures(score: Score, from: number, to: number, staff?: number): Score {
  const s = cloneScore(score);
  for (let i = from; i <= to; i++)
    s.measures[i].staves.forEach((st, si) => {
      if (staff === undefined || staff === si) st.voices = [[fullRest()]];
    });
  return s;
}

export function copyMeasures(score: Score, from: number, to: number): Measure[] {
  return structuredClone(score.measures.slice(from, to + 1));
}

export function pasteMeasures(score: Score, at: number, clip: Measure[]): Score {
  const s = cloneScore(score);
  const n = staffCount(s);
  clip.forEach((m, k) => {
    const target = s.measures[at + k];
    const copy = structuredClone(m);
    for (const st of copy.staves) for (const v of st.voices) for (const e of v) e.id = newId();
    if (!target) {
      s.measures.push({ staves: copy.staves });
    } else {
      target.staves = copy.staves;
      target.chords = copy.chords;
    }
  });
  const lens = measureLengths(s);
  for (let i = at; i < at + clip.length && i < s.measures.length; i++) fitMeasure(s.measures[i], lens[i], n);
  return s;
}

export function updateMeasure(score: Score, index: number, patch: Partial<Measure>): Score {
  const s = cloneScore(score);
  const m = s.measures[index];
  Object.assign(m, patch);
  for (const k of Object.keys(patch) as (keyof Measure)[]) if (patch[k] === undefined) delete m[k];
  return s;
}

export function setChordSymbol(score: Score, index: number, beat: number, text: string): Score {
  const s = cloneScore(score);
  const m = s.measures[index];
  const list = (m.chords ?? []).filter((c) => Math.abs(c.beat - beat) > 1e-6);
  if (text.trim()) list.push({ beat, text: text.trim() });
  list.sort((a, b) => a.beat - b.beat);
  m.chords = list.length ? list : undefined;
  return s;
}

export function addVoice(score: Score, id: string): { score: Score; firstId: string | null } {
  const s = cloneScore(score);
  const loc = findEvent(s, id);
  if (!loc) return { score, firstId: null };
  const st = s.measures[loc.m].staves[loc.s];
  if (st.voices.length >= 2) return { score, firstId: st.voices[1][0]?.id ?? null };
  const len = measureLengths(s)[loc.m];
  const v = restsFor(len);
  st.voices.push(v);
  return { score: s, firstId: v[0]?.id ?? null };
}
