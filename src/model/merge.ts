import { measureTicks } from './duration';
import { fitScore, fullRest } from './fix';
import { Score, cloneScore } from './types';

/** Append several scores (e.g. pages read separately) into one, using the first score's parts. */
export function mergeScores(scores: Score[]): Score {
  const out = cloneScore(scores[0]);
  const staffCount = out.parts.reduce((a, p) => a + p.staves.length, 0);
  let key = out.key;
  let time = out.time;
  for (const m of out.measures) {
    if (m.key !== undefined) key = m.key;
    if (m.time) time = m.time;
  }
  for (const s of scores.slice(1)) {
    const n = s.parts.reduce((a, p) => a + p.staves.length, 0);
    const offset = Math.max(0, staffCount - n); // a page missing the top staff (e.g. voice) aligns to the bottom
    s.measures.forEach((m, i) => {
      const staves = Array.from({ length: staffCount }, (_, k) => m.staves[k - offset] ?? { voices: [[fullRest()]] });
      const copy = { ...structuredClone(m), staves: structuredClone(staves) };
      if (i === 0) {
        if (s.key !== key && copy.key === undefined) copy.key = s.key;
        // a page without a printed time signature gets a guessed one: only a different length is a real change
        if (measureTicks(s.time) !== measureTicks(time) && !copy.time) copy.time = s.time;
        delete copy.pickup;
      }
      if (copy.key === key) delete copy.key;
      if (copy.key !== undefined) key = copy.key;
      if (copy.time) time = copy.time;
      out.measures.push(copy);
    });
    out.notes = [...(out.notes ?? []), ...(s.notes ?? [])];
  }
  fitScore(out);
  return out;
}
