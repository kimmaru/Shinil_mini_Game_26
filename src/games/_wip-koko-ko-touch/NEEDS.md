# NEEDS: a "touch your own landmark" detector

`코코코... 눈!` needs: is the player's OWN hand currently near one of their
OWN other landmarks (nose/ear/eye/mouth/shoulder/knee), with hysteresis and a
cooldown, the way every other gesture in `gestures/index.ts` is rented rather
than hand-rolled?

Nothing in the gesture set covers this:

- `jointTargets` is the closest-sounding match, but its `targets` are fixed
  **0..1 view fractions** (`service.ts`: "Targets are in 0..1 view
  fractions") — it is built for "put your hand in this zone of the screen",
  not "put your hand on this part of your own, moving body". Feeding it a
  body landmark's current screen position as the target would need
  recomputing `targets` every frame, which is exactly the per-frame
  reconfiguration the detector contract says a game must not do mid-round.
- `holdPose` compares joint *angles* to a target pose, not a distance between
  two of the player's own joints.
- `poseMatch` compares a whole joint set's shape via cosine similarity, not a
  single pairwise distance.

What I actually implemented (the honest version without the primitive): each
prompt, I test the chosen landmark(s) directly with `palm()` (view px) against
`jointPx()`/`midPx()` of the target joint, divide the distance by `p.scalePx`
to get shoulder-widths, and compare to a fixed per-part radius (0.38–0.6 sw —
tighter for the close-together face points, looser for shoulder/knee). The
"hysteresis + cooldown" that a rented detector would give for free is
replaced by a simple one-shot latch: once a prompt's target is hit it is
marked `hit` and never re-tested, so there is no way to double-score it, and
the ≥250ms floor is satisfied for free because the shortest response window
(900ms at the end of the ramp) is already well above it.

If two or more other authors want the same "hand near own landmark" primitive
(pose-match games, "simon says touch your X" games), this is worth promoting
to a real detector — something like
`zone`-but-the-zone-follows-a-joint, or a `selfTouch` kind with
`{ joints: Joint[], side?, radius }` → `{ touching, ok }`.
