# NEEDS: a rotational/circular gesture signal

`bike-pedal`'s spec calls for the real signal: the two wrists' circular
*phase and rotation direction* (hands drawing a circle, not reciprocating up
and down), with a bonus when the hands are ~180° apart in that circle.

The engine has no primitive for this today:

- `GestureOpts['rep'].signal` is a plain `(p: PlayerPose) => number` scalar
  with hysteresis `enter`/`exit`. It has no notion of a 2D path, a rotation
  direction, or lap-completion, so it cannot distinguish a genuine circle
  from a hand bobbing up and down at the same rate.
- No clip in `src/engine/testing/clips.ts` drives a hand through an actual
  rotation (a full 2D orbit around a point). `knee-run`'s arm swing is a
  pendulum arc centred on the shoulder — real x/y motion, but it reverses
  direction every half-swing rather than completing a lap — so there is
  nothing in the corpus to smoke-test true circular detection against even
  if I built it.

What I shipped instead (the simplest honest version): both hands reuse
`kneeLift(p, side)` — the exact scalar `run-in-place-sprint` uses, and the
one `reps.ts`'s own doc comment names "pedalling" under. A pump/bob of either
hand counts a cycle via the engine's own `rep` hysteresis; two independent
`rep` detectors (L, R) are kept, and this file compares their `phase` values
— close to 0.5 apart (antiphase) is scored as "good form" and gives a
distance bonus, which is the honest proxy for "hands opposite in the circle"
available from the data that already exists. The "반대로!" (reverse) segment
is therefore flavour only (the wheel/gear spin backward on screen, and
cadence is rewarded the same as the forward direction) — true direction
reversal is not verified, because reciprocating a scalar up and down has no
inherent "direction" to check.

If a second author independently asks for rotation-direction detection (a
`circle` gesture kind: centre, radius, phase, and signed angular velocity,
smuggled the same way `rep` smuggles its scalar), this becomes a Wave 3+
engine service rather than two bespoke copies.
