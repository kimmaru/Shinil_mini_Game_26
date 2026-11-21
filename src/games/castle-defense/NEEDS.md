# NEEDS — castle-defense

**Signal needed:** a rented `swing`-style detector for a joint other than the
wrist — specifically the ankles, for a foot-swat swing.

**Why:** the brief wants both hands and feet to knock rocks away with a
*swing* (speed-gated, swept-segment hit test), not a static touch. The engine's
`SwingDetector` (`src/engine/gestures/detectors.ts`) hardcodes `L.LEFT_WRIST` /
`L.RIGHT_WRIST` in its `step()` — `SwingOpts.side` only selects which wrist,
not which joint. There is no way to rent a swing detector for `L.LEFT_ANKLE` /
`L.RIGHT_ANKLE`.

**What I did instead:** the foot swat is a bonus, never required — hands alone
play the whole game, and `requiredLandmarks` does not declare legs. It is
implemented inline in `index.ts` (`handleFoot()`) from engine primitives only:

- `p.vis[ankle]` gates visibility (hold, don't guess),
- the engine's filtered normalized velocity `p.v` at the ankle must exceed
  3.0 shoulder-widths/sec for 3 frames running,
- AND the ankle must have travelled >= 0.5 shoulder-widths (net, from where the
  run began). Sensor jitter on a distant, still child is fast but random and
  never travels, so a far-small child standing still cannot fire it,
- a 260 ms cooldown after a landed hit, plus a 300 ms per-rock hit gap,
- `hitSegCircle` from the previous-frame ankle position to the current one.

The 3.0 / 0.5 numbers are **not** corpus-measured like the hand thresholds in
`docs/GAME_AUTHORING.md` §4 — there is no ankle-swing clip in the corpus. They
were chosen strict on purpose and checked only against `idle`, `fidget` and a
synthetic still child at 4 m (all score 0 from feet).

**If a second author needs this:** generalize `SwingOpts` with an optional
`joint: 'wrist' | 'ankle'` (or a `Joint` pair) so `SwingDetector.step()` picks
the pair instead of hardcoding wrists, and the proper hysteresis/cooldown
machinery becomes available for foot-swing games instead of every author
re-deriving a thinner version of it.
