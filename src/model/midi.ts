// Standard MIDI File (type 1) export, built from the playback plan so repeats are unrolled.
import { PlaybackPlan } from './playback';
import { Score } from './types';

const PPQ = 480;
const GM_PROGRAM: Record<string, number> = {
  piano: 0, epiano: 4, voice: 52, flute: 73, strings: 48, organ: 19, musicbox: 10, marimba: 12, guitar: 24, bass: 32,
};

function vlq(n: number): number[] {
  const bytes = [n & 0x7f];
  while ((n >>= 7)) bytes.unshift((n & 0x7f) | 0x80);
  return bytes;
}
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

function track(events: { tick: number; order: number; data: number[] }[]): number[] {
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const out: number[] = [];
  let last = 0;
  for (const e of events) {
    out.push(...vlq(Math.max(0, e.tick - last)), ...e.data);
    last = Math.max(last, e.tick);
  }
  out.push(0, 0xff, 0x2f, 0);
  return [0x4d, 0x54, 0x72, 0x6b, ...u32(out.length), ...out];
}

function text(type: number, s: string): number[] {
  const bytes = [...new TextEncoder().encode(s)];
  return [0xff, type, ...vlq(bytes.length), ...bytes];
}

export function toMidi(score: Score, plan: PlaybackPlan): Uint8Array {
  let acc = 0;
  const spans = plan.measures.map((m) => {
    const startTick = acc;
    acc += Math.round(((m.end - m.time) * m.qpm * PPQ) / 60);
    return { ...m, startTick };
  });
  const toTick = (t: number) => {
    let lo = 0;
    let hi = spans.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (spans[mid].time <= t) lo = mid;
      else hi = mid - 1;
    }
    const s = spans[lo];
    if (!s) return 0;
    return Math.max(0, Math.round(s.startTick + ((t - s.time) * s.qpm * PPQ) / 60));
  };

  const tracks: number[][] = [];
  const meta: { tick: number; order: number; data: number[] }[] = [{ tick: 0, order: 0, data: text(0x03, score.title || 'Untitled') }];
  let lastQpm = -1;
  for (const s of spans) {
    if (s.qpm !== lastQpm) {
      const us = Math.round(60_000_000 / s.qpm);
      meta.push({ tick: s.startTick, order: 1, data: [0xff, 0x51, 0x03, (us >> 16) & 255, (us >> 8) & 255, us & 255] });
      lastQpm = s.qpm;
    }
  }
  const [num, den] = score.time;
  meta.push({ tick: 0, order: 2, data: [0xff, 0x58, 0x04, num, Math.log2(den), 24, 8] });
  meta.push({ tick: 0, order: 3, data: [0xff, 0x59, 0x02, score.key & 0xff, 0] });
  tracks.push(track(meta));

  score.parts.forEach((part, pi) => {
    const ch = pi >= 9 ? pi + 1 : pi; // skip drum channel
    const ev: { tick: number; order: number; data: number[] }[] = [
      { tick: 0, order: 0, data: text(0x03, part.name) },
      { tick: 0, order: 1, data: [0xc0 | ch, GM_PROGRAM[part.instrument] ?? 0] },
    ];
    for (const n of plan.notes) {
      if (n.part !== pi) continue;
      const a = toTick(Math.max(0, n.time));
      const b = Math.max(a + 1, toTick(n.time + n.dur));
      const vel = Math.max(1, Math.min(127, Math.round(n.velocity * 127)));
      ev.push({ tick: a, order: 3, data: [0x90 | ch, n.midi, vel] });
      ev.push({ tick: b, order: 2, data: [0x80 | ch, n.midi, 0] });
    }
    tracks.push(track(ev));
  });
  const header = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, tracks.length, (PPQ >> 8) & 255, PPQ & 255];
  return new Uint8Array([...header, ...tracks.flat()]);
}
