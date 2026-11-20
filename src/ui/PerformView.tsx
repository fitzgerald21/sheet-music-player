import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './Icons';
import { ScoreView, ScoreViewHandle } from './ScoreView';
import { PianoKeyboard, KeyMark } from './PianoKeyboard';
import { FallingNotes } from './FallingNotes';
import { OriginalPages, OriginalHandle } from './OriginalPages';
import { engine, INSTRUMENTS } from '../audio/engine';
import { midiIn } from '../audio/midiInput';
import { MicListener } from '../audio/micListener';
import { buildPlan, PlaybackPlan, PlayNote } from '../model/playback';
import { buildSteps, sectionSpan, Tally, TimingScore } from '../model/practice';
import { nativeApp } from '../native';
import { chordFromMidis } from '../model/chordDetect';
import { toneName } from '../model/pitch';
import { InstrumentId, Score } from '../model/types';
import { logSession } from '../practiceLog';
import { Settings } from '../storage';

type Mode = 'follow' | 'wait' | 'turn';
type Hands = 'both' | 'rh' | 'lh' | 'none';
type Input = 'midi' | 'mic';
type Paper = 'white' | 'cream' | 'dark';
/** How the music is shown: engraved pages, one long line, falling notes, or the photos it was scanned from. */
type Look = 'pages' | 'scroll' | 'falling' | 'original';
const LOOKS: { id: Look; label: string }[] = [
  { id: 'pages', label: 'Pages' },
  { id: 'scroll', label: 'Side-scroll' },
  { id: 'falling', label: 'Falling notes' },
  { id: 'original', label: 'Original' },
];

interface Props {
  score: Score;
  settings: Settings;
  onSettings: (s: Settings) => void;
  startMeasure?: number;
  onExit: () => void;
}

/** How close to its beat a key has to be to count in "Play along", in seconds. */
const IN_TIME = 0.25;
const tallyText = (t: Tally) => `${t.hit} of ${t.total} notes in time (${t.percent}%)${t.extra ? `, ${t.extra} extra` : ''}`;

const PREFS_KEY = 'smp.perform.v1';
function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}');
  } catch {
    return {};
  }
}

export function PerformView({ score, settings, onSettings, startMeasure, onExit }: Props) {
  const prefs = useMemo(loadPrefs, []);
  const [mode, setMode] = useState<Mode>(prefs.mode ?? 'follow');
  const [hands, setHands] = useState<Hands>(prefs.hands ?? 'rh');
  const [accompany, setAccompany] = useState<boolean>(prefs.accompany ?? true);
  const [input, setInput] = useState<Input>(prefs.input ?? 'midi');
  const [paper, setPaper] = useState<Paper>(prefs.paper ?? 'white');
  const [showKeys, setShowKeys] = useState<boolean>(prefs.showKeys ?? true);
  const [thru, setThru] = useState<boolean>(prefs.thru ?? false);
  const [look, setLook] = useState<Look>(prefs.look ?? 'pages');
  /** the sound of the keyboard part, '' = as the score says */
  const [sound, setSound] = useState<InstrumentId | ''>(prefs.sound ?? '');
  const [origScale, setOrigScale] = useState(1);
  const lastMeasure = score.measures.length - 1;
  const [from, setFrom] = useState(Math.min(startMeasure ?? 0, lastMeasure));
  const [to, setTo] = useState(lastMeasure);
  const [repeat, setRepeat] = useState(false);
  const [held, setHeld] = useState<Set<number>>(new Set());
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
      localStorage.setItem(PREFS_KEY, JSON.stringify({ mode, hands, accompany, input, paper, showKeys, zoom, thru, look, sound }));
    } catch {
      /* ignore */
    }
  }, [mode, hands, accompany, input, paper, showKeys, zoom, thru, look, sound]);
  // read by callbacks that outlive a render (the engine's end-of-piece call, MIDI listeners)
  const live = useRef({ speed, repeat, thru, voice: 'piano' as InstrumentId });
  live.current.speed = speed;
  live.current.repeat = repeat;
  live.current.thru = thru;

  // ---- which staves are "yours" ----
  const staffInfo = useMemo(() => {
    let g = 0;
    let kb: number[] = [];
    let part = 0;
    score.parts.forEach((p, pi) => {
      const idx = p.staves.map((_, i) => g + i);
      if (!kb.length && (p.staves.length === 2 || ['piano', 'epiano', 'organ', 'harpsichord'].includes(p.instrument))) {
        kb = idx;
        part = pi;
      }
      g += p.staves.length;
    });
    if (!kb.length) kb = [0];
    return { kb, part, total: g, rh: kb[0], lh: kb[1] ?? kb[0] };
  }, [score]);
  // the parts as they sound here: the keyboard part can be given another instrument
  const voice: InstrumentId = sound || score.parts[staffInfo.part]?.instrument || 'piano';
  const soundParts = useMemo(() => score.parts.map((p, i) => (i === staffInfo.part ? { ...p, instrument: voice } : p)), [score.parts, staffInfo.part, voice]);
  useEffect(() => engine.configureParts(soundParts), [soundParts]);
  live.current.voice = voice;
  const userStaves = useMemo(() => {
    if (hands === 'none') return [];
    if (hands === 'both') return staffInfo.kb;
    if (hands === 'rh') return [staffInfo.rh];
    return [staffInfo.lh];
  }, [hands, staffInfo]);

  // a plan with every note (for highlighting / the keyboard) and one for what the app plays
  const visual = useMemo(() => buildPlan(score, { humanize: false, tremolo: false }), [score]);
  // the stretch being practised: the whole piece, or a range of measures
  const span = useMemo(() => sectionSpan(visual, from, to), [visual, from, to]);
  const whole = from === 0 && to >= lastMeasure;
  const spanRef = useRef(span);
  spanRef.current = span;
  useEffect(() => {
    posRef.current = span.start;
  }, [span.start]);
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
    nativeApp.post({ type: 'awake', on: true });
    const onVis = () => void req();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      void lock?.release().catch(() => {});
      nativeApp.post({ type: 'awake', on: false });
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
    if (look === 'original') return origRef.current?.turn(dir);
    if (look === 'scroll') {
      const sc = scrollRef.current;
      return sc?.scrollBy({ left: dir * sc.clientWidth * 0.8, behavior: 'smooth' });
    }
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
  }, [geometry, look]);

  // ---- side-scrolling: the music slides under a playhead that stays put ----
  const origRef = useRef<OriginalHandle>(null);
  const posRef = useRef(0);
  const anchors = useRef<{ t: number; x: number }[] | null>(null);
  useEffect(() => {
    anchors.current = null;
  }, [look, zoom, visual]);
  const sideScroll = useCallback((pos: number) => {
    const sc = scrollRef.current;
    const host = sc?.querySelector('.score-host');
    if (!sc || !host) return;
    if (!anchors.current) {
      // when each note sounds and where it is drawn, measured from the left edge of what scrolls
      const xs = viewRef.current?.notePositions();
      const off = host.getBoundingClientRect().left - sc.getBoundingClientRect().left + sc.scrollLeft;
      const list: { t: number; x: number }[] = [];
      for (const n of visual.notes) {
        const x = xs?.get(n.eventId);
        if (x === undefined) continue;
        const last = list[list.length - 1];
        if (last && n.time - last.t < 0.001) last.x = Math.min(last.x, x + off);
        else list.push({ t: n.time, x: x + off });
      }
      if (!list.length) return;
      anchors.current = list;
    }
    const a = anchors.current;
    let lo = 0;
    let hi = a.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (a[mid].t <= pos) lo = mid;
      else hi = mid - 1;
    }
    const cur = a[lo];
    const next = a[lo + 1];
    let x = cur.x;
    // glide to the next note, unless the music jumps back there (a repeat)
    if (next && next.x > cur.x && pos > cur.t) x += (next.x - cur.x) * Math.min(1, (pos - cur.t) / (next.t - cur.t));
    sc.scrollLeft = Math.max(0, x - sc.clientWidth * 0.3);
  }, [visual]);

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

  // ---- your keyboard ----
  useEffect(() => {
    midiIn.onDevices = (names) => setMidiDevices(names);
    void midiIn.autoConnect().then(setMidiDevices);
    return () => {
      midiIn.onDevices = null;
    };
  }, []);

  const connectMidi = useCallback(async (): Promise<string[]> => {
    try {
      const d = await midiIn.connect();
      setMidiDevices(d);
      setStatus(d.length ? '' : midiIn.canBluetooth
        ? 'No MIDI keyboard found – plug it in with a USB adapter, or pair it with “Bluetooth MIDI” in the settings here.'
        : 'No MIDI keyboard found – plug it in (USB) or pair it (Bluetooth), or tap the on-screen keys.');
      return d;
    } catch (e) {
      setStatus(`${(e as Error).message.replace(/\.$/, '')} – you can still tap the on-screen keys.`);
      return [];
    }
  }, []);

  // keys pressed in "Play along" flash green (in time) or red (not in the music just now)
  const flash = useRef(new Map<number, { mark: KeyMark; t: number }>());

  // ---- running state shared by both modes ----
  const stopAll = useCallback(() => {
    engine.stop();
    setRunning(false);
    viewRef.current?.setPlaying(new Set(), null, false);
    viewRef.current?.setTargets(new Set());
    setMarks(new Map());
    setStatus('');
    lastRow.current = -1;
    flash.current.clear();
    posRef.current = spanRef.current.start;
    origRef.current?.show(null, 0);
  }, []);

  useEffect(() => () => {
    engine.stop();
    micRef.current?.stop();
  }, []);

  const ensureAudio = useCallback(async () => {
    setLoading(true);
    try {
      await engine.init();
      engine.configureParts(soundParts);
      await engine.ready();
    } finally {
      setLoading(false);
    }
  }, [soundParts]);

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
      let through = 0;
      for (let i = ms.length - 1; i >= 0; i--)
        if (ms[i].time <= pos) {
          measure = pos < plan.duration ? ms[i].measure : null;
          through = (pos - ms[i].time) / (ms[i].end - ms[i].time);
          break;
        }
      posRef.current = pos;
      viewRef.current?.setPlaying(ids, measure, false);
      if (look === 'scroll') sideScroll(pos);
      else if (look === 'original') origRef.current?.show(measure, through);
      else follow(measure);
      return { marks: m, measure };
    },
    [staffInfo, follow, look, sideScroll],
  );

  // the notes you are expected to play, in the section being practised
  const steps = useMemo(() => buildSteps(visual, userStaves, span.start, span.end), [visual, userStaves, span]);

  // ---- the practice diary: how long each go lasted and how it went ----
  const began = useRef(0);
  const endSession = useCallback((percent?: number) => {
    const seconds = began.current ? (performance.now() - began.current) / 1000 : 0;
    began.current = 0;
    if (seconds >= 15 && mode !== 'turn') logSession({ id: score.id, at: Date.now(), seconds: Math.round(seconds), mode, percent });
  }, [score.id, mode]);
  useEffect(() => {
    if (running) began.current = performance.now();
  }, [running]);
  // leaving in the middle still counts as practice
  const endRef = useRef(endSession);
  endRef.current = endSession;
  useEffect(() => () => endRef.current(), []);

  // ---- follow mode: engine plays, we highlight and mark what you play on a MIDI keyboard ----
  const followRun = useRef<{ plan: PlaybackPlan; tally: TimingScore; lap: number } | null>(null);

  const playFollow = useCallback((withCountIn: boolean) => {
    const run = followRun.current;
    if (!run) return;
    run.tally = new TimingScore(steps);
    engine.play(run.plan, span.start, { speed: live.current.speed, metronome, countIn: withCountIn, loop: false }, []);
  }, [steps, span.start, metronome]);

  // the section (or the piece) is over: go round again, or stop and say how it went
  const finishFollow = useCallback(() => {
    const run = followRun.current;
    const summary = run?.tally.presses ? tallyText(run.tally.result()) : '';
    if (run && live.current.repeat) {
      setStatus(summary && `Time ${run.lap}: ${summary}`);
      run.lap++;
      lastRow.current = -1;
      playFollow(false);
    } else {
      endSession(run?.tally.presses ? run.tally.result().percent : undefined);
      stopAll();
      setStatus(summary);
    }
  }, [playFollow, stopAll, endSession]);
  const finishRef = useRef(finishFollow);
  finishRef.current = finishFollow;

  const startFollow = useCallback(async () => {
    await ensureAudio();
    const muted = accompany ? userStaves : Array.from({ length: staffInfo.total }, (_, i) => i);
    const plan = buildPlan(score, { humanize: settings.humanize, mutedStaves: muted });
    followRun.current = { plan, tally: new TimingScore(steps), lap: 1 };
    engine.onEnd = () => finishRef.current();
    engine.onStall = () => stopAll();
    playFollow(countIn);
    setRunning(true);
  }, [ensureAudio, accompany, userStaves, staffInfo.total, score, settings.humanize, steps, playFollow, countIn, stopAll]);

  useEffect(() => {
    if (!running || mode !== 'follow') return;
    let raf = 0;
    let lastMarks = '';
    const tick = () => {
      const pos = engine.position();
      if (pos >= span.end - 0.02 && span.end < visual.duration - 0.05) {
        finishRef.current();
        if (!live.current.repeat) return;
      }
      const now = performance.now();
      const extra = new Map<number, KeyMark>();
      for (const [m, f] of flash.current) {
        if (now - f.t < 350) extra.set(m, f.mark);
        else flash.current.delete(m);
      }
      const { marks: m } = showAt(engine.position(), visual, extra);
      const sig = [...m].join();
      if (sig !== lastMarks) {
        lastMarks = sig;
        setMarks(m);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [running, mode, showAt, visual, span.end]);

  useEffect(() => {
    if (!running || mode !== 'follow' || !userStaves.length) return;
    return midiIn.subscribe((e) => {
      if (e.type !== 'on') return;
      const r = followRun.current?.tally.press(e.midi, engine.position(), IN_TIME * live.current.speed);
      if (r) flash.current.set(e.midi, { mark: r === 'hit' ? 'good' : 'wrong', t: performance.now() });
    });
  }, [running, mode, userStaves]);

  // ---- wait mode: a clock that stops at each of your notes until you play them ----
  const waitState = useRef({ vt: 0, k: 0, pressed: new Map<number, number>(), wrong: new Map<number, number>(), slipped: false, clean: 0, lap: 1 });

  const startWait = useCallback(async () => {
    await ensureAudio();
    if (input === 'midi') {
      if (!midiIn.devices.length) await connectMidi();
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
    st.vt = span.start;
    st.k = 0;
    st.pressed.clear();
    st.slipped = false;
    st.clean = 0;
    st.lap = 1;
    micRef.current?.resetOnset();
    setRunning(true);
  }, [ensureAudio, input, connectMidi, span.start]);

  useEffect(() => {
    if (!running || mode !== 'wait') return;
    const st = waitState.current;
    const unsub = midiIn.subscribe((e) => {
      if (e.type !== 'on') return;
      st.pressed.set(e.midi, performance.now());
      const step = steps[st.k];
      if (step && !step.midis.includes(e.midi)) {
        st.wrong.set(e.midi, performance.now());
        st.slipped = true;
      }
    });
    const autoNotes: PlayNote[] = accompany ? visual.notes.filter((n) => !userStaves.includes(n.staff) && n.part >= 0) : [];
    const firstFrom = (t: number) => {
      const i = autoNotes.findIndex((n) => n.time >= t - 0.001);
      return i < 0 ? autoNotes.length : i;
    };
    let ai = firstFrom(st.vt);
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
        if (!st.slipped) st.clean++;
        st.slipped = false;
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
      if (!next && st.vt >= span.end) {
        const summary = input === 'midi' && steps.length ? ` ${st.clean} of ${steps.length} right first time.` : '';
        if (!live.current.repeat) {
          endSession(input === 'midi' && steps.length ? Math.round((st.clean / steps.length) * 100) : undefined);
          stopAll();
          setStatus(`Well played! 🎉${summary}`);
          return;
        }
        // go round again
        setStatus(`Time ${st.lap}:${summary || ' done.'}`);
        st.lap++;
        st.vt = span.start;
        st.k = 0;
        st.clean = 0;
        st.slipped = false;
        st.pressed.clear();
        ai = firstFrom(st.vt);
        bi = beats.findIndex((b) => b.t >= st.vt - 0.001);
        lastRow.current = -1;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      unsub();
    };
  }, [running, mode, steps, span, speed, input, accompany, visual, userStaves, metronome, showAt, stopAll, endSession]);

  // the keys you're holding, the chord they make, and (if asked for) their sound
  const [heldChord, setHeldChord] = useState<string | null>(null);
  const thruAudio = useRef(false);
  useEffect(() => {
    return midiIn.subscribe((e) => {
      setHeld(new Set(midiIn.held));
      setHeldChord(chordFromMidis([...midiIn.held], score.key));
      if (!live.current.thru || e.type !== 'on' || e.source !== 'device') return;
      if (!thruAudio.current) {
        thruAudio.current = true;
        void ensureAudio().catch(() => undefined);
      }
      engine.playKey(e.midi, e.velocity, live.current.voice);
    });
  }, [score.key, ensureAudio]);
  const shownMarks = useMemo(() => {
    if (!held.size) return marks;
    const m = new Map(marks);
    for (const k of held) if (!m.has(k)) m.set(k, 'held');
    return m;
  }, [marks, held]);

  const setSection = (a: number, b: number) => {
    if (Number.isNaN(a) || Number.isNaN(b)) return;
    stopAll();
    const f = Math.min(Math.max(0, a), lastMeasure);
    setFrom(f);
    setTo(Math.min(Math.max(f, b), lastMeasure));
  };

  const toggleRun = useCallback(() => {
    if (running) {
      // stopped part-way through: say how it was going
      const run = mode === 'follow' ? followRun.current : null;
      const sofar = run?.tally.presses ? run.tally.result(engine.position()) : null;
      const summary = sofar ? tallyText(sofar) : '';
      const done = waitState.current;
      endSession(sofar ? sofar.percent : mode === 'wait' && input === 'midi' && done.k > 3 ? Math.round((done.clean / done.k) * 100) : undefined);
      stopAll();
      setStatus(summary);
      return;
    }
    setStatus('');
    if (mode === 'follow') void startFollow();
    else if (mode === 'wait') void startWait();
  }, [running, mode, input, startFollow, startWait, stopAll, endSession]);

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

  const zoomBy = (d: number) => {
    if (look === 'original') setOrigScale((z) => Math.min(3, Math.max(0.4, +(z + d).toFixed(2))));
    else setZoom((z) => Math.min(2.5, Math.max(0.4, +(z + d).toFixed(2))));
  };
  const handOf = useCallback((n: PlayNote) => (n.staff === staffInfo.rh ? 'rh' : n.staff === staffInfo.lh && staffInfo.lh !== staffInfo.rh ? 'lh' : 'other'), [staffInfo]);
  const isMine = useCallback((n: PlayNote) => userStaves.includes(n.staff), [userStaves]);
  const now = useCallback(() => posRef.current, []);
  const fs = typeof document !== 'undefined' && document.fullscreenEnabled;
  const handsLabel = { both: 'Both hands', rh: 'Right hand', lh: 'Left hand', none: 'Just listen' }[hands];

  return (
    <div className={`perform paper-${paper}`} onPointerMove={running ? pokeControls : undefined}>
      <header className={`perform-top ${controls ? '' : 'hidden'}`}>
        <button className="icon-btn" onClick={onExit} aria-label="Exit play-along"><Icon.back /></button>
        <div className="perform-title">
          <span className="t">{score.title}</span>
          <span className="s">{mode === 'turn' ? 'Page turning' : `${mode === 'wait' ? 'Waits for you' : 'Plays along'} · ${handsLabel}${whole ? '' : ` · measures ${from + 1}–${to + 1}`}`}</span>
        </div>
        <span className="grow" />
        {midiIn.supported && mode !== 'turn' && (
          <button className={`midi-chip ${midiDevices.length ? 'on' : ''}`} onClick={() => void connectMidi()} title={midiDevices.length ? `Connected: ${midiDevices.join(', ')}` : 'Connect a MIDI keyboard'}>
            <span className="dot" /><span className="name">{midiDevices.length ? midiDevices[0] : 'Connect keyboard'}</span>
          </button>
        )}
        <button className="icon-btn" onClick={() => zoomBy(-0.1)} disabled={look === 'falling'} aria-label="Smaller"><Icon.zoomOut /></button>
        <button className="icon-btn" onClick={() => zoomBy(0.1)} disabled={look === 'falling'} aria-label="Bigger"><Icon.zoomIn /></button>
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
          <div className="pp-row">
            <span className="mini">View</span>
            <div className="seg compact wrap">
              {LOOKS.map((l) => (
                <button key={l.id} className={look === l.id ? 'on' : ''} onClick={() => setLook(l.id)}>{l.label}</button>
              ))}
            </div>
          </div>
          {mode !== 'turn' && (
            <div className="pp-row">
              <label className="mini" htmlFor="psound">Sound</label>
              <select id="psound" value={sound} onChange={(e) => setSound(e.target.value as InstrumentId | '')}>
                <option value="">As written ({INSTRUMENTS.find((i) => i.id === score.parts[staffInfo.part]?.instrument)?.label ?? 'Grand piano'})</option>
                {INSTRUMENTS.map((i) => <option key={i.id} value={i.id}>{i.label}</option>)}
              </select>
            </div>
          )}
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
          {mode !== 'turn' && (
            <div className="pp-row">
              <span className="mini">Measures</span>
              <input type="number" min={1} max={lastMeasure + 1} value={from + 1} onFocus={(e) => e.target.select()} onChange={(e) => setSection(e.target.valueAsNumber - 1, to)} aria-label="First measure" />
              <span>to</span>
              <input type="number" min={from + 1} max={lastMeasure + 1} value={to + 1} onFocus={(e) => e.target.select()} onChange={(e) => setSection(from, e.target.valueAsNumber - 1)} aria-label="Last measure" />
              {!whole && <button className="link" onClick={() => setSection(0, lastMeasure)}>Whole piece</button>}
              <label className="check"><input type="checkbox" checked={repeat} onChange={(e) => setRepeat(e.target.checked)} /> Repeat</label>
            </div>
          )}
          {mode !== 'turn' && (mode === 'follow' || input === 'midi') && (
            <p className="hint">
              {!midiIn.supported
                ? 'This browser can’t use MIDI keyboards (Safari, and every browser on iPhone and iPad). Use Chrome or Edge on a computer or Android, or the Sheet Music Player app on iPhone, iPad and Mac.'
                : midiDevices.length
                  ? `Connected: ${midiDevices.join(', ')}.${mode === 'follow' && hands !== 'none' ? ' Play in time with the app and it tells you how many notes you got.' : ''}`
                  : `Plug in your digital piano (USB or Bluetooth MIDI)${mode === 'wait' ? ', then press Start.' : ' to have your playing marked.'}`}
            </p>
          )}
          {mode !== 'turn' && midiIn.supported && (
            <div className="pp-row">
              <label className="check"><input type="checkbox" checked={thru} onChange={(e) => setThru(e.target.checked)} /> Play my keys through this device</label>
              {midiIn.canBluetooth && <button className="btn sm" onClick={() => midiIn.bluetooth()}>Bluetooth MIDI…</button>}
            </div>
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
          {(look === 'pages' || look === 'scroll') && (
            <label className="check"><input type="checkbox" checked={settings.noteNames.on} onChange={(e) => onSettings({ ...settings, noteNames: { ...settings.noteNames, on: e.target.checked } })} /> Name notes far off the staff (more in Settings)</label>
          )}
          {look !== 'falling' && <label className="check"><input type="checkbox" checked={showKeys} onChange={(e) => setShowKeys(e.target.checked)} /> Show piano keys</label>}
          <p className="hint">Turn pages by tapping the left or right side of the music, with the arrow keys, or with a Bluetooth page-turner pedal.</p>
        </div>
      )}

      <div className={`perform-stage look-${look}`}>
        {look === 'falling' ? (
          <div className="perform-fall" onClick={() => setControls((c) => !c)}>
            <FallingNotes notes={visual.notes} measures={visual.measures} low={keyRange[0]} high={keyRange[1]} time={now} hand={handOf} mine={isMine} />
          </div>
        ) : (
          <div className="perform-scroll" ref={scrollRef}>
            <div className="perform-tap" onClick={onTap}>
              {look === 'original' ? (
                <OriginalPages ref={origRef} scoreId={score.id} total={score.measures.length} scale={origScale} scroller={scrollRef} />
              ) : (
                <ScoreView ref={viewRef} score={score} zoom={zoom} selection={null} onSelect={() => {}} editMode={false} paper={paper} passive singleLine={look === 'scroll'} onRendered={() => { anchors.current = null; }} noteNames={settings.noteNames} />
              )}
            </div>
          </div>
        )}
        {look === 'scroll' && <div className="playhead" />}
      </div>

      <footer className={`perform-bottom ${controls || !running ? '' : 'faded'}`}>
        {(status || (running && mode === 'wait')) && (
          <div className="perform-status">
            {status && <span className="hint">{status}</span>}
            {running && mode === 'wait' && youPlay && <span>Play: <strong>{youPlay}</strong></span>}
            {running && mode === 'wait' && input === 'mic' && <span className="mic-meter"><span style={{ width: `${Math.round(micLevel * 100)}%` }} /></span>}
          </div>
        )}
        {(showKeys || look === 'falling') && <PianoKeyboard low={keyRange[0]} high={keyRange[1]} marks={shownMarks} onPress={onScreenKey} labels={!running || mode === 'wait'} />}
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
