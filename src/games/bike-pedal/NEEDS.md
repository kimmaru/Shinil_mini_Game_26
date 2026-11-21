# NEEDS: a rotational/circular gesture signal

`bike-pedal` wants to know that a hand is really drawing a circle: phase and
rotation direction, with the two hands half a lap apart.

The engine has no such primitive. `rep` takes a plain scalar, so it cannot tell
a circle from a hand bobbing up and down, and no clip in
`src/engine/testing/clips.ts` drives a hand through a real orbit to test one.

Shipped instead: each hand's wrist height above its own elbow (shoulder-widths)
fed to a `rep` detector. One lap of a circle swings the wrist above and below
the elbow once, so a lap counts as one cycle. Strides must alternate left/right.
Direction of rotation is NOT verified, so the game does not ask for "reverse".

If a second author needs it, a `circle` gesture kind (centre, radius, phase,
signed angular velocity) becomes a shared engine service.
