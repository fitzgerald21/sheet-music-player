import { memo } from 'react';

export type KeyMark = 'rh' | 'lh' | 'other' | 'target' | 'good' | 'wrong' | 'held';

interface Props {
  low: number;
  high: number;
  marks: Map<number, KeyMark>;
  onPress?: (midi: number, down: boolean) => void;
  labels?: boolean;
}

const BLACK = new Set([1, 3, 6, 8, 10]);
const NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

/** Where each key sits, in percent of the keyboard's width. The range is widened to start and end on white keys. */
export function keyGeometry(low: number, high: number) {
  while (BLACK.has(((low % 12) + 12) % 12)) low--;
  while (BLACK.has(((high % 12) + 12) % 12)) high++;
  const whites: number[] = [];
  for (let m = low; m <= high; m++) if (!BLACK.has(m % 12)) whites.push(m);
  const ww = 100 / whites.length;
  const keys = new Map<number, { left: number; width: number; black: boolean }>();
  whites.forEach((m, i) => keys.set(m, { left: i * ww, width: ww, black: false }));
  for (let m = low; m <= high; m++) if (BLACK.has(m % 12)) keys.set(m, { left: (whites.indexOf(m - 1) + 1) * ww - ww * 0.32, width: ww * 0.64, black: true });
  return { low, high, whites, keys };
}

/** A responsive piano keyboard that lights up keys. */
export const PianoKeyboard = memo(function PianoKeyboard({ low, high, marks, onPress, labels }: Props) {
  const { whites, keys } = keyGeometry(low, high);
  const down = (m: number) => (e: React.PointerEvent) => {
    e.preventDefault();
    onPress?.(m, true);
  };
  const up = (m: number) => () => onPress?.(m, false);
  return (
    <div className="piano" role="img" aria-label="Piano keyboard">
      {whites.map((m) => (
        <div
          key={m}
          className={`pk white ${marks.get(m) ?? ''}`}
          style={{ left: `${keys.get(m)!.left}%`, width: `${keys.get(m)!.width}%` }}
          onPointerDown={down(m)}
          onPointerUp={up(m)}
          onPointerLeave={up(m)}
        >
          {labels && m % 12 === 0 && <span className="pk-label">C{Math.floor(m / 12) - 1}</span>}
          {labels && marks.get(m) && m % 12 !== 0 && <span className="pk-label lit">{NAMES[m % 12]}</span>}
        </div>
      ))}
      {[...keys].filter(([, k]) => k.black).map(([m, k]) => (
        <div
          key={m}
          className={`pk black ${marks.get(m) ?? ''}`}
          style={{ left: `${k.left}%`, width: `${k.width}%` }}
          onPointerDown={down(m)}
          onPointerUp={up(m)}
          onPointerLeave={up(m)}
        />
      ))}
    </div>
  );
});
