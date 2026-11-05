import { decompose, eventTicks, measureTicks, voiceTicks } from './duration';
import { Measure, NoteEvent, Score, newId } from './types';

export function restEvent(dur: NoteEvent['dur'], dots = 0, triplet = false): NoteEvent {
  return { id: newId(), pitches: [], rest: true, dur, dots, ...(triplet ? { triplet } : {}) };
}

export function fullRest(): NoteEvent {
  return { id: newId(), pitches: [], rest: true, fullMeasure: true, dur: 'w', dots: 0 };
}

export function restsFor(ticks: number): NoteEvent[] {
  return decompose(ticks).map((d) => restEvent(d.dur, d.dots, d.triplet));
}

/** Time signature in effect at each measure. */
export function timeAt(score: Score): [number, number][] {
  let cur = score.time;
  return score.measures.map((m) => (cur = m.time ?? cur));
}

export function keyAt(score: Score): number[] {
  let cur = score.key;
  return score.measures.map((m) => (cur = m.key ?? cur));
}

/** Actual length (ticks) of each measure, accounting for pickups. */
export function measureLengths(score: Score): number[] {
  const times = timeAt(score);
  return score.measures.map((m, i) => {
    const full = measureTicks(times[i]);
    if (!m.pickup) return full;
    let max = 0;
    for (const st of m.staves) for (const v of st.voices) max = Math.max(max, voiceTicks(v.filter((e) => !e.fullMeasure), full));
    return max > 0 && max < full ? max : full;
  });
}

/**
 * Make every voice of a measure add up exactly to the measure length.
 * Returns true if something had to be changed.
 */
export function fitMeasure(m: Measure, len: number, staffCount: number): boolean {
  let changed = false;
  while (m.staves.length < staffCount) {
    m.staves.push({ voices: [[fullRest()]] });
    changed = true;
  }
  if (m.staves.length > staffCount) {
    m.staves.length = staffCount;
    changed = true;
  }
  for (const st of m.staves) {
    if (!st.voices.length) st.voices.push([]);
    st.voices = st.voices.filter((v, i) => i === 0 || v.some((e) => !e.rest || !e.fullMeasure));
    for (let vi = 0; vi < st.voices.length; vi++) {
      const v = st.voices[vi];
      // a full-measure rest mixed with other things is meaningless
      if (v.length > 1 && v.some((e) => e.fullMeasure)) {
        st.voices[vi] = v.filter((e) => !e.fullMeasure);
        changed = true;
      }
      const voice = st.voices[vi];
      if (!voice.length) {
        voice.push(vi === 0 ? fullRest() : fullRest());
        changed = true;
        continue;
      }
      let total = voiceTicks(voice, len);
      if (total < len) {
        voice.push(...restsFor(len - total));
        changed = true;
      } else if (total > len) {
        changed = true;
        // drop trailing rests first, then shorten from the end
        while (total > len && voice.length) {
          const last = voice[voice.length - 1];
          const t = eventTicks(last, len);
          if (total - t >= len || last.rest) {
            voice.pop();
            total -= t;
          } else {
            const keep = len - (total - t);
            const parts = decompose(keep);
            if (!parts.length) {
              voice.pop();
              total -= t;
              continue;
            }
            last.dur = parts[0].dur;
            last.dots = parts[0].dots;
            last.triplet = parts[0].triplet;
            last.pitches.forEach((p) => (p.tie = false));
            total = total - t + eventTicks(last, len);
          }
        }
        if (total < len) voice.push(...restsFor(len - total));
      }
    }
    // second voice that is entirely rests is dropped
    st.voices = st.voices.filter((v, i) => i === 0 || v.some((e) => !e.rest));
  }
  return changed;
}

/** Normalise a whole score. Returns the indices of measures that needed fixing. */
export function fitScore(score: Score): number[] {
  const staffCount = score.parts.reduce((a, p) => a + p.staves.length, 0);
  const lens = measureLengths(score);
  const fixed: number[] = [];
  score.measures.forEach((m, i) => {
    if (fitMeasure(m, lens[i], staffCount)) fixed.push(i);
  });
  return fixed;
}
