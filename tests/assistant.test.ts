import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssistantAnswer, Mark, applyAnswer, askAssistant, buildRequest, describeMark, measuresToSend, mentionedMeasures } from '../src/ai/assistant';
import { parseVoice, voiceToString } from '../src/model/tokens';
import { Score } from '../src/model/types';

function make(staves: string[][][], extra: Partial<Score> = {}): Score {
  return {
    id: 's', title: 'Test', tempo: 100, time: [4, 4], key: 0, created: 0, updated: 0,
    parts: [{ id: 'p', name: 'Piano', instrument: 'piano', volume: 0, staves: [{ clef: 'treble' }, { clef: 'bass' }] }],
    measures: staves.map((m) => ({ staves: m.map((v) => ({ voices: v.map((t) => parseVoice(t).events) })) })),
    ...extra,
  };
}
const answer = (a: Partial<AssistantAnswer>): AssistantAnswer => ({ reply: '', measures: [], insert: [], delete: [], score: {}, transpose: 0, ...a });
const top = (s: Score, m: number) => voiceToString(s.measures[m].staves[0].voices[0]);

const song = () => make([
  [['C4/q D4/q E4/q F4/q'], ['C3/w']],
  [['C4+E4+G4/h~ C4+E4+G4/h'], ['C3/w']],
  [['G4/w'], ['G2/w']],
]);

describe('applying an answer from the assistant', () => {
  it('changes one note and keeps the identity of the others', () => {
    const s = song();
    const ids = s.measures[0].staves[0].voices[0].map((e) => e.id);
    const res = applyAnswer(s, answer({ measures: [{ m: 1, staves: [['C#4/q D4/q E4/q F4/q'], ['C3/w']] }] }));
    expect(top(res.score, 0)).toBe('C#4/q D4/q E4/q F4/q');
    expect(res.changed).toEqual([0]);
    expect(res.problems).toEqual([]);
    const after = res.score.measures[0].staves[0].voices[0].map((e) => e.id);
    expect(after.slice(1)).toEqual(ids.slice(1));
    expect(after[0]).not.toBe(ids[0]);
    expect(top(s, 0)).toBe('C4/q D4/q E4/q F4/q'); // the original is untouched
  });

  it('removes the tie from one note of a chord', () => {
    const res = applyAnswer(song(), answer({ measures: [{ m: 2, staves: [['C4~+E4~+G4/h C4+E4+G4/h'], ['C3/w']] }] }));
    const chord = res.score.measures[1].staves[0].voices[0][0];
    expect(chord.pitches.map((p) => !!p.tie)).toEqual([true, true, false]);
  });

  it('refuses a measure it cannot read and says so', () => {
    const s = song();
    const res = applyAnswer(s, answer({ measures: [{ m: 1, staves: [['C4/q H9/q'], ['C3/w']] }, { m: 9, staves: [['C4/w'], ['C3/w']] }, { m: 3, staves: [['G4/w']] }] }));
    expect(res.unchanged).toBe(true);
    expect(res.score).toBe(s);
    expect(res.problems).toHaveLength(3);
  });

  it('pads a measure that is too short and reports it', () => {
    const res = applyAnswer(song(), answer({ measures: [{ m: 1, staves: [['C4/q D4/q'], ['C3/w']] }] }));
    expect(top(res.score, 0)).toBe('C4/q D4/q r/h');
    expect(res.problems[0]).toMatch(/Measure 1 did not add up/);
  });

  it('sets chords alone, inserts, deletes, renames and transposes', () => {
    const res = applyAnswer(song(), answer({
      measures: [{ m: 1, chords: [{ beat: 1, symbol: 'C' }, { beat: 3, symbol: 'F/C' }] }],
      insert: [{ after: 1, staves: [['E4/w'], ['R']] }],
      delete: [3],
      score: { title: 'New name', tempo: 72 },
    }));
    expect(res.score.measures).toHaveLength(3);
    expect(res.score.measures[0].chords).toEqual([{ beat: 1, text: 'C' }, { beat: 3, text: 'F/C' }]);
    expect(top(res.score, 0)).toBe('C4/q D4/q E4/q F4/q');
    expect(top(res.score, 1)).toBe('E4/w');
    expect(top(res.score, 2)).toBe('C4+E4+G4/h~ C4+E4+G4/h');
    expect(res.score.title).toBe('New name');
    expect(res.score.tempo).toBe(72);
    expect(res.changed).toEqual([0, 1]);

    const up = applyAnswer(song(), answer({ transpose: 2 }));
    expect(top(up.score, 0)).toBe('D4/q E4/q F#4/q G4/q');
    expect(up.score.key).toBe(2);
    expect(up.unchanged).toBe(false);
  });

  it('in chord mode never touches the notes', () => {
    const res = applyAnswer(song(), answer({ measures: [{ m: 1, staves: [['G4/w'], ['R']], chords: [{ beat: 1, symbol: 'C' }] }], delete: [2], transpose: 3 }), 'chords');
    expect(res.score.measures).toHaveLength(3);
    expect(top(res.score, 0)).toBe('C4/q D4/q E4/q F4/q');
    expect(res.score.measures[0].chords).toEqual([{ beat: 1, text: 'C' }]);
  });

  it('reports nothing changed when the answer repeats the score', () => {
    const s = song();
    const res = applyAnswer(s, answer({ reply: 'Which C?', measures: [{ m: 1, staves: [['C4/q D4/q E4/q F4/q'], ['C3/w']] }] }));
    expect(res.unchanged).toBe(true);
  });
});

describe('telling the assistant what the user means', () => {
  it('describes highlighted notes, chord notes and measures', () => {
    const s = song();
    const chord = s.measures[1].staves[0].voices[0][0];
    const single = s.measures[0].staves[0].voices[0][2];
    const marks: Mark[] = [{ kind: 'note', eventId: chord.id, pitchIdx: 2 }, { kind: 'note', eventId: single.id, pitchIdx: null }, { kind: 'measure', m: 2 }];
    expect(describeMark(s, marks[0])).toEqual({ forModel: 'the note G4 inside the chord at m2, S1 treble, 1st token "C4+E4+G4/h~"', label: 'G4 in chord, m. 2' });
    expect(describeMark(s, marks[1])?.forModel).toBe('the note at m1, S1 treble, 3rd token "E4/q"');
    expect(describeMark(s, marks[2])?.label).toBe('Measure 3');
    expect(describeMark(s, { kind: 'note', eventId: 'gone', pitchIdx: null })).toBeNull();
    const req = buildRequest(s, 'remove the tie', marks, 'edit');
    expect(req).toContain('m2\n  S1 treble: C4+E4+G4/h~ C4+E4+G4/h\n  S2 bass: C3/w');
    expect(req).toContain('The user highlighted: the note G4 inside the chord at m2');
    expect(req.trim().endsWith('Request: remove the tie')).toBe(true);
    expect(buildRequest(s, 'chords please', [], 'chords')).not.toContain('detector');
  });

  it('finds measure numbers in the request and sends only nearby measures of a long score', () => {
    expect(mentionedMeasures('in measure 25 and bars 3-5, also m. 7', 30)).toEqual([25, 3, 4, 5, 7]);
    const long = make(Array.from({ length: 200 }, () => [['C4/w'], ['C3/w']]));
    expect(measuresToSend(long, 'fix measure 150', [])).toEqual([147, 148, 149, 150, 151]);
    expect(measuresToSend(long, 'fix it', [{ kind: 'measure', m: 0 }])).toEqual([0, 1, 2]);
    expect(measuresToSend(song(), 'fix measure 2', [])).toEqual([0, 1, 2]);
  });
});

describe('asking the assistant', () => {
  afterEach(() => vi.unstubAllGlobals());
  const cfg = { baseUrl: 'https://ai.test/v1', apiKey: 'k', model: 'm' };
  const reply = (content: string, status = 200) => new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }), { status });

  it('sends the score and the request and reads the answer', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => reply('```json\n{"reply":"Changed C to C sharp.","measures":[{"m":1,"staves":[["C#4/q D4/q E4/q F4/q"],["C3/w"]]}]}\n```'));
    vi.stubGlobal('fetch', fetchMock);
    const a = await askAssistant(cfg, song(), 'make the first C sharp', [], { history: [{ ask: 'earlier', reply: 'ok' }] });
    expect(a.reply).toBe('Changed C to C sharp.');
    expect(a.measures[0].staves).toEqual([['C#4/q D4/q E4/q F4/q'], ['C3/w']]);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(fetchMock.mock.calls[0][0]).toBe('https://ai.test/v1/chat/completions');
    expect(body.messages.map((m: { role: string }) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(body.messages[3].content).toContain('Request: make the first C sharp');
  });

  it('treats a plain-words answer as a question and explains failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply('Which C do you mean, the first or the second?')));
    const a = await askAssistant(cfg, song(), 'change the C', []);
    expect(a.reply).toMatch(/Which C/);
    expect(a.measures).toEqual([]);
    vi.stubGlobal('fetch', vi.fn(async () => reply('', 401)));
    await expect(askAssistant(cfg, song(), 'x', [])).rejects.toThrow(/key was rejected/);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
    await expect(askAssistant(cfg, song(), 'x', [])).rejects.toThrow(/Could not reach/);
    await expect(askAssistant({ ...cfg, apiKey: '' }, song(), 'x', [])).rejects.toThrow(/Add an AI key/);
  });
});

describe('where chord symbols are written', () => {
  it('puts each symbol at the note it belongs to and keeps the exact beat in the file', async () => {
    const { toMusicXML } = await import('../src/model/musicxml');
    const s = make([[['C4/q D4/q E4/h'], ['C3/w']]]);
    s.measures[0].chords = [{ beat: 1, text: 'C' }, { beat: 3, text: 'F/C' }, { beat: 4, text: 'G7' }];
    const drawn = toMusicXML(s, { chordText: true }).xml.replace(/\n/g, '');
    // third symbol has no note of its own, so it shares the label of the nearest one
    expect(drawn).toMatch(/text="C".*<step>C<\/step>.*<step>D<\/step>.*text="F\/C {2}G7".*<step>E<\/step>/);
    const file = toMusicXML(s).xml.replace(/\n/g, '');
    expect(file).toMatch(/<root-step>C<\/root-step>.*<step>C<\/step>.*<step>D<\/step>.*<root-step>F<\/root-step>.*<root-step>G<\/root-step>.*<offset>96<\/offset>.*<step>E<\/step>/);
  });
});
