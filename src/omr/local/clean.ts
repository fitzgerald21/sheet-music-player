/**
 * Tidies what the on-device reader returns for one photo before it is imported.
 *
 * A photo of a book usually shows a sliver of the facing page and some print showing through
 * the paper. The reader turns those into an extra part or a few nearly empty measures, and the
 * extra part's guessed time signature can end up governing the whole page. This removes:
 *  - parts that hold almost no notes compared with the main part,
 *  - measures that are empty in every part,
 *  - short one-staff fragments in the middle of the page,
 * and corrects a time signature that disagrees with the length of most measures.
 */
export interface CleanSummary {
  parts: number;
  measures: number;
  time?: string;
}

const kids = (el: Element, tag?: string) => Array.from(el.children).filter((c) => !tag || c.tagName === tag);
const num = (el: Element | null | undefined, tag: string) => {
  const t = el && kids(el, tag)[0]?.textContent;
  return t ? Number(t) : NaN;
};
const pitched = (el: Element) => el.getElementsByTagName('pitch').length;

interface Info {
  /** length of the measure's content in quarter notes */
  quarters: number;
  notes: number;
  /** staves that hold a pitched note */
  staves: Set<string>;
  hasTime: boolean;
}

function measureInfo(partEl: Element): Info[] {
  let div = 1;
  return kids(partEl, 'measure').map((m) => {
    let pos = 0;
    let max = 0;
    let last = 0;
    let hasTime = false;
    const staves = new Set<string>();
    for (const el of kids(m)) {
      if (el.tagName === 'attributes') {
        const d = num(el, 'divisions');
        if (d > 0) div = d;
        if (kids(el, 'time').length) hasTime = true;
      } else if (el.tagName === 'note') {
        const d = num(el, 'duration') || 0;
        if (kids(el, 'pitch').length) staves.add(kids(el, 'staff')[0]?.textContent ?? '1');
        if (kids(el, 'chord').length) pos = last;
        last = pos;
        pos += d / div;
        max = Math.max(max, pos);
      } else if (el.tagName === 'backup') pos = Math.max(0, pos - (num(el, 'duration') || 0) / div);
      else if (el.tagName === 'forward') {
        pos += (num(el, 'duration') || 0) / div;
        max = Math.max(max, pos);
      }
    }
    return { quarters: Math.round(max * 1000) / 1000, notes: kids(m, 'note').length, staves, hasTime };
  });
}

function mode(values: number[]): { value: number; share: number } | null {
  if (!values.length) return null;
  const count = new Map<number, number>();
  for (const v of values) count.set(v, (count.get(v) ?? 0) + 1);
  const [value, n] = [...count].sort((a, b) => b[1] - a[1])[0];
  return { value, share: n / values.length };
}

export function cleanScanXml(xml: string): { xml: string; summary: CleanSummary } {
  const summary: CleanSummary = { parts: 0, measures: 0 };
  const doc = new DOMParser().parseFromString(xml.replace(/^﻿?\s*<\?xml[^>]*\?>/, '').replace(/<!DOCTYPE[^>]*>/, ''), 'application/xml');
  const root = doc.documentElement;
  if (!root || root.tagName !== 'score-partwise' || doc.getElementsByTagName('parsererror').length) return { xml, summary };

  // 1. parts with next to nothing in them
  let parts = kids(root, 'part');
  const most = Math.max(...parts.map(pitched));
  if (parts.length > 1 && most > 0) {
    for (const p of parts) {
      if (pitched(p) >= most * 0.15) continue;
      const id = p.getAttribute('id');
      for (const list of kids(root, 'part-list')) for (const sp of kids(list, 'score-part')) if (sp.getAttribute('id') === id) sp.remove();
      p.remove();
      summary.parts++;
    }
    parts = kids(root, 'part');
  }

  // 2. measures that are empty everywhere, and short one-staff fragments
  const infos = parts.map(measureInfo);
  const count = Math.max(0, ...infos.map((i) => i.length));
  const usual = mode(infos.flatMap((list) => list.filter((i) => i.notes > 0).map((i) => i.quarters)));
  const twoStaves = parts.some((p) => p.getElementsByTagName('staves').length > 0) || parts.length > 1;
  const drop: number[] = [];
  for (let i = 0; i < count; i++) {
    const here = infos.map((list) => list[i]).filter(Boolean);
    if (here.every((x) => x.notes === 0)) {
      drop.push(i);
      continue;
    }
    if (i === 0 || i === count - 1 || !usual || usual.share < 0.5) continue;
    const length = Math.max(...here.map((x) => x.quarters));
    const used = new Set(here.flatMap((x, k) => [...x.staves].map((s) => `${k}:${s}`)));
    if (length <= usual.value / 2 && !here.some((x) => x.hasTime) && (!twoStaves || used.size <= 1)) drop.push(i);
  }
  if (drop.length && drop.length < count) {
    for (const p of parts) {
      const ms = kids(p, 'measure');
      for (const i of drop) ms[i]?.remove();
      kids(p, 'measure').forEach((m, k) => m.setAttribute('number', String(k + 1)));
    }
    summary.measures = drop.length;
  }

  // 2b. changes of key or time in the middle of a page that do not last. A real change stays for a
  // while; one that is gone again within two measures, or appears in the last two measures of the
  // page, is a misread. A time "change" to another way of writing the same length is dropped too.
  for (const p of parts) {
    const ms = kids(p, 'measure');
    const attr = (m: Element, tag: string) => kids(m, 'attributes').flatMap((a) => kids(a, tag))[0];
    let key = num(attr(ms[0], 'key'), 'fifths');
    let time = [num(attr(ms[0], 'time'), 'beats'), num(attr(ms[0], 'time'), 'beat-type')];
    for (let i = 1; i < ms.length; i++) {
      const k = attr(ms[i], 'key');
      if (k) {
        const next = num(k, 'fifths');
        const later = ms.slice(i + 1, i + 3).map((m) => attr(m, 'key')).find(Boolean);
        const reverts = later && num(later, 'fifths') === key;
        if (next === key || reverts || i >= ms.length - 2) {
          k.remove();
          if (reverts) later!.remove();
        } else key = next;
      }
      const t = attr(ms[i], 'time');
      if (t) {
        const next = [num(t, 'beats'), num(t, 'beat-type')];
        if (next[0] / next[1] === time[0] / time[1]) t.remove();
        else time = next;
      }
    }
  }

  // 3. a time signature that most measures do not fit
  const lengths = parts.map(measureInfo);
  const main = lengths.map((l, k) => ({ l, k })).sort((a, b) => b.l.length - a.l.length)[0];
  const usualNow = main && mode(main.l.filter((i) => i.notes > 0).map((i) => i.quarters));
  if (usualNow && usualNow.share >= 0.5 && usualNow.value > 0) {
    for (const p of parts) {
      const time = p.getElementsByTagName('time')[0];
      if (!time) continue;
      const beats = num(time, 'beats');
      const type = num(time, 'beat-type');
      if (!(beats > 0) || !(type > 0) || Math.abs((beats * 4) / type - usualNow.value) < 0.01) continue;
      let fixed: [number, number] | null = null;
      for (const t of [type, 8, 4, 2]) {
        const b = (usualNow.value * t) / 4;
        if (Number.isInteger(b) && b >= 1 && b <= 16) {
          fixed = [b, t];
          break;
        }
      }
      if (!fixed) continue;
      kids(time, 'beats')[0].textContent = String(fixed[0]);
      kids(time, 'beat-type')[0].textContent = String(fixed[1]);
      summary.time = fixed.join('/');
    }
  }

  return { xml: new XMLSerializer().serializeToString(doc), summary };
}
