import { fitScore, fullRest, measureLengths } from '../model/fix';
import { parseVoice } from '../model/tokens';
import { ottavaSemitones, staffEvents } from '../model/spans';
import { Clef, InstrumentId, Measure, Navigation, NoteEvent, Part, Score, newId } from '../model/types';
import { PageMeasure, PageTranscription } from './schema';

export interface ConvertResult {
  score: Score;
  warnings: string[];
  /** measure indices whose rhythm had to be repaired */
  repaired: number[];
}

function parseTime(s: string | undefined): [number, number] | undefined {
  const m = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(s ?? '');
  if (!m) return undefined;
  const n = parseInt(m[1], 10);
  const d = parseInt(m[2], 10);
  if (!n || ![1, 2, 4, 8, 16, 32].includes(d)) return undefined;
  return [n, d];
}

export function guessInstrument(name: string): InstrumentId {
  const n = name.toLowerCase();
  if (/voice|vocal|sopran|alto|tenor|bari|melody|sing|chorus|choir/.test(n)) return 'voice';
  if (/flute|recorder|piccolo/.test(n)) return 'flute';
  if (/violin|viola|cello|string/.test(n)) return 'strings';
  if (/organ/.test(n)) return 'organ';
  if (/guitar/.test(n)) return 'guitar';
  if (/bass/.test(n) && !/piano/.test(n)) return 'bass';
  return 'piano';
}

const CLEFS: Clef[] = ['treble', 'bass', 'alto', 'tenor', 'treble8vb'];

/** Map each staff of `page` onto the reference staff list (by clef, aligned to give the most matches). */
function alignStaves(ref: Clef[], page: Clef[]): number[] {
  if (ref.length === page.length) return page.map((_, i) => i);
  if (page.length > ref.length) return page.map((_, i) => (i < ref.length ? i : -1));
  let bestOff = 0;
  let best = -1;
  for (let off = 0; off <= ref.length - page.length; off++) {
    let score = 0;
    page.forEach((c, i) => (score += c === ref[off + i] ? 1 : 0));
    // prefer aligning to the bottom (missing vocal staff is the common case)
    if (score > best || (score === best && off > bestOff)) {
      best = score;
      bestOff = off;
    }
  }
  return page.map((_, i) => bestOff + i);
}

/** Order pages by printed page numbers when every page has a distinct one. */
export function orderPages(pages: PageTranscription[]): PageTranscription[] {
  const nums = pages.map((p) => p.pageNumber);
  if (nums.every((n) => n > 0) && new Set(nums).size === nums.length) return [...pages].sort((a, b) => a.pageNumber - b.pageNumber);
  return pages;
}

export function convertPages(pagesIn: PageTranscription[], opts: { reorder?: boolean } = {}): ConvertResult {
  const pages = opts.reorder === false ? pagesIn : orderPages(pagesIn);
  const warnings: string[] = [];
  const refPage = pages.reduce((a, b) => (b.parts.reduce((x, p) => x + p.clefs.length, 0) > a.parts.reduce((x, p) => x + p.clefs.length, 0) ? b : a), pages[0]);
  const parts: Part[] = refPage.parts.map((p) => ({
    id: newId('p'),
    name: p.name || 'Part',
    staves: (p.clefs.length ? p.clefs : ['treble']).map((c) => ({ clef: (CLEFS.includes(c as Clef) ? c : 'treble') as Clef })),
    instrument: guessInstrument(p.name),
    volume: 0,
  }));
  if (!parts.length) parts.push({ id: newId('p'), name: 'Piano', staves: [{ clef: 'treble' }, { clef: 'bass' }], instrument: 'piano', volume: 0 });
  const refClefs = parts.flatMap((p) => p.staves.map((s) => s.clef));
  const first = pages[0];
  const withMeta = pages.find((p) => p.title) ?? first;
  const score: Score = {
    id: newId('s'),
    title: withMeta.title || 'Untitled',
    subtitle: withMeta.subtitle?.trim() || pages.find((p) => p.subtitle?.trim())?.subtitle?.trim() || undefined,
    composer: withMeta.composer || undefined,
    lyricist: withMeta.lyricist || undefined,
    arranger: withMeta.arranger || undefined,
    tempo: pages.find((p) => p.tempo > 0)?.tempo || 100,
    time: parseTime(first.timeSignature) ?? [4, 4],
    key: Math.max(-7, Math.min(7, first.keyFifths | 0)),
    parts,
    measures: [],
    created: Date.now(),
    updated: Date.now(),
    notes: [],
  };

  let curTime = score.time.join('/');
  let curKey = score.key;
  const pageStarts: number[] = [];
  pages.forEach((page, pi) => {
    pageStarts.push(score.measures.length);
    const pageClefs = page.parts.flatMap((p) => p.clefs as Clef[]);
    const map = alignStaves(refClefs, pageClefs.length ? pageClefs : refClefs);
    // implicit time/key change at page start
    const pt = parseTime(page.timeSignature);
    page.measures.forEach((pm, mi) => {
      const m = convertMeasure(pm, map, refClefs.length, warnings, pi, mi);
      if (mi === 0 && pi > 0) {
        if (pt && pt.join('/') !== curTime && !m.time) m.time = pt;
        if (page.keyFifths !== curKey && m.key === undefined && Number.isFinite(page.keyFifths)) m.key = page.keyFifths;
      }
      if (score.measures.length === 0) {
        if (m.time) {
          score.time = m.time;
          delete m.time;
        }
        if (m.key !== undefined) {
          score.key = m.key;
          delete m.key;
        }
        if (m.tempo) {
          score.tempo = m.tempo;
          delete m.tempo;
        }
        curTime = score.time.join('/');
        curKey = score.key;
      }
      if (m.time) curTime = m.time.join('/');
      if (m.key !== undefined) curKey = m.key;
      // a page's first measure of a later page shouldn't be marked pickup
      if (m.pickup && score.measures.length > 0) delete m.pickup;
      score.measures.push(m);
    });
    for (const u of page.uncertain ?? []) score.notes!.push(pages.length > 1 ? `Page ${pi + 1}: ${u}` : u);
  });
  if (!score.measures.length) score.measures.push({ staves: refClefs.map(() => ({ voices: [[fullRest()]] })) });
  applyOctaveLines(score, pageStarts);
  const repaired = fitScore(score);
  return { score, warnings, repaired };
}

/**
 * Notes under an 8va / 8vb line are transcribed as printed. Here they are moved to where they sound,
 * and the marks are tidied: one start and one end per line. A line still open at the end of a page
 * carries on only if the next page marks it again on its first note; otherwise it ends with the page.
 */
export function applyOctaveLines(score: Score, pageStarts: number[] = [0]): void {
  const lens = measureLengths(score);
  const staffCount = score.parts.reduce((n, p) => n + p.staves.length, 0);
  for (let staff = 0; staff < staffCount; staff++) {
    const notes = staffEvents(score, staff, lens).filter((p) => !p.e.rest && p.e.pitches.length);
    let open: NoteEvent['ottava'];
    let last: NoteEvent | undefined;
    let closed: { e: NoteEvent; value: NoteEvent['ottava'] } | undefined;
    let page = 0;
    for (const { e, measure } of notes) {
      let newPage = false;
      while (page + 1 < pageStarts.length && measure >= pageStarts[page + 1]) {
        page++;
        newPage = true;
      }
      if (open && last && ((newPage && e.ottava !== open) || (e.ottava && e.ottava !== open))) {
        last.ottavaEnd = true;
        open = undefined;
      }
      // a line that ends with one page and starts again with the next is one line
      if (newPage && !open && closed && e.ottava === closed.value) {
        delete closed.e.ottavaEnd;
        delete e.ottava;
        open = closed.value;
      }
      closed = undefined;
      if (e.ottava) {
        if (open) delete e.ottava;
        else open = e.ottava;
      }
      if (open) {
        const octaves = ottavaSemitones(open) / 12;
        for (const p of e.pitches) p.octave += octaves;
        last = e;
      }
      if (e.ottavaEnd) {
        if (!open) delete e.ottavaEnd;
        else closed = { e, value: open };
        open = undefined;
      }
    }
    if (open && last) last.ottavaEnd = true;
  }
}

function convertMeasure(pm: PageMeasure, map: number[], staffCount: number, warnings: string[], page: number, idx: number): Measure {
  const m: Measure = { staves: Array.from({ length: staffCount }, () => ({ voices: [] })) };
  (pm.staves ?? []).forEach((voices, si) => {
    const target = map[si];
    if (target === undefined || target < 0 || target >= staffCount) return;
    for (const vs of voices ?? []) {
      if (!vs || !vs.trim()) continue;
      const r = parseVoice(vs);
      for (const e of r.errors) warnings.push(`Page ${page + 1}, measure ${pm.number || idx + 1}: ${e}`);
      if (r.events.length) m.staves[target].voices.push(r.events);
    }
  });
  for (const st of m.staves) if (!st.voices.length) st.voices.push([fullRest()]);
  if (pm.chords?.length) m.chords = pm.chords.filter((c) => c.symbol?.trim()).map((c) => ({ beat: c.beat > 0 ? c.beat : 1, text: c.symbol.trim() }));
  const t = parseTime(pm.timeSignature);
  if (t) m.time = t;
  if (pm.keyFifths !== '' && pm.keyFifths !== undefined && pm.keyFifths !== null) {
    const k = parseInt(String(pm.keyFifths), 10);
    if (Number.isFinite(k) && k >= -7 && k <= 7) m.key = k;
  }
  if (pm.tempo > 0) m.tempo = pm.tempo;
  if (pm.pickup) m.pickup = true;
  if (pm.repeatStart) m.repeatStart = true;
  if (pm.repeatEnd) m.repeatEnd = 2;
  if (pm.ending) {
    const nums = pm.ending.split(/[,\s.]+/).map((x) => parseInt(x, 10)).filter((x) => x > 0);
    if (nums.length) m.ending = nums;
  }
  if (pm.navigation) m.navigation = pm.navigation as Navigation;
  for (const mk of pm.markers ?? []) {
    if (mk === 'segno') m.segno = true;
    if (mk === 'coda') m.coda = true;
    if (mk === 'fine') m.fine = true;
    if (mk === 'toCoda') m.toCoda = true;
  }
  if (pm.text?.trim()) m.text = pm.text.trim();
  return m;
}
