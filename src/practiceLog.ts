// A small diary of play-along sessions, kept in the browser: what was practised, for how long and
// how well. The library shows it as a streak, minutes this week and a best score per piece.
const KEY = 'smp.practice.v1';
const KEEP = 600;

export interface Session {
  /** score id */
  id: string;
  /** when it ended, ms */
  at: number;
  seconds: number;
  mode: 'follow' | 'wait';
  /** notes right, 0–100; absent when no keyboard was listening */
  percent?: number;
}

function all(): Session[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]') as Session[];
  } catch {
    return [];
  }
}

export function logSession(s: Session) {
  try {
    localStorage.setItem(KEY, JSON.stringify([...all(), s].slice(-KEEP)));
  } catch {
    /* storage full or blocked: the diary is a nicety */
  }
}

const day = (t: number) => {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};
const DAY = 86400000;

export interface PracticeSummary {
  /** days in a row with some practice, counting today or yesterday as the latest */
  streak: number;
  minutesThisWeek: number;
  /** per score id */
  pieces: Map<string, { sessions: number; best?: number; last: number }>;
}

export function summarize(sessions = all(), now = Date.now()): PracticeSummary {
  const days = new Set(sessions.map((s) => day(s.at)));
  let streak = 0;
  // half a day before midnight is always the day before, even when the clocks change
  let d = day(now);
  if (!days.has(d)) d = day(d - DAY / 2);
  while (days.has(d)) {
    streak++;
    d = day(d - DAY / 2);
  }
  const weekAgo = now - 7 * DAY;
  const minutesThisWeek = Math.round(sessions.filter((s) => s.at >= weekAgo).reduce((a, s) => a + s.seconds, 0) / 60);
  const pieces: PracticeSummary['pieces'] = new Map();
  for (const s of sessions) {
    const p = pieces.get(s.id) ?? { sessions: 0, last: 0 };
    p.sessions++;
    p.last = Math.max(p.last, s.at);
    if (s.percent !== undefined) p.best = Math.max(p.best ?? 0, s.percent);
    pieces.set(s.id, p);
  }
  return { streak, minutesThisWeek, pieces };
}
