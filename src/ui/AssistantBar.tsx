import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icons';
import { Mark, describeMark } from '../ai/assistant';
import { Score } from '../model/types';

export interface AssistantNote {
  kind: 'reply' | 'error';
  text: string;
  /** details the model's answer could not deliver */
  problems?: string[];
  /** the last request changed the score and can be undone */
  canUndo?: boolean;
}

interface Props {
  score: Score;
  marks: Mark[];
  onRemoveMark: (m: Mark) => void;
  onClearMarks: () => void;
  busy: boolean;
  note: AssistantNote | null;
  ready: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  onUndo: () => void;
  onClose: () => void;
  onSettings: () => void;
}

const EXAMPLES = ['In measure 3, make the first C in the treble a C sharp', 'Remove the tie from just the G here', 'Make these two measures an octave lower in the left hand'];

/** The bar for asking for a change in words. While it is open, tapping the score highlights things to talk about. */
export function AssistantBar({ score, marks, onRemoveMark, onClearMarks, busy, note, ready, onSend, onStop, onUndo, onClose, onSettings }: Props) {
  const [text, setText] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [text]);

  const send = () => {
    const t = text.trim();
    if (!t || busy || !ready) return;
    onSend(t);
    setText('');
  };

  return (
    <div className="assist" role="region" aria-label="Ask for a change">
      <div className="assist-head">
        <strong>Ask for a change</strong>
        <span className="hint grow">{marks.length ? '' : 'Optional: tap notes or measures to point at them.'}</span>
        <button className="icon-btn sm" onClick={onClose} aria-label="Close"><Icon.close size={16} /></button>
      </div>

      {marks.length > 0 && (
        <div className="assist-marks scroll-x" aria-label="Highlighted">
          {marks.map((m, i) => {
            const d = describeMark(score, m);
            if (!d) return null;
            return (
              <span key={i} className={`mark-chip ${m.kind}`}>
                {d.label}
                <button onClick={() => onRemoveMark(m)} aria-label={`Remove ${d.label}`}>×</button>
              </span>
            );
          })}
          {marks.length > 1 && <button className="link" onClick={onClearMarks}>Clear all</button>}
        </div>
      )}

      {note && (
        <div className={`assist-note ${note.kind}`} role="status">
          <span>{note.text}</span>
          {note.problems?.map((p, i) => <span key={i} className="assist-problem">{p}</span>)}
          {note.canUndo && <button className="btn sm" onClick={onUndo}><Icon.undo size={14} /> Undo</button>}
        </div>
      )}

      {!ready ? (
        <div className="assist-note error">
          <span>This needs an AI key. Your request and the notes of the score are sent to that service.</span>
          <button className="btn sm" onClick={onSettings}>Open Settings</button>
        </div>
      ) : (
        <>
          <div className="assist-row">
            <textarea
              ref={box}
              rows={1}
              value={text}
              placeholder={marks.length ? 'What should change about the highlighted part?' : 'e.g. In measure 25, change the first C in the treble to C sharp'}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              aria-label="Your request"
              disabled={busy}
            />
            {busy ? (
              <button className="btn" onClick={onStop}>Stop</button>
            ) : (
              <button className="btn primary" onClick={send} disabled={!text.trim()}>Send</button>
            )}
          </div>
          {busy && <div className="assist-busy" role="status">Working on it…</div>}
          {!busy && !note && !text && (
            <div className="assist-examples scroll-x">
              {EXAMPLES.map((ex) => <button key={ex} className="example" onClick={() => { setText(ex); box.current?.focus(); }}>{ex}</button>)}
            </div>
          )}
        </>
      )}
    </div>
  );
}
