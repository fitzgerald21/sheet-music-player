import { describe, expect, it } from 'vitest';
import { parseVoice, voiceToString } from '../src/model/tokens';
import { completeChordTies, fitMeasure, measureLengths } from '../src/model/fix';
import { transposeScore } from '../src/model/transpose';
import { buildPlan, playbackOrder } from '../src/model/playback';
import { toMusicXML } from '../src/model/musicxml';
import { demoScore } from '../src/demo';
import { setDuration, changePitch, setLetter } from '../src/model/edit';
import { convertPages } from '../src/omr/convert';
import { transposeChord } from '../src/model/chords';
import { midiOf, transposeKey } from '../src/model/pitch';
import { Score } from '../src/model/types';
import { applyExtras, lyricSlots, readExtras } from '../src/omr/annotate';

describe('tokens', () => {
  it('round-trips', () => {
    const s = 'D4+F4+Bb4/q C5/8.~ C5/16 r/8 G4/8t@stacc A4/8t B4/8t( R';
    const r = parseVoice(s);
    expect(r.errors).toEqual([]);
    expect(voiceToString(r.events)).toBe('D4+F4+Bb4/q C5/8.~ C5/16 r/8 G4/8t@stacc A4/8t B4/8t( R');
  });
  it('parses lyrics, dynamics and partial ties', () => {
    const r = parseVoice('F4/h"wish"@mf C4~+E4/q g:A4/16 D4/q"knew-"');
    expect(r.errors).toEqual([]);
    expect(r.events[0].lyric).toBe('wish');
    expect(r.events[0].dynamic).toBe('mf');
    expect(r.events[1].pitches[0].tie).toBe(true);
    expect(r.events[1].pitches[1].tie).toBeFalsy();
    expect(r.events[2].grace).toBe(true);
    expect(r.events[3].lyric).toBe('knew-');
  });
  it('reports errors', () => {
    expect(parseVoice('H4/q C4').errors.length).toBe(2);
  });
});

describe('fit', () => {
  it('pads and trims voices', () => {
    const m = { staves: [{ voices: [parseVoice('C4/q D4/q').events] }, { voices: [parseVoice('C3/w D3/q').events] }] };
    fitMeasure(m, 384, 2);
    expect(voiceToString(m.staves[0].voices[0])).toBe('C4/q D4/q r/h');
    expect(voiceToString(m.staves[1].voices[0])).toBe('C3/w');
  });
});

describe('demo', () => {
  const s = demoScore();
  it('has 16 measures in 3/4', () => {
    expect(s.measures.length).toBe(16);
    expect(s.time).toEqual([3, 4]);
    expect(measureLengths(s).every((l) => l === 288)).toBe(true);
  });
  it('repeats the first half', () => {
    expect(playbackOrder(s).length).toBe(24);
  });
  it('builds a plan', () => {
    const p = buildPlan(s);
    expect(p.notes.length).toBeGreaterThan(50);
    expect(p.duration).toBeCloseTo((24 * 3 * 60) / 112, 3);
  });
  it('exports MusicXML', () => {
    const { xml, eventKeys } = toMusicXML(s);
    expect(xml).toContain('<fifths>1</fifths>');
    expect(xml).toContain('<repeat direction="backward"/>');
    expect(eventKeys.size).toBeGreaterThan(50);
  });
});

describe('transpose', () => {
  it('transposes keys and notes', () => {
    const s = demoScore();
    const t = transposeScore(s, 2); // G -> A major
    expect(t.key).toBe(3);
    const first = t.measures[0].staves[0].voices[0][0].pitches[0];
    expect(first).toMatchObject({ step: 'E', alter: 0, octave: 5 });
    const fsharp = t.measures[2].staves[0].voices[0][4].pitches[0]; // F#5 -> G#5
    expect(fsharp).toMatchObject({ step: 'G', alter: 1, octave: 5 });
    const down = transposeScore(s, -1); // G -> Gb (6 flats) or F#
    expect(Math.abs(down.key)).toBe(6);
  });
  it('keys', () => {
    expect(transposeKey(-2, 2)).toBe(0); // Bb -> C
    expect(transposeKey(3, -3)).toBe(6); // A -> F#
  });
  it('chords', () => {
    expect(transposeChord('Bb7/F', 2, 1)).toBe('C7/G');
    expect(transposeChord('D7/F#', 2, 1)).toBe('E7/G#');
    expect(transposeChord('Ebm', -3, -2)).toBe('Cm');
  });
});

describe('edit', () => {
  it('lengthens a note in overwrite mode', () => {
    const s = demoScore();
    const id = s.measures[0].staves[0].voices[0][1].id; // G4/8
    const t = setDuration(s, id, 'q', 0);
    expect(voiceToString(t.measures[0].staves[0].voices[0])).toMatch(/^D5\/q@mf G4\/q\( B4\/8 C5\/8\)$/);
  });
  it('shortens a note and fills with rests', () => {
    const s = demoScore();
    const id = s.measures[1].staves[0].voices[0][0].id; // D5/q
    const t = setDuration(s, id, '8', 0);
    expect(voiceToString(t.measures[1].staves[0].voices[0])).toBe('D5/8 r/8 G4/q@stacc G4/q@stacc');
  });
  it('changes pitch diatonically in key', () => {
    const s = demoScore();
    const id = s.measures[0].staves[0].voices[0][4].id; // C5
    const t = changePitch(s, id, null, 'diatonic', 2); // -> E5
    expect(midiOf(t.measures[0].staves[0].voices[0][4].pitches[0])).toBe(76);
    const u = changePitch(s, id, null, 'diatonic', -1); // -> B4
    expect(midiOf(u.measures[0].staves[0].voices[0][4].pitches[0])).toBe(71);
    const f = setLetter(s, id, null, 'F', 76); // F in G major = F#
    expect(t).not.toBe(s);
    expect(f.measures[0].staves[0].voices[0][4].pitches[0]).toMatchObject({ step: 'F', alter: 1, octave: 5 });
  });
});

describe('convert', () => {
  it('merges pages with a missing vocal staff', () => {
    const base = { title: '', composer: '', lyricist: '', arranger: '', tempo: 0, timeSignature: '4/4', keyFifths: -2, uncertain: [] };
    const mm = (n: number, staves: string[][]) => ({ number: n, staves, chords: [], timeSignature: '', keyFifths: '', tempo: 0, pickup: false, repeatStart: false, repeatEnd: false, ending: '', navigation: '', markers: [], text: '' });
    const p1 = { ...base, title: 'Song', pageNumber: 1, tempo: 120, parts: [{ name: 'Piano', clefs: ['treble', 'bass'] }], measures: [mm(1, [['C4/w'], ['C3/w']])] };
    const p2 = { ...base, pageNumber: 2, parts: [{ name: 'Voice', clefs: ['treble'] }, { name: 'Piano', clefs: ['treble', 'bass'] }], measures: [mm(2, [['G4/w'], ['E4/w'], ['C3/w']])] };
    const { score } = convertPages([p2, p1]);
    expect(score.title).toBe('Song');
    expect(score.parts.map((p) => p.name)).toEqual(['Voice', 'Piano']);
    expect(score.parts[0].instrument).toBe('voice');
    expect(score.measures[0].staves[0].voices[0][0].fullMeasure).toBe(true);
    expect(voiceToString(score.measures[0].staves[1].voices[0])).toBe('C4/w');
    expect(voiceToString(score.measures[1].staves[0].voices[0])).toBe('G4/w');
    expect(score.key).toBe(-2);
  });
});

describe('navigation', () => {
  it('handles D.C. al Fine and voltas', () => {
    const s = demoScore() as Score;
    s.measures = s.measures.slice(0, 6);
    for (const m of s.measures) {
      delete m.repeatStart;
      delete m.repeatEnd;
    }
    s.measures[1].repeatEnd = 2;
    s.measures[1].ending = [1];
    s.measures[2].ending = [2];
    s.measures[2].fine = true;
    s.measures[5].navigation = 'DCalFine';
    expect(playbackOrder(s)).toEqual([0, 1, 0, 2, 3, 4, 5, 0, 2]);
  });
});

describe('exports', () => {
  it('writes chord text for display and harmony for export', () => {
    const { score } = convertPages([
      {
        title: 'T', composer: '', lyricist: '', arranger: '', pageNumber: 1, tempo: 90, timeSignature: '4/4', keyFifths: 0, uncertain: [],
        parts: [{ name: 'Piano', clefs: ['treble', 'bass'] }],
        measures: [{ number: 1, staves: [['C5/w'], ['C3/w']], chords: [{ beat: 1, symbol: 'Bb7/F#' }], timeSignature: '', keyFifths: '', tempo: 0, pickup: false, repeatStart: false, repeatEnd: false, ending: '', navigation: '', markers: [], text: '' }],
      },
    ]);
    expect(toMusicXML(score, { chordText: true }).xml).toContain('text="B♭7/F♯"');
    const ex = toMusicXML(score).xml;
    expect(ex).toContain('<root-step>B</root-step><root-alter>-1</root-alter>');
    expect(ex).toContain('<kind text="7">dominant</kind>');
  });
  it('writes a MIDI file', async () => {
    const { toMidi } = await import('../src/model/midi');
    const s = demoScore();
    const bytes = toMidi(s, buildPlan(s, { humanize: false }));
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('MThd');
    expect(bytes.length).toBeGreaterThan(500);
  });
});

describe('chord ties', () => {
  it('ties every shared note when one note of a chord is tied over a barline', () => {
    const a = parseVoice('C4+E4+G4/8').events;
    const b = parseVoice('C4+E4+G4/h D4/q D4/q').events;
    a[0].pitches[1].tie = true;
    const score = { measures: [{ staves: [{ voices: [a] }] }, { staves: [{ voices: [b] }] }] } as unknown as Score;
    expect(completeChordTies(score)).toBe(2);
    expect(a[0].pitches.every((p) => p.tie)).toBe(true);
    expect(b[1].pitches[0].tie).toBeFalsy();
  });
  it('leaves untied chords and notes the next chord lacks alone', () => {
    const a = parseVoice('C4+E4/q C4+E4/q C4+G4/q').events;
    a[1].pitches[0].tie = true;
    const score = { measures: [{ staves: [{ voices: [a] }] }] } as unknown as Score;
    expect(completeChordTies(score)).toBe(0);
    expect(a[0].pitches.some((p) => p.tie)).toBe(false);
  });
});

describe('title, chords and lyrics from an AI model', () => {
  const page = (): Score =>
    ({
      title: 'Untitled',
      tempo: 100,
      time: [4, 4],
      measures: [
        { staves: [{ voices: [parseVoice('D5/q. C5/8 Bb4/h~').events] }] },
        { staves: [{ voices: [parseVoice('Bb4/q r/q F4/8 G4/8 A4/q').events] }] },
      ],
    }) as unknown as Score;

  it('counts one syllable per sung note and skips notes held by a tie', () => {
    expect(lyricSlots(page()).map((s) => s.length)).toEqual([3, 3]);
  });

  it('asks the model and writes its answer into the score', async () => {
    const answer = {
      title: 'I Wish I Knew',
      composer: 'B. Taylor',
      tempo: 96,
      measures: [
        { m: 1, chords: [{ beat: 1, symbol: 'B♭' }, { beat: 3, symbol: 'D7/F#' }], lyrics: ['Sing', 'a', 'song'] },
        { m: 2, chords: [], lyrics: ['of', 'six-'] },
        { m: 9, chords: [{ beat: 1, symbol: 'C' }], lyrics: ['x'] },
      ],
    };
    let sent: { model: string; messages: { content: unknown }[] } | undefined;
    const original = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init: { body: string }) => {
      sent = JSON.parse(init.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: '```json\n' + JSON.stringify(answer) + '\n```' } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const score = page();
      const extras = await readExtras({ baseUrl: 'https://example.test/v1', apiKey: 'k', model: 'some/model' }, { data: 'AAAA', mediaType: 'image/jpeg' } as never, score);
      const prompt = JSON.stringify(sent!.messages[1].content);
      expect(prompt).toContain('1: D5/q. C5/8 Bb4/h~   [3 sung notes]');
      const summary = applyExtras(score, extras);
      expect(score.title).toBe('I Wish I Knew');
      expect(score.tempo).toBe(96);
      expect(score.measures[0].chords).toEqual([{ beat: 1, text: 'Bb' }, { beat: 3, text: 'D7/F#' }]);
      expect(voiceToString(score.measures[0].staves[0].voices[0])).toBe('D5/q."Sing" C5/8"a" Bb4/h~"song"');
      expect(voiceToString(score.measures[1].staves[0].voices[0])).toBe('Bb4/q r/q F4/8"of" G4/8"six-" A4/q');
      expect(summary).toEqual({ chords: 2, lyrics: 5, uneven: [1] });
    } finally {
      globalThis.fetch = original;
    }
  });
});
