// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { cleanScanXml } from '../src/omr/local/clean';
import { parseMusicXML } from '../src/importers/musicxml';
import { mergeScores } from '../src/model/merge';

describe('cleaning a page from the on-device reader', () => {
  const note = (step: string, dur: number, staff = 1) => `<note><pitch><step>${step}</step><octave>4</octave></pitch><duration>${dur}</duration><staff>${staff}</staff></note>`;
  const full = `<measure>${note('C', 6)}${note('D', 6)}<backup><duration>12</duration></backup>${note('E', 12, 2)}</measure>`;
  const page = `<?xml version="1.0"?><score-partwise><part-list><score-part id="P1"><part-name>x</part-name></score-part><score-part id="P2"><part-name>y</part-name></score-part></part-list>
    <part id="P1"><measure><attributes><divisions>2</divisions><time><beats>2</beats><beat-type>4</beat-type></time></attributes><note><rest/><duration>4</duration></note></measure><measure><note><rest/><duration>4</duration></note></measure></part>
    <part id="P2"><measure><attributes><divisions>2</divisions><staves>2</staves><time><beats>13</beats><beat-type>8</beat-type></time></attributes>${note('C', 6)}${note('D', 6)}<backup><duration>12</duration></backup>${note('E', 12, 2)}</measure>
      ${full}<measure></measure>${full}<measure><attributes><key><fifths>0</fifths></key></attributes>${note('A', 1)}</measure>${full}${full}</part></score-partwise>`;

  it('drops stray parts and measures and corrects the time signature', () => {
    const { xml, summary } = cleanScanXml(page);
    expect(summary).toEqual({ parts: 1, measures: 2, time: '12/8' });
    const score = parseMusicXML(xml);
    expect(score.parts).toHaveLength(1);
    expect(score.time).toEqual([12, 8]);
    expect(score.measures).toHaveLength(5);
    expect(score.measures.every((m) => m.staves[0].voices[0].some((e) => !e.rest))).toBe(true);
  });

  it('keeps a page that needs nothing', () => {
    const fine = `<score-partwise><part-list><score-part id="P1"><part-name>x</part-name></score-part></part-list><part id="P1"><measure><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>${note('C', 4)}</measure><measure>${note('D', 4)}</measure></part></score-partwise>`;
    expect(cleanScanXml(fine).summary).toEqual({ parts: 0, measures: 0 });
  });

  it('does not treat a guessed time of the same length as a change between pages', () => {
    const one = (time: string) => parseMusicXML(`<score-partwise><part-list><score-part id="P1"><part-name>x</part-name></score-part></part-list><part id="P1"><measure><attributes><divisions>1</divisions>${time}</attributes>${note('C', 6)}</measure></part></score-partwise>`);
    const merged = mergeScores([one('<time><beats>12</beats><beat-type>8</beat-type></time>'), one('<time><beats>6</beats><beat-type>4</beat-type></time>')]);
    expect(merged.time).toEqual([12, 8]);
    expect(merged.measures[1].time).toBeUndefined();
  });
});
