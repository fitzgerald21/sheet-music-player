import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './Icons';
import { ScoreView, ScoreViewHandle } from './ScoreView';
import { PianoKeyboard, KeyMark } from './PianoKeyboard';
import { engine } from '../audio/engine';
import { midiIn } from '../audio/midiInput';
import { MicListener } from '../audio/micListener';
import { buildPlan, PlaybackPlan, PlayNote } from '../model/playback';
import { chordFromMidis } from '../model/chordDetect';
import { toneName } from '../model/pitch';
import { Score } from '../model/types';
import { Settings } from '../storage';

type Mode = 'follow' | 'wait' | 'turn';
type Hands = 'both' | 'rh' | 'lh' | 'none';
type Input = 'midi' | 'mic';
type Paper = 'white' | 'cream' | 'dark';

interface Props {
  score: Score;
  settings: Settings;
  startMeasure?: number;
  onExit: () => void;
}

interface Step {
  time: number;
  midis: number[];
  ids: string[];
}

const PREFS_KEY = 'smp.perform.v1';
function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}');
  } catch {
    return {};
  }
}

export function PerformView({ score, settings, startMeasure, onExit }: Props) {
  const prefs = useMemo(loadPrefs, []);
  const [mode, setMode] = useState<Mode>(prefs.mode ?? 'follow');
  const [hands, setHands] = useState<Hands>(prefs.hands ?? 'rh');
  const [accompany, setAccompany] = useState<boolean>(prefs.accompany ?? true);
  const [input, setInput] = useState<Input>(prefs.input ?? 'midi');
  const [paper, setPaper] = useState<Paper>(prefs.paper ?? 'white');
  const [showKeys, setShowKeys] = useState<boolean>(prefs.showKeys ?? true);
  const [zoom, setZoom] = useState<number>(prefs.zoom ?? (window.innerWidth < 700 ? 0.8 : 1.25));
  const [speed, setSpeed] = useState(1);
  const [metronome, setMetronome] = useState(false);
  const [countIn, setCountIn] = useState(true);
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(false);
  const [controls, setControls] = useState(true);
  const [panel, setPanel] = useState(false);
  const [marks, setMarks] = useState<Map<number, KeyMark>>(new Map());
  const [status, setStatus] = useState('');
  const [youPlay, setYouPlay] = useState<string | null>(null);
  const [midiDevices, setMidiDevices] = useState<string[]>([]);
  const [micLevel, setMicLevel] = useState(0);
  const viewRef = useRef<ScoreViewHandle>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const micRef = useRef<MicListener | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ mode, hands, accompany, input, paper, showKeys, zoom }));
    } catch {
      /* ignore */
    }
  }, [mode, hands, accompany, input, paper, showKeys, zoom]);

  // ---- which staves are "yours" ----
  const staffInfo = useMemo(() => {
    let g = 0;
    let kb: number[] = [];
    score.parts.forEach((p) => {
      const idx = p.staves.map((_, i) => g + i);
      if (!kb.length && (p.staves.length === 2 || ['piano', 'epiano', 'organ'].includes(p.instrument))) kb = idx;
      g += p.staves.length;
    });
    if (!kb.length) kb = [0];
    return { kb, total: g, rh: kb[0], lh: kb[1] ?? kb[0] };
  }, [score]);
  const userStaves = useMemo(() => {
    if (hands === 'none') return [];
    if (hands === 'both') return staffInfo.kb;
    if (hands === 'rh') return [staffInfo.rh];
    return [staffInfo.lh];
  }, [hands, staffInfo]);

  // a plan with every note (for highlighting / the keyboard) and one for what the app plays
  const visual = useMemo(() => buildPlan(score, { humanize: false }), [score]);
  const startTime = useMemo(() => (startMeasure !== undefined ? visual.measures.find((m) => m.measure === startMeasure)?.time ?? 0 : 0), [visual, startMeasure]);
  const keyRange = useMemo(() => {
    const ms = visual.notes.map((n) => n.midi);
    if (!ms.length) return [48, 84];
    let lo = Math.min(...ms) - 2;
    let hi = Math.max(...ms) + 2;
    if (hi - lo < 25) {
      const c = (hi + lo) / 2;
      lo = Math.round(c - 13);
      hi = Math.round(c + 12);
    }
    return [Math.max(21, lo), Math.min(108, hi)];
  }, [visual]);

  // ---- wake lock & fullscreen ----
  useEffect(() => {
    let lock: { release: () => Promise<void> } | null = null;
    const req = async () => {
      try {
        const wl = (navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } }).wakeLock;
        if (wl && document.visibilityState === 'visible') lock = await wl.request('screen');
      } catch {
        /* not allowed */
      }
    };
    void req();
    const onVis = () => void req();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      void lock?.release().catch(() => {});
    };
  }, []);

  const pokeControls = useCallback(() => {
    setControls(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setControls(false), 3500);
  }, []);
  useEffect(() => {
    if (!running) {
      setControls(true);
      clearTimeout(hideTimer.current);
    } else pokeControls();
  }, [running, pokeControls]);

  // ---- page turning ----
  const geometry = useCallback(() => {
    const sc = scrollRef.current;
    const wrap = sc?.querySelector('.score-host-wrap') as HTMLElement | null;
    if (!sc || !wrap) return null;
    const off = wrap.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
    const boxes = viewRef.current?.measureBoxes() ?? [];
    const rows: { y: number; h: number; measures: number[] }[] = [];
    boxes.forEach((b, i) => {
      if (!b) return;
      const r = rows.find((x) => Math.abs(x.y - (b.y + off)) < 4);
      if (r) {
        r.measures.push(i);
        r.h = Math.max(r.h, b.h);
      } else rows.push({ y: b.y + off, h: b.h, measures: [i] });
    });
    rows.sort((a, b) => a.y - b.y);
    return { sc, rows };
  }, []);

  const turn = useCallback((dir: 1 | -1) => {
    const g = geometry();
    if (!g) return;
    const { sc, rows } = g;
    const top = sc.scrollTop;
    const bottom = top + sc.clientHeight;
    if (dir === 1) {
      const next = rows.find((r) => r.y + r.h > bottom - 2);
      sc.scrollTo({ top: next ? Math.max(0, next.y - 12) : sc.scrollHeight, behavior: 'smooth' });
    } else {
      const target = top - sc.clientHeight;
      const row = rows.find((r) => r.y >= target);
      sc.scrollTo({ top: row && target > 0 ? Math.max(0, row.y - 12) : 0, behavior: 'smooth' });
    }
  }, [geometry]);

  const lastRow = useRef(-1);
  const follow = useCallback((measure: number | null) => {
    if (measure === null) return;
    const g = geometry();
    if (!g) return;
    const { sc, rows } = g;
    const ri = rows.findIndex((r) => r.measures.includes(measure));
    if (ri < 0 || ri === lastRow.current) return;
    lastRow.current = ri;
    const row = rows[ri];
    const next = rows[ri + 1];
    const top = sc.scrollTop;
    const bottom = top + sc.clientHeight;
    const rowHidden = row.y < top || row.y + row.h > bottom;
    const nextHidden = next && next.y + next.h > bottom;
    if (rowHidden || nextHidden) sc.scrollTo({ top: Math.max(0, row.y - 12), behavior: 'smooth' });
  }, [geometry]);

  // ---- running state shared by both modes ----
  const stopAll = useCallback(() => {
    engine.stop();
    setRunning(false);
    viewRef.current?.setPlaying(new Set(), null, false);
    viewRef.current?.setTargets(new Set());
    setMarks(new Map());
    setStatus('');
    lastRow.current = -1;
  }, []);

  useEffect(() => () => {
    engine.stop();
    micRef.current?.stop();
  }, []);

  const ensureAudio = useCallback(async () => {
    setLoading(true);
    try {
      await engine.init();
      engine.configureParts(score.parts);
      await engine.ready();
    } finally {
      setLoading(false);
    }
  }, [score.parts]);

  // highlight + keyboard for a score time
  const showAt = useCallback(
    (pos: number, plan: PlaybackPlan, extra?: Map<number, KeyMark>) => {
      const ids = new Set<string>();
      const m = new Map<number, KeyMark>();
      for (const n of plan.notes) {
        if (n.time > pos) break;
        if (n.time + Math.max(n.dur, 0.08) > pos) {
          if (n.eventId) ids.add(n.eventId);
          m.set(n.midi, n.staff === staffInfo.rh ? 'rh' : n.staff === staffInfo.lh && staffInfo.lh !== staffInfo.rh ? 'lh' : 'other');
        }
      }
      if (extra) for (const [k, v] of extra) m.set(k, v);
      const ms = plan.measures;
      let measure: number | null = null;
      for (let i = ms.length - 1; i >= 0; i--)
        if (ms[i].time <= pos) {
          measure = pos < plan.duration ? ms[i].measure : null;
          break;
        }
      viewRef.current?.setPlaying(ids, measure, false);
      follow(measure);
      return { marks: m, measure };
    },
    [staffInfo, follow],
  );

  // ---- follow mode: engine plays, we highlight ----
  const startFollow = useCallback(async () => {
    await ensureAudio();
    const muted = accompany ? userStaves : Array.from({ length: staffInfo.total }, (_, i) => i);
    const plan = buildPlan(score, { humanize: settings.humanize, mutedStaves: muted });
    engine.onEnd = () => stopAll();
    engine.onStall = () => stopAll();
    engine.play(plan, startTime, { speed, metronome, countIn, loop: false }, []);
    setRunning(true);
  }, [ensureAudio, accompany, userStaves, staffInfo.total, score, settings.humanize, startTime, speed, metronome, countIn, stopAll]);

  useEffect(() => {
    if (!running || mode !== 'follow') return;
    let raf = 0;
    let lastMarks = '';
    const tick = () => {
      const pos = engine.position();
      const { marks: m } = showAt(pos, visual);
      const sig = [...m].join();
      if (sig !== lastMarks) {
        lastMarks = sig;
        setMarks(m);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [running, mode, showAt, visual]);

  // ---- wait mode: a clock that stops at each of your notes until you play them ----
  const steps = useMemo<Step[]>(() => {
    const out: Step[] = [];
    for (const n of visual.notes) {
      if (!userStaves.includes(n.staff)) continue;
      const last = out[out.length - 1];
      if (last && Math.abs(last.time - n.time) < 0.02) {
        if (!last.midis.includes(n.midi)) last.midis.push(n.midi);
        if (n.eventId && !last.ids.includes(n.eventId)) last.ids.push(n.eventId);
      } else out.push({ time: n.time, midis: [n.midi], ids: n.eventId ? [n.eventId] : [] });
    }
    return out;
  }, [visual, userStaves]);

  const waitState = useRef({ vt: 0, k: 0, pressed: new Map<number, number>(), wrong: new Map<number, number>() });

  const startWait = useCallback(async () => {
    await ensureAudio();
    if (input === 'midi') {
      try {
        const d = await midiIn.connect();
        setMidiDevices(d);
        if (!d.length) setStatus('No MIDI keyboard found – connect one (USB or Bluetooth), or tap the on-screen keys.');
      } catch (e) {
        setStatus(`${(e as Error).message.replace(/\.$/, '')} – you can still tap the on-screen keys.`);
      }
    } else if (!micRef.current) {
      try {
        const mic = new MicListener();
        await mic.start();
        micRef.current = mic;
      } catch {
        setStatus('Microphone access was blocked.');
        return;
      }
    }
    const st = waitState.current;
    st.vt = startTime;
    st.k = steps.findIndex((s) => s.time >= startTime - 0.001);
    if (st.k < 0) st.k = steps.length;
    st.pressed.clear();
    micRef.current?.resetOnset();
    setRunning(true);
  }, [ensureAudio, input, steps, startTime]);

  useEffect(() => {
    if (!running || mode !== 'wait') return;
    const st = waitState.current;
    const unsub = midiIn.subscribe((e) => {
      if (e.type !== 'on') return;
      st.pressed.set(e.midi, performance.now());
      const step = steps[st.k];
      if (step && !step.midis.includes(e.midi)) st.wrong.set(e.midi, performance.now());
    });
    const autoNotes: PlayNote[] = accompany ? visual.notes.filter((n) => !userStaves.includes(n.staff) && n.part >= 0) : [];
    let ai = autoNotes.findIndex((n) => n.time >= st.vt - 0.001);
    if (ai < 0) ai = autoNotes.length;
    let last = performance.now();
    let raf = 0;
    let lastSig = '';
    const beats = visual.measures.flatMap((m) => Array.from({ length: m.beats }, (_, b) => ({ t: m.time + b * m.beatDur, accent: b === 0 })));
    let bi = beats.findIndex((b) => b.t >= st.vt - 0.001);
    const tick = () => {
      const now = performance.now();
      const dt = ((now - last) / 1000) * speed;
      last = now;
      const step = steps[st.k];
      const fresh = (m: number) => (st.pressed.get(m) ?? 0) > now - 1500;
      let satisfied = false;
      if (step) {
        if (input === 'mic' && micRef.current) {
          const r = micRef.current.check(step.midis);
          setMicLevel(r.level);
          satisfied = r.onset && r.heard.length >= Math.ceil(step.midis.length * 0.6);
        } else satisfied = step.midis.every(fresh);
      }
      if (step && satisfied) {
        st.vt = Math.max(st.vt, step.time);
        st.k++;
        st.pressed.clear();
        micRef.current?.resetOnset();
      } else if (step && st.vt + dt >= step.time) {
        st.vt = step.time; // wait here
      } else st.vt += dt;
      // accompaniment & metronome up to the virtual time
      while (ai < autoNotes.length && autoNotes[ai].time <= st.vt) {
        const n = autoNotes[ai++];
        if (st.vt - n.time < 0.25) engine.playPartNote(n.part, n.midi, n.dur / speed, n.velocity);
      }
      while (metronome && bi >= 0 && bi < beats.length && beats[bi].t <= st.vt) engine.click(beats[bi++].accent);
      const waiting = !!step && st.vt >= step.time - 0.0001 && !satisfied;
      const extra = new Map<number, KeyMark>();
      const next = steps[st.k];
      if (next) for (const m of next.midis) extra.set(m, midiIn.held.has(m) ? 'good' : 'target');
      for (const [m, t] of st.wrong) {
        if (now - t < 400) extra.set(m, 'wrong');
        else st.wrong.delete(m);
      }
      const { marks: mk } = showAt(st.vt, visual, extra);
      viewRef.current?.setTargets(new Set(next?.ids ?? []));
      const sig = [...mk].join() + waiting;
      if (sig !== lastSig) {
        lastSig = sig;
        setMarks(mk);
        setYouPlay(next ? next.midis.map(toneName).join(' ') : null);
      }
      if (!next && st.vt >= visual.duration) {
        stopAll();
        setStatus('Well played! 🎉');
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      unsub();
    };
  }, [running, mode, steps, speed, input, accompany, visual, userStaves, metronome, showAt, stopAll]);

  // chord readout for what you're holding on a MIDI keyboard
  const [heldChord, setHeldChord] = useState<string | null>(null);
  useEffect(() => {
    return midiIn.subscribe(() => setHeldChord(chordFromMidis([...midiIn.held], score.key)));
  }, [score.key]);

  const toggleRun = useCallback(() => {
    if (running) {
      stopAll();
      return;
    }
    setStatus('');
    if (mode === 'follow') void startFollow();
    else if (mode === 'wait') void startWait();
  }, [running, mode, startFollow, startWait, stopAll]);

  // ---- keyboard: pedals send arrows / PageDown ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT')) return;
      if (['ArrowRight', 'ArrowDown', 'PageDown'].includes(e.key)) {
        e.preventDefault();
        turn(1);
      } else if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(e.key)) {
        e.preventDefault();
        turn(-1);
      } else if (e.key === ' ' && mode !== 'turn') {
        e.preventDefault();
        toggleRun();
      } else if (e.key === 'Escape') onExit();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [turn, toggleRun, mode, onExit]);

  const onTap = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    if (x > 0.66) turn(1);
    else if (x < 0.33) turn(-1);
    else setControls((c) => !c);
  };

  const onScreenKey = useCallback((midi: number, down: boolean) => {
    if (down) {
      void engine.init().then(() => engine.preview([midi])).catch(() => undefined);
      midiIn.emit('on', midi);
    } else if (midiIn.held.has(midi)) midiIn.emit('off', midi);
  }, []);

  const fs = typeof document !== 'undefined' && document.fullscreenEnabled;
  const handsLabel = { both: 'Both hands', rh: 'Right hand', lh: 'Left hand', none: 'Just listen' }[hands];

  return (
    <div className={`perform paper-${paper}`} onPointerMove={running ? pokeControls : undefined}>
      <header className={`perform-top ${controls ? '' : 'hidden'}`}>
        <button className="icon-btn" onClick={onExit} aria-label="Exit play-along"><Icon.back /></button>
        <div className="perform-title">
          <span className="t">{score.title}</span>
          <span className="s">{mode === 'turn' ? 'Page turning' : `${mode === 'wait' ? 'Waits for you' : 'Plays along'} · ${handsLabel}`}</span>
        </div>
        <span className="grow" />
        <button className="icon-btn" onClick={() => setZoom((z) => Math.max(0.4, +(z - 0.1).toFixed(2)))} aria-label="Smaller"><Icon.zoomOut /></button>
        <button className="icon-btn" onClick={() => setZoom((z) => Math.min(2.5, +(z + 0.1).toFixed(2)))} aria-label="Bigger"><Icon.zoomIn /></button>
        {fs && (
          <button className="icon-btn hide-xs" onClick={() => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen())} aria-label="Full screen">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></svg>
          </button>
        )}
        <button className={`icon-btn ${panel ? 'toggle on' : ''}`} onClick={() => setPanel((p) => !p)} aria-label="Play-along settings" aria-expanded={panel}><Icon.settings /></button>
      </header>

      {panel && (
        <div className="perform-panel" onClick={(e) => e.stopPropagation()}>
          <div className="pp-row">
            <span className="mini">Mode</span>
            <div className="seg compact">
              {(['follow', 'wait', 'turn'] as Mode[]).map((m) => (
                <button key={m} className={mode === m ? 'on' : ''} onClick={() => { stopAll(); setMode(m); }}>
                  {{ follow: 'Play along', wait: 'Wait for me', turn: 'Just pages' }[m]}
                </button>
              ))}
            </div>
          </div>
          {mode !== 'turn' && (
            <div className="pp-row">
              <span className="mini">You play</span>
              <div className="seg compact">
                {(['rh', 'lh', 'both', ...(mode === 'follow' ? ['none'] : [])] as Hands[]).map((h) => (
                  <button key={h} className={hands === h ? 'on' : ''} onClick={() => { stopAll(); setHands(h); }}>
                    {{ rh: 'Right', lh: 'Left', both: 'Both', none: 'Nothing' }[h]}
                  </button>
                ))}
              </div>
            </div>
          )}
          {mode !== 'turn' && (
            <label className="check"><input type="checkbox" checked={accompany} onChange={(e) => { stopAll(); setAccompany(e.target.checked); }} /> App plays the other parts</label>
          )}
          {mode === 'wait' && (
            <div className="pp-row">
              <span className="mini">Listen with</span>
              <div className="seg compact">
                <button className={input === 'midi' ? 'on' : ''} onClick={() => { stopAll(); setInput('midi'); }}>MIDI keyboard</button>
                <button className={input === 'mic' ? 'on' : ''} onClick={() => { stopAll(); setInput('mic'); }}>Microphone (beta)</button>
              </div>
            </div>
          )}
          {mode === 'wait' && input === 'midi' && (
            <p className="hint">{midiIn.supported ? (midiDevices.length ? `Connected: ${midiDevices.join(', ')}` : 'Plug in your digital piano (USB or Bluetooth MIDI), then press Start.') : 'This browser can’t use MIDI keyboards (iPhone/iPad Safari). Use Chrome on a computer or Android, or the microphone.'}</p>
          )}
          {mode === 'wait' && input === 'mic' && (
            <p className="hint">Experimental: works best on a quiet room with an in-tune piano. {accompany ? 'Use headphones so the app’s sound doesn’t confuse the listener.' : ''}</p>
          )}
          <div className="pp-row">
            <span className="mini">Paper</span>
            <div className="seg compact">
              {(['white', 'cream', 'dark'] as Paper[]).map((p) => (
                <button key={p} className={paper === p ? 'on' : ''} onClick={() => setPaper(p)}>{p[0].toUpperCase() + p.slice(1)}</button>
              ))}
            </div>
          </div>
          <label className="check"><input type="checkbox" checked={showKeys} onChange={(e) => setShowKeys(e.target.checked)} /> Show piano keys</label>
          <p className="hint">Turn pages by tapping the left or right side of the music, with the arrow keys, or with a Bluetooth page-turner pedal.</p>
        </div>
      )}

      <div className="perform-scroll" ref={scrollRef}>
        <div className="perform-tap" onClick={onTap}>
          <ScoreView ref={viewRef} score={score} zoom={zoom} selection={null} onSelect={() => {}} editMode={false} paper={paper} passive />
        </div>
      </div>

      <footer className={`perform-bottom ${controls || !running ? '' : 'faded'}`}>
        {(status || (running && mode === 'wait')) && (
          <div className="perform-status">
            {status && <span className="hint">{status}</span>}
            {running && mode === 'wait' && youPlay && <span>Play: <strong>{youPlay}</strong></span>}
            {running && mode === 'wait' && input === 'mic' && <span className="mic-meter"><span style={{ width: `${Math.round(micLevel * 100)}%` }} /></span>}
          </div>
        )}
        {showKeys && <PianoKeyboard low={keyRange[0]} high={keyRange[1]} marks={marks} onPress={onScreenKey} labels={!running || mode === 'wait'} />}
        <div className="perform-transport">
          {mode !== 'turn' ? (
            <button className="play-btn" onClick={toggleRun} disabled={loading} aria-label={running ? 'Stop' : 'Start'}>
              {loading ? <div className="spinner light" /> : running ? <Icon.stop size={22} /> : <Icon.play size={24} />}
            </button>
          ) : (
            <>
              <button className="btn" onClick={() => turn(-1)}><Icon.left size={18} /> Back</button>
              <button className="btn" onClick={() => turn(1)}>Next <Icon.right size={18} /></button>
            </>
          )}
          {mode !== 'turn' && (
            <div className="speed">
              <label htmlFor="pspeed" className="mini">♩ = {Math.round(score.tempo * speed)}</label>
              <input id="pspeed" type="range" min={0.25} max={1.5} step={0.05} value={speed} onChange={(e) => { setSpeed(+e.target.value); if (mode === 'follow') engine.setSpeed(+e.target.value); }} aria-label="Speed" />
            </div>
          )}
          <span className="grow" />
          {heldChord && <span className="held-chord" title="The chord you're holding">{heldChord}</span>}
          {mode !== 'turn' && (
            <>
              <button className={`icon-btn toggle ${metronome ? 'on' : ''}`} onClick={() => setMetronome(!metronome)} aria-label="Metronome"><Icon.metronome /></button>
              {mode === 'follow' && <button className={`icon-btn toggle txt ${countIn ? 'on' : ''}`} onClick={() => setCountIn(!countIn)} aria-label="Count-in">1‑2</button>}
            </>
          )}
        </div>
      </footer>
    </div>
  );
}
