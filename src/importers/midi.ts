// Standard MIDI File -> Score. Notes are quantised to a 16th / 8th-triplet grid, each track becomes a
// part (wide-ranged tracks become a two-staff piano part split at middle C), and overlapping notes
// are written as chords with ties so that playback stays faithful.
import { TPQ, measureTicks } from '../model/duration';
import { fitScore, fullRest } from '../model/fix';
import { spellMidi } from '../model/pitch';
import { Clef, InstrumentId, Measure, NoteEvent, Part, Score, StaffMeasure, newId } from '../model/types';
import { eventsForTicks } from './common';

interface MNote {
  start: number; // in our ticks (TPQ per quarter)
  end: number;
  midi: number;
  vel: number;
  channel: number;
}

interface MTrack {
  name: string;
  notes: MNote[];
  program: number;
}

interface ParsedMidi {
  tracks: MTrack[];
  tempos: { tick: number; qpm: number }[];
  times: { tick: number; num: number; den: number }[];
  keys: { tick: number; fifths: number }[];
  title?: string;
}

export function parseMidiFile(bytes: Uint8Array): ParsedMidi {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const str = (o: number, n: number) => String.fromCharCode(...bytes.slice(o, o + n));
  if (str(0, 4) !== 'MThd') throw new Error('This is not a MIDI file.');
  const hdrLen = dv.getUint32(4);
  const ntracks = dv.getUint16(10);
  const division = dv.getUint16(12);
  if (division & 0x8000) throw new Error('SMPTE-timed MIDI files are not supported.');
  const scale = TPQ / division;
  let off = 8 + hdrLen;
  const out: ParsedMidi = { tracks: [], tempos: [], times: [], keys: [] };
  for (let t = 0; t < ntracks && off < bytes.length; t++) {
    if (str(off, 4) !== 'MTrk') break;
    const len = dv.getUint32(off + 4);
    let p = off + 8;
    const end = p + len;
    off = end;
    let tick = 0;
    let running = 0;
    const open = new Map<number, MNote[]>();
    const byChannel = new Map<number, MTrack>();
    let name = '';
    const vlq = () => {
      let v = 0;
      let b: number;
      do {
        b = bytes[p++];
        v = (v << 7) | (b & 0x7f);
      } while (b & 0x80 && p < end);
      return v;
    };
    const track = (ch: number) => {
      let tr = byChannel.get(ch);
      if (!tr) byChannel.set(ch, (tr = { name: '', notes: [], program: 0 }));
      return tr;
    };
    while (p < end) {
      tick += vlq();
      let status = bytes[p];
      if (status & 0x80) p++;
      else status = running;
      if (status === 0xff) {
        const type = bytes[p++];
        const l = vlq();
        const data = bytes.slice(p, p + l);
        p += l;
        const at = Math.round(tick * scale);
        if (type === 0x51 && l === 3) out.tempos.push({ tick: at, qpm: 60_000_000 / ((data[0] << 16) | (data[1] << 8) | data[2]) });
        else if (type === 0x58) out.times.push({ tick: at, num: data[0], den: 2 ** data[1] });
        else if (type === 0x59) out.keys.push({ tick: at, fifths: (data[0] << 24) >> 24 });
        else if (type === 0x03) name = new TextDecoder().decode(data).trim();
        continue;
      }
      if (status === 0xf0 || status === 0xf7) {
        p += vlq();
        continue;
      }
      running = status;
      const kind = status & 0xf0;
      const ch = status & 0x0f;
      const a = bytes[p++];
      const b = kind === 0xc0 || kind === 0xd0 ? 0 : bytes[p++];
      const at = Math.round(tick * scale);
      if (kind === 0x90 && b > 0) {
        const n: MNote = { start: at, end: at, midi: a, vel: b / 127, channel: ch };
        const key = ch * 128 + a;
        open.set(key, [...(open.get(key) ?? []), n]);
        track(ch).notes.push(n);
      } else if (kind === 0x80 || (kind === 0x90 && b === 0)) {
        const key = ch * 128 + a;
        const list = open.get(key);
        const n = list?.shift();
        if (n) n.end = at;
      } else if (kind === 0xc0) track(ch).program = a;
    }
    for (const [, tr] of byChannel) {
      if (!tr.notes.length) continue;
      tr.name = name;
      for (const n of tr.notes) if (n.end <= n.start) n.end = n.start + TPQ / 2;
      out.tracks.push(tr);
    }
    if (t === 0 && name && !out.title) out.title = name;
  }
  out.tracks = out.tracks.filter((t) => t.notes.length && t.notes[0].channel !== 9);
  return out;
}

function quantise(t: number): number {
  const a = Math.round(t / 24) * 24; // 16ths
  const b = Math.round(t / 32) * 32; // 8th triplets
  return Math.abs(b - t) < Math.abs(a - t) - 4 ? b : a;
}

function instrumentFor(program: number): InstrumentId {
  if (program < 8) return 'piano';
  if (program < 16) return 'musicbox';
  if (program < 24) return 'organ';
  if (program < 32) return 'guitar';
  if (program < 40) return 'bass';
  if (program < 56) return 'strings';
  if (program < 64) return 'voice';
  if (program >= 72 && program < 80) return 'flute';
  return 'piano';
}

export function midiToScore(bytes: Uint8Array, fileName = 'Imported MIDI'): Score {
  const pm = parseMidiFile(bytes);
  if (!pm.tracks.length) throw new Error('This MIDI file has no notes.');
  const time: [number, number] = pm.times[0] ? [pm.times[0].num, pm.times[0].den] : [4, 4];
  const key = pm.keys[0]?.fifths ?? 0;
  const tempo = Math.round(pm.tempos[0]?.qpm ?? 120);
  const mLen = measureTicks(time);

  for (const tr of pm.tracks)
    for (const n of tr.notes) {
      n.start = quantise(n.start);
      n.end = Math.max(n.start + 24, quantise(n.end));
    }
  // drop leading silence to the start of its measure
  const first = Math.min(...pm.tracks.flatMap((t) => t.notes.map((n) => n.start)));
  const shift = Math.floor(first / mLen) * mLen;
  const lastEnd = Math.max(...pm.tracks.flatMap((t) => t.notes.map((n) => n.end))) - shift;
  const nMeasures = Math.max(1, Math.ceil(lastEnd / mLen));

  const parts: Part[] = [];
  const staffNotes: MNote[][] = [];
  for (const tr of pm.tracks) {
    const notes = tr.notes.map((n) => ({ ...n, start: n.start - shift, end: n.end - shift }));
    const pitchesSorted = notes.map((n) => n.midi).sort((a, b) => a - b);
    const range = pitchesSorted[pitchesSorted.length - 1] - pitchesSorted[0];
    const lows = notes.filter((n) => n.midi < 57).length;
    const highs = notes.filter((n) => n.midi > 64).length;
    const twoStaves = (tr.program < 8 && range >= 19) || (lows > notes.length * 0.12 && highs > notes.length * 0.12);
    const name = tr.name || (tr.program < 8 ? 'Piano' : `Track ${parts.length + 1}`);
    if (twoStaves) {
      parts.push({ id: newId('p'), name, staves: [{ clef: 'treble' }, { clef: 'bass' }], instrument: instrumentFor(tr.program), volume: 0 });
      const [rh, lh] = splitHands(notes, mLen);
      staffNotes.push(rh, lh);
    } else {
      const sorted = notes.map((n) => n.midi).sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      const clef: Clef = median < 57 ? 'bass' : 'treble';
      parts.push({ id: newId('p'), name, staves: [{ clef }], instrument: instrumentFor(tr.program), volume: 0 });
      staffNotes.push(notes);
    }
  }

  const measures: Measure[] = [];
  for (let mi = 0; mi < nMeasures; mi++) {
    const m0 = mi * mLen;
    const m1 = m0 + mLen;
    const staves: StaffMeasure[] = staffNotes.map((notes) => ({ voices: [buildVoice(notes, m0, m1, key)] }));
    const m: Measure = { staves };
    const tch = pm.tempos.find((t, i) => i > 0 && t.tick - shift >= m0 && t.tick - shift < m1);
    if (tch) m.tempo = Math.round(tch.qpm);
    measures.push(m);
  }
  const score: Score = {
    id: newId('s'),
    title: pm.title && !/^(track|untitled)/i.test(pm.title) ? pm.title : fileName.replace(/\.(mid|midi)$/i, ''),
    tempo,
    time,
    key,
    parts,
    measures,
    created: Date.now(),
    updated: Date.now(),
  };
  fitScore(score);
  return score;
}

/** Split a piano track into right/left hand: clear cases by register, the middle by per-measure 2-means. */
function splitHands(notes: MNote[], mLen: number): [MNote[], MNote[]] {
  const rh: MNote[] = [];
  const lh: MNote[] = [];
  const sorted = notes.map((n) => n.midi).sort((a, b) => a - b);
  let gLo = sorted[Math.floor(sorted.length * 0.2)];
  let gHi = sorted[Math.floor(sorted.length * 0.8)];
  if (gHi - gLo < 7) {
    gLo -= 6;
    gHi += 6;
  }
  const byMeasure = new Map<number, MNote[]>();
  for (const n of notes) {
    const k = Math.floor(n.start / mLen);
    byMeasure.set(k, [...(byMeasure.get(k) ?? []), n]);
  }
  for (const [, ms] of byMeasure) {
    let lo = gLo;
    let hi = gHi;
    for (let it = 0; it < 6; it++) {
      const a = ms.filter((n) => Math.abs(n.midi - lo) <= Math.abs(n.midi - hi));
      const b = ms.filter((n) => Math.abs(n.midi - lo) > Math.abs(n.midi - hi));
      if (a.length) lo = a.reduce((x, n) => x + n.midi, 0) / a.length;
      if (b.length) hi = b.reduce((x, n) => x + n.midi, 0) / b.length;
      if (!a.length || !b.length) break;
    }
    const split = hi - lo >= 5 ? (lo + hi) / 2 : 60;
    for (const n of ms) {
      if (n.midi < 53) lh.push(n);
      else if (n.midi > 69) rh.push(n);
      else (n.midi >= split ? rh : lh).push(n);
    }
  }
  return [rh, lh];
}

function buildVoice(notes: MNote[], m0: number, m1: number, key: number): NoteEvent[] {
  const inM = notes.filter((n) => n.start < m1 && n.end > m0);
  if (!inM.length) return [fullRest()];
  const bounds = new Set<number>([m0, m1]);
  for (const n of inM) {
    bounds.add(Math.max(m0, n.start));
    bounds.add(Math.min(m1, n.end));
  }
  const b = [...bounds].sort((x, y) => x - y);
  const out: NoteEvent[] = [];
  for (let i = 0; i < b.length - 1; i++) {
    const s = b[i];
    const e = b[i + 1];
    if (e <= s) continue;
    const sounding = inM.filter((n) => n.start <= s && n.end >= e);
    const uniq = [...new Map(sounding.map((n) => [n.midi, n])).values()].sort((x, y) => x.midi - y.midi);
    if (!uniq.length) {
      out.push(...eventsForTicks(e - s, null));
      continue;
    }
    const pitches = uniq.map((n) => ({ ...spellMidi(n.midi, key), ...(n.end > e ? { tie: true } : {}) }));
    out.push(...eventsForTicks(e - s, pitches));
  }
  return out;
}
