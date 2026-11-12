// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { parseMusicXML } from '../src/importers/musicxml';
import { toMusicXML } from '../src/model/musicxml';
import { buildPlan } from '../src/model/playback';
import { hairpinSpans, ottavaSpans, tripletGroups } from '../src/model/spans';
import { parseVoice, voiceToString } from '../src/model/tokens';
import { convertPages } from '../src/omr/convert';
import type { PageMeasure, PageTranscription } from '../src/omr/schema';

const measure = (number: number, treble: string, bass: string, more: Partial<PageMeasure> = {}): PageMeasure => ({
  number, staves: [[treble], [bass]], chords: [], timeSignature: '', keyFifths: '', tempo: 0, pickup: false,
  repeatStart: false, repeatEnd: false, ending: '', navigation: '', markers: [], text: '', ...more,
});
const page = (measures: PageMeasure[], more: Partial<PageTranscription> = {}): PageTranscription => ({
  title: 'Test', subtitle: '', composer: '', lyricist: '', arranger: '', pageNumber: 0, tempo: 120, timeSignature: '4/4', keyFifths: 0,
  parts: [{ name: 'Piano', clefs: ['treble', 'bass'] }], measures, uncertain: [], ...more,
});
const top = (s: ReturnType<typeof convertPages>['score'], m: number) => voiceToString(s.measures[m].staves[0].voices[0]);

describe('tremolo, hairpins and octave lines', () => {
  it('reads and writes the marks in the text notation', () => {
    const text = 'C4+E4/h@trem C4/q@cresc D4/q@hpend@8va E4/q@trem2@dim F4/q@8end';
    const { events, errors } = parseVoice(text);
    expect(errors).toEqual([]);
    expect(events[0].tremolo).toBe(3);
    expect(events[1].hairpin).toBe('cresc');
    expect(events[2]).toMatchObject({ hairpinEnd: true, ottava: 8 });
    expect(events[3]).toMatchObject({ hairpin: 'dim', tremolo: 2 });
    expect(events[4].ottavaEnd).toBe(true);
    expect(voiceToString(events)).toBe(text);
  });

  it('moves notes under an 8va line to where they sound and keeps the line', () => {
    const { score } = convertPages([page([
      measure(1, 'C4/q@8va D4/q E4/q F4/q', 'C2/q@8vb D2/q@8end E2/q F2/q'),
      measure(2, 'G4/q A4/q@8end B4/q C5/q', 'R'),
    ], { subtitle: 'from a film' })]);
    expect(score.subtitle).toBe('from a film');
    expect(top(score, 0)).toBe('C5/q@8va D5/q E5/q F5/q');
    expect(top(score, 1)).toBe('G5/q A5/q@8end B4/q C5/q');
    expect(voiceToString(score.measures[0].staves[1].voices[0])).toBe('C1/q@8vb D1/q@8end E2/q F2/q');
    expect(ottavaSpans(score).map((o) => [o.staff, o.value, o.a, o.b])).toEqual([[0, 8, 0, 576], [1, -8, 0, 192]]);
  });

  it('ends an open octave line with the page unless the next page marks it again', () => {
    const one = page([measure(1, 'C4/q@8va D4/q E4/q F4/q', 'R')]);
    const ended = convertPages([one, page([measure(2, 'C4/q D4/q E4/q F4/q', 'R')])], { reorder: false }).score;
    expect(top(ended, 0)).toBe('C5/q@8va D5/q E5/q F5/q@8end');
    expect(top(ended, 1)).toBe('C4/q D4/q E4/q F4/q');
    const carried = convertPages([one, page([measure(2, 'C4/q@8va D4/q@8end E4/q F4/q', 'R')])], { reorder: false }).score;
    expect(top(carried, 0)).toBe('C5/q@8va D5/q E5/q F5/q');
    expect(top(carried, 1)).toBe('C5/q D5/q@8end E4/q F4/q');
  });

  it('closes a hairpin that was left open at the next dynamic mark', () => {
    const { score } = convertPages([page([
      measure(1, 'C4/q@cresc D4/q E4/q@f F4/q', 'R'),
      measure(2, 'C4/q@dim D4/q E4/q F4/q', 'R'),
      measure(3, 'C4/w', 'R'),
      measure(4, 'C4/w', 'R'),
    ])]);
    expect(hairpinSpans(score).map((h) => [h.value, h.a, h.b])).toEqual([['cresc', 0, 192], ['dim', 384, 1152]]);
  });

  it('writes them to MusicXML and reads them back', () => {
    const { score } = convertPages([page([
      measure(1, 'C4+E4/h@trem2@cresc C4/q D4/q@hpend', 'C3/w'),
      measure(2, 'C4/q@8va D4/q@8end r/8t E4/8t F4/8t G4/8t A4/8t B4/8t', 'C3/w'),
    ], { subtitle: 'from a film' })]);
    const xml = toMusicXML(score).xml;
    expect(xml).toContain('<tremolo type="single">2</tremolo>');
    expect(xml).toContain('<wedge type="crescendo" number="1"/>');
    expect(xml).toContain('<wedge type="stop" number="1"/>');
    expect(xml).toContain('<octave-shift type="down" size="8" number="1"/>');
    expect(xml).toContain('<octave-shift type="stop" size="8" number="1"/>');
    // a triplet with a rest gets a bracket, one under a single beam only the number
    expect(xml.match(/<tuplet type="start" bracket="(yes|no)"\/>/g)).toEqual(['<tuplet type="start" bracket="yes"/>', '<tuplet type="start" bracket="no"/>']);
    const back = parseMusicXML(xml);
    expect(back.subtitle).toBe('from a film');
    expect(top(back, 0)).toBe(top(score, 0));
    expect(top(back, 1)).toBe(top(score, 1));
  });

  it('groups a triplet quarter and eighth as one beat', () => {
    const { events } = parseVoice('C4/qt D4/8t E4/8t F4/8t G4/8t A4/h');
    const marks = tripletGroups(events, 384);
    expect([...marks.entries()].map(([i, m]) => [i, !!m.start, !!m.stop, !!m.bracket])).toEqual([[0, true, false, true], [1, false, true, false], [2, true, false, false], [4, false, true, false]]);
  });
});

describe('playback of the marks', () => {
  const plan = (measures: PageMeasure[]) => buildPlan(convertPages([page(measures)]).score, { humanize: false });

  it('swings eighth notes after "Swing" and stops at "Straight"', () => {
    const p = plan([
      measure(1, 'C4/8 D4/8 E4/8t F4/8t G4/8t A4/h', 'R', { text: 'Swing eighths' }),
      measure(2, 'C4/8 D4/8 E4/h.', 'R', { text: 'Straight eighths' }),
    ]);
    const at = (i: number) => +p.notes[i].time.toFixed(3);
    // 120 to the minute: a beat is 0.5 s, the swung offbeat falls two thirds of the way through it
    expect([at(0), at(1), at(2), at(3)]).toEqual([0, 0.333, 0.5, 0.667]);
    expect(+p.notes[0].dur.toFixed(2)).toBeGreaterThan(+p.notes[1].dur.toFixed(2));
    expect([at(6), at(7)]).toEqual([2, 2.25]);
  });

  it('gets louder through a crescendo up to the next dynamic', () => {
    const p = plan([measure(1, 'C4/q@p@cresc D4/q E4/q F4/q@hpend', 'R'), measure(2, 'G4/q@f A4/q B4/q C5/q', 'R')]);
    const v = p.notes.map((n) => n.velocity);
    expect(v[1]).toBeGreaterThan(v[0] - 0.03);
    expect(v[2]).toBeGreaterThan(v[1]);
    expect(v[3]).toBeGreaterThan(v[2]);
    expect(v[3]).toBeLessThan(v[4]);
    expect(v[5]).toBeCloseTo(0.72 + 0.015 + 0.02, 2);
  });

  it('plays a tremolo as repeated strokes for the length of the note', () => {
    const p = plan([measure(1, 'C4+E4+G4/h@trem A4/h@trem2', 'R')]);
    const chord = p.notes.filter((n) => n.time < 0.999);
    const single = p.notes.filter((n) => n.time >= 0.999);
    expect(chord.length).toBeGreaterThan(12);
    expect(new Set(chord.map((n) => n.midi))).toEqual(new Set([60, 64, 67]));
    // the lower notes and the top note take turns
    expect(chord.filter((n) => n.time === 0).map((n) => n.midi).sort()).toEqual([60, 64]);
    expect(single.length).toBe(8);
    expect(Math.max(...p.notes.map((n) => n.time + n.dur))).toBeLessThan(2.05);
  });
});
