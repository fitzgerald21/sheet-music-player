import { Icon, NoteGlyph, RestGlyph } from './Icons';
import { DurType, Dynamic, DYNAMICS, NoteEvent, Step } from '../model/types';

export type EditAction =
  | { type: 'dur'; dur: DurType }
  | { type: 'dot' }
  | { type: 'triplet' }
  | { type: 'rest' }
  | { type: 'step'; amount: number }
  | { type: 'semi'; amount: number }
  | { type: 'octave'; amount: number }
  | { type: 'acc'; alter: number }
  | { type: 'letter'; step: Step; chord: boolean }
  | { type: 'interval'; steps: number }
  | { type: 'tie' }
  | { type: 'artic'; artic: 'staccato' | 'accent' | 'tenuto' | 'fermata' }
  | { type: 'slur' }
  | { type: 'dynamic'; dynamic: Dynamic | undefined }
  | { type: 'lyric' }
  | { type: 'prev' }
  | { type: 'next' }
  | { type: 'voice2' }
  | { type: 'measure' };

interface Props {
  event: NoteEvent | null;
  onAction: (a: EditAction) => void;
  hasSelection: boolean;
  chordMode: boolean;
  setChordMode: (b: boolean) => void;
}

const DURS: DurType[] = ['w', 'h', 'q', '8', '16', '32'];

export function EditPalette({ event, onAction, hasSelection, chordMode, setChordMode }: Props) {
  const dis = !event;
  const isNote = !!event && !event.rest;
  return (
    <div className="palette" onMouseDown={(e) => e.preventDefault()}>
      {!hasSelection && <div className="palette-hint">Tap a note or rest to edit it. Tap an empty part of a measure for measure tools.</div>}
      <div className="palette-row scroll-x">
        <div className="tool-group">
          <button className="tool" onClick={() => onAction({ type: 'prev' })} disabled={dis} title="Previous (←)"><Icon.left size={18} /></button>
          <button className="tool" onClick={() => onAction({ type: 'next' })} disabled={dis} title="Next (→)"><Icon.right size={18} /></button>
        </div>
        <div className="tool-group">
          {DURS.map((d) => (
            <button key={d} className={`tool ${event && !event.fullMeasure && event.dur === d ? 'on' : ''}`} disabled={dis} onClick={() => onAction({ type: 'dur', dur: d })} title={`Duration`}>
              <NoteGlyph dur={d} />
            </button>
          ))}
          <button className={`tool txt ${event?.dots ? 'on' : ''}`} disabled={dis} onClick={() => onAction({ type: 'dot' })} title="Dot (.)">•</button>
          <button className={`tool txt ${event?.triplet ? 'on' : ''}`} disabled={dis} onClick={() => onAction({ type: 'triplet' })} title="Triplet">3</button>
          <button className={`tool ${event?.rest ? 'on' : ''}`} disabled={dis} onClick={() => onAction({ type: 'rest' })} title="Make rest (0 / Delete)"><RestGlyph /></button>
        </div>
        <div className="tool-group">
          <button className="tool" disabled={!isNote} onClick={() => onAction({ type: 'step', amount: 1 })} title="Up a step (↑)"><Icon.up size={18} /></button>
          <button className="tool" disabled={!isNote} onClick={() => onAction({ type: 'step', amount: -1 })} title="Down a step (↓)"><Icon.down size={18} /></button>
          <button className="tool txt" disabled={!isNote} onClick={() => onAction({ type: 'acc', alter: 1 })} title="Sharp (+)">♯</button>
          <button className="tool txt" disabled={!isNote} onClick={() => onAction({ type: 'acc', alter: -1 })} title="Flat (-)">♭</button>
          <button className="tool txt" disabled={!isNote} onClick={() => onAction({ type: 'acc', alter: 0 })} title="Natural (n)">♮</button>
          <button className="tool txt sm" disabled={!isNote} onClick={() => onAction({ type: 'octave', amount: 1 })} title="Octave up (Ctrl+↑)">8va</button>
          <button className="tool txt sm" disabled={!isNote} onClick={() => onAction({ type: 'octave', amount: -1 })} title="Octave down (Ctrl+↓)">8vb</button>
        </div>
        <div className="tool-group">
          <button className={`tool txt sm ${isNote && event!.pitches.every((p) => p.tie) ? 'on' : ''}`} disabled={!isNote} onClick={() => onAction({ type: 'tie' })} title="Tie (t)">tie</button>
          <button className={`tool txt sm ${event?.slurStart ? 'on' : ''}`} disabled={!isNote} onClick={() => onAction({ type: 'slur' })} title="Slur start/end">slur</button>
          <button className={`tool txt ${event?.artic?.includes('staccato') ? 'on' : ''}`} disabled={!isNote} onClick={() => onAction({ type: 'artic', artic: 'staccato' })} title="Staccato (s)">·</button>
          <button className={`tool txt ${event?.artic?.includes('accent') ? 'on' : ''}`} disabled={!isNote} onClick={() => onAction({ type: 'artic', artic: 'accent' })} title="Accent (>)">&gt;</button>
          <button className={`tool txt ${event?.artic?.includes('tenuto') ? 'on' : ''}`} disabled={!isNote} onClick={() => onAction({ type: 'artic', artic: 'tenuto' })} title="Tenuto">–</button>
          <button className={`tool txt ${event?.artic?.includes('fermata') ? 'on' : ''}`} disabled={!isNote} onClick={() => onAction({ type: 'artic', artic: 'fermata' })} title="Fermata">𝄐</button>
          <select className="tool-select" disabled={!isNote} value={event?.dynamic ?? ''} onChange={(e) => onAction({ type: 'dynamic', dynamic: (e.target.value || undefined) as Dynamic | undefined })} title="Dynamic">
            <option value="">dyn</option>
            {DYNAMICS.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
          <button className="tool txt sm" disabled={!isNote} onClick={() => onAction({ type: 'lyric' })} title="Lyric (l)">lyric</button>
        </div>
        <div className="tool-group">
          <button className="tool txt sm" disabled={!isNote} onClick={() => onAction({ type: 'interval', steps: 2 })} title="Add a 3rd above">+3rd</button>
          <button className="tool txt sm" disabled={!isNote} onClick={() => onAction({ type: 'interval', steps: 4 })} title="Add a 5th above">+5th</button>
          <button className="tool txt sm" disabled={!isNote} onClick={() => onAction({ type: 'interval', steps: 7 })} title="Add an octave above">+8ve</button>
          <button className="tool txt sm" disabled={dis} onClick={() => onAction({ type: 'voice2' })} title="Add / go to a second voice in this measure">voice 2</button>
          <button className="tool txt sm" disabled={!hasSelection} onClick={() => onAction({ type: 'measure' })} title="Measure tools">bar…</button>
        </div>
      </div>
      <div className="palette-row letters">
        {(['C', 'D', 'E', 'F', 'G', 'A', 'B'] as Step[]).map((s) => (
          <button key={s} className="tool letter" disabled={dis} onClick={() => onAction({ type: 'letter', step: s, chord: chordMode && isNote })}>{s}</button>
        ))}
        <button className={`tool txt sm chord-toggle ${chordMode ? 'on' : ''}`} onClick={() => setChordMode(!chordMode)} title="When on, letters add a note to the chord (Shift+letter)">+ chord</button>
      </div>
    </div>
  );
}
