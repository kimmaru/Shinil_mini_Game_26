// 기록 — the booth's standing best per game.
//
// Scoped to the DAY, not to all time, and that is a product decision rather
// than a storage convenience: a stranger who plays one round can plausibly
// beat today's best, and cannot plausibly beat a number set over three weeks.
// An unbeatable record is not a record, it is a wall, and it removes the only
// reason a passer-by has to try a second time.
//
// Nothing here identifies anybody. A score and a timestamp, under the `mg:`
// namespace, cleared by the 전체 삭제 button in 설정 like everything else.
import type { GameId, GameResult } from '@/engine/types';

export interface GameRecord {
  score: number;
  stars: 0 | 1 | 2 | 3;
  /** ms since epoch, for "방금" vs "아까" copy. */
  atMs: number;
}

export type RecordTable = Partial<Record<GameId, GameRecord>>;

const LS_KEY = 'mg:records';

/** Local calendar day, so the reset lands at the booth's midnight rather than
 *  UTC's — a booth open until 9pm must not roll over mid-evening. */
export function dayKey(nowMs: number): string {
  const d = new Date(nowMs);
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

interface Stored {
  day: string;
  games: RecordTable;
}

/** Storage can throw outright (Safari private mode, a locked-down kiosk
 *  profile), so every path here degrades to "no records" rather than taking
 *  the page down. A booth with no record board still runs games. */
export function loadRecords(nowMs = Date.now()): RecordTable {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return {};
    const s = JSON.parse(raw) as Partial<Stored>;
    if (s.day !== dayKey(nowMs)) return {}; // yesterday's board is not today's
    return s.games && typeof s.games === 'object' ? s.games : {};
  } catch {
    return {};
  }
}

function write(t: RecordTable, nowMs: number): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ day: dayKey(nowMs), games: t } as Stored));
  } catch {
    /* a full or disabled store must not fail the round that just finished */
  }
}

/**
 * Fold a finished round into the table.
 *
 * Returns the table to render and whether this round actually took the record,
 * because the results screen celebrates those two things differently and must
 * not have to diff the tables itself.
 */
export function submitRecord(
  table: RecordTable,
  id: GameId,
  result: GameResult,
  nowMs = Date.now(),
): { table: RecordTable; beat: boolean; previous: GameRecord | null } {
  const previous = table[id] ?? null;
  // Strictly greater: tying today's best is not beating it, and awarding the
  // celebration for a tie makes the celebration mean nothing.
  const beat = previous === null || result.rawScore > previous.score;
  if (!beat) return { table, beat: false, previous };
  const next: RecordTable = {
    ...table,
    [id]: { score: result.rawScore, stars: result.stars, atMs: nowMs },
  };
  write(next, nowMs);
  return { table: next, beat: true, previous };
}

export function clearRecords(): void {
  try {
    localStorage.removeItem(LS_KEY);
  } catch {
    /* nothing to do and nothing worth reporting */
  }
}
