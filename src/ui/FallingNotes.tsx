import { useEffect, useRef } from 'react';
import { keyGeometry } from './PianoKeyboard';
import { MeasureSpan, PlayNote } from '../model/playback';

interface Props {
  notes: PlayNote[];
  measures: MeasureSpan[];
  /** the keyboard drawn underneath: the notes fall onto its keys */
  low: number;
  high: number;
  /** the score time now, read every frame */
  time: () => number;
  /** which hand a note belongs to, and whether the player (not the app) plays it */
  hand: (n: PlayNote) => 'rh' | 'lh' | 'other';
  mine: (n: PlayNote) => boolean;
  /** how many seconds of music are on screen */
  seconds?: number;
}

const COLORS = { rh: [91, 140, 255], lh: [255, 157, 60], other: [176, 140, 240] } as const;

/** Notes falling towards the keyboard, each as long as it lasts. */
export function FallingNotes({ notes, measures, low, high, time, hand, mine, seconds = 4 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // the newest props, for the drawing loop
  const props = useRef({ notes, measures, low, high, time, hand, mine, seconds });
  props.current = { notes, measures, low, high, time, hand, mine, seconds };

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d')!;
    let raf = 0;
    const draw = () => {
      const p = props.current;
      const dpr = window.devicePixelRatio || 1;
      const W = canvas.clientWidth;
      const H = canvas.clientHeight;
      if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
        canvas.width = Math.round(W * dpr);
        canvas.height = Math.round(H * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const bg = ctx.createLinearGradient(0, 0, 0, H);
      bg.addColorStop(0, '#0c0e16');
      bg.addColorStop(1, '#1a1e2e');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);

      const { keys } = keyGeometry(p.low, p.high);
      const t = p.time();
      const y = (at: number) => H - ((at - t) / p.seconds) * H;

      // a faint line up from every C, and one across for every bar and beat
      ctx.lineWidth = 1;
      for (const [m, k] of keys) {
        if (m % 12 !== 0 || k.black) continue;
        ctx.strokeStyle = 'rgba(255,255,255,0.07)';
        ctx.beginPath();
        ctx.moveTo((k.left / 100) * W + 0.5, 0);
        ctx.lineTo((k.left / 100) * W + 0.5, H);
        ctx.stroke();
      }
      for (const m of p.measures) {
        if (m.end < t || m.time > t + p.seconds) continue;
        for (let b = 0; b < m.beats; b++) {
          const yy = Math.round(y(m.time + b * m.beatDur)) + 0.5;
          ctx.strokeStyle = b === 0 ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.06)';
          ctx.beginPath();
          ctx.moveTo(0, yy);
          ctx.lineTo(W, yy);
          ctx.stroke();
        }
      }

      for (const n of p.notes) {
        if (n.time > t + p.seconds) break;
        if (n.time + n.dur < t) continue;
        const k = keys.get(n.midi);
        if (!k) continue;
        const x = (k.left / 100) * W + 1;
        const w = Math.max(3, (k.width / 100) * W - 2);
        const bottom = Math.min(H, y(n.time));
        const top = y(n.time + n.dur);
        const h = Math.max(4, bottom - top - 1.5);
        const [r, g, b] = COLORS[p.hand(n)];
        const sounding = n.time <= t;
        const shade = k.black ? 0.78 : 1;
        // the app's own notes are drawn fainter than the ones you play
        ctx.globalAlpha = p.mine(n) ? 1 : 0.42;
        ctx.fillStyle = `rgb(${Math.round(r * shade)},${Math.round(g * shade)},${Math.round(b * shade)})`;
        ctx.shadowColor = `rgba(${r},${g},${b},0.9)`;
        ctx.shadowBlur = sounding ? 16 : 0;
        ctx.beginPath();
        ctx.roundRect(x, bottom - h, w, h, Math.min(5, w / 2, h / 2));
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 1;
      }
      // the line the notes land on
      const glow = ctx.createLinearGradient(0, H - 28, 0, H);
      glow.addColorStop(0, 'rgba(255,255,255,0)');
      glow.addColorStop(1, 'rgba(255,255,255,0.16)');
      ctx.fillStyle = glow;
      ctx.fillRect(0, H - 28, W, 28);
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  return <canvas ref={canvasRef} className="falling" aria-label="Falling notes" />;
}
