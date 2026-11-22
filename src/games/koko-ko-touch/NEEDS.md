# NEEDS: a "touch your own landmark" detector

`코코코... 눈!` needs: is the player's OWN hand currently resting on one of
their OWN other landmarks (nose/eye/mouth/ear/head-top/shoulder/belly), with
hysteresis, confirm frames and a cooldown, the way every other gesture in
`gestures/index.ts` is rented rather than hand-rolled?

Nothing in the gesture set covers this:

- `jointTargets` targets are fixed **0..1 view fractions** — "put your hand in
  this zone of the screen", not "on this part of your own moving body".
  Feeding it a landmark's position would mean reconfiguring it every frame.
- `holdPose` compares joint *angles*; `poseMatch` compares a whole joint set's
  shape. Neither is a pairwise distance between two of the player's joints.

## What index.ts does instead (the honest local version)

- **Palms** come from the rented `reach` detector (`leftPalm`/`rightPalm`).
- **Anchors** are rebuilt every frame from the player's own landmarks:
  nose + eye-centre + mouth-centre (one FACE region), both ears, a head-top
  point (nose + 0.6 x (nose - shoulder centre)), both shoulders, and a belly
  point 62% of the way from shoulder centre to hip centre (or, with hips
  hidden behind a desk, continued down the head-to-shoulder line).
- **Distance is in shoulder widths** (px / `scalePx`), never pixels. Each region
  has a radius (0.30–0.44 sw); a palm belongs to the region with the smallest
  distance/radius ratio below 1.
- **Not single-frame:** a palm must stay in the same region for 7 frames
  (~117 ms) AND have travelled < 0.4 sw over the last 8 frames (it has
  arrived, it is not a swipe passing through).
- **"Fooled"** (resting on the part the caller pointed at instead of the part
  it said) needs 30 frames (~0.5 s) of rest there counted from the call, and
  never before 1.2 s after it — a passing hand is not a choice, and a finger
  still leaving the nose from the chant is not one either.
- **One-shot latch per prompt:** the first judgement ends the prompt; prompts
  are >= 2.5 s apart, which covers the >= 250 ms cooldown.

Known limit: nose, eyes and mouth are ~0.15 sw apart — inside palm-estimate
error — so they are ONE region. Saying "눈" and touching the mouth counts.
Tricks never pair two words from the same region, so no trick is judged on a
distinction the camera cannot make.

If two or more other authors want the same primitive (body-simon, "simon says
touch your X", pose games with self-contact), it is worth promoting to a real
detector — e.g. `selfTouch` with `{ anchors: Joint[] | derived, radius,
confirmFrames, settleSw }` -> `{ region, touching, held, ok }`.

## Also missing: a clip that touches the body

No smoke clip puts a hand on the head, face or ears. `clap-x12` is the dev clip
because its waist and shoulder-height claps brush the belly and shoulders —
it plays like a child who taps their tummy on a metronome without listening,
and lands on one star. A `self-touch` clip (hands to head / nose / ear /
shoulder / belly and back, held ~0.6 s each) would let this game, body-simon
and any "touch your X" game be tested on what they actually ask for.
