import { Score } from './model/types';
import { Effort } from './omr/transcribe';

const INDEX_KEY = 'smp.library.v1';
const SCORE_KEY = (id: string) => `smp.score.v1.${id}`;
const SETTINGS_KEY = 'smp.settings.v1';

export interface LibraryEntry {
  id: string;
  title: string;
  composer?: string;
  updated: number;
  measures: number;
}

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function safeSet(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function listLibrary(): LibraryEntry[] {
  try {
    const list = JSON.parse(safeGet(INDEX_KEY) ?? '[]') as LibraryEntry[];
    return list.sort((a, b) => b.updated - a.updated);
  } catch {
    return [];
  }
}

export function saveScore(score: Score): boolean {
  const ok = safeSet(SCORE_KEY(score.id), JSON.stringify(score));
  if (!ok) return false;
  const list = listLibrary().filter((e) => e.id !== score.id);
  list.push({ id: score.id, title: score.title, composer: score.composer, updated: score.updated, measures: score.measures.length });
  return safeSet(INDEX_KEY, JSON.stringify(list));
}

export function loadScore(id: string): Score | null {
  try {
    const raw = safeGet(SCORE_KEY(id));
    return raw ? (JSON.parse(raw) as Score) : null;
  } catch {
    return null;
  }
}

export function deleteScore(id: string) {
  try {
    localStorage.removeItem(SCORE_KEY(id));
  } catch {
    /* ignore */
  }
  safeSet(INDEX_KEY, JSON.stringify(listLibrary().filter((e) => e.id !== id)));
}

export type Engine = 'claude' | 'compat' | 'audiveris';

export interface Settings {
  engine: Engine;
  compatPreset: string;
  compatBaseUrl: string;
  compatKey: string;
  compatModel: string;
  apiKey: string;
  model: string;
  effort: Effort;
  zoom: number;
  humanize: boolean;
  playChords: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  engine: 'claude',
  compatPreset: 'openrouter',
  compatBaseUrl: 'https://openrouter.ai/api/v1',
  compatKey: '',
  compatModel: '',
  apiKey: '',
  model: 'claude-opus-5-5',
  effort: 'high',
  zoom: typeof window !== 'undefined' && window.innerWidth < 700 ? 0.62 : 0.95,
  humanize: true,
  playChords: false,
};

export function loadSettings(): Settings {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(safeGet(SETTINGS_KEY) ?? '{}') };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(s: Settings) {
  safeSet(SETTINGS_KEY, JSON.stringify(s));
}
