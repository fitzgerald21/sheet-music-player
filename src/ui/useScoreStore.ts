import { useCallback, useRef, useState } from 'react';
import { Score } from '../model/types';

export interface ScoreStore {
  score: Score | null;
  set: (s: Score, opts?: { record?: boolean }) => void;
  replace: (s: Score | null) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

/** Score state with undo/redo history. */
export function useScoreStore(): ScoreStore {
  const [score, setScore] = useState<Score | null>(null);
  const past = useRef<Score[]>([]);
  const future = useRef<Score[]>([]);
  const [, force] = useState(0);

  const set = useCallback((s: Score, opts: { record?: boolean } = {}) => {
    setScore((prev) => {
      if (prev && opts.record !== false && prev !== s) {
        past.current.push(prev);
        if (past.current.length > 200) past.current.shift();
        future.current = [];
      }
      return { ...s, updated: Date.now() };
    });
    force((x) => x + 1);
  }, []);

  const replace = useCallback((s: Score | null) => {
    past.current = [];
    future.current = [];
    setScore(s);
    force((x) => x + 1);
  }, []);

  const undo = useCallback(() => {
    setScore((cur) => {
      const prev = past.current.pop();
      if (!prev || !cur) return cur;
      future.current.push(cur);
      return prev;
    });
    force((x) => x + 1);
  }, []);

  const redo = useCallback(() => {
    setScore((cur) => {
      const next = future.current.pop();
      if (!next || !cur) return cur;
      past.current.push(cur);
      return next;
    });
    force((x) => x + 1);
  }, []);

  return { score, set, replace, undo, redo, canUndo: past.current.length > 0, canRedo: future.current.length > 0 };
}
