import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './Icons';
import { ScoreView, ScoreViewHandle, Selection } from './ScoreView';
import { ScanView } from './ScanView';
import { Library } from './Library';
import { EditPalette, EditAction } from './EditPalette';
import { Transport } from './Transport';
import { AssistantBar, AssistantNote } from './AssistantBar';
import { AssistantError, Mark, Turn, applyAnswer, askAssistant, assistantConfig, sameMark } from '../ai/assistant';
import { ChordsPanel, InfoPanel, MeasurePanel, PartsPanel, SettingsPanel, TransposePanel, Sheet } from './Panels';
import { PrintView } from './PrintView';
import { PerformView } from './PerformView';
import { FindMusic } from './FindMusic';
import { importFile as importAnyFile } from '../importers';
import { useScoreStore } from './useScoreStore';
import { engine } from '../audio/engine';
import { buildPlan, PlaybackPlan } from '../model/playback';
import { toMusicXML } from '../model/musicxml';
import { toMidi } from '../model/midi';
import { Measure, NoteEvent, Score, displayScore, newId } from '../model/types';
import { keyAt } from '../model/fix';
import { midiOf } from '../model/pitch';
import {
  addInterval, addVoice, changePitch, clearMeasures, copyMeasures, deleteMeasures, findEvent, getEvent, insertMeasures, neighborEvent,
  pasteMeasures, setAccidental, setChordSymbol, setDuration, setDynamic, setLetter, setLyric, toRest, toggleArtic, toggleDot, toggleTie,
  updateMeasure, verticalNeighbor,
} from '../model/edit';
import { DEFAULT_SETTINGS, Settings, deleteScore, listLibrary, loadScore, loadSettings, saveScore, saveSettings } from '../storage';
import { serverInfo } from '../omr/client';
import { demoScore } from '../demo';

type Panel = null | 'parts' | 'transpose' | 'info' | 'settings' | 'measure' | 'export' | 'help' | 'chords';
type PlayState = 'stopped' | 'playing' | 'paused';

function download(name: string, data: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function fileSafe(s: string) {
  return (s || 'score').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'score';
}

function fmtTime(sec: number) {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function App() {
  const store = useScoreStore();
  const score = store.score;
  const [view, setView] = useState<'library' | 'scan' | 'score' | 'print' | 'perform' | 'find'>('library');
  const [scanFiles, setScanFiles] = useState<File[] | undefined>(undefined);
  const [audiveris, setAudiveris] = useState(false);
  const [settings, setSettingsState] = useState<Settings>(loadSettings);
  const shown = useMemo(() => (score ? displayScore(score, { chords: settings.showChords, lyrics: settings.showLyrics }) : null), [score, settings.showChords, settings.showLyrics]);
  const [library, setLibrary] = useState(listLibrary);
  const [sel, setSel] = useState<Selection | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const [chordMode, setChordMode] = useState(false);
  const [serverKey, setServerKey] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [notesOpen, setNotesOpen] = useState(true);
  const [moreOpen, setMoreOpen] = useState(false);
  const [assistOpen, setAssistOpen] = useState(false);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [assistBusy, setAssistBusy] = useState(false);
  const [assistNote, setAssistNote] = useState<AssistantNote | null>(null);
  const [changed, setChanged] = useState<number[]>([]);
  const assistHistory = useRef<Turn[]>([]);
  const assistAbort = useRef<AbortController | null>(null);

  const [playState, setPlayState] = useState<PlayState>('stopped');
  const [loadingAudio, setLoadingAudio] = useState(false);
  const [speed, setSpeedState] = useState(1);
  const [metronome, setMetronome] = useState(false);
  const [loop, setLoop] = useState(false);
  const [countIn, setCountIn] = useState(false);
  const [posLabel, setPosLabel] = useState('0:00');
  const [progress, setProgress] = useState(0);
  const planRef = useRef<PlaybackPlan | null>(null);
  const planScoreRef = useRef<Score | null>(null);
  const viewRef = useRef<ScoreViewHandle>(null);
  const clipboard = useRef<Measure[] | null>(null);

  useEffect(() => {
    void serverInfo().then((i) => {
      setServerKey(i.serverKey);
      setAudiveris(i.audiveris);
    });
  }, []);

  const setSettings = useCallback((s: Settings) => {
    setSettingsState(s);
    saveSettings(s);
  }, []);

  const flash = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((t) => (t === msg ? null : t)), 2600);
  }, []);

  // autosave
  useEffect(() => {
    if (!score) return;
    const t = setTimeout(() => {
      if (!saveScore(score)) flash('Could not save – browser storage is full.');
      setLibrary(listLibrary());
    }, 500);
    return () => clearTimeout(t);
  }, [score, flash]);

  const openScore = useCallback((s: Score) => {
    engine.stop();
    planRef.current = null;
    planScoreRef.current = null;
    setProgress(0);
    setPosLabel('0:00');
    setPlayState('stopped');
    store.replace(s);
    setSel(null);
    setEditMode(false);
    setNotesOpen(true);
    assistAbort.current?.abort();
    setAssistOpen(false);
    setMarks([]);
    setChanged([]);
    setAssistNote(null);
    assistHistory.current = [];
    setView('score');
  }, [store]);

  // ---------------- playback ----------------
  const loopRange = useCallback((): [number, number] | undefined => {
    if (!loop || !sel) return undefined;
    return [sel.m0, sel.m1];
  }, [loop, sel]);

  const makePlan = useCallback(
    (s: Score) => buildPlan(s, { range: loopRange(), humanize: settings.humanize, playChords: settings.playChords }),
    [loopRange, settings.humanize, settings.playChords],
  );

  const startAt = useCallback(
    (from: number, overrides: Partial<{ metronome: boolean; loop: boolean; countIn: boolean; speed: number }> = {}, s = score) => {
      if (!s) return;
      const plan = makePlan(s);
      planRef.current = plan;
      planScoreRef.current = s;
      engine.onStall = () => {
        setPlayState('paused');
        flash('The sound was interrupted – tap play to continue.');
      };
      engine.onEnd = () => {
        setPlayState('stopped');
        viewRef.current?.setPlaying(new Set(), null, false);
        setProgress(0);
        setPosLabel('0:00');
      };
      engine.play(plan, Math.min(from, Math.max(0, plan.duration - 0.01)), {
        speed: overrides.speed ?? speed,
        metronome: overrides.metronome ?? metronome,
        countIn: overrides.countIn ?? false,
        loop: overrides.loop ?? loop,
      }, []);
      setPlayState('playing');
    },
    [makePlan, score, speed, metronome, loop],
  );

  const togglePlay = useCallback(async () => {
    if (!score) return;
    if (playState === 'playing') {
      engine.pause();
      setPlayState('paused');
      return;
    }
    setLoadingAudio(true);
    try {
      await engine.init();
      engine.configureParts(score.parts);
      await engine.ready();
    } catch (e) {
      console.error(e);
      flash(e instanceof Error && e.message === 'AUDIO_ASLEEP' ? 'The sound did not wake up – tap play again.' : 'Could not start audio.');
      setLoadingAudio(false);
      return;
    } finally {
      setLoadingAudio(false);
    }
    let from = 0;
    if (playState === 'paused') from = engine.pausedAt;
    else if (sel && !loop) {
      const plan = makePlan(score);
      from = plan.measures.find((m) => m.measure === sel.m0)?.time ?? 0;
    }
    startAt(from, { countIn });
  }, [score, playState, sel, loop, countIn, makePlan, startAt, flash]);

  const stop = useCallback(() => {
    engine.stop();
    setPlayState('stopped');
    viewRef.current?.setPlaying(new Set(), null, false);
    setProgress(0);
    setPosLabel('0:00');
  }, []);

  // keep engine part settings in sync
  useEffect(() => {
    if (score) engine.configureParts(score.parts);
  }, [score]);

  // restart with a new plan when the score or loop settings change while playing
  useEffect(() => {
    if (playState !== 'playing' || !score) return;
    if (planScoreRef.current === score) return;
    startAt(engine.position());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [score]);

  // animation loop for highlighting
  useEffect(() => {
    if (playState !== 'playing') return;
    let raf = 0;
    let lastLabel = 0;
    const step = () => {
      const plan = planRef.current;
      if (plan) {
        const pos = engine.position();
        const ids = new Set<string>();
        // spans are sorted by start; look back a bounded window
        let lo = 0;
        let hi = plan.spans.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (plan.spans[mid].time <= pos) lo = mid + 1;
          else hi = mid;
        }
        for (let i = lo - 1; i >= 0 && i >= lo - 400; i--) {
          const sp = plan.spans[i];
          if (sp.end > pos) ids.add(sp.eventId);
          if (pos - sp.time > 8) break;
        }
        const ms = plan.measures;
        let mIdx: number | null = null;
        let a = 0;
        let b = ms.length - 1;
        while (a <= b) {
          const mid = (a + b) >> 1;
          if (ms[mid].time <= pos) {
            mIdx = mid;
            a = mid + 1;
          } else b = mid - 1;
        }
        const measure = mIdx !== null && pos < plan.duration ? ms[mIdx].measure : null;
        viewRef.current?.setPlaying(ids, measure, true);
        const now = performance.now();
        if (now - lastLabel > 200) {
          lastLabel = now;
          setPosLabel(`${measure !== null ? `m. ${measure + 1} · ` : ''}${fmtTime(pos / speed)} / ${fmtTime(plan.duration / speed)}`);
          setProgress(plan.duration ? Math.min(1, pos / plan.duration) : 0);
        }
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playState, speed]);

  const setSpeed = useCallback((s: number) => {
    setSpeedState(s);
    engine.setSpeed(s);
  }, []);

  const changeTransportToggle = (kind: 'metronome' | 'loop', value: boolean) => {
    if (kind === 'metronome') setMetronome(value);
    else setLoop(value);
    if (playState === 'playing') {
      const pos = engine.position();
      // loop changes the plan when a range is selected
      setTimeout(() => startAt(kind === 'loop' && value && sel ? 0 : pos, { [kind]: value }), 0);
    }
  };

  const seek = useCallback((frac: number) => {
    const plan = planRef.current ?? (score ? makePlan(score) : null);
    if (!plan || !score) return;
    const t = frac * plan.duration;
    if (playState === 'playing') startAt(t);
    else {
      engine.pausedAt = t;
      planRef.current = plan;
      planScoreRef.current = score;
      setPlayState('paused');
      setProgress(frac);
      setPosLabel(`${fmtTime(t / speed)} / ${fmtTime(plan.duration / speed)}`);
    }
  }, [makePlan, playState, score, speed, startAt]);

  // ---------------- editing ----------------
  const selectedEvent: NoteEvent | null = useMemo(() => {
    if (!score || !sel?.eventId) return null;
    const loc = findEvent(score, sel.eventId);
    return loc ? getEvent(score, loc) ?? null : null;
  }, [score, sel]);

  const commit = useCallback((next: Score, opts: { preview?: string | null } = {}) => {
    if (!score || next === score) return;
    store.set(next);
    if (opts.preview) {
      const loc = findEvent(next, opts.preview);
      const e = loc ? getEvent(next, loc) : null;
      if (e && !e.rest) {
        const part = next.parts[0];
        void engine.init().then(() => engine.preview(e.pitches.map(midiOf), part?.instrument === 'voice' ? 'piano' : part?.instrument)).catch(() => undefined);
      }
    }
  }, [score, store]);

  const nearMidiFor = useCallback((s: Score, id: string): number => {
    const loc = findEvent(s, id);
    if (!loc) return 67;
    const e = getEvent(s, loc)!;
    if (!e.rest && e.pitches.length) return midiOf(e.pitches[e.pitches.length - 1]);
    let cur: string | null = id;
    for (let k = 0; k < 32 && cur; k++) {
      cur = neighborEvent(s, cur, -1);
      if (!cur) break;
      const l2 = findEvent(s, cur);
      const e2 = l2 ? getEvent(s, l2) : null;
      if (e2 && !e2.rest && e2.pitches.length) return midiOf(e2.pitches[e2.pitches.length - 1]);
    }
    let staffIdx = loc.s;
    for (const p of s.parts) {
      if (staffIdx < p.staves.length) return p.staves[staffIdx].clef === 'bass' ? 50 : 71;
      staffIdx -= p.staves.length;
    }
    return 67;
  }, []);

  const selectEvent = useCallback((s: Score, id: string | null) => {
    if (!id) return;
    const loc = findEvent(s, id);
    if (!loc) return;
    setSel({ eventId: id, pitchIdx: null, m0: loc.m, m1: loc.m });
  }, []);

  const onAction = useCallback((a: EditAction) => {
    if (!score) return;
    if (a.type === 'measure') {
      if (sel) setPanel('measure');
      return;
    }
    const id = sel?.eventId;
    if (!id) return;
    const e = selectedEvent;
    if (!e) return;
    const pIdx = sel?.pitchIdx ?? null;
    switch (a.type) {
      case 'dur':
        return commit(setDuration(score, id, a.dur, 0, !!e.triplet));
      case 'dot':
        return commit(toggleDot(score, id));
      case 'triplet':
        return commit(setDuration(score, id, e.dur, 0, !e.triplet));
      case 'rest':
        return commit(toRest(score, id));
      case 'step':
        return commit(changePitch(score, id, pIdx, 'diatonic', a.amount), { preview: id });
      case 'semi':
        return commit(changePitch(score, id, pIdx, 'chromatic', a.amount), { preview: id });
      case 'octave':
        return commit(changePitch(score, id, pIdx, 'octave', a.amount), { preview: id });
      case 'acc':
        return commit(setAccidental(score, id, pIdx, a.alter), { preview: id });
      case 'letter': {
        const next = setLetter(score, id, pIdx, a.step, nearMidiFor(score, id), a.chord);
        commit(next, { preview: id });
        if (!a.chord && e.rest && editMode) {
          // when filling in rests, move on to the next slot
          const nid = neighborEvent(next, id, 1);
          if (nid) selectEvent(next, nid);
        }
        return;
      }
      case 'interval':
        return commit(addInterval(score, id, a.steps), { preview: id });
      case 'tie':
        return commit(toggleTie(score, id));
      case 'artic':
        return commit(toggleArtic(score, id, a.artic));
      case 'slur': {
        const s2 = structuredClone(score);
        const loc = findEvent(s2, id)!;
        const ev = getEvent(s2, loc)!;
        if (!ev.slurStart && !ev.slurEnd) ev.slurStart = true;
        else if (ev.slurStart) {
          delete ev.slurStart;
          ev.slurEnd = true;
        } else delete ev.slurEnd;
        return commit(s2);
      }
      case 'dynamic':
        return commit(setDynamic(score, id, a.dynamic));
      case 'lyric': {
        const t = prompt('Lyric syllable (end with "-" if the word continues):', e.lyric ?? '');
        if (t !== null) commit(setLyric(score, id, t));
        return;
      }
      case 'prev':
      case 'next':
        return selectEvent(score, neighborEvent(score, id, a.type === 'next' ? 1 : -1));
      case 'voice2': {
        const r = addVoice(score, id);
        if (r.score !== score) commit(r.score);
        if (r.firstId) selectEvent(r.score, r.firstId);
        return;
      }
    }
  }, [score, sel, selectedEvent, commit, nearMidiFor, selectEvent, editMode]);

  // keyboard shortcuts
  useEffect(() => {
    if (view !== 'score') return;
    const onKey = (ev: KeyboardEvent) => {
      const t = ev.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (panel) {
        if (ev.key === 'Escape') setPanel(null);
        return;
      }
      const mod = ev.ctrlKey || ev.metaKey;
      if (ev.key === ' ') {
        ev.preventDefault();
        void togglePlay();
        return;
      }
      if (mod && ev.key.toLowerCase() === 'z') {
        ev.preventDefault();
        if (ev.shiftKey) store.redo();
        else store.undo();
        return;
      }
      if (mod && ev.key.toLowerCase() === 'y') {
        ev.preventDefault();
        store.redo();
        return;
      }
      if (ev.key === 'Escape') {
        setSel(null);
        return;
      }
      if (!score || !sel) return;
      if (mod && ev.key.toLowerCase() === 'c') {
        clipboard.current = copyMeasures(score, sel.m0, sel.m1);
        flash(`Copied ${sel.m1 - sel.m0 + 1} measure(s)`);
        return;
      }
      if (mod && ev.key.toLowerCase() === 'v' && clipboard.current) {
        commit(pasteMeasures(score, sel.m0, clipboard.current));
        return;
      }
      if (!sel.eventId) {
        if (ev.key === 'Delete' || ev.key === 'Backspace') commit(clearMeasures(score, sel.m0, sel.m1));
        return;
      }
      const k = ev.key;
      let a: EditAction | null = null;
      if (k === 'ArrowUp' || k === 'ArrowDown') {
        const d = k === 'ArrowUp' ? 1 : -1;
        if (ev.altKey) {
          selectEvent(score, verticalNeighbor(score, sel.eventId, (-d) as 1 | -1));
          ev.preventDefault();
          return;
        }
        a = mod ? { type: 'octave', amount: d } : ev.shiftKey ? { type: 'semi', amount: d } : { type: 'step', amount: d };
      } else if (k === 'ArrowLeft') a = { type: 'prev' };
      else if (k === 'ArrowRight') a = { type: 'next' };
      else if (/^[a-gA-G]$/.test(k) && !mod) a = { type: 'letter', step: k.toUpperCase() as 'C', chord: ev.shiftKey || chordMode };
      else if (/^[1-7]$/.test(k) && !mod) a = { type: 'dur', dur: (['64', '32', '16', '8', 'q', 'h', 'w'] as const)[+k - 1] };
      else if (k === '.') a = { type: 'dot' };
      else if (k === '0' || k === 'Delete' || k === 'Backspace') a = { type: 'rest' };
      else if (k === '+' || k === '=' || k === '#') a = { type: 'acc', alter: 1 };
      else if (k === '-' || k === '_') a = { type: 'acc', alter: -1 };
      else if (k === 'n') a = { type: 'acc', alter: 0 };
      else if (k === 't') a = { type: 'tie' };
      else if (k === 's') a = { type: 'artic', artic: 'staccato' };
      else if (k === '>') a = { type: 'artic', artic: 'accent' };
      else if (k === 'l') a = { type: 'lyric' };
      if (a) {
        ev.preventDefault();
        onAction(a);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [view, panel, score, sel, togglePlay, store, onAction, selectEvent, commit, flash, chordMode]);

  const onSelect = useCallback((s: Selection | null, additive: boolean) => {
    setMoreOpen(false);
    if (assistOpen) {
      // while asking for a change, a tap points at something instead of selecting it
      if (!s || !score) return;
      let mark: Mark = { kind: 'measure', m: s.m0 };
      if (s.eventId) {
        const loc = findEvent(score, s.eventId);
        const e = loc ? getEvent(score, loc) : null;
        mark = { kind: 'note', eventId: s.eventId, pitchIdx: e && e.pitches.length > 1 ? s.pitchIdx : null };
      }
      setMarks((list) => (list.some((x) => sameMark(x, mark)) ? list.filter((x) => !sameMark(x, mark)) : [...list, mark]));
      return;
    }
    if (!s) {
      setSel(null);
      return;
    }
    if (!editMode && s.eventId) s = { ...s, eventId: null, pitchIdx: null };
    if (additive && sel) {
      setSel({ eventId: null, pitchIdx: null, m0: Math.min(sel.m0, s.m0), m1: Math.max(sel.m1, s.m1) });
      return;
    }
    // tapping the already-selected measure in play mode toggles selection off
    if (!editMode && sel && !sel.eventId && sel.m0 === s.m0 && sel.m1 === s.m1) {
      setSel(null);
      return;
    }
    setSel(s);
    if (!editMode && playState === 'playing' && score) {
      const plan = planRef.current;
      const t = plan?.measures.find((m) => m.measure === s.m0)?.time;
      if (t !== undefined && !loop) startAt(t);
    }
    if (editMode && s.eventId && score) {
      const loc = findEvent(score, s.eventId);
      const e = loc ? getEvent(score, loc) : null;
      if (e && !e.rest && engine.state !== 'playing') {
        const midis = s.pitchIdx !== null && e.pitches[s.pitchIdx] ? [midiOf(e.pitches[s.pitchIdx])] : e.pitches.map(midiOf);
        void engine.init().then(() => engine.preview(midis)).catch(() => undefined);
      }
    }
  }, [editMode, sel, playState, score, loop, startAt, assistOpen]);

  // ---------------- asking for a change ----------------
  const aiConfig = useMemo(() => assistantConfig(settings), [settings]);

  const openAssistant = useCallback(() => {
    setMoreOpen(false);
    setAssistOpen(true);
    setAssistNote(null);
    setChanged([]);
    // what was selected becomes the first highlight
    if (sel && score) {
      const first: Mark[] = [];
      if (sel.eventId) {
        const loc = findEvent(score, sel.eventId);
        const e = loc ? getEvent(score, loc) : null;
        first.push({ kind: 'note', eventId: sel.eventId, pitchIdx: e && e.pitches.length > 1 ? sel.pitchIdx : null });
      } else for (let m = sel.m0; m <= sel.m1 && m < sel.m0 + 16; m++) first.push({ kind: 'measure', m });
      setMarks(first);
    }
    setSel(null);
  }, [sel, score]);

  const closeAssistant = useCallback(() => {
    assistAbort.current?.abort();
    setAssistOpen(false);
    setMarks([]);
    setChanged([]);
    setAssistBusy(false);
  }, []);

  const sendToAssistant = useCallback(async (text: string) => {
    if (!score || !aiConfig) return;
    const ctl = new AbortController();
    assistAbort.current = ctl;
    setAssistBusy(true);
    setAssistNote(null);
    setChanged([]);
    try {
      const answer = await askAssistant(aiConfig, score, text, marks, { history: assistHistory.current, signal: ctl.signal });
      const res = applyAnswer(score, answer);
      const reply = answer.reply || (res.unchanged ? 'Nothing was changed.' : 'Done.');
      assistHistory.current = [...assistHistory.current, { ask: text, reply }].slice(-6);
      if (!res.unchanged) {
        store.set(res.score);
        setChanged(res.changed);
        setMarks([]);
      }
      setAssistNote({ kind: 'reply', text: reply, problems: res.problems, canUndo: !res.unchanged });
    } catch (e) {
      if (ctl.signal.aborted) setAssistNote({ kind: 'reply', text: 'Stopped. Nothing was changed.' });
      else setAssistNote({ kind: 'error', text: e instanceof AssistantError ? e.message : 'Something went wrong. Nothing was changed.' });
    } finally {
      setAssistBusy(false);
    }
  }, [score, aiConfig, marks, store]);

  // ---------------- import / export ----------------
  const importFile = async (f: File) => {
    try {
      flash('Opening…');
      const r = await importAnyFile(f);
      if (r.kind === 'images') {
        setScanFiles(r.files);
        setView('scan');
        return;
      }
      r.scores.forEach((s) => saveScore(s));
      setLibrary(listLibrary());
      openScore(r.scores[0]);
      flash(r.scores.length > 1 ? `Imported ${r.scores.length} pieces` : 'Imported');
    } catch (e) {
      flash(e instanceof Error ? e.message : 'Could not open that file.');
    }
  };

  const exportAs = (kind: 'musicxml' | 'midi' | 'json' | 'print') => {
    if (!score) return;
    setMoreOpen(false);
    const name = fileSafe(score.title);
    if (kind === 'musicxml') download(`${name}.musicxml`, toMusicXML(score, { includeHidden: true }).xml, 'application/vnd.recordare.musicxml+xml');
    if (kind === 'midi') download(`${name}.mid`, toMidi(score, buildPlan(score, { humanize: false })) as BlobPart, 'audio/midi');
    if (kind === 'json') download(`${name}.smp.json`, JSON.stringify(score), 'application/json');
    if (kind === 'print') {
      stop();
      setView('print');
    }
  };

  // ---------------- render ----------------
  if (view === 'scan') {
    return (
      <>
        <ScanView
          initialFiles={scanFiles}
          settings={settings}
          onSettings={setSettings}
          onCancel={() => { setScanFiles(undefined); setView(score ? 'score' : 'library'); }}
          onNeedKey={() => setPanel('settings')}
          onDone={(scores) => {
            setScanFiles(undefined);
            scores.forEach((s) => saveScore(s));
            setLibrary(listLibrary());
            openScore(scores[0]);
            if (scores.length > 1) flash(`${scores.length} pieces saved to your library`);
          }}
        />
        {panel === 'settings' && <SettingsPanel settings={settings} onChange={setSettings} onClose={() => setPanel(null)} serverKey={serverKey} audiveris={audiveris} />}
      </>
    );
  }

  if (view === 'find') {
    return (
      <>
        <FindMusic onBack={() => setView('library')} onOpen={(s) => { saveScore(s); setLibrary(listLibrary()); openScore(s); }} onImportFile={importFile} />
        {toast && <div className="toast">{toast}</div>}
      </>
    );
  }

  if (view === 'print' && score) return <PrintView score={shown ?? score} onBack={() => setView('score')} />;

  if (view === 'perform' && score)
    return <PerformView score={shown ?? score} settings={settings} startMeasure={sel?.m0} onExit={() => setView('score')} />;

  if (view === 'library' || !score) {
    return (
      <>
        <Library
          entries={library}
          needsKey={settings.engine === 'local' ? false : settings.engine === 'claude' ? !serverKey && !settings.apiKey : settings.engine === 'compat' ? !settings.compatKey : !audiveris}
          onFind={() => setView('find')}
          onOpen={(id) => {
            const s = loadScore(id);
            if (s) openScore(s);
            else flash('Could not open that score.');
          }}
          onDelete={(id) => {
            deleteScore(id);
            setLibrary(listLibrary());
          }}
          onScan={() => { setScanFiles(undefined); setView('scan'); }}
          onDemo={() => openScore(demoScore())}
          onImport={importFile}
          onSettings={() => setPanel('settings')}
        />
        {panel === 'settings' && <SettingsPanel settings={settings} onChange={setSettings} onClose={() => setPanel(null)} serverKey={serverKey} audiveris={audiveris} />}
        {toast && <div className="toast">{toast}</div>}
      </>
    );
  }

  const zoom = settings.zoom;
  const key = keyAt(score)[sel?.m0 ?? 0];
  void key;

  return (
    <div className="app">
      <header className="topbar">
        <button className="icon-btn" onClick={() => { stop(); setView('library'); }} aria-label="Library"><Icon.back /></button>
        <button className="title-btn" onClick={() => setPanel('info')} title="Score details">
          <span className="t">{score.title}</span>
          {score.composer && <span className="s">{score.composer}</span>}
        </button>
        <span className="grow" />
        {editMode && (
          <>
            <button className="icon-btn" onClick={store.undo} disabled={!store.canUndo} aria-label="Undo"><Icon.undo /></button>
            <button className="icon-btn" onClick={store.redo} disabled={!store.canRedo} aria-label="Redo"><Icon.redo /></button>
          </>
        )}
        <button className={`btn sm ${editMode ? 'primary' : ''}`} onClick={() => { setEditMode((x) => !x); setSel(null); if (engine.state !== 'playing') viewRef.current?.setPlaying(new Set(), null, false); }} aria-pressed={editMode} aria-label={editMode ? 'Done editing' : 'Edit'}>
          <Icon.edit size={16} /> <span className="hide-xs">{editMode ? 'Done' : 'Edit'}</span>
        </button>
        <button className={`icon-btn toggle ${assistOpen ? 'on' : ''}`} onClick={() => (assistOpen ? closeAssistant() : openAssistant())} aria-pressed={assistOpen} aria-label="Ask for a change" title="Ask for a change in words"><Icon.spark /></button>
        <button className="btn sm accent-soft" onClick={() => { stop(); setView('perform'); }} aria-label="Play along" title="Play along on your piano">
          <Icon.keyboard size={16} /> <span className="hide-xs">Play along</span>
        </button>
        <button className="icon-btn" onClick={() => setPanel('transpose')} aria-label="Transpose" title="Transpose"><Icon.transpose /></button>
        <button className="icon-btn" onClick={() => setPanel('parts')} aria-label="Parts and sound" title="Parts & sound"><Icon.mixer /></button>
        <div className="menu-wrap">
          <button className="icon-btn" onClick={() => setMoreOpen((x) => !x)} aria-label="More" aria-expanded={moreOpen}><Icon.more /></button>
          {moreOpen && (
            <div className="menu" onMouseLeave={() => setMoreOpen(false)}>
              <button onClick={() => { setMoreOpen(false); setView('scan'); }}><Icon.camera size={16} /> Scan new music</button>
              <button onClick={() => { setMoreOpen(false); setPanel('info'); }}><Icon.info size={16} /> Score details</button>
              <button onClick={openAssistant}><Icon.spark size={16} /> Ask for a change…</button>
              <button onClick={() => { setMoreOpen(false); setPanel('chords'); }}><Icon.music size={16} /> Chord symbols…</button>
              <button role="menuitemcheckbox" aria-checked={settings.showChords} onClick={() => setSettings({ ...settings, showChords: !settings.showChords })}><span className="menu-tick">{settings.showChords ? '✓' : ''}</span> Show chord symbols</button>
              <button role="menuitemcheckbox" aria-checked={settings.showLyrics} onClick={() => setSettings({ ...settings, showLyrics: !settings.showLyrics })}><span className="menu-tick">{settings.showLyrics ? '✓' : ''}</span> Show lyrics</button>
              <div className="menu-sep" />
              <button onClick={() => exportAs('musicxml')}><Icon.download size={16} /> Export MusicXML</button>
              <button onClick={() => exportAs('midi')}><Icon.download size={16} /> Export MIDI</button>
              <button onClick={() => exportAs('json')}><Icon.download size={16} /> Save file (.json)</button>
              <button onClick={() => exportAs('print')}><Icon.download size={16} /> Print / PDF…</button>
              <div className="menu-sep" />
              <button onClick={() => { setSettings({ ...settings, zoom: Math.min(2, +(zoom + 0.1).toFixed(2)) }); }}><Icon.zoomIn size={16} /> Zoom in</button>
              <button onClick={() => { setSettings({ ...settings, zoom: Math.max(0.35, +(zoom - 0.1).toFixed(2)) }); }}><Icon.zoomOut size={16} /> Zoom out</button>
              <button onClick={() => { setMoreOpen(false); setPanel('help'); }}><Icon.keyboard size={16} /> Shortcuts</button>
              <button onClick={() => { setMoreOpen(false); setPanel('settings'); }}><Icon.settings size={16} /> Settings</button>
            </div>
          )}
        </div>
      </header>

      {editMode && !assistOpen && <EditPalette event={selectedEvent} onAction={onAction} hasSelection={!!sel} chordMode={chordMode} setChordMode={setChordMode} />}

      {notesOpen && score.notes && score.notes.length > 0 && !editMode && (
        <div className="banner">
          <div className="banner-text">
            <strong>
              {score.source === 'claude'
                ? 'Scanned by Claude — give it a listen and fix anything that’s off.'
                : score.source === 'compat'
                  ? 'Scanned by an AI model — give it a listen and fix anything that’s off.'
                  : score.source === 'audiveris'
                    ? 'Scanned with Audiveris — give it a listen and fix anything that’s off.'
                    : 'About this score:'}
            </strong>
            <span> {score.notes[0]}{score.notes.length > 1 ? ` (+${score.notes.length - 1} more)` : ''}</span>
          </div>
          <button className="btn sm" onClick={() => setPanel('info')}>Details</button>
          <button className="icon-btn sm" onClick={() => setNotesOpen(false)} aria-label="Dismiss"><Icon.close size={16} /></button>
        </div>
      )}

      {!editMode && !assistOpen && sel && (
        <div className="sel-bar">
          <span>{sel.m0 === sel.m1 ? `Measure ${sel.m0 + 1}` : `Measures ${sel.m0 + 1}–${sel.m1 + 1}`}{loop ? ' · looping' : ''}</span>
          <span className="grow" />
          <span className="hint hide-xs">Shift-click to extend</span>
          <button className="btn sm" onClick={() => setPanel('measure')}>Measure tools</button>
          <button className="icon-btn sm" onClick={() => setSel(null)} aria-label="Clear selection"><Icon.close size={16} /></button>
        </div>
      )}

      <main className="score-scroll">
        <ScoreView ref={viewRef} score={shown ?? score} zoom={zoom} selection={sel} onSelect={onSelect} editMode={editMode || assistOpen} marks={assistOpen ? marks : undefined} changed={changed} />
      </main>

      {assistOpen && (
        <AssistantBar
          score={score}
          marks={marks}
          onRemoveMark={(m) => setMarks((list) => list.filter((x) => !sameMark(x, m)))}
          onClearMarks={() => setMarks([])}
          busy={assistBusy}
          note={assistNote}
          ready={!!aiConfig}
          onSend={(t) => void sendToAssistant(t)}
          onStop={() => assistAbort.current?.abort()}
          onUndo={() => { store.undo(); setChanged([]); setAssistNote({ kind: 'reply', text: 'Undone.' }); assistHistory.current = assistHistory.current.slice(0, -1); }}
          onClose={closeAssistant}
          onSettings={() => setPanel('settings')}
        />
      )}

      <Transport
        playing={playState === 'playing'}
        loading={loadingAudio}
        onPlay={togglePlay}
        onStop={stop}
        speed={speed}
        setSpeed={setSpeed}
        tempo={score.tempo}
        metronome={metronome}
        setMetronome={(b) => changeTransportToggle('metronome', b)}
        loop={loop}
        setLoop={(b) => changeTransportToggle('loop', b)}
        countIn={countIn}
        setCountIn={setCountIn}
        position={posLabel}
        progress={progress}
        onSeek={seek}
      />

      {panel === 'parts' && <PartsPanel score={score} onChange={(s, record) => store.set(s, { record })} onClose={() => setPanel(null)} />}
      {panel === 'transpose' && <TransposePanel score={score} onApply={(s) => { commit(s); flash('Transposed'); }} onClose={() => setPanel(null)} />}
      {panel === 'info' && <InfoPanel score={score} onChange={commit} onClose={() => setPanel(null)} />}
      {panel === 'settings' && <SettingsPanel settings={settings} onChange={setSettings} onClose={() => setPanel(null)} serverKey={serverKey} audiveris={audiveris} />}
      {panel === 'help' && <HelpPanel onClose={() => setPanel(null)} />}
      {panel === 'chords' && (
        <ChordsPanel
          score={score}
          ai={aiConfig}
          playChords={settings.playChords}
          setPlayChords={(b) => setSettings({ ...settings, playChords: b })}
          onApply={(s, msg) => { commit(s); flash(msg); }}
          onClose={() => setPanel(null)}
        />
      )}
      {panel === 'measure' && sel && (
        <MeasurePanel
          score={score}
          m0={sel.m0}
          m1={sel.m1}
          onClose={() => setPanel(null)}
          onUpdate={(i, patch) => commit(updateMeasure(score, i, patch))}
          onInsert={(at) => { commit(insertMeasures(score, at)); setPanel(null); }}
          onDelete={() => { commit(deleteMeasures(score, sel.m0, sel.m1)); setSel(null); setPanel(null); }}
          onClear={() => commit(clearMeasures(score, sel.m0, sel.m1))}
          onCopy={() => { clipboard.current = copyMeasures(score, sel.m0, sel.m1); flash('Copied'); }}
          onPaste={() => { if (clipboard.current) commit(pasteMeasures(score, sel.m0, clipboard.current)); setPanel(null); }}
          canPaste={!!clipboard.current}
          onChord={(beat, text) => commit(setChordSymbol(score, sel.m0, beat, text))}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function HelpPanel({ onClose }: { onClose: () => void }) {
  const rows: [string, string][] = [
    ['Space', 'Play / pause'],
    ['Click a measure', 'Select it (play starts there); Shift-click to extend'],
    ['Edit → click a note', 'Select a note (click a chord note to pick it)'],
    ['↑ / ↓', 'Move note up / down a step in the key'],
    ['Shift + ↑ / ↓', 'Up / down a semitone'],
    ['Ctrl + ↑ / ↓', 'Up / down an octave'],
    ['Alt + ↑ / ↓', 'Select in the staff above / below'],
    ['← / →', 'Previous / next note'],
    ['A – G', 'Set the note name (turns a rest into a note)'],
    ['Shift + A – G', 'Add a note to the chord'],
    ['1 – 7', '64th, 32nd, 16th, 8th, quarter, half, whole'],
    ['.', 'Toggle dot'],
    ['0 / Delete', 'Turn into a rest'],
    ['+  −  n', 'Sharp, flat, natural'],
    ['t  s  >  l', 'Tie, staccato, accent, lyric'],
    ['Ctrl + C / V', 'Copy / paste selected measures'],
    ['Ctrl + Z / Y', 'Undo / redo'],
  ];
  return (
    <Sheet title="Keyboard shortcuts" onClose={onClose}>
      <table className="keys">
        <tbody>{rows.map(([k, v]) => <tr key={k}><td><kbd>{k}</kbd></td><td>{v}</td></tr>)}</tbody>
      </table>
    </Sheet>
  );
}

export { DEFAULT_SETTINGS };
