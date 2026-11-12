import { ReactNode, useEffect, useRef, useState } from 'react';
import { Icon } from './Icons';
import { INSTRUMENTS } from '../audio/engine';
import { Clef, InstrumentId, Measure, Navigation, Score, cloneScore } from '../model/types';
import { INTERVAL_NAMES, octaveShift, transposeScore } from '../model/transpose';
import { keyName, transposeKey, keyTonicPitchClass } from '../model/pitch';
import { Settings, Engine } from '../storage';
import { COMPAT_PRESETS } from '../omr/openaiCompat';
import { DEFAULT_EXTRAS_MODEL } from '../omr/annotate';
import { detectChords, removeChords } from '../model/chordDetect';
import { AssistantError, applyAnswer, askAssistant } from '../ai/assistant';
import type { CompatConfig } from '../omr/openaiCompat';
import { keyAt, timeAt } from '../model/fix';

export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon.close />
          </button>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  );
}

// ---------------- Parts / mixer ----------------
export function PartsPanel({ score, onChange, onClose }: { score: Score; onChange: (s: Score, record?: boolean) => void; onClose: () => void }) {
  const update = (i: number, patch: Partial<Score['parts'][number]>, record = true) => {
    const s = cloneScore(score);
    Object.assign(s.parts[i], patch);
    onChange(s, record);
  };
  return (
    <Sheet title="Parts & sound" onClose={onClose}>
      {score.parts.map((p, i) => (
        <div className="part-card" key={p.id}>
          <div className="part-row">
            <input className="part-name" value={p.name} onChange={(e) => update(i, { name: e.target.value })} aria-label="Part name" />
            <button className={`chip ${p.muted ? 'on warn' : ''}`} onClick={() => update(i, { muted: !p.muted }, false)} title="Mute">M</button>
            <button className={`chip ${p.solo ? 'on' : ''}`} onClick={() => update(i, { solo: !p.solo }, false)} title="Solo">S</button>
          </div>
          <div className="part-row">
            <label className="mini">Sound</label>
            <select value={p.instrument} onChange={(e) => update(i, { instrument: e.target.value as InstrumentId }, false)}>
              {INSTRUMENTS.map((ins) => (
                <option key={ins.id} value={ins.id}>{ins.label}</option>
              ))}
            </select>
          </div>
          <div className="part-row">
            <label className="mini">Volume</label>
            <input type="range" min={-30} max={6} step={1} value={p.volume} onChange={(e) => update(i, { volume: +e.target.value }, false)} />
            <span className="mono">{p.volume > 0 ? '+' : ''}{p.volume} dB</span>
          </div>
          <div className="part-row">
            <label className="mini">Clefs</label>
            {p.staves.map((st, si) => (
              <select key={si} value={st.clef} onChange={(e) => {
                const s = cloneScore(score);
                s.parts[i].staves[si].clef = e.target.value as Clef;
                onChange(s);
              }}>
                <option value="treble">Treble</option>
                <option value="bass">Bass</option>
                <option value="alto">Alto</option>
                <option value="tenor">Tenor</option>
                <option value="treble8vb">Treble 8vb</option>
              </select>
            ))}
          </div>
          <div className="part-row">
            <label className="check">
              <input type="checkbox" checked={!p.hidden} onChange={(e) => update(i, { hidden: !e.target.checked }, false)} /> Show in score
            </label>
            <span className="grow" />
            <button className="btn sm" onClick={() => onChange(octaveShift(score, -1, [i]))}>Octave ↓</button>
            <button className="btn sm" onClick={() => onChange(octaveShift(score, 1, [i]))}>Octave ↑</button>
          </div>
        </div>
      ))}
    </Sheet>
  );
}

// ---------------- Transpose ----------------
const MAJOR_KEYS = [0, 7, 2, 9, 4, 11, 5, 10, 3, 8, 1, 6]; // pitch classes in a friendly order
export function TransposePanel({ score, onApply, onClose }: { score: Score; onApply: (s: Score) => void; onClose: () => void }) {
  const [semis, setSemis] = useState(0);
  const [partIdx, setPartIdx] = useState<number | 'all'>('all');
  const newKey = transposeKey(score.key, semis);
  const fromPc = keyTonicPitchClass(score.key);
  const apply = () => {
    if (!semis) return onClose();
    onApply(transposeScore(score, semis, partIdx === 'all' ? {} : { parts: [partIdx] }));
    onClose();
  };
  return (
    <Sheet title="Transpose" onClose={onClose}>
      <div className="transpose-dial">
        <button className="icon-btn lg" onClick={() => setSemis((s) => Math.max(-12, s - 1))} aria-label="Down a semitone"><Icon.down /></button>
        <div className="transpose-value">
          <div className="big-num">{semis > 0 ? `+${semis}` : semis}</div>
          <div className="sub">{semis === 0 ? 'semitones' : `${semis > 0 ? 'up' : 'down'} a ${INTERVAL_NAMES[Math.abs(semis)]?.toLowerCase()}`}</div>
        </div>
        <button className="icon-btn lg" onClick={() => setSemis((s) => Math.min(12, s + 1))} aria-label="Up a semitone"><Icon.up /></button>
      </div>
      <div className="field-row">
        <label>To key</label>
        <select
          value={String(keyTonicPitchClass(newKey))}
          onChange={(e) => {
            const target = +e.target.value;
            let d = (((target - fromPc) % 12) + 12) % 12;
            if (d > 6) d -= 12;
            setSemis(d);
          }}
        >
          {MAJOR_KEYS.map((pc) => {
            const f = transposeKey(0, pc);
            return <option key={pc} value={pc}>{keyName(f)}</option>;
          })}
        </select>
      </div>
      <p className="hint">Current key: {keyName(score.key)} → <strong>{keyName(newKey)}</strong></p>
      {score.parts.length > 1 && (
        <div className="field-row">
          <label>Apply to</label>
          <select value={String(partIdx)} onChange={(e) => setPartIdx(e.target.value === 'all' ? 'all' : +e.target.value)}>
            <option value="all">All parts</option>
            {score.parts.map((p, i) => <option key={p.id} value={i}>{p.name} only (no key change)</option>)}
          </select>
        </div>
      )}
      <div className="row-end">
        <button className="btn" onClick={() => setSemis(0)}>Reset</button>
        <button className="btn primary" onClick={apply} disabled={!semis}>Transpose</button>
      </div>
    </Sheet>
  );
}

// ---------------- Score info ----------------
export function InfoPanel({ score, onChange, onClose }: { score: Score; onChange: (s: Score) => void; onClose: () => void }) {
  const [draft, setDraft] = useState({ title: score.title, subtitle: score.subtitle ?? '', composer: score.composer ?? '', lyricist: score.lyricist ?? '', arranger: score.arranger ?? '', tempo: score.tempo, key: score.key });
  const save = () => {
    const s = cloneScore(score);
    s.title = draft.title.trim() || 'Untitled';
    s.subtitle = draft.subtitle.trim() || undefined;
    s.composer = draft.composer.trim() || undefined;
    s.lyricist = draft.lyricist.trim() || undefined;
    s.arranger = draft.arranger.trim() || undefined;
    s.tempo = Math.max(20, Math.min(300, Math.round(draft.tempo) || 100));
    s.key = draft.key;
    onChange(s);
    onClose();
  };
  const text = (k: 'title' | 'subtitle' | 'composer' | 'lyricist' | 'arranger', label: string) => (
    <div className="field">
      <label htmlFor={`f-${k}`}>{label}</label>
      <input id={`f-${k}`} value={draft[k]} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />
    </div>
  );
  return (
    <Sheet title="Score details" onClose={onClose}>
      {text('title', 'Title')}
      {text('subtitle', 'Subtitle')}
      {text('composer', 'Composer')}
      {text('lyricist', 'Lyricist')}
      {text('arranger', 'Arranger')}
      <div className="field-grid">
        <div className="field">
          <label htmlFor="f-tempo">Tempo (♩ per minute)</label>
          <input id="f-tempo" type="number" min={20} max={300} value={draft.tempo} onChange={(e) => setDraft({ ...draft, tempo: +e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="f-key">Key signature</label>
          <select id="f-key" value={draft.key} onChange={(e) => setDraft({ ...draft, key: +e.target.value })}>
            {Array.from({ length: 15 }, (_, i) => i - 7).map((f) => <option key={f} value={f}>{f === 0 ? 'No sharps/flats' : `${Math.abs(f)} ${f > 0 ? 'sharp' : 'flat'}${Math.abs(f) > 1 ? 's' : ''}`} – {keyName(f)}</option>)}
          </select>
        </div>
      </div>
      <p className="hint">Changing the key signature here only changes how notes are written. Use Transpose to change how it sounds.</p>
      {score.notes && score.notes.length > 0 && (
        <div className="notes-box">
          <h3>Scan notes</h3>
          <ul>{score.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
        </div>
      )}
      <div className="row-end">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={save}>Save</button>
      </div>
    </Sheet>
  );
}

// ---------------- Measure tools ----------------
const NAV_OPTIONS: { v: Navigation | ''; label: string }[] = [
  { v: '', label: 'None' }, { v: 'DC', label: 'D.C.' }, { v: 'DCalFine', label: 'D.C. al Fine' }, { v: 'DCalCoda', label: 'D.C. al Coda' },
  { v: 'DS', label: 'D.S.' }, { v: 'DSalFine', label: 'D.S. al Fine' }, { v: 'DSalCoda', label: 'D.S. al Coda' },
];

export function MeasurePanel({ score, m0, m1, onUpdate, onInsert, onDelete, onClear, onCopy, onPaste, canPaste, onChord, onClose }: {
  score: Score; m0: number; m1: number;
  onUpdate: (index: number, patch: Partial<Measure>) => void;
  onInsert: (at: number) => void;
  onDelete: () => void;
  onClear: () => void;
  onCopy: () => void;
  onPaste: () => void;
  canPaste: boolean;
  onChord: (beat: number, text: string) => void;
  onClose: () => void;
}) {
  const m = score.measures[m0];
  const time = timeAt(score)[m0];
  const key = keyAt(score)[m0];
  const [chordBeat, setChordBeat] = useState(1);
  const existing = m.chords?.find((c) => Math.abs(c.beat - chordBeat) < 1e-6)?.text ?? '';
  const [chordText, setChordText] = useState(existing);
  const range = m0 === m1 ? `Measure ${m0 + 1}` : `Measures ${m0 + 1}–${m1 + 1}`;
  return (
    <Sheet title={range} onClose={onClose}>
      <div className="btn-grid">
        <button className="btn" onClick={() => onInsert(m0)}>Insert before</button>
        <button className="btn" onClick={() => onInsert(m1 + 1)}>Insert after</button>
        <button className="btn" onClick={onCopy}>Copy</button>
        <button className="btn" onClick={onPaste} disabled={!canPaste}>Paste</button>
        <button className="btn" onClick={onClear}>Clear notes</button>
        <button className="btn danger" onClick={onDelete} disabled={score.measures.length <= m1 - m0 + 1}>Delete</button>
      </div>
      <h3 className="sub-h">Chord symbol</h3>
      <div className="field-grid">
        <div className="field">
          <label htmlFor="cb">On beat</label>
          <select id="cb" value={chordBeat} onChange={(e) => { const b = +e.target.value; setChordBeat(b); setChordText(m.chords?.find((c) => Math.abs(c.beat - b) < 1e-6)?.text ?? ''); }}>
            {Array.from({ length: time[0] }, (_, i) => i + 1).map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="ct">Symbol</label>
          <input id="ct" placeholder="e.g. Bb7, Gm, D7/F#" value={chordText} onChange={(e) => setChordText(e.target.value)} />
        </div>
      </div>
      <div className="row-end"><button className="btn sm" onClick={() => onChord(chordBeat, chordText)}>Set chord</button></div>

      <h3 className="sub-h">Structure</h3>
      <div className="check-grid">
        <label className="check"><input type="checkbox" checked={!!m.repeatStart} onChange={(e) => onUpdate(m0, { repeatStart: e.target.checked || undefined })} /> Repeat start</label>
        <label className="check"><input type="checkbox" checked={!!score.measures[m1].repeatEnd} onChange={(e) => onUpdate(m1, { repeatEnd: e.target.checked ? 2 : undefined })} /> Repeat end</label>
        <label className="check"><input type="checkbox" checked={!!m.segno} onChange={(e) => onUpdate(m0, { segno: e.target.checked || undefined })} /> Segno 𝄋</label>
        <label className="check"><input type="checkbox" checked={!!m.coda} onChange={(e) => onUpdate(m0, { coda: e.target.checked || undefined })} /> Coda 𝄌</label>
        <label className="check"><input type="checkbox" checked={!!m.fine} onChange={(e) => onUpdate(m0, { fine: e.target.checked || undefined })} /> Fine</label>
        <label className="check"><input type="checkbox" checked={!!m.toCoda} onChange={(e) => onUpdate(m0, { toCoda: e.target.checked || undefined })} /> To Coda</label>
      </div>
      <div className="field-grid">
        <div className="field">
          <label htmlFor="mend">Ending (volta)</label>
          <select id="mend" value={m.ending?.join(',') ?? ''} onChange={(e) => {
            const v = e.target.value;
            for (let i = m0; i <= m1; i++) onUpdate(i, { ending: v ? v.split(',').map(Number) : undefined });
          }}>
            <option value="">None</option><option value="1">1.</option><option value="2">2.</option><option value="3">3.</option><option value="1,2">1., 2.</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="mnav">Jump at end</label>
          <select id="mnav" value={score.measures[m1].navigation ?? ''} onChange={(e) => onUpdate(m1, { navigation: (e.target.value || undefined) as Navigation | undefined })}>
            {NAV_OPTIONS.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="mtempo">Tempo change</label>
          <input id="mtempo" type="number" min={0} max={300} placeholder="—" value={m.tempo ?? ''} onChange={(e) => onUpdate(m0, { tempo: +e.target.value > 0 ? +e.target.value : undefined })} />
        </div>
        <div className="field">
          <label htmlFor="mkey">Key change</label>
          <select id="mkey" value={m.key === undefined ? 'none' : String(m.key)} onChange={(e) => onUpdate(m0, { key: e.target.value === 'none' ? undefined : +e.target.value })}>
            <option value="none">— (currently {keyName(key).split(' /')[0]})</option>
            {Array.from({ length: 15 }, (_, i) => i - 7).map((f) => <option key={f} value={f}>{keyName(f)}</option>)}
          </select>
        </div>
      </div>
      <div className="field">
        <label htmlFor="mtext">Text (e.g. rit., a tempo)</label>
        <input id="mtext" value={m.text ?? ''} onChange={(e) => onUpdate(m0, { text: e.target.value || undefined })} />
      </div>
    </Sheet>
  );
}

// ---------------- Settings ----------------
export function SettingsPanel({ settings, onChange, onClose, serverKey, audiveris }: { settings: Settings; onChange: (s: Settings) => void; onClose: () => void; serverKey: boolean; audiveris?: boolean }) {
  const [show, setShow] = useState(false);
  const preset = COMPAT_PRESETS.find((p) => p.id === settings.compatPreset) ?? COMPAT_PRESETS[0];
  return (
    <Sheet title="Settings" onClose={onClose}>
      <h3 className="sub-h">Music recognition</h3>
      <div className="field">
        <label htmlFor="engine">Read photos with</label>
        <select id="engine" value={settings.engine} onChange={(e) => onChange({ ...settings, engine: e.target.value as Engine })}>
          <option value="local">This device – free, private, no key</option>
          <option value="claude">Claude</option>
          <option value="compat">OpenRouter / DeepInfra / other AI model</option>
          <option value="audiveris">Audiveris – free, algorithmic{audiveris ? '' : ' (not installed on server)'}</option>
        </select>
      </div>
      {settings.engine === 'local' && (
        <p className="hint">
          Photos are read on this device by <a href="https://github.com/liebharc/homr" target="_blank" rel="noreferrer">homr</a>, so nothing is uploaded and there is nothing to pay. It reads notes and rhythms well, but not the title, tempo, chord symbols or lyrics – an AI model can add those (below). The first scan downloads the reader (about 200 MB, kept for next time); after that a page takes roughly 1–3 minutes. It needs a fairly recent phone or computer.
        </p>
      )}
      {settings.engine === 'local' && (
        <label className="check"><input type="checkbox" checked={settings.localExtras} onChange={(e) => onChange({ ...settings, localExtras: e.target.checked })} /> Add the title, tempo, chord symbols and lyrics with an AI model</label>
      )}
      {settings.engine === 'local' && settings.localExtras && (
        <>
          <div className="check-group">
            <label className="check"><input type="checkbox" checked={settings.extrasInfo} onChange={(e) => onChange({ ...settings, extrasInfo: e.target.checked })} /> Title, composer and tempo</label>
            <label className="check"><input type="checkbox" checked={settings.extrasChords} onChange={(e) => onChange({ ...settings, extrasChords: e.target.checked })} /> Chord symbols</label>
            <label className="check"><input type="checkbox" checked={settings.extrasLyrics} onChange={(e) => onChange({ ...settings, extrasLyrics: e.target.checked })} /> Lyrics</label>
          </div>
          <p className="hint">For this the photo is sent to the service below, with your key. It costs roughly 5–15 cents a page with the default model. Without a key, only the notes are read.</p>
        </>
      )}
      {settings.engine === 'claude' && (
        <>
          <div className="field">
            <label htmlFor="apikey">Claude API key</label>
            <div className="input-with-btn">
              <input id="apikey" type={show ? 'text' : 'password'} autoComplete="off" placeholder={serverKey ? 'Using the server’s key' : 'sk-ant-…'} value={settings.apiKey} onChange={(e) => onChange({ ...settings, apiKey: e.target.value })} />
              <button className="btn sm" onClick={() => setShow((x) => !x)}>{show ? 'Hide' : 'Show'}</button>
            </div>
            <p className="hint">
              {serverKey ? 'This server already has a key, so this is optional. ' : 'Needed to scan photos. '}
              Your key is stored only in this browser and sent only to Anthropic. Get one at console.anthropic.com.
            </p>
          </div>
          <div className="field-grid">
            <div className="field">
              <label htmlFor="model">Model</label>
              <select id="model" value={settings.model} onChange={(e) => onChange({ ...settings, model: e.target.value })}>
                <option value="claude-opus-5-5">Claude Opus 5.5 (best)</option>
                <option value="claude-sonnet-5-5">Claude Sonnet 5.5 (cheaper)</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="effort">Accuracy</label>
              <select id="effort" value={settings.effort} onChange={(e) => onChange({ ...settings, effort: e.target.value as Settings['effort'] })}>
                <option value="medium">Quick</option>
                <option value="high">Careful</option>
                <option value="xhigh">Very careful</option>
              </select>
            </div>
          </div>
        </>
      )}
      {(settings.engine === 'compat' || (settings.engine === 'local' && settings.localExtras)) && (
        <>
          <div className="field">
            <label htmlFor="preset">Service</label>
            <select id="preset" value={settings.compatPreset} onChange={(e) => {
              const p = COMPAT_PRESETS.find((x) => x.id === e.target.value)!;
              onChange({ ...settings, compatPreset: p.id, compatBaseUrl: p.baseUrl || settings.compatBaseUrl });
            }}>
              {COMPAT_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </div>
          {preset.id === 'custom' && (
            <div className="field">
              <label htmlFor="cbase">API address</label>
              <input id="cbase" placeholder="https://…/v1" value={settings.compatBaseUrl} onChange={(e) => onChange({ ...settings, compatBaseUrl: e.target.value })} />
            </div>
          )}
          <div className="field">
            <label htmlFor="cmodel">Model (must accept images)</label>
            <input id="cmodel" autoCapitalize="off" autoCorrect="off" placeholder={settings.engine === 'local' && preset.id === 'openrouter' ? `${DEFAULT_EXTRAS_MODEL} (used if left empty)` : preset.example} value={settings.compatModel} onChange={(e) => onChange({ ...settings, compatModel: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="ckey">API key</label>
            <div className="input-with-btn">
              <input id="ckey" type={show ? 'text' : 'password'} autoComplete="off" value={settings.compatKey} onChange={(e) => onChange({ ...settings, compatKey: e.target.value })} />
              <button className="btn sm" onClick={() => setShow((x) => !x)}>{show ? 'Hide' : 'Show'}</button>
            </div>
            <p className="hint">Stored only in this browser and sent only to that service.{settings.engine === 'local' ? '' : ' Reading sheet music is hard: smaller open models make many more mistakes than Claude, so expect more fixing.'}</p>
          </div>
        </>
      )}
      {settings.engine === 'audiveris' && (
        <p className="hint">
          {audiveris
            ? 'Audiveris is installed on this server. It is free and works best on clean, flat scans or PDFs; phone photos with curl or shadows, lyrics and chord symbols are harder for it.'
            : 'Audiveris runs on the app’s server, not in the browser. Install it on the computer running “npm start” and set AUDIVERIS_CMD – see the README. It is not available on the GitHub Pages version.'}
        </p>
      )}
      <h3 className="sub-h">Playback</h3>
      <label className="check"><input type="checkbox" checked={settings.humanize} onChange={(e) => onChange({ ...settings, humanize: e.target.checked })} /> Human feel (tiny timing & touch variations)</label>
      <label className="check"><input type="checkbox" checked={settings.playChords} onChange={(e) => onChange({ ...settings, playChords: e.target.checked })} /> Also play chord symbols</label>
      <h3 className="sub-h">Display</h3>
      <label className="check"><input type="checkbox" checked={settings.showChords} onChange={(e) => onChange({ ...settings, showChords: e.target.checked })} /> Show chord symbols</label>
      <label className="check"><input type="checkbox" checked={settings.showLyrics} onChange={(e) => onChange({ ...settings, showLyrics: e.target.checked })} /> Show lyrics</label>
      <h3 className="sub-h">About</h3>
      <p className="hint">Piano samples: Salamander Grand Piano by Alexander Holm (CC BY 3.0). Notation rendering: OpenSheetMusicDisplay. Sound: Tone.js. On-device music reading: homr by Christian Liebhardt and contributors (AGPL-3.0), run with Pyodide and ONNX Runtime.</p>
    </Sheet>
  );
}

// ---------------- Chords ----------------
export function ChordsPanel({ score, onApply, onClose, playChords, setPlayChords, ai }: { score: Score; onApply: (s: Score, msg: string) => void; onClose: () => void; playChords: boolean; setPlayChords: (b: boolean) => void; ai: CompatConfig | null }) {
  const has = score.measures.some((m) => m.chords?.length);
  const [granularity, setGranularity] = useState<'auto' | 'measure' | 'beat'>('auto');
  const [overwrite, setOverwrite] = useState(!has);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  const writeWithAi = async () => {
    if (!ai) return;
    const ctl = new AbortController();
    abort.current = ctl;
    setBusy(true);
    setError(null);
    try {
      const answer = await askAssistant(ai, score, 'Write the chord symbols for the whole piece.', [], { mode: 'chords', signal: ctl.signal });
      // without "replace", measures that already have chord symbols are left alone
      if (!overwrite) answer.measures = answer.measures.filter((m) => !score.measures[m.m - 1]?.chords?.length);
      const res = applyAnswer(score, answer, 'chords');
      if (res.unchanged) setError(answer.reply || 'The AI model did not suggest any chord symbols.');
      else {
        const n = res.changed.reduce((a, i) => a + (res.score.measures[i].chords?.length ?? 0), 0);
        onApply(res.score, `Wrote ${n} chord symbol${n === 1 ? '' : 's'} – check them by ear`);
        onClose();
      }
    } catch (e) {
      if (!ctl.signal.aborted) setError(e instanceof AssistantError ? e.message : 'Something went wrong. Nothing was changed.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet title="Chord symbols" onClose={onClose}>
      <p className="hint">
        Work out chord names (like <strong>Gm7</strong> or <strong>D7/F♯</strong>) from the notes in each measure. They appear above the staff,
        follow transposition, and you can edit any of them with Measure tools. Printed chord symbols are already read when you scan.
      </p>
      <div className="field">
        <label htmlFor="gran">How often</label>
        <select id="gran" value={granularity} onChange={(e) => setGranularity(e.target.value as typeof granularity)}>
          <option value="auto">Automatic (up to two per measure)</option>
          <option value="measure">One per measure</option>
          <option value="beat">Every beat (busy)</option>
        </select>
      </div>
      {has && <label className="check"><input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} /> Replace the existing chord symbols (otherwise only fill measures without any)</label>}
      <label className="check"><input type="checkbox" checked={playChords} onChange={(e) => setPlayChords(e.target.checked)} /> Play chord symbols softly during playback</label>
      <div className="row-end">
        {has && <button className="btn danger" onClick={() => { onApply(removeChords(score), 'Chord symbols removed'); onClose(); }}>Remove all</button>}
        <button className="btn primary" onClick={() => {
          const { score: s, added } = detectChords(score, { granularity, overwrite });
          onApply(s, added ? `Added ${added} chord symbol${added === 1 ? '' : 's'}` : 'No chords found');
          onClose();
        }} disabled={busy}>Detect chords</button>
      </div>
      <h3 className="sub-h">With AI</h3>
      <p className="hint">
        An AI model reads the notes and writes the chords a musician would, without looking at the detector’s guesses. It is better at slash chords,
        added-note chords and quick changes. {ai ? 'The notes of the score are sent to the AI service set in Settings.' : 'Needs an AI key – add one in Settings.'}
      </p>
      {error && <p className="hint" role="alert" style={{ color: 'var(--danger)' }}>{error}</p>}
      <div className="row-end">
        {busy && <button className="btn" onClick={() => abort.current?.abort()}>Stop</button>}
        <button className="btn primary" onClick={() => void writeWithAi()} disabled={!ai || busy}>{busy ? 'Writing chords…' : 'Write chords with AI'}</button>
      </div>
    </Sheet>
  );
}
