// ABC notation -> Score (single-voice tunes: notes, chords, rests, ties, slurs, triplets, broken
// rhythms, grace notes, decorations, chord symbols, repeats and 1st/2nd endings, inline K:/M:/L:).
import { measureTicks } from '../model/duration';
import { fitScore, fullRest } from '../model/fix';
import { keyAlter } from '../model/pitch';
import { Articulation, ChordSymbol, Dynamic, DYNAMICS, Measure, NoteEvent, Pitch, Score, Step, newId } from '../model/types';
import { beatOf, eventsForTicks } from './common';

const MAJOR_FIFTHS: Record<string, number> = {
  C: 0, G: 1, D: 2, A: 3, E: 4, B: 5, 'F#': 6, 'C#': 7, F: -1, Bb: -2, Eb: -3, Ab: -4, Db: -5, Gb: -6, Cb: -7,
};
const MODE_SHIFT: [RegExp, number][] = [
  [/^(maj|major|ion)/i, 0], [/^(mix)/i, -1], [/^(dor)/i, -2], [/^(m|min|minor|aeo)/i, -3], [/^(phr)/i, -4], [/^(loc)/i, -5], [/^(lyd)/i, 1],
];

export function parseAbcKey(k: string): number {
  const m = /^\s*([A-G])([#b]?)\s*([A-Za-z]*)/.exec(k.trim());
  if (!m) return 0;
  const tonic = m[1] + m[2];
  let f = MAJOR_FIFTHS[tonic];
  if (f === undefined) {
    // enharmonic fallbacks
    f = { 'D#': -3, 'G#': -4, 'A#': -2 }[tonic] ?? 0;
  }
  const mode = m[3];
  if (mode) for (const [re, s] of MODE_SHIFT) if (re.test(mode)) {
    f += s;
    break;
  }
  if (f > 7) f -= 12;
  if (f < -7) f += 12;
  return f;
}

export const SESSION_METER: Record<string, string> = {
  jig: '6/8', reel: '4/4', 'slip jig': '9/8', hornpipe: '4/4', polka: '2/4', slide: '12/8', waltz: '3/4',
  barndance: '4/4', strathspey: '4/4', 'three-two': '3/2', mazurka: '3/4', march: '4/4',
};

function frac(s: string): [number, number] | null {
  const m = /^\s*(\d+)\s*\/\s*(\d+)/.exec(s);
  if (m) return [parseInt(m[1], 10), parseInt(m[2], 10)];
  if (/^\s*C\|/.test(s)) return [2, 2];
  if (/^\s*C/.test(s)) return [4, 4];
  return null;
}

interface Tok {
  kind: 'note' | 'rest' | 'bar';
  pitches?: Pitch[];
  ticks?: number;
  bar?: string;
  ending?: number[];
  chord?: string;
  grace?: Pitch[];
  artic?: Articulation[];
  dynamic?: Dynamic;
  slurStart?: boolean;
  slurEnd?: boolean;
  tie?: boolean;
  triplet?: boolean;
  invisible?: boolean;
}

export function parseAbc(abc: string, defaults: { title?: string; meter?: string; key?: string; composer?: string } = {}): Score {
  const lines = abc.replace(/\r/g, '').split('\n');
  const header: Record<string, string> = {};
  const body: string[] = [];
  let inBody = false;
  for (const raw of lines) {
    const line = raw.replace(/%.*$/, '');
    const h = /^([A-Za-z]):\s*(.*)$/.exec(line);
    if (h && (!inBody || 'KMLQTPw'.includes(h[1]))) {
      const [, f, v] = h;
      if (f === 'w' || f === 'W') continue;
      if (inBody) body.push(`[${f}:${v}]`);
      else header[f] = header[f] && f === 'T' ? header[f] : v.trim();
      if (f === 'K') inBody = true;
      continue;
    }
    if (line.trim()) {
      inBody = true;
      body.push(line);
    }
  }
  const meterStr = header.M ?? defaults.meter ?? '4/4';
  let time: [number, number] = (frac(meterStr) ?? [4, 4]) as [number, number];
  const lStr = header.L;
  let unit = lStr ? frac(lStr) ?? [1, 8] : time[0] / time[1] < 0.75 ? [1, 16] : [1, 8];
  let key = parseAbcKey(header.K ?? defaults.key ?? 'C');
  let tempo = 100;
  if (header.Q) {
    const q = /(\d+)\s*\/\s*(\d+)\s*=\s*(\d+)/.exec(header.Q) ?? /=?\s*(\d+)\s*$/.exec(header.Q);
    if (q && q.length === 4) tempo = Math.round(((parseInt(q[3], 10) * parseInt(q[1], 10)) / parseInt(q[2], 10)) * 4);
    else if (q) tempo = parseInt(q[1], 10);
  } else {
    // sensible default speeds for dance tunes
    tempo = time[1] === 8 ? 180 : time[0] === 2 ? 110 : 160;
  }

  const src = body.join('\n');
  const toks: Tok[] = [];
  let i = 0;
  let pendingChord: string | undefined;
  let pendingArtic: Articulation[] = [];
  let pendingDyn: Dynamic | undefined;
  let pendingSlur = false;
  let pendingGrace: Pitch[] | undefined;
  let tuplet = 0;
  let tupletRatio = 1;
  let broken = 0; // multiplier for the next note
  const unitTicks = () => (384 * unit[0]) / unit[1];

  const readPitch = (): Pitch | null => {
    let alter: number | null = null;
    while (src[i] === '^' || src[i] === '_' || src[i] === '=') {
      const c = src[i++];
      alter = (alter ?? 0) + (c === '^' ? 1 : c === '_' ? -1 : 0);
      if (c === '=') alter = 0;
    }
    const c = src[i];
    if (!c || !/[A-Ga-g]/.test(c)) return null;
    i++;
    const step = c.toUpperCase() as Step;
    let octave = c === c.toUpperCase() ? 4 : 5;
    while (src[i] === "'" || src[i] === ',') octave += src[i++] === "'" ? 1 : -1;
    return { step, alter: alter === null ? NaN : alter, octave };
  };
  const readLen = (): number => {
    let num = 1;
    let den = 1;
    const m = /^(\d*)(\/*)(\d*)/.exec(src.slice(i))!;
    i += m[0].length;
    if (m[1]) num = parseInt(m[1], 10);
    if (m[2]) den = m[3] ? parseInt(m[3], 10) : 2 ** m[2].length;
    return num / den;
  };
  const pushNote = (t: Tok, len: number) => {
    let mult = len;
    if (broken) {
      mult *= broken;
      broken = 0;
    }
    if (tuplet > 0) {
      mult *= tupletRatio;
      t.triplet = tupletRatio === 2 / 3;
      tuplet--;
    }
    t.ticks = Math.round(unitTicks() * mult);
    if (pendingChord) t.chord = pendingChord;
    if (pendingArtic.length) t.artic = pendingArtic;
    if (pendingDyn) t.dynamic = pendingDyn;
    if (pendingSlur) t.slurStart = true;
    if (pendingGrace) t.grace = pendingGrace;
    pendingChord = undefined;
    pendingArtic = [];
    pendingDyn = undefined;
    pendingSlur = false;
    pendingGrace = undefined;
    toks.push(t);
  };

  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '`') {
      i++;
      continue;
    }
    if (c === '"') {
      const j = src.indexOf('"', i + 1);
      const text = src.slice(i + 1, j < 0 ? src.length : j);
      i = j < 0 ? src.length : j + 1;
      if (!/^[\^_<>@]/.test(text) && /^[A-G]/.test(text)) pendingChord = text.replace(/\(.*\)$/, '').trim();
      continue;
    }
    if (c === '!' || c === '+') {
      const m = new RegExp(`^\\${c}([^!+\\s]{1,20})\\${c}`).exec(src.slice(i));
      if (m) {
        const d = m[1];
        if ((DYNAMICS as readonly string[]).includes(d)) pendingDyn = d as Dynamic;
        else if (/^(accent|>|emphasis)$/.test(d)) pendingArtic.push('accent');
        else if (d === 'staccato') pendingArtic.push('staccato');
        else if (d === 'tenuto') pendingArtic.push('tenuto');
        else if (d === 'fermata') pendingArtic.push('fermata');
        i += m[0].length;
      } else i++; // line break marker
      continue;
    }
    if (c === '.') {
      pendingArtic.push('staccato');
      i++;
      continue;
    }
    if (c === '~' || /[HLMOPSTuv]/.test(c)) {
      if (c === 'H') pendingArtic.push('fermata');
      if (c === 'L') pendingArtic.push('accent');
      i++;
      continue;
    }
    if (c === '{') {
      const j = src.indexOf('}', i);
      const inner = src.slice(i + 1, j < 0 ? src.length : j);
      const g: Pitch[] = [];
      const save = i;
      void save;
      const re = /([_^=]*)([A-Ga-g])([',]*)/g;
      let mm: RegExpExecArray | null;
      while ((mm = re.exec(inner))) {
        const acc = mm[1];
        const step = mm[2].toUpperCase() as Step;
        let octave = mm[2] === step ? 4 : 5;
        for (const o of mm[3]) octave += o === "'" ? 1 : -1;
        const alter = acc ? [...acc].reduce((a, ch) => (ch === '^' ? a + 1 : ch === '_' ? a - 1 : 0), 0) : NaN;
        g.push({ step, alter, octave });
      }
      if (g.length) pendingGrace = g;
      i = j < 0 ? src.length : j + 1;
      continue;
    }
    if (c === '(') {
      const m = /^\((\d)(?::(\d)?(?::(\d))?)?/.exec(src.slice(i));
      if (m) {
        const p = parseInt(m[1], 10);
        const q = m[2] ? parseInt(m[2], 10) : p === 3 || p === 6 ? 2 : p === 2 || p === 4 || p === 8 ? 3 : time[1] === 8 && time[0] % 3 === 0 ? 3 : 2;
        tuplet = m[3] ? parseInt(m[3], 10) : p;
        tupletRatio = q / p;
        i += m[0].length;
      } else {
        pendingSlur = true;
        i++;
      }
      continue;
    }
    if (c === ')') {
      for (let k = toks.length - 1; k >= 0; k--) if (toks[k].kind === 'note') {
        toks[k].slurEnd = true;
        break;
      }
      i++;
      continue;
    }
    if (c === '-') {
      for (let k = toks.length - 1; k >= 0; k--) if (toks[k].kind === 'note') {
        toks[k].tie = true;
        break;
      }
      i++;
      continue;
    }
    if (c === '>' || c === '<') {
      let n = 0;
      while (src[i] === c) {
        n++;
        i++;
      }
      const prev = [...toks].reverse().find((t) => t.kind !== 'bar');
      const big = 2 - 1 / 2 ** n;
      const small = 1 / 2 ** n;
      if (prev?.ticks) prev.ticks = Math.round((prev.ticks * (c === '>' ? big : small)));
      broken = c === '>' ? small : big;
      continue;
    }
    // inline field or chord or ending
    if (c === '[') {
      const field = /^\[([KMLQ]):([^\]]*)\]/.exec(src.slice(i));
      if (field) {
        const [, f, v] = field;
        if (f === 'K') toks.push({ kind: 'bar', bar: `K:${v}` });
        if (f === 'M') toks.push({ kind: 'bar', bar: `M:${v}` });
        if (f === 'L') unit = frac(v) ?? unit;
        i += field[0].length;
        continue;
      }
      const end = /^\[(\d[\d,-]*)/.exec(src.slice(i));
      if (end) {
        toks.push({ kind: 'bar', bar: '', ending: parseEnding(end[1]) });
        i += end[0].length;
        continue;
      }
      if (src[i + 1] === '|') {
        toks.push({ kind: 'bar', bar: '[|' });
        i += 2;
        continue;
      }
      // chord
      i++;
      const pitches: Pitch[] = [];
      let innerLen = 1;
      while (i < src.length && src[i] !== ']') {
        const p = readPitch();
        if (!p) {
          i++;
          continue;
        }
        innerLen = readLen();
        if (src[i] === '-') {
          p.tie = true;
          i++;
        }
        pitches.push(p);
      }
      i++;
      const len = readLen() * innerLen;
      const t: Tok = { kind: 'note', pitches };
      if (src[i] === '-') {
        t.tie = true;
        i++;
      }
      if (pitches.length) pushNote(t, len);
      continue;
    }
    if (c === '|' || c === ':') {
      const m = /^(:*\|*\]?\|*:*)([\d][\d,-]*)?/.exec(src.slice(i))!;
      const bar = m[1] || c;
      i += m[0].length || 1;
      toks.push({ kind: 'bar', bar, ending: m[2] ? parseEnding(m[2]) : undefined });
      continue;
    }
    if (c === ']') {
      i++;
      continue;
    }
    if (c === 'z' || c === 'x') {
      i++;
      const len = readLen();
      pushNote({ kind: 'rest', invisible: c === 'x' }, len);
      continue;
    }
    if (c === 'Z' || c === 'X') {
      i++;
      const n = /^\d+/.exec(src.slice(i));
      const count = n ? parseInt(n[0], 10) : 1;
      if (n) i += n[0].length;
      for (let k = 0; k < count; k++) {
        toks.push({ kind: 'rest', ticks: measureTicks(time) });
        if (k < count - 1) toks.push({ kind: 'bar', bar: '|' });
      }
      continue;
    }
    const p = readPitch();
    if (p) {
      const len = readLen();
      const t: Tok = { kind: 'note', pitches: [p] };
      if (src[i] === '-') {
        t.tie = true;
        i++;
      }
      pushNote(t, len);
      continue;
    }
    i++; // unknown character
  }

  // ---- group into measures ----
  const measures: Measure[] = [];
  let cur: { toks: Tok[]; repeatStart?: boolean; ending?: number[]; key?: number; time?: [number, number] } = { toks: [] };
  let openEnding: number[] | undefined;
  const closeMeasure = (bar: string) => {
    const hasNotes = cur.toks.some((t) => t.kind !== 'bar');
    if (!hasNotes) return false;
    const m = buildMeasure(cur.toks, time, key);
    if (cur.repeatStart) m.repeatStart = true;
    if (cur.ending) m.ending = cur.ending;
    if (cur.key !== undefined) m.key = cur.key;
    if (cur.time) m.time = cur.time;
    if (/^:/.test(bar)) m.repeatEnd = 2;
    measures.push(m);
    return true;
  };
  for (const t of toks) {
    if (t.kind !== 'bar') {
      cur.toks.push(t);
      continue;
    }
    const bar = t.bar ?? '';
    if (bar.startsWith('K:')) {
      key = parseAbcKey(bar.slice(2));
      cur.key = key;
      continue;
    }
    if (bar.startsWith('M:')) {
      const f = frac(bar.slice(2));
      if (f) {
        time = f;
        cur.time = f;
      }
      continue;
    }
    const closed = closeMeasure(bar);
    const terminates = bar.startsWith(':') || bar.endsWith(':') || /\|\||\|\]|\[\|/.test(bar);
    if (closed) {
      if (terminates) openEnding = undefined;
      cur = { toks: [] };
    } else if (/^:/.test(bar) && measures.length) {
      measures[measures.length - 1].repeatEnd = 2;
      openEnding = undefined;
    }
    if (/:$/.test(bar)) cur.repeatStart = true;
    if (t.ending) openEnding = t.ending;
    if (openEnding) cur.ending = openEnding;
  }
  closeMeasure('|');
  if (!measures.length) measures.push({ staves: [{ voices: [[fullRest()]] }] });

  // incomplete measures (the pickup, and the halves of measures split by a repeat sign) stay short
  {
    let t = (frac(meterStr) ?? [4, 4]) as [number, number];
    measures.forEach((m) => {
      if (m.time) t = m.time;
      const len = measureLen(m);
      if (len > 0 && len < measureTicks(t)) m.pickup = true;
    });
  }

  const score: Score = {
    id: newId('s'),
    title: header.T || defaults.title || 'Untitled tune',
    composer: header.C || defaults.composer,
    tempo,
    time: (frac(meterStr) ?? [4, 4]) as [number, number],
    key: parseAbcKey(header.K ?? defaults.key ?? 'C'),
    parts: [{ id: newId('p'), name: 'Melody', staves: [{ clef: 'treble' }], instrument: 'piano', volume: 0 }],
    measures,
    created: Date.now(),
    updated: Date.now(),
  };
  fitScore(score);
  return score;
}

function parseEnding(s: string): number[] {
  const out: number[] = [];
  for (const part of s.split(',')) {
    const r = /^(\d+)-(\d+)$/.exec(part);
    if (r) for (let k = +r[1]; k <= +r[2]; k++) out.push(k);
    else if (+part) out.push(+part);
  }
  return out;
}

function measureLen(m: Measure): number {
  let t = 0;
  for (const e of m.staves[0].voices[0]) {
    if (e.grace) continue;
    const base = { w: 384, h: 192, q: 96, '8': 48, '16': 24, '32': 12, '64': 6 }[e.dur];
    let x = base;
    let add = base;
    for (let d = 0; d < e.dots; d++) {
      add /= 2;
      x += add;
    }
    t += e.triplet ? (x * 2) / 3 : x;
  }
  return Math.round(t);
}

function buildMeasure(toks: Tok[], time: [number, number], key: number): Measure {
  const events: NoteEvent[] = [];
  const chords: ChordSymbol[] = [];
  const acc = new Map<string, number>();
  let tick = 0;
  const resolve = (p: Pitch): Pitch => {
    const k = `${p.step}${p.octave}`;
    let alter = p.alter;
    if (Number.isNaN(alter)) alter = acc.has(k) ? acc.get(k)! : keyAlter(key, p.step);
    else acc.set(k, alter);
    return { step: p.step, alter, octave: p.octave, ...(p.tie ? { tie: true } : {}) };
  };
  for (const t of toks) {
    if (t.chord) chords.push({ beat: beatOf(tick, time[1]), text: t.chord });
    if (t.grace) events.push({ id: newId(), pitches: t.grace.map(resolve), dur: '16', dots: 0, grace: true });
    const ticks = t.ticks ?? 48;
    if (t.kind === 'rest') {
      events.push(...eventsForTicks(ticks, null));
    } else {
      const pitches = (t.pitches ?? []).map(resolve).map((p) => ({ ...p, ...(t.tie ? { tie: true } : {}) }));
      const base: Partial<NoteEvent> = {};
      if (t.artic?.length) base.artic = t.artic;
      if (t.dynamic) base.dynamic = t.dynamic;
      if (t.slurStart) base.slurStart = true;
      if (t.slurEnd) base.slurEnd = true;
      const evs = eventsForTicks(ticks, pitches, base);
      if (evs.length === 1 && t.triplet && !evs[0].triplet) {
        // keep as plain value
      }
      events.push(...evs);
    }
    tick += ticks;
  }
  const m: Measure = { staves: [{ voices: [events.length ? events : [fullRest()]] }] };
  if (chords.length) m.chords = chords;
  return m;
}
