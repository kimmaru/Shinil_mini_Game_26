// ══ FROZEN CONTRACT ══ imported by 58 game modules.
//
// The HUD is engine-owned and rendered in the DOM, above the canvas: 58 games
// must not each lay out their own timer and score, and DOM text gives us real
// Korean shaping, `aria-live` and the 10-foot type scale for free.
//
// A game SETS state here; it never draws chrome.
import type { Slot } from '../types';

export interface HudService {
  /** The one-line objective, shown top-centre. "모기를 잡아요!" */
  setGoal(textKo: string): void;
  /** Main score. The engine animates the count-up and uses tabular figures. */
  setScore(n: number, slot?: Slot): void;
  /** Combo counter. 0 or 1 hides it. */
  setCombo(n: number, slot?: Slot): void;
  /** A labelled 0..1 progress/health bar. Call with the same `key` to update. */
  setBar(key: string, value: number, o?: { labelKo?: string; color?: string }): void;
  /** Remove a bar. */
  clearBar(key: string): void;
  /** Transient message, ~1.4s. For "좋아요!" not for instructions. */
  toast(textKo: string, o?: { color?: string; big?: boolean }): void;
  /**
   * Announce to assistive tech AND show on screen. Every spoken prompt must go
   * through here: audio is never load-bearing, so the text is the real channel
   * and the voice is the garnish.
   */
  announce(textKo: string, o?: { assertive?: boolean; speak?: boolean }): void;
  /**
   * Pulsing ring locked to the audio beat. The engine renders it whenever
   * `manifest.a11y.audioOptional === false`, so a player with sound off can
   * still play a rhythm game.
   */
  beatRing(on: boolean): void;
  /** Lives/hearts display. -1 hides it. */
  setLives(n: number, max?: number): void;
  /** Remaining seconds, if the game wants to override the engine's timer
   *  (e.g. a round-based game). Omit to use the manifest duration. */
  setTime(secondsLeft: number): void;
}
