# NEEDS — castle-defense

**Signal needed:** a rented `swing`-style detector for a joint other than the
wrist — specifically the ankles, for a foot-swat swing.

**Why:** the brief requires both hands and feet to knock rocks away with a
*swing* (speed-gated, swept-segment hit test), not a static touch. The engine's
`SwingDetector` (`src/engine/gestures/detectors.ts`) hardcodes `L.LEFT_WRIST` /
`L.RIGHT_WRIST` in its `step()` — `SwingOpts.side` only selects which wrist,
not which joint. There is no way to rent a swing detector for `L.LEFT_ANKLE` /
`L.RIGHT_ANKLE`.

**What I did instead:** implemented the simplest honest version inline in
`index.ts` (`handleFoot()`), using only engine-provided primitives:

- `p.vis[ankle]` to gate on visibility (hold, don't guess),
- `p.v` (the engine's own filtered normalized velocity) magnitude at the ankle
  as the speed gate, rather than differencing raw pixels myself,
- `hitSegCircle` against the ankle's previous-frame position (a `Pt` scratch
  held in a field, NaN-sentinel on the first frame — the same idiom
  `SwingDetector` itself uses for `prevLX`/`prevLY`).

This is deliberately more primitive than `SwingDetector`: no hysteresis
Trigger, no confirm-frames, no re-arm cooldown — just a one-shot speed gate,
safe only because every rock is a one-hit-kill entity (`life <= 0` is checked
before any hit test, so a rock already killed this frame by one limb cannot
be re-resolved by another limb's test in the same `update()`).

The foot speed threshold (2.4 shoulder-widths/sec, see the `FOOT_SWING_GATE`
comment in `index.ts`) is **not** corpus-measured like the documented hand
thresholds in `docs/GAME_AUTHORING.md` §4 — there is no ankle-swing clip in
the corpus to measure against. It is a judgment call scaled down from the
hand default (3.5 sw/s) on the assumption that a kick is generally slower than
an arm swing from this camera distance; it has not been validated against a
real foot-swing clip the way `jump`/`clap`/`swing` were.

**If a second author needs this:** generalize `SwingOpts` with an optional
`joint: 'wrist' | 'ankle'` (or a `Joint` pair) so `SwingDetector.step()` picks
the pair instead of hardcoding wrists, and the proper hysteresis/cooldown
machinery becomes available for foot-swing games instead of every author
re-deriving a thinner version of it.
