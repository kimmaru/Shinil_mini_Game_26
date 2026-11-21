# NEEDS — fruit-slash

## `swing` over an arbitrary joint (here: the ankles)

`SwingOpts` takes `side: 'L' | 'R' | 'both'` and the detector is hard-wired to
`LEFT_WRIST` / `RIGHT_WRIST`. This game wants the identical state machine on
`LEFT_ANKLE` / `RIGHT_ANKLE` so a kick can slice a fruit, which is the whole-body
half of the design.

**What is missing:** `SwingOpts.joints?: readonly Joint[]`, or a `'foot'` side,
giving the same `active` / `from` / `to` / `speed` / `dirDeg` signal measured at
the chosen joint — crucially including `from`/`to`, so the kick can be swept with
`hitSegCircle` the same way a hand slash is.

**Why it cannot be faked at the wrist threshold:** an ankle's apparent speed is
much noisier than a wrist's, because the scale estimate error multiplies a
position far from the hip. Measured max ankle speed from `p.v` across the corpus:
`idle` 1.34, `fidget` 2.03, running in place 2.92, `jump-x8` 3.70, and **5.61 at
4 m (`far-small`)**. There is no speed threshold that fires on a real kick and
not on a distant child standing still, so a speed-based local copy would be
unfair exactly where the engine's own `far-small` clip exists to catch it.

**What shipped instead:** a rented `rep` detector whose scalar is the ankle's
lift above the *other* ankle in shoulder-widths — a displacement, not a speed, so
the scale noise multiplies 0.6 sw instead of a 2 sw position. The engine then
owns the hysteresis (0.60 / 0.28), the confirm frames and the 300 ms refractory
period, and the rising edge opens a 220 ms window during which the ankle's
per-frame segment is swept with `hitSegCircle`. Measured ankle lift across the
corpus: `idle` 0.08, `fidget` 0.10, `step-lr` 0.13, `jump-x8` 0.16, `far-small`
0.17, running in place 0.43, the 10 fps `laggy` clip 0.52 — so 0.60 clears
everything the corpus does without a kick in it.

**Cost of the workaround:** the kick is credited from a lift rather than from a
swing, so a slow deliberate leg raise counts as a kick and a fast low toe-poke
that never lifts the foot 0.6 sw does not. Both are acceptable here because the
kick is a bonus; in a game where kicking IS the mechanic it would not be.
