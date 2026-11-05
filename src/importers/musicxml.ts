// MusicXML (partwise) -> Score. Handles the common subset: multiple parts & staves, voices, chords,
// ties, slurs, tuplets (3:2), articulations, dynamics, lyrics, chord symbols, key/time/tempo changes,
// repeats, voltas and D.C./D.S./Fine/Coda.
import { unzipSync, strFromU8 } from 'fflate';
import { fitScore, fullRest } from '../model/fix';
import { TPQ } from '../model/duration';
import { guessInstrument } from '../omr/convert';
import { Articulation, Clef, DurType, Dynamic, DYNAMICS, Measure, Navigation, NoteEvent, Part, Pitch, Score, Step, newId } from '../model/types';
import { beatOf, chordSymbolFromKind, eventsForTicks } from './common';

const TYPE_MAP: Record<string, DurType> = {
  whole: 'w', half: 'h', quarter: 'q', eighth: '8', '16th': '16', '32nd': '32', '64th': '64', breve: 'w', '128th': '64',
};

/** Read .mxl (compressed) or plain MusicXML bytes. */
export function musicXmlText(bytes: Uint8Array): string {
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    const files = unzipSync(bytes);
    const container = files['META-INF/container.xml'];
    let path: string | undefined;
    if (container) {
      const m = /full-path="([^"]+)"/.exec(strFromU8(container));
      if (m) path = m[1];
    }
    if (!path) path = Object.keys(files).find((f) => /\.(xml|musicxml)$/i.test(f) && !f.startsWith('META-INF'));
    if (!path || !files[path]) throw new Error('No MusicXML file inside this .mxl archive.');
    return strFromU8(files[path]);
  }
  return new TextDecoder().decode(bytes);
}

const kids = (el: Element | null | undefined, name?: string): Element[] =>
  el ? (Array.from(el.children) as Element[]).filter((c) => !name || c.tagName === name) : [];
const kid = (el: Element | null | undefined, name: string): Element | null => kids(el, name)[0] ?? null;
const txt = (el: Element | null | undefined, name: string): string | null => {
  const k = kid(el, name);
  return k ? (k.textContent ?? '').trim() : null;
};
const num = (el: Element | null | undefined, name: string): number | null => {
  const t = txt(el, name);
  if (t === null || t === '') return null;
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : null;
};

interface RawNote {
  start: number; // ticks from measure start
  dur: number; // ticks
  pitch: Pitch | null;
  chord: boolean;
  grace: boolean;
  type?: DurType;
  dots: number;
  triplet: boolean;
  tieStart: boolean;
  slurStart: boolean;
  slurEnd: boolean;
  artic: Articulation[];
  lyric?: string;
  staff: number;
  voice: string;
  dynamic?: Dynamic;
  measureRest: boolean;
}

interface PartMeasure {
  notes: RawNote[];
  length: number;
  measure: Partial<Measure>;
  chords: { beat: number; text: string }[];
  dynamics: { staff: number; tick: number; d: Dynamic }[];
}

export function parseMusicXML(xmlText: string): Score {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  const root = doc.documentElement;
  if (!root || root.tagName === 'parsererror' || doc.getElementsByTagName('parsererror').length) throw new Error('This file is not valid MusicXML.');
  if (root.tagName === 'score-timewise') throw new Error('Timewise MusicXML is not supported – export as partwise MusicXML.');
  if (root.tagName !== 'score-partwise') throw new Error('This file is not a MusicXML score.');

  const title =
    txt(kid(root, 'work'), 'work-title') ||
    txt(root, 'movement-title') ||
    creditText(root, 'title') ||
    'Untitled';
  const ident = kid(root, 'identification');
  const creator = (type: string) => kids(ident, 'creator').find((c) => c.getAttribute('type') === type)?.textContent?.trim() || undefined;

  const partNames = new Map<string, string>();
  for (const sp of kids(kid(root, 'part-list'), 'score-part')) partNames.set(sp.getAttribute('id') ?? '', txt(sp, 'part-name') || txt(sp, 'part-abbreviation') || 'Part');

  const parts: Part[] = [];
  const partMeasures: PartMeasure[][] = [];
  let scoreTime: [number, number] | null = null;
  let scoreKey: number | null = null;
  let scoreTempo: number | null = null;

  for (const partEl of kids(root, 'part')) {
    const id = partEl.getAttribute('id') ?? '';
    let divisions = 1;
    let staves = 1;
    const clefs: Clef[] = ['treble'];
    let clefsSet = false;
    let time: [number, number] = [4, 4];
    const measures: PartMeasure[] = [];
    let mIdx = 0;
    for (const mEl of kids(partEl, 'measure')) {
      const pm: PartMeasure = { notes: [], length: 0, measure: {}, chords: [], dynamics: [] };
      let pos = 0;
      let maxPos = 0;
      let lastStart = 0;
      let pendingDyn: Dynamic | undefined;
      if (mEl.getAttribute('implicit') === 'yes') pm.measure.pickup = true;
      for (const el of kids(mEl)) {
        switch (el.tagName) {
          case 'attributes': {
            const d = num(el, 'divisions');
            if (d) divisions = d;
            const st = num(el, 'staves');
            if (st) staves = st;
            const key = kid(el, 'key');
            if (key && num(key, 'fifths') !== null) {
              const f = Math.max(-7, Math.min(7, num(key, 'fifths')!));
              if (mIdx === 0 && pos === 0) scoreKey ??= f;
              else pm.measure.key = f;
            }
            const t = kid(el, 'time');
            if (t && num(t, 'beats') && num(t, 'beat-type')) {
              const beats = parseInt(txt(t, 'beats')!.split('+').reduce((a, b) => String(+a + +b)), 10);
              time = [beats, num(t, 'beat-type')!];
              if (mIdx === 0) scoreTime ??= time;
              else pm.measure.time = time;
            }
            for (const c of kids(el, 'clef')) {
              const n = parseInt(c.getAttribute('number') ?? '1', 10) - 1;
              if (clefsSet && mIdx > 0) continue; // mid-piece clef changes are not modelled
              clefs[n] = clefFrom(txt(c, 'sign'), num(c, 'line'), num(c, 'clef-octave-change'));
            }
            break;
          }
          case 'backup':
            pos -= ticksOf(num(el, 'duration') ?? 0, divisions);
            if (pos < 0) pos = 0;
            break;
          case 'forward':
            pos += ticksOf(num(el, 'duration') ?? 0, divisions);
            maxPos = Math.max(maxPos, pos);
            break;
          case 'direction': {
            const staff = (num(el, 'staff') ?? 1) - 1;
            const offset = ticksOf(num(el, 'offset') ?? 0, divisions);
            for (const dt of kids(el, 'direction-type')) {
              const dyn = kid(dt, 'dynamics');
              if (dyn) {
                const name = kids(dyn)[0]?.tagName as Dynamic | undefined;
                if (name && (DYNAMICS as readonly string[]).includes(name)) {
                  pm.dynamics.push({ staff, tick: pos + offset, d: name });
                  pendingDyn = name;
                }
              }
              const metro = kid(dt, 'metronome');
              if (metro && num(metro, 'per-minute')) {
                const unit = txt(metro, 'beat-unit') ?? 'quarter';
                const dotted = !!kid(metro, 'beat-unit-dot');
                const factor = ({ half: 2, quarter: 1, eighth: 0.5, whole: 4 }[unit] ?? 1) * (dotted ? 1.5 : 1);
                setTempo(Math.round(num(metro, 'per-minute')! * factor));
              }
              if (kid(dt, 'segno')) pm.measure.segno = true;
              if (kid(dt, 'coda')) pm.measure.coda = true;
              const words = kids(dt, 'words').map((w) => (w.textContent ?? '').trim()).filter(Boolean).join(' ');
              if (words) applyWords(pm.measure, words);
            }
            const snd = kid(el, 'sound');
            if (snd) applySound(snd);
            void pendingDyn;
            break;
          }
          case 'sound':
            applySound(el);
            break;
          case 'harmony': {
            const r = kid(el, 'root');
            const kindEl = kid(el, 'kind');
            if (!r) {
              if (kindEl?.textContent?.trim() === 'none') pm.chords.push({ beat: beatOf(pos, time[1]), text: 'N.C.' });
              break;
            }
            const step = txt(r, 'root-step');
            const alter = num(r, 'root-alter') ?? 0;
            const kind = (kindEl?.textContent ?? 'major').trim();
            const kindText = kindEl?.getAttribute('text');
            let sym = (step ?? 'C') + accStr(alter) + chordSymbolFromKind(kind, kindText ?? null);
            const b = kid(el, 'bass');
            if (b) sym += '/' + (txt(b, 'bass-step') ?? '') + accStr(num(b, 'bass-alter') ?? 0);
            const offset = ticksOf(num(el, 'offset') ?? 0, divisions);
            pm.chords.push({ beat: beatOf(pos + offset, time[1]), text: sym });
            break;
          }
          case 'note': {
            const isChord = !!kid(el, 'chord');
            const grace = !!kid(el, 'grace');
            const durT = grace ? 0 : ticksOf(num(el, 'duration') ?? 0, divisions);
            const start = isChord ? lastStart : pos;
            const restEl = kid(el, 'rest');
            let pitch: Pitch | null = null;
            const pEl = kid(el, 'pitch');
            if (pEl) {
              pitch = { step: (txt(pEl, 'step') ?? 'C') as Step, alter: Math.round(num(pEl, 'alter') ?? 0), octave: num(pEl, 'octave') ?? 4 };
            } else if (!restEl) {
              // unpitched: treat as rest for our purposes
            }
            const notations = kids(el, 'notations');
            const artic: Articulation[] = [];
            let slurStart = false;
            let slurEnd = false;
            let tieStart = kids(el, 'tie').some((t) => t.getAttribute('type') === 'start');
            for (const n of notations) {
              for (const s of kids(n, 'slur')) {
                if (s.getAttribute('type') === 'start') slurStart = true;
                if (s.getAttribute('type') === 'stop') slurEnd = true;
              }
              if (kids(n, 'tied').some((t) => t.getAttribute('type') === 'start')) tieStart = true;
              for (const a of kids(kid(n, 'articulations'))) {
                const m: Record<string, Articulation> = { staccato: 'staccato', staccatissimo: 'staccato', accent: 'accent', tenuto: 'tenuto', 'strong-accent': 'marcato' };
                if (m[a.tagName]) artic.push(m[a.tagName]);
              }
              if (kid(n, 'fermata')) artic.push('fermata');
            }
            const tm = kid(el, 'time-modification');
            const triplet = !!tm && num(tm, 'actual-notes') === 3 && num(tm, 'normal-notes') === 2;
            const lyricEl = kids(el, 'lyric')[0];
            let lyric: string | undefined;
            if (lyricEl) {
              const t = kids(lyricEl, 'text').map((x) => x.textContent ?? '').join('');
              const syl = txt(lyricEl, 'syllabic');
              if (t) lyric = t + (syl === 'begin' || syl === 'middle' ? '-' : '');
            }
            const typeName = txt(el, 'type');
            const raw: RawNote = {
              start,
              dur: durT,
              pitch: restEl ? null : pitch,
              chord: isChord,
              grace,
              type: typeName ? TYPE_MAP[typeName] : undefined,
              dots: kids(el, 'dot').length,
              triplet,
              tieStart,
              slurStart,
              slurEnd,
              artic,
              lyric,
              staff: Math.max(0, (num(el, 'staff') ?? 1) - 1),
              voice: txt(el, 'voice') ?? '1',
              measureRest: restEl?.getAttribute('measure') === 'yes' || (!!restEl && !typeName),
            };
            pm.notes.push(raw);
            if (!isChord) {
              lastStart = pos;
              pos += durT;
            }
            maxPos = Math.max(maxPos, pos);
            break;
          }
          case 'barline': {
            const rep = kid(el, 'repeat');
            if (rep?.getAttribute('direction') === 'forward') pm.measure.repeatStart = true;
            if (rep?.getAttribute('direction') === 'backward') pm.measure.repeatEnd = parseInt(rep.getAttribute('times') ?? '2', 10) || 2;
            const end = kid(el, 'ending');
            if (end && end.getAttribute('type') === 'start') {
              const nums = (end.getAttribute('number') ?? '').split(/[,\s]+/).map((x) => parseInt(x, 10)).filter((x) => x > 0);
              if (nums.length) pm.measure.ending = nums;
            }
            const snd = kid(el, 'sound');
            if (snd) applySound(snd);
            break;
          }
        }
      }
      pm.length = maxPos;
      // carry an open ending forward until it is closed
      measures.push(pm);
      mIdx++;

      function applySound(snd: Element) {
        const tempo = parseFloat(snd.getAttribute('tempo') ?? '');
        if (tempo > 0) setTempo(Math.round(tempo));
        if (snd.getAttribute('fine')) pm.measure.fine = true;
        if (snd.getAttribute('segno')) pm.measure.segno ??= true;
        if (snd.getAttribute('coda')) pm.measure.coda ??= true;
        if (snd.getAttribute('tocoda')) pm.measure.toCoda = true;
        if (snd.getAttribute('dacapo') === 'yes') pm.measure.navigation ??= 'DC';
        if (snd.getAttribute('dalsegno')) pm.measure.navigation ??= 'DS';
      }
      function setTempo(t: number) {
        if (mIdx === 0 && pos === 0 && scoreTempo === null) scoreTempo = t;
        else if (mIdx > 0 || scoreTempo !== null) pm.measure.tempo = t;
        else scoreTempo = t;
      }
    }
    // propagate voltas: MusicXML marks only the start; continue until a stop/discontinue
    propagateEndings(partEl, measures);
    clefsSet = true;
    while (clefs.length < staves) clefs.push(clefs.length === 1 ? 'bass' : 'treble');
    parts.push({
      id: newId('p'),
      name: partNames.get(id) ?? 'Part',
      staves: clefs.slice(0, staves).map((c) => ({ clef: c ?? 'treble' })),
      instrument: guessInstrument(partNames.get(id) ?? ''),
      volume: 0,
    });
    partMeasures.push(measures);
  }
  if (!parts.length) throw new Error('This MusicXML file has no parts.');

  const nMeasures = Math.max(...partMeasures.map((m) => m.length));
  const measures: Measure[] = [];
  for (let mi = 0; mi < nMeasures; mi++) {
    const m: Measure = { staves: [] };
    partMeasures.forEach((pms, pi) => {
      const pm = pms[mi];
      if (pi === 0 && pm) {
        Object.assign(m, pm.measure);
        if (pm.chords.length) m.chords = pm.chords;
      }
      for (let s = 0; s < parts[pi].staves.length; s++) m.staves.push(pm ? buildStaff(pm, s) : { voices: [[fullRest()]] });
    });
    measures.push(m);
  }
  const score: Score = {
    id: newId('s'),
    title,
    subtitle: txt(kid(root, 'work'), 'work-number') || undefined,
    composer: creator('composer') || creditText(root, 'composer'),
    lyricist: creator('lyricist') || creator('poet') || undefined,
    arranger: creator('arranger') || undefined,
    tempo: scoreTempo ?? 100,
    time: scoreTime ?? [4, 4],
    key: scoreKey ?? 0,
    parts,
    measures,
    created: Date.now(),
    updated: Date.now(),
  };
  fitScore(score);
  return score;
}

function propagateEndings(partEl: Element, measures: PartMeasure[]) {
  const mEls = kids(partEl, 'measure');
  let open: number[] | null = null;
  mEls.forEach((mEl, i) => {
    const pm = measures[i];
    if (pm.measure.ending) open = pm.measure.ending;
    else if (open) pm.measure.ending = open;
    for (const b of kids(mEl, 'barline')) {
      const e = kid(b, 'ending');
      const t = e?.getAttribute('type');
      if (t === 'stop' || t === 'discontinue') open = null;
    }
  });
}

function applyWords(m: Partial<Measure>, words: string) {
  const w = words.toLowerCase().replace(/\s+/g, ' ');
  const nav: [RegExp, Navigation][] = [
    [/d\.?\s?c\.? al fine|da capo al fine/, 'DCalFine'],
    [/d\.?\s?c\.? al coda|da capo al coda/, 'DCalCoda'],
    [/d\.?\s?s\.? al fine|dal segno al fine/, 'DSalFine'],
    [/d\.?\s?s\.? al coda|dal segno al coda/, 'DSalCoda'],
    [/^d\.?\s?c\.?$|da capo/, 'DC'],
    [/^d\.?\s?s\.?$|dal segno/, 'DS'],
  ];
  for (const [re, n] of nav)
    if (re.test(w)) {
      m.navigation = n;
      return;
    }
  if (/^fine$/.test(w)) {
    m.fine = true;
    return;
  }
  if (/to coda/.test(w)) {
    m.toCoda = true;
    return;
  }
  m.text = m.text ? `${m.text} ${words}` : words;
}

function accStr(a: number) {
  return a === 1 ? '#' : a === -1 ? 'b' : a === 2 ? '##' : a === -2 ? 'bb' : '';
}

function ticksOf(dur: number, divisions: number): number {
  return Math.round((dur * TPQ) / divisions);
}

function clefFrom(sign: string | null, line: number | null, oct: number | null): Clef {
  if (sign === 'F') return 'bass';
  if (sign === 'C') return line === 4 ? 'tenor' : 'alto';
  if (sign === 'G' && oct === -1) return 'treble8vb';
  return 'treble';
}

function creditText(root: Element, type: string): string | undefined {
  for (const c of kids(root, 'credit')) {
    if (txt(c, 'credit-type') === type) return kids(c, 'credit-words').map((w) => w.textContent ?? '').join(' ').trim() || undefined;
  }
  return undefined;
}

function buildStaff(pm: PartMeasure, staff: number): { voices: NoteEvent[][] } {
  const notes = pm.notes.filter((n) => n.staff === staff);
  const byVoice = new Map<string, RawNote[]>();
  for (const n of notes) {
    const arr = byVoice.get(n.voice) ?? [];
    arr.push(n);
    byVoice.set(n.voice, arr);
  }
  const voiceKeys = [...byVoice.keys()].sort((a, b) => (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0));
  // keep voices that contain notes (up to 4); rest-only voices beyond the first are dropped
  const voices: NoteEvent[][] = [];
  for (const vk of voiceKeys) {
    const list = byVoice.get(vk)!;
    if (voices.length > 0 && list.every((n) => !n.pitch)) continue;
    if (voices.length >= 4) break;
    voices.push(buildVoice(list, pm, staff));
  }
  if (!voices.length) voices.push([fullRest()]);
  return { voices };
}

function buildVoice(list: RawNote[], pm: PartMeasure, staff: number): NoteEvent[] {
  const out: NoteEvent[] = [];
  // group chord notes with their head
  const groups: RawNote[][] = [];
  for (const n of list) {
    if (n.chord && groups.length) groups[groups.length - 1].push(n);
    else groups.push([n]);
  }
  groups.sort((a, b) => a[0].start - b[0].start || (a[0].grace ? -1 : 0) - (b[0].grace ? -1 : 0));
  let pos = 0;
  const dyns = pm.dynamics.filter((d) => d.staff === staff || (staff === 0 && d.staff < 0));
  for (const g of groups) {
    const head = g[0];
    if (head.grace) {
      const pitches = g.map((n) => n.pitch).filter((p): p is Pitch => !!p);
      if (pitches.length) out.push({ id: newId(), pitches, dur: head.type === 'q' ? '8' : head.type ?? '16', dots: 0, grace: true });
      continue;
    }
    if (head.start > pos) out.push(...eventsForTicks(head.start - pos, null));
    if (head.start < pos) {
      // overlapping note in the same voice – skip it
      continue;
    }
    const pitches: Pitch[] = g.filter((n) => n.pitch).map((n) => ({ ...n.pitch!, ...(n.tieStart ? { tie: true } : {}) }));
    pitches.sort((a, b) => pitchVal(a) - pitchVal(b));
    const base: Partial<NoteEvent> = {};
    if (head.slurStart) base.slurStart = true;
    if (head.slurEnd) base.slurEnd = true;
    const artic = [...new Set(g.flatMap((n) => n.artic))];
    if (artic.length) base.artic = artic;
    const lyric = g.find((n) => n.lyric)?.lyric;
    if (lyric) base.lyric = lyric;
    const dyn = dyns.find((d) => d.tick >= pos && d.tick <= head.start);
    if (dyn && pitches.length) base.dynamic = dyn.d;
    if (head.measureRest && !pitches.length) {
      out.push(fullRest());
      pos = head.start + head.dur;
      continue;
    }
    let evs: NoteEvent[];
    if (head.type && ticksMatch(head)) {
      evs = [{ ...base, id: newId(), pitches, dur: head.type, dots: head.dots, ...(head.triplet ? { triplet: true } : {}), ...(pitches.length ? {} : { rest: true }) }];
    } else {
      evs = eventsForTicks(head.dur, pitches.length ? pitches : null, base);
      if (!pitches.length) evs.forEach((e) => (e.rest = true));
    }
    out.push(...evs);
    pos = head.start + head.dur;
  }
  return out;
}

function ticksMatch(n: RawNote): boolean {
  if (!n.type) return false;
  const base = { w: 384, h: 192, q: 96, '8': 48, '16': 24, '32': 12, '64': 6 }[n.type];
  let t = base;
  let add = base;
  for (let i = 0; i < n.dots; i++) {
    add /= 2;
    t += add;
  }
  if (n.triplet) t = Math.round((t * 2) / 3);
  return Math.abs(t - n.dur) <= 1;
}

function pitchVal(p: Pitch) {
  return p.octave * 12 + { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[p.step] + p.alter;
}
