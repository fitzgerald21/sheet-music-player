import { parseChord, musicXmlKind } from './chords';
import { BASE_TICKS, TPQ, eventTicks, measureTicks } from './duration';
import { keyAt, measureLengths, timeAt } from './fix';
import { keyAlter, midiOf } from './pitch';
import { Clef, Measure, NoteEvent, Part, Score } from './types';

const TYPE_NAME: Record<string, string> = { w: 'whole', h: 'half', q: 'quarter', '8': 'eighth', '16': '16th', '32': '32nd', '64': '64th' };
const ACC_NAME: Record<number, string> = { 2: 'double-sharp', 1: 'sharp', 0: 'natural', '-1': 'flat', '-2': 'flat-flat' } as never;

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function clefXml(clef: Clef, n: number): string {
  const c = {
    treble: ['G', 2, 0],
    bass: ['F', 4, 0],
    alto: ['C', 3, 0],
    tenor: ['C', 4, 0],
    treble8vb: ['G', 2, -1],
  }[clef] as [string, number, number];
  return `<clef number="${n}"><sign>${c[0]}</sign><line>${c[1]}</line>${c[2] ? `<clef-octave-change>${c[2]}</clef-octave-change>` : ''}</clef>`;
}

export interface XmlExport {
  xml: string;
  /** key `${measure}|${visibleStaff}|${voiceNumber}|${tick}` -> event id */
  eventKeys: Map<string, string>;
  /** visible staff index -> global staff index */
  staffMap: number[];
}

export interface XmlOptions {
  includeHidden?: boolean;
  /** Draw title/composer header. */
  header?: boolean;
  /**
   * Display mode for OSMD: write chord symbols so they show exactly as typed (with ♭/♯).
   * Uses the <numeral> text path, so only use it for on-screen rendering, not for export.
   */
  chordText?: boolean;
}

export function voiceNumber(staffInPart: number, voiceIdx: number): number {
  return staffInPart * 4 + voiceIdx + 1;
}

export function toMusicXML(score: Score, opts: XmlOptions = {}): XmlExport {
  const times = timeAt(score);
  const keys = keyAt(score);
  const lens = measureLengths(score);
  const eventKeys = new Map<string, string>();
  const staffMap: number[] = [];

  // global staff offset of every part
  const partOffsets: number[] = [];
  let off = 0;
  for (const p of score.parts) {
    partOffsets.push(off);
    off += p.staves.length;
  }
  const visibleParts = score.parts.map((p, i) => ({ p, i })).filter(({ p }) => opts.includeHidden || !p.hidden);
  if (!visibleParts.length) visibleParts.push({ p: score.parts[0], i: 0 });
  for (const { p, i } of visibleParts) p.staves.forEach((_, s) => staffMap.push(partOffsets[i] + s));

  const out: string[] = [];
  out.push('<?xml version="1.0" encoding="UTF-8" standalone="no"?>');
  out.push('<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">');
  out.push('<score-partwise version="4.0">');
  if (score.title) out.push(`<work><work-title>${esc(score.title)}</work-title></work>`);
  out.push('<identification>');
  if (score.composer) out.push(`<creator type="composer">${esc(score.composer)}</creator>`);
  if (score.lyricist) out.push(`<creator type="lyricist">${esc(score.lyricist)}</creator>`);
  if (score.arranger) out.push(`<creator type="arranger">${esc(score.arranger)}</creator>`);
  out.push('<encoding><software>Sheet Music Player</software></encoding></identification>');
  if (score.subtitle) out.push(`<credit page="1"><credit-type>subtitle</credit-type><credit-words>${esc(score.subtitle)}</credit-words></credit>`);
  out.push('<part-list>');
  for (const { p, i } of visibleParts) {
    out.push(`<score-part id="P${i + 1}"><part-name>${esc(p.name)}</part-name></score-part>`);
  }
  out.push('</part-list>');

  let visibleStaffBase = 0;
  visibleParts.forEach(({ p, i: pi }, vpIdx) => {
    out.push(`<part id="P${pi + 1}">`);
    const tieState = new Map<string, Set<number>>(); // `${staff}|${voice}` -> midis tied from previous event
    const lyricHyphen = new Map<string, boolean>();
    let endingOpen: number[] | null = null;
    score.measures.forEach((m, mi) => {
      const len = lens[mi];
      const full = measureTicks(times[mi]);
      const num = score.measures[0].pickup ? mi : mi + 1;
      const implicit = m.pickup ? ' implicit="yes"' : '';
      out.push(`<measure number="${num}"${implicit}>`);

      // left barline: repeat start / ending start
      const endingStarts = m.ending && (!endingOpen || mi === 0 || !sameEnding(score.measures[mi - 1], m));
      if (m.repeatStart || endingStarts) {
        out.push('<barline location="left">');
        if (m.repeatStart) out.push('<bar-style>heavy-light</bar-style><repeat direction="forward"/>');
        if (endingStarts && m.ending) out.push(`<ending number="${m.ending.join(',')}" type="start">${m.ending.join('., ')}.</ending>`);
        out.push('</barline>');
        if (endingStarts) endingOpen = m.ending ?? null;
      }

      // attributes
      const attrs: string[] = [];
      if (mi === 0) attrs.push(`<divisions>${TPQ}</divisions>`);
      if (mi === 0 || m.key !== undefined) attrs.push(`<key><fifths>${keys[mi]}</fifths></key>`);
      if (mi === 0 || m.time) attrs.push(`<time><beats>${times[mi][0]}</beats><beat-type>${times[mi][1]}</beat-type></time>`);
      if (mi === 0) {
        if (p.staves.length > 1) attrs.push(`<staves>${p.staves.length}</staves>`);
        p.staves.forEach((s, si) => attrs.push(clefXml(s.clef, si + 1)));
      }
      if (attrs.length) out.push(`<attributes>${attrs.join('')}</attributes>`);

      // directions (only first visible part)
      if (vpIdx === 0) {
        const tempo = mi === 0 ? m.tempo ?? score.tempo : m.tempo;
        if (tempo)
          out.push(
            `<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${Math.round(tempo)}</per-minute></metronome></direction-type><sound tempo="${tempo}"/></direction>`,
          );
        if (m.segno) out.push('<direction placement="above"><direction-type><segno/></direction-type><sound segno="segno"/></direction>');
        if (m.coda) out.push('<direction placement="above"><direction-type><coda/></direction-type><sound coda="coda"/></direction>');
        if (m.text) out.push(`<direction placement="above"><direction-type><words font-style="italic">${esc(m.text)}</words></direction-type></direction>`);
      }

      // Chord symbols are written just before the note they sit above. Where no note starts at that
      // exact spot, the file keeps the true position as an offset; the drawing (which ignores offsets)
      // uses the nearest note instead.
      const harmonyAt = new Map<string, string[]>();
      if (vpIdx === 0 && m.chords?.length) {
        const top = m.staves[partOffsets[pi]]?.voices ?? [];
        const onsets: { vi: number; ei: number; tick: number }[] = [];
        top.forEach((voice, vi) => {
          let tick = 0;
          voice.forEach((e, ei) => {
            if (!e.grace) onsets.push({ vi, ei, tick });
            tick += eventTicks(e, len);
          });
        });
        const main = onsets.filter((o) => o.vi === 0);
        const placed = new Map<string, { texts: string[]; xml: string[] }>();
        for (const c of [...m.chords].sort((x, y) => x.beat - y.beat)) {
          const pc = parseChord(c.text);
          if (!pc || !main.length) continue;
          const tick = Math.max(0, Math.round(((c.beat - 1) * 4 * TPQ) / times[mi][1]));
          const exact = onsets.find((o) => o.tick === tick);
          const before = [...main].reverse().find((o) => o.tick <= tick) ?? main[0];
          const nearest = main.reduce((best, o) => (Math.abs(o.tick - tick) < Math.abs(best.tick - tick) ? o : best), before);
          const at = exact ?? (opts.chordText ? nearest : before);
          const key = `${at.vi}|${at.ei}`;
          const slot = placed.get(key) ?? { texts: [], xml: [] };
          placed.set(key, slot);
          const offset = tick - at.tick;
          if (opts.chordText) slot.texts.push(prettyChord(c.text));
          else {
            const kind = musicXmlKind(pc.quality);
            slot.xml.push(
              `<harmony print-frame="no"><root><root-step>${pc.root}</root-step>${pc.rootAlter ? `<root-alter>${pc.rootAlter}</root-alter>` : ''}</root>` +
                `<kind text="${esc(pc.quality)}">${kind === 'other' ? 'major' : kind}</kind>` +
                (pc.bass ? `<bass><bass-step>${pc.bass}</bass-step>${pc.bassAlter ? `<bass-alter>${pc.bassAlter}</bass-alter>` : ''}</bass>` : '') +
                `${offset ? `<offset>${offset}</offset>` : ''}</harmony>`,
            );
          }
        }
        for (const [key, slot] of placed) {
          // two symbols over one note are drawn side by side as one label
          if (slot.texts.length) slot.xml.push(`<harmony print-frame="no"><numeral><numeral-root text="${esc(slot.texts.join('  '))}">1</numeral-root></numeral><kind>major</kind></harmony>`);
          harmonyAt.set(key, slot.xml);
        }
      }

      // notes
      let firstVoiceWritten = false;
      p.staves.forEach((_, si) => {
        const gStaff = partOffsets[pi] + si;
        const vStaff = visibleStaffBase + si;
        const sm = m.staves[gStaff];
        if (!sm) return;
        const accState = new Map<string, number>();
        const multiVoice = sm.voices.length > 1;
        sm.voices.forEach((voice, vi) => {
          if (firstVoiceWritten) out.push(`<backup><duration>${len}</duration></backup>`);
          firstVoiceWritten = true;
          const vnum = voiceNumber(si, vi);
          const tkey = `${si}|${vi}`;
          let tick = 0;
          let graceIdx = 0;
          let tupletAcc = 0;
          let tupletGroup = 0;
          voice.forEach((e, ei) => {
            const t = eventTicks(e, len);
            if (e.grace) {
              eventKeys.set(`${mi}|${vStaff}|${vnum}|${tick}|g${graceIdx++}`, e.id);
            } else {
              graceIdx = 0;
              eventKeys.set(`${mi}|${vStaff}|${vnum}|${tick}`, e.id);
            }
            if (si === 0) for (const h of harmonyAt.get(`${vi}|${ei}`) ?? []) out.push(h);
            // dynamics
            if (e.dynamic) {
              out.push(
                `<direction placement="below"><direction-type><dynamics><${e.dynamic}/></dynamics></direction-type>${p.staves.length > 1 ? `<staff>${si + 1}</staff>` : ''}</direction>`,
              );
            }
            // tuplet bookkeeping
            let tupletMark = '';
            if (e.triplet && !e.grace) {
              if (tupletAcc === 0) {
                tupletGroup = (BASE_TICKS[e.dur] * 2 * (e.dots ? 1.5 : 1)); // three triplet notes span two plain ones
                tupletMark = '<tuplet type="start" bracket="no"/>';
              }
              tupletAcc += t;
              if (tupletAcc >= tupletGroup - 1) {
                tupletMark += '<tuplet type="stop"/>';
                tupletAcc = 0;
              }
            } else {
              tupletAcc = 0;
            }
            const prevTied = tieState.get(tkey) ?? new Set<number>();
            const nowTied = new Set<number>();
            const pitches = e.rest ? [null] : e.pitches;
            // lyric syllabic
            let lyricXml = '';
            if (e.lyric && !e.rest) {
              let text = e.lyric;
              const hyph = text.endsWith('-');
              if (hyph) text = text.slice(0, -1);
              const ext = text.endsWith('_');
              if (ext) text = text.slice(0, -1);
              const prevH = lyricHyphen.get(tkey) ?? false;
              const syl = prevH ? (hyph ? 'middle' : 'end') : hyph ? 'begin' : 'single';
              lyricHyphen.set(tkey, hyph);
              lyricXml = `<lyric number="1"><syllabic>${syl}</syllabic><text>${esc(text)}</text>${ext ? '<extend/>' : ''}</lyric>`;
            }
            pitches.forEach((pt, pidx) => {
              const n: string[] = ['<note>'];
              if (e.grace) n.push('<grace slash="yes"/>');
              if (pidx > 0) n.push('<chord/>');
              if (!pt) {
                n.push(e.fullMeasure ? '<rest measure="yes"/>' : '<rest/>');
              } else {
                n.push(`<pitch><step>${pt.step}</step>${pt.alter ? `<alter>${pt.alter}</alter>` : ''}<octave>${pt.octave}</octave></pitch>`);
              }
              if (!e.grace) n.push(`<duration>${t}</duration>`);
              const midi = pt ? midiOf(pt) : -1;
              const tieStop = pt && prevTied.has(midi);
              if (tieStop) n.push('<tie type="stop"/>');
              if (pt?.tie) {
                n.push('<tie type="start"/>');
                nowTied.add(midi);
              }
              n.push(`<voice>${vnum}</voice>`);
              if (!e.fullMeasure) n.push(`<type>${TYPE_NAME[e.grace && e.dur === 'q' ? '8' : e.dur]}</type>`);
              for (let d = 0; d < e.dots && !e.fullMeasure; d++) n.push('<dot/>');
              if (pt) {
                const k = `${pt.step}${pt.octave}`;
                const cur = accState.has(k) ? accState.get(k)! : keyAlter(keys[mi], pt.step);
                if (cur !== pt.alter && !tieStop) {
                  n.push(`<accidental>${ACC_NAME[pt.alter]}</accidental>`);
                }
                accState.set(k, pt.alter);
              }
              if (e.triplet) n.push('<time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>');
              if (pt && multiVoice) n.push(`<stem>${vi % 2 === 0 ? 'up' : 'down'}</stem>`);
              if (p.staves.length > 1) n.push(`<staff>${si + 1}</staff>`);
              const notations: string[] = [];
              if (tieStop) notations.push('<tied type="stop"/>');
              if (pt?.tie) notations.push('<tied type="start"/>');
              if (pidx === 0) {
                if (e.slurEnd) notations.push('<slur type="stop" number="1"/>');
                if (e.slurStart) notations.push('<slur type="start" number="1"/>');
                if (tupletMark) notations.push(tupletMark);
                const arts = (e.artic ?? []).filter((a) => a !== 'fermata');
                if (arts.length)
                  notations.push(
                    `<articulations>${arts.map((a) => ({ staccato: '<staccato/>', accent: '<accent/>', tenuto: '<tenuto/>', marcato: '<strong-accent/>' })[a as 'staccato']).join('')}</articulations>`,
                  );
                if (e.artic?.includes('fermata')) notations.push('<fermata type="upright"/>');
              }
              if (notations.length) n.push(`<notations>${notations.join('')}</notations>`);
              if (pidx === 0 && lyricXml) n.push(lyricXml);
              n.push('</note>');
              out.push(n.join(''));
            });
            if (!e.grace) {
              tieState.set(tkey, nowTied);
              tick += t;
            }
            void ei;
          });
        });
      });

      // end-of-measure directions
      if (vpIdx === 0) {
        if (m.fine) out.push('<direction placement="above"><direction-type><words font-weight="bold">Fine</words></direction-type><sound fine="yes"/></direction>');
        if (m.toCoda) out.push('<direction placement="above"><direction-type><words>To Coda</words></direction-type><sound tocoda="coda"/></direction>');
        if (m.navigation) {
          const words = { DC: 'D.C.', DCalFine: 'D.C. al Fine', DCalCoda: 'D.C. al Coda', DS: 'D.S.', DSalFine: 'D.S. al Fine', DSalCoda: 'D.S. al Coda' }[m.navigation];
          const snd = m.navigation.startsWith('DC') ? '<sound dacapo="yes"/>' : '<sound dalsegno="segno"/>';
          out.push(`<direction placement="above"><direction-type><words font-style="italic" font-weight="bold">${words}</words></direction-type>${snd}</direction>`);
        }
      }

      // right barline
      const isLast = mi === score.measures.length - 1;
      const endingStops = m.ending && (isLast || !sameEnding(m, score.measures[mi + 1]));
      if (m.repeatEnd || endingStops || isLast) {
        out.push('<barline location="right">');
        out.push(`<bar-style>${m.repeatEnd || isLast ? 'light-heavy' : 'regular'}</bar-style>`);
        if (endingStops && m.ending) {
          out.push(`<ending number="${m.ending.join(',')}" type="${m.repeatEnd ? 'stop' : 'discontinue'}"/>`);
          endingOpen = null;
        }
        if (m.repeatEnd) out.push(`<repeat direction="backward"${m.repeatEnd > 2 ? ` times="${m.repeatEnd}"` : ''}/>`);
        out.push('</barline>');
      }
      void full;
      out.push('</measure>');
    });
    out.push('</part>');
    visibleStaffBase += p.staves.length;
  });
  out.push('</score-partwise>');
  return { xml: out.join('\n'), eventKeys, staffMap };
}

/** "Bb7/F#" -> "B♭7/F♯" (only root and bass accidentals). */
export function prettyChord(text: string): string {
  return text
    .replace(/^([A-G])b/, '$1♭')
    .replace(/^([A-G])#/, '$1♯')
    .replace(/\/([A-G])b/, '/$1♭')
    .replace(/\/([A-G])#/, '/$1♯');
}

function sameEnding(a: Measure, b: Measure): boolean {
  return !!a.ending && !!b.ending && a.ending.join(',') === b.ending.join(',') && !b.repeatStart && !a.repeatEnd;
}

export type { Part, NoteEvent };
