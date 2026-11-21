// UI and gesture icons. Filled in by the icon authoring pass.
import {
  circlePath, defineSprites, linePath, roundRectPath, starPath,
  type SpriteLayer,
} from './sprite';

defineSprites({});

// ─── UI, navigation and status icons ────────────────────────────────────────
//
// These replace the emoji the shell used to print in buttons and badges. An
// emoji is three different pictures on three platforms and cannot be
// recoloured; these are the same artwork as the game canvas, from the same
// 100x100 author box, in the same palette roles.
//
// Two rules decide almost every choice below (ART.md §2.1):
//   - a silhouette edge is `keyline` (white on the dark canvas, swapped for a
//     dark same-hue line by `spriteToSvg({on:'light'})` on a light panel), so
//     every icon survives both backgrounds;
//   - `ink` only ever lands ON TOP of a fill, never against the canvas.
//
// Wrapped in a block so the local helpers cannot collide with the other
// author working in this file.
{
  const SW = 4;
  const KEY = 'keyline';

  /** A filled shape carrying the house outline. */
  const solid = (d: string, fill: SpriteLayer['fill'], sw = SW): SpriteLayer =>
    ({ d, fill, stroke: KEY, sw });

  /** A detail line inside a filled shape — ink, because it has a fill behind it. */
  const ink = (d: string, sw = 3): SpriteLayer => ({ d, stroke: 'ink', sw });

  /** A glyph made only of strokes. Keyline, so it inverts with the background:
   *  these are the icons that sit in buttons rather than on the game canvas. */
  const glyph = (d: string, sw = 7): SpriteLayer => ({ d, stroke: KEY, sw });

  defineSprites({
    // ─── Buttons and navigation ────────────────────────────────────────────

    /** "Another game" / "re-roll". A quincunx of five pips reads as a die at
     *  any size; three pips read as a domino. */
    'ui-dice': {
      layers: [
        solid(roundRectPath(14, 14, 72, 72, 14), 'white'),
        {
          d: circlePath(32, 32, 7) + circlePath(68, 32, 7) + circlePath(50, 50, 7)
            + circlePath(32, 68, 7) + circlePath(68, 68, 7),
          fill: 'ink',
        },
      ],
    },

    /** Settings. Six SQUARE-ended teeth, hand-plotted: `starPath` can only
     *  make pointed spikes, and a spiked ring at icon size reads as a flower,
     *  not a cog. Tips sit on the 92 live edge, roots on 32. */
    'ui-gear': {
      layers: [
        solid(
          'M37 21L39 8L61 8L63 21L69 24L80 20L92 39L82 46L82 54L92 61L80 80L69 76'
          + 'L63 79L61 92L39 92L37 79L31 76L20 80L8 61L18 54L18 46L8 39L20 20L31 24Z',
          'theme',
        ),
        { d: circlePath(50, 50, 13), fill: 'white' },
      ],
    },

    /** Home. Roof drawn after the body so one edge covers the other and the
     *  two keylines read as a single silhouette. */
    'ui-home': {
      layers: [
        solid(roundRectPath(24, 46, 52, 44, 8), 'theme'),
        solid('M8 52 50 14 92 52Z', 'themeLight'),
        solid(roundRectPath(42, 64, 16, 26, 5), 'white', 3),
      ],
    },

    /** "Stop playing". The chequer pattern is what makes this a finish flag
     *  rather than any flag, so the squares get the contrast, not the cloth.
     *  The cloth outline is re-stroked last to tidy the corner squares. */
    'ui-flag-finish': {
      layers: [
        glyph('M22 12v78', 6),
        solid(roundRectPath(22, 12, 56, 40, 4), 'white'),
        {
          d: 'M22 12h14v20h-14ZM50 12h14v20h-14ZM36 32h14v20h-14ZM64 32h14v20h-14Z',
          fill: 'ink',
        },
        { d: roundRectPath(22, 12, 56, 40, 4), stroke: KEY, sw: SW },
      ],
    },

    /** Retry. One arc plus a chevron head, both stroked, so the glyph is a
     *  single weight and needs no fill to read at button size. */
    'ui-refresh': {
      layers: [glyph('M23 34A34 34 0 1 0 50 20M57 12 46 20 57 28')],
    },

    /** "Play with the keyboard" — the fallback when there is no camera.
     *  Keys are round-capped stubs rather than nine rounded rectangles: one
     *  short path instead of 900 characters of corner arcs. */
    'ui-keyboard': {
      layers: [
        solid(roundRectPath(8, 26, 84, 48, 10), 'white'),
        ink('M20 38h6M36 38h6M52 38h6M68 38h6M20 52h6M36 52h6M52 52h6M68 52h6M30 64h40', 8),
      ],
    },

    /** Start. */
    'ui-play': { layers: [solid('M32 16 82 50 32 84Z', 'theme')] },
    /** Next. */
    'ui-next': { layers: [solid('M14 20 52 50 14 80ZM52 20 90 50 52 80Z', 'theme')] },
    /** Pause. */
    'ui-pause': {
      layers: [solid(roundRectPath(26, 16, 16, 68, 6) + roundRectPath(58, 16, 16, 68, 6), 'theme')],
    },

    /** Close. Same cross as `cross`, but thin and in the keyline colour: that
     *  one is a wrong-answer stamp, this one is furniture in a corner. */
    'ui-close': { layers: [glyph('M28 28 72 72M72 28 28 72')] },

    /** Back. */
    'ui-back': { layers: [glyph('M44 26 20 50 44 74M20 50h58')] },

    /** "Delete everything". Deliberately NOT red: ART.md §3.6 keeps red for
     *  the last five seconds and for things that hurt you. */
    'ui-trash': {
      layers: [
        solid(roundRectPath(40, 12, 20, 12, 5), 'theme', 3),
        solid(roundRectPath(10, 24, 80, 12, 5), 'theme'),
        solid('M20 38h60l-6 46a8 8 0 0 1-8 7H34a8 8 0 0 1-8-7Z', 'theme'),
        ink('M38 48v32M50 48v32M62 48v32'),
      ],
    },

    /** "Got it". The cuff is drawn first and overlapped by the hand so the
     *  two keylines never show as two objects. */
    'ui-thumb-up': {
      layers: [
        solid(roundRectPath(10, 48, 26, 38, 6), 'themeLight', 3),
        solid('M34 48l14-32a8 8 0 0 1 14 6l-4 16h18a8 8 0 0 1 8 10l-6 26a10 10 0 0 1-10 8H34Z', 'white'),
        ink('M44 58h30M44 70h26'),
      ],
    },

    /** Done. Shape badge plus colour, never colour alone (ART.md §3.6.1). */
    'ui-check-circle': {
      layers: [
        solid(circlePath(50, 50, 42), 'success'),
        { d: linePath([30, 52, 44, 66, 70, 36]), stroke: 'white', sw: 8 },
      ],
    },

    // ─── Status and reward ─────────────────────────────────────────────────

    /** First place. Spikes are one of the four shapes ART.md §2.3 lets stay
     *  sharp; the band and gems are what stop it reading as a saw blade. */
    'ui-crown': {
      layers: [
        solid('M12 82V30l22 18 16-26 16 26 22-18v52Z', 'accent'),
        { d: circlePath(28, 66, 6) + circlePath(50, 64, 6) + circlePath(72, 66, 6), fill: 'white' },
      ],
    },

    /** Trophy. Handles go in first as bare keyline strokes — they are wire,
     *  so they need no fill and no silhouette of their own. */
    'ui-trophy': {
      layers: [
        glyph('M24 20q-16 2-10 16 4 9 14 6M76 20q16 2 10 16-4 9-14 6', 6),
        solid('M24 14h52l-4 30a22 22 0 0 1-44 0Z', 'accent'),
        solid('M42 66h16v12h14a6 6 0 0 1 0 12H28a6 6 0 0 1 0-12h14Z', 'accent'),
      ],
    },

    /** Medal. Two ribbon strips cross and are then covered by the disc, which
     *  is why they can be one flat path with one fill. */
    'ui-medal': {
      layers: [
        solid('M22 10h18l14 34H36ZM78 10H60L46 44h18Z', 'theme'),
        solid(circlePath(50, 64, 26), 'accent'),
        { d: starPath(50, 64, 13, 5, 0.46), fill: 'white' },
      ],
    },

    /** Combo. Warm pair rather than red: a streak is a reward, not a hazard.
     *  The inner lick is a deliberate one-step shade (ART.md §2.7). */
    'ui-fire': {
      layers: [
        solid('M50 8c14 18 6 24 14 30 6-10 16 2 16 18a30 30 0 0 1-60 0c0-22 18-34 30-48Z', 'warn'),
        { d: 'M50 44c10 10 10 14 10 20a10 10 0 0 1-20 0c0-8 6-12 10-20Z', fill: 'accent' },
      ],
    },

    /** Celebration. The cone points down-left and the confetti leaves the
     *  mouth, so the icon has a direction and reads as a popper, not a hat. */
    'ui-party': {
      layers: [
        solid('M12 88 40 24 76 44Z', 'theme'),
        ink('M28 62 36 70M34 46 48 56'),
        {
          d: circlePath(86, 22, 6) + circlePath(68, 12, 5) + circlePath(52, 10, 4),
          fill: 'accent',
        },
      ],
    },

    /** A life you no longer have: the SAME geometry as `heart`, unfilled.
     *  Reuse like this is the point of the system — an empty heart is not a
     *  second drawing of a heart. */
    'ui-heart-empty': {
      layers: [{
        d: 'M50 86C24 68 10 54 10 38a22 22 0 0 1 40-13A22 22 0 0 1 90 38c0 16-14 30-40 48Z',
        stroke: KEY,
        sw: 5,
      }],
    },

    /** Careful. Triangle + bang, so it is not warn-orange alone doing the
     *  talking. Corners rounded by arcs; a triangle is not on the sharp list. */
    'ui-warn': {
      layers: [
        solid('M44 18a7 7 0 0 1 12 0l34 60a7 7 0 0 1-6 10H16a7 7 0 0 1-6-10Z', 'warn'),
        ink('M50 36v20M50 70v2', 8),
      ],
    },

    /** Sound on. */
    'ui-sound-on': {
      layers: [
        solid('M10 38h14L44 20v60L24 62H10Z', 'theme'),
        { d: 'M58 34a22 22 0 0 1 0 32M70 24a36 36 0 0 1 0 52', stroke: KEY, sw: 5 },
      ],
    },

    /** Sound off. Same speaker, waves replaced by a cross: the two states
     *  differ in SHAPE, not only in colour, which is the one way a 7-year-old
     *  across the room can tell them apart. */
    'ui-sound-off': {
      layers: [
        solid('M10 38h14L44 20v60L24 62H10Z', 'theme'),
        { d: 'M58 36 84 64M84 36 58 64', stroke: KEY, sw: 6 },
      ],
    },

    // ─── Camera and permission ─────────────────────────────────────────────
    //
    // These four carry the privacy promise, so they are the plainest drawings
    // in the set. A child (and the adult reading over their shoulder) has to
    // recognise them instantly, with no cleverness in the way.

    /** The camera itself. Hood bump is part of the body path, so the whole
     *  camera is one silhouette with one outline. */
    'ui-camera': {
      layers: [
        solid('M8 38a10 10 0 0 1 10-10h14l8-10h20l8 10h14a10 10 0 0 1 10 10v34a10 10 0 0 1-10 10H18a10 10 0 0 1-10-10Z', 'theme'),
        solid(circlePath(50, 55, 18), 'white'),
        { d: circlePath(50, 55, 9), fill: 'themeDark' },
      ],
    },

    /** "It stays on your machine." */
    'ui-lock': {
      layers: [
        glyph('M30 46V34a20 20 0 0 1 40 0v12'),
        solid(roundRectPath(16, 44, 68, 46, 10), 'accent'),
        { d: circlePath(50, 62, 7) + 'M46 66h8l-2 14h-4Z', fill: 'ink' },
      ],
    },

    /** "We do not record." The one place red earns its keep: a ring and a bar
     *  is the single most universally read glyph there is, and it sits on a
     *  static explainer screen, never as gameplay feedback. */
    'ui-ban': {
      layers: [{ d: circlePath(50, 50, 38) + 'M24 24 76 76', stroke: 'danger', sw: 10 }],
    },

    /** "This is all the game sees." The most important icon in the set: six
     *  joints and the bones between them — a head, two shoulders, two hands,
     *  one chest. No face dots (ART.md §5: eleven points on a child's face
     *  reads as surveillance), no body, nothing a parent has to take on
     *  trust. The bones are keyline and the joints are theme-filled, so the
     *  figure reads as structure rather than as a person. */
    'ui-joints': {
      layers: [
        glyph('M50 35v29M26 44h48M26 44 14 70M74 44 84 26', 5),
        {
          d: circlePath(50, 21, 12) + circlePath(26, 44, 7) + circlePath(74, 44, 7)
            + circlePath(14, 70, 7) + circlePath(84, 26, 7) + circlePath(50, 64, 7),
          fill: 'theme',
          stroke: KEY,
          sw: 3,
        },
      ],
    },

    /** "Look up here." One finger and a fist. The three ink marks are what
     *  make it a hand rather than a bottle: a thumb folded across, and two
     *  creases for the fingers behind it. Drawn as detail rather than as
     *  silhouette bumps because at 40px the bumps vanish and the creases
     *  survive — checked side by side at 44px before choosing. */
    'ui-point-up': {
      layers: [
        solid('M38 50V20a10 10 0 0 1 20 0v28h16a10 10 0 0 1 10 10v20a12 12 0 0 1-12 12H42a14 14 0 0 1-14-14V62a12 12 0 0 1 10-12Z', 'white'),
        ink('M32 72q8-16 24-12M56 66h22M56 78h18'),
      ],
    },
  });
}

// ─── Gesture badges and scene icons ─────────────────────────────────────────
//
// THE STICK-FIGURE SPEC — read this before adding an eighteenth badge.
//
// Seventeen badges have to look like one person drew them in one sitting. That
// only happens if nobody re-decides the proportions per badge, so the skeleton
// is fixed and a pose is made by MOVING JOINTS, never by resizing anything:
//
//   head centre       (50, 19)   r 10, filled `theme`, 4-unit keyline
//   neck / torso top  (50, 29)
//   shoulder          (50, 36)   both arms branch from this one point
//   hip               (50, 58)   torso ends here, both legs branch
//   knee              y 72
//   ankle             y 86       + 3.5 for the stroke = 89.5, inside the box
//   ground line       y 92       for the badges that need one
//   limb weight       7          torso, arms and legs, all the same
//   accent mark       6          arrows, arcs, dashes, speed lines
//
// Arms and legs are ALWAYS two segments (shoulder-elbow-wrist,
// hip-knee-ankle). A one-segment limb beside a two-segment one is the single
// most visible way a set like this stops looking like a set. A badge that
// needs a lower head (a squat) moves the WHOLE skeleton down and keeps every
// spacing; `g-mirror` is the one exception, and it scales to r 8 / sw 6
// because it has to fit two people in one 100x100 box.
//
// NO FACES. These figures are the player, and drawing a face on the player
// turns a neutral "you do this" into a character the child is being compared
// to — and dotting a child's face reads as surveillance (ART.md §2.5, §5).
// The head is a plain disc. The scene icons are not the player, so `s-dog`
// gets eyes.
//
// Colour carries the division of labour: the BODY is keyline (white, 17.6:1 on
// the canvas — the thing you must read at 2m), the HEAD is `theme`, and the
// one thing the gesture adds — direction, repetition, impact, time — is
// `accent`. Four colours total, so none of them has to be decoded.
//
// Block-scoped so these helpers cannot collide with the other author's.
{
  const KEY = 'keyline';
  /** Head radius for a lone figure. */
  const HEAD_R = 10;
  /** Torso, arms and legs. One weight for the whole skeleton. */
  const LIMB_SW = 7;
  /** Arrows, arcs and dashes: the accent layer. */
  const MARK_SW = 6;

  /**
   * A posed figure, as its two layers: the skeleton, then the head disc on top.
   *
   * The head goes last on purpose — limb ends tuck UNDER it, so an arm raised
   * past the ear reads as behind the head instead of drawn through it, and the
   * neck join never shows as a seam.
   */
  const figure = (
    bones: readonly (readonly number[])[],
    heads: readonly (readonly [number, number])[] = [[50, 19]],
    r = HEAD_R,
    sw = LIMB_SW,
  ): SpriteLayer[] => [
    { d: bones.map(linePath).join(''), stroke: KEY, sw },
    { d: heads.map(([x, y]) => circlePath(x, y, r)).join(''), fill: 'theme', stroke: KEY, sw: 4 },
  ];

  /** An accent mark: arrow, arc, dash, speed line. Never a silhouette. */
  const mark = (d: string, sw = MARK_SW): SpriteLayer => ({ d, stroke: 'accent', sw });

  /**
   * A mitten with one finger raised, as a single filled path. `s` scales it;
   * (x, y) is the top-left of the finger.
   *
   * A disc with a pill stuck on top is what the first draft did, and it read
   * as a balloon: the silhouette has to turn the corner from finger to palm in
   * one outline, which means one path and not three stacked shapes. Four
   * separate fingers are a smudge at badge size.
   *
   * The finger is 14 units against a 38-unit palm. The second draft had it at
   * 18 and the whole thing read as an oven glove — below about a third, the
   * notch at the knuckle is what the eye picks up as a pointing hand.
   */
  const mitten = (x: number, y: number, s: number): string => {
    const n = (v: number): number => Math.round(v * s);
    const px = (v: number): number => x + n(v);
    const py = (v: number): number => y + n(v);
    return `M${px(0)} ${py(36)}V${py(7)}a${n(7)} ${n(7)} 0 0 1 ${n(14)} 0`
      + `v${n(22)}h${n(13)}a${n(11)} ${n(11)} 0 0 1 ${n(11)} ${n(11)}`
      + `v${n(12)}a${n(13)} ${n(13)} 0 0 1 ${-n(13)} ${n(13)}H${px(14)}`
      + `a${n(14)} ${n(14)} 0 0 1 ${-n(14)} ${-n(14)}Z`;
  };

  /**
   * A footprint, in two parts because one path of five shapes blows the
   * 420-character budget: `toes` goes in one layer, `sole` in the next.
   *
   * The toes are the whole cue. The first draft was a ball pad over a heel
   * pad, correctly proportioned, and at 40px it read as a dumbbell — a print
   * is recognised by the row of dots, not by the outline of the foot.
   */
  const toes = (x: number, y: number, w: number): string => {
    const t = Math.round(w * 0.13);
    return circlePath(x + Math.round(w * 0.15), y + t + 1, t)
      + circlePath(x + Math.round(w * 0.5), y + t, t)
      + circlePath(x + Math.round(w * 0.85), y + t + 1, t);
  };

  /** Ball and heel, 2.15 widths tall in total — a foot is far longer than it
   *  is wide, and anything squarer reads as two pills. */
  const sole = (x: number, y: number, w: number): string =>
    roundRectPath(x, y + Math.round(w * 0.28), w, Math.round(w * 0.62), Math.round(w * 0.31))
    + roundRectPath(
      x + Math.round(w * 0.22), y + Math.round(w * 1.15),
      Math.round(w * 0.56), w, Math.round(w * 0.26),
    );

  // The relaxed stance, so sixteen badges do not each re-invent a leg.
  const TORSO = [50, 29, 50, 58];
  const ARM_DOWN_L = [50, 36, 37, 47, 33, 60];
  const LEG_L = [50, 58, 44, 72, 42, 86];
  const LEG_R = [50, 58, 56, 72, 58, 86];
  const LEG_NARROW_L = [50, 58, 46, 72, 44, 86];
  const LEG_NARROW_R = [50, 58, 54, 72, 56, 86];

  defineSprites({
    // ─── Gesture badges ────────────────────────────────────────────────────
    //
    // Shown before a round: "this game asks you to do THIS". They are read
    // once, from across a living room, by a child who cannot yet read the
    // caption underneath — so each one carries the movement in the pose and
    // the INTENT in a single accent mark.

    /** Jump. The dashed ground line is the whole trick: bent legs alone read
     *  as a squat, and a broken line under the feet is what says "not touching
     *  it". Arms up and out because that is what a child's jump looks like. */
    'g-jump': {
      layers: [
        ...figure([
          [50, 28, 50, 54],
          [50, 35, 37, 26, 31, 14],
          [50, 35, 63, 26, 69, 14],
          [50, 54, 39, 66, 34, 76],
          [50, 54, 61, 66, 66, 76],
        ], [[50, 18]]),
        mark('M18 88h14M43 88h14M68 88h14'),
      ],
    },

    /** Squat. The entire skeleton drops 7 units rather than the legs folding
     *  under a figure that stayed put — a squat is the hips going down, and
     *  drawing it any other way reads as kneeling. Two arrows, not one: a
     *  single side arrow reads as "lean". */
    'g-squat': {
      layers: [
        ...figure([
          [50, 36, 50, 62],
          [50, 42, 38, 52, 34, 64],
          [50, 42, 62, 52, 66, 64],
          [50, 62, 33, 69, 36, 86],
          [50, 62, 67, 69, 64, 86],
        ], [[50, 26]]),
        mark('M14 44 14 68M7 59 14 68 21 59M86 44 86 68M79 59 86 68 93 59'),
      ],
    },

    /** Clap. The hands meet in front of the chest, which in a front view means
     *  they meet ON the torso line — so the meeting point is a filled burst
     *  that covers the overlap and becomes the subject. The two outer flicks
     *  are kept clear of the elbows; put them any closer and they read as part
     *  of the arm. */
    'g-clap': {
      layers: [
        ...figure([
          TORSO,
          [50, 36, 32, 45, 46, 51],
          [50, 36, 68, 45, 54, 51],
          LEG_L,
          LEG_R,
        ]),
        { d: starPath(50, 52, 12, 6, 0.45), fill: 'accent' },
        mark('M26 38 18 30M74 38 82 30M24 60 16 66M76 60 84 66'),
      ],
    },

    /** Swing an arm. The arm is drawn mid-swing (bent, already moving) and the
     *  swoosh is the path it came down. An arm at the END of its travel plus a
     *  trail reads as "point at this"; catching it halfway is what makes it a
     *  swing. */
    'g-swing': {
      layers: [
        ...figure([TORSO, ARM_DOWN_L, [50, 36, 62, 30, 70, 38], LEG_L, LEG_R]),
        mark('M66 12Q92 28 82 58M89 52 82 58 80 49'),
      ],
    },

    /** Both hands up. The one badge with no accent mark on the body: a solid
     *  ground line under planted feet, so it cannot be confused with `g-jump`,
     *  whose line is broken. Arms straight up and barely out — angled arms
     *  read as a star jump. */
    'g-raise': {
      layers: [
        ...figure([
          TORSO,
          [50, 36, 33, 30, 30, 12],
          [50, 36, 67, 30, 70, 12],
          LEG_NARROW_L,
          LEG_NARROW_R,
        ]),
        mark('M16 92h68', 5),
      ],
    },

    /** Lean. The torso is a tilted line and the head rides off-centre on top
     *  of it, because a vertical body with a tilted head is a head tilt, not a
     *  lean. The double arrow says either direction; a single one would make
     *  the picture a rule. */
    'g-lean': {
      layers: [
        ...figure([
          [62, 30, 44, 58],
          [58, 36, 46, 45, 42, 57],
          [58, 36, 69, 45, 72, 57],
          [44, 58, 38, 72, 36, 86],
          [44, 58, 50, 72, 52, 86],
        ], [[64, 20]]),
        mark('M28 46 12 46M19 39 12 46 19 53M80 46 92 46M85 39 92 46 85 53'),
      ],
    },

    /** Move your feet. No figure — a figure mid-step is indistinguishable from
     *  one standing still, so this is the trace it leaves. Both prints face
     *  forward under a left-right arrow: the detector quantises into lanes, so
     *  the instruction is "side to side", not "walk away". */
    'g-step': {
      layers: [
        { d: toes(22, 38, 22) + toes(56, 38, 22), fill: 'theme', stroke: KEY, sw: 3 },
        { d: sole(22, 38, 22) + sole(56, 38, 22), fill: 'theme', stroke: KEY, sw: 4 },
        mark('M26 20 74 20M34 12 26 20 34 28M66 12 74 20 66 28'),
      ],
    },

    /** Reach. One arm at full extension, the other hanging — symmetry would
     *  make it `g-raise` at a different angle. The dot sits just beyond the
     *  fingertips, close enough to read as the thing being reached for and far
     *  enough that the arm has visibly not got there. */
    'g-reach': {
      layers: [
        ...figure([TORSO, ARM_DOWN_L, [50, 36, 66, 33, 80, 28], LEG_L, LEG_R]),
        { d: circlePath(88, 20, 6), fill: 'accent', stroke: KEY, sw: 3 },
      ],
    },

    /** Hold an arm at an angle. The two arm segments ARE the two rays of the
     *  angle, so the only thing added is the protractor sweep between them,
     *  sized to sit ON both segments rather than float near them.
     *
     *  The forearm points DOWN, not up. Pointing it up puts the sweep in the
     *  same corner as the head, which both crowds it and leaves the right
     *  angle half-hidden; downward, the sweep sits in open space between the
     *  arm and the ribs, which is the only place it reads at badge size. */
    'g-angle': {
      layers: [
        ...figure([TORSO, ARM_DOWN_L, [50, 36, 72, 36, 72, 62], LEG_L, LEG_R]),
        mark('M58 36Q58 50 72 50'),
      ],
    },

    /** Hold the pose. Arms out level — the most obviously *held* shape a stick
     *  figure has — plus a clock, because what the detector is actually
     *  measuring is time. The clock face is white with ink hands: ink is legal
     *  here because it lands on a fill, not on the canvas. */
    'g-hold': {
      layers: [
        ...figure([
          TORSO,
          [50, 36, 34, 36, 18, 36],
          [50, 36, 66, 36, 82, 36],
          LEG_NARROW_L,
          LEG_NARROW_R,
        ]),
        { d: circlePath(80, 74, 11), fill: 'white', stroke: KEY, sw: 4 },
        { d: 'M80 74 80 66M80 74 87 77', stroke: 'ink', sw: 3 },
      ],
    },

    /** Repeat. Mid-curl, both arms the same, plus a cycle arrow — the arrow is
     *  doing the work, so it is nearly a full turn: a shallow arc reads as a
     *  rotation instruction instead of "again". */
    'g-rep': {
      layers: [
        ...figure([
          TORSO,
          [50, 36, 36, 30, 26, 22],
          [50, 36, 64, 30, 74, 22],
          LEG_NARROW_L,
          LEG_NARROW_R,
        ]),
        mark('M86 42A12 12 0 1 1 80 40M72 35 80 40 72 45'),
      ],
    },

    /** Stay still. Arms clamped to the sides, feet together — the stance is
     *  half the message. The pause bars carry the other half; radiating dashes
     *  were the obvious alternative and say the exact opposite (motion). */
    'g-still': {
      layers: [
        ...figure([
          TORSO,
          [50, 36, 37, 48, 36, 62],
          [50, 36, 63, 48, 64, 62],
          [50, 58, 48, 72, 47, 86],
          [50, 58, 52, 72, 53, 86],
        ]),
        {
          d: roundRectPath(74, 38, 7, 28, 3) + roundRectPath(85, 38, 7, 28, 3),
          fill: 'accent',
          stroke: KEY,
          sw: 3,
        },
      ],
    },

    /** Stand on one foot. Arms out for balance, one shin folded UP — a merely
     *  bent leg reads as a limp. The ground line is what makes the lift
     *  measurable: one foot on it, one well clear. */
    'g-balance': {
      layers: [
        ...figure([
          TORSO,
          [50, 36, 34, 34, 18, 36],
          [50, 36, 66, 34, 82, 36],
          [50, 58, 48, 72, 46, 86],
          [50, 58, 66, 66, 76, 54],
        ]),
        mark('M16 92h56', 5),
      ],
    },

    /** Draw with your hand. A hand and the line it has already left: the trail
     *  runs into the fingertip so the curve reads as drawn rather than as a
     *  decorative swoosh beside a hand. */
    'g-draw': {
      layers: [
        { d: mitten(44, 28, 0.9), fill: 'theme', stroke: KEY, sw: 4 },
        mark('M12 72C10 34 24 16 46 22'),
      ],
    },

    /** Copy the pose. Two figures at r 8 instead of one at r 10 — the only
     *  scale change in the set, and unavoidable: "mirror" needs two people.
     *  The dashed centre line is the mirror plane, and the inner arms stop
     *  short of it so the two poses answer each other across a gap. */
    'g-mirror': {
      layers: [
        ...figure([
          [26, 34, 26, 58],
          [26, 40, 36, 47, 42, 41],
          [26, 40, 17, 48, 15, 59],
          [26, 58, 20, 72, 18, 85],
          [26, 58, 32, 72, 34, 85],
          [74, 34, 74, 58],
          [74, 40, 64, 47, 58, 41],
          [74, 40, 83, 48, 85, 59],
          [74, 58, 80, 72, 82, 85],
          [74, 58, 68, 72, 66, 85],
        ], [[26, 26], [74, 26]], 8, 6),
        mark('M50 16v10M50 32v10M50 48v10M50 64v10M50 80v8', 5),
      ],
    },

    /** Stand on the spot. Deliberately NOT the `target` bullseye: that one is
     *  a thing you hit, this is a place you put your feet, and the difference
     *  has to survive being seen side by side. Hence a floor ring with prints
     *  inside it rather than concentric bands. */
    'g-target': {
      layers: [
        { d: circlePath(50, 52, 36), stroke: 'accent', sw: 6 },
        { d: toes(27, 30, 20) + toes(52, 30, 20), fill: 'theme', stroke: KEY, sw: 3 },
        { d: sole(27, 30, 20) + sole(52, 30, 20), fill: 'theme', stroke: KEY, sw: 3 },
      ],
    },

    /** Touch the spots. The same hand construction as `g-draw`, smaller, with
     *  the dots it has to cover. The finger points at the nearest one, which
     *  is what turns four circles and a mitten into an instruction. */
    'g-points': {
      layers: [
        { d: mitten(24, 40, 0.75), fill: 'theme', stroke: KEY, sw: 4 },
        {
          d: circlePath(32, 16, 8) + circlePath(60, 24, 8) + circlePath(82, 48, 8)
            + circlePath(70, 76, 8),
          fill: 'accent',
          stroke: KEY,
          sw: 3,
        },
      ],
    },

    // ─── Scene icons ───────────────────────────────────────────────────────
    //
    // Safety card and rest screen. These are objects rather than people, so
    // they follow the ordinary house style: a filled silhouette, a keyline,
    // and ink only ever on top of a fill.

    /** "You need about two metres." A ruler plus the measured span underneath:
     *  a ruler alone is a ruler, a ruler with a dimension line is a distance. */
    's-ruler': {
      layers: [
        { d: roundRectPath(8, 38, 84, 24, 8), fill: 'theme', stroke: KEY, sw: 4 },
        { d: 'M22 38v13M36 38v9M50 38v13M64 38v9M78 38v13', stroke: 'ink', sw: 3 },
        mark('M12 78 88 78M20 71 12 78 20 85M80 71 88 78 80 85', 5),
      ],
    },

    /** "Move the chair out of the way." Side view: a front-view chair is four
     *  legs and a rectangle, which is a table. The back goes in before the
     *  seat so the seat covers the join. */
    's-chair': {
      layers: [
        {
          d: roundRectPath(24, 58, 10, 28, 4) + roundRectPath(62, 58, 10, 28, 4),
          fill: '#C98B4B',
          stroke: KEY,
          sw: 4,
        },
        { d: roundRectPath(64, 14, 13, 36, 5), fill: '#C98B4B', stroke: KEY, sw: 4 },
        { d: roundRectPath(18, 46, 60, 13, 5), fill: '#C98B4B', stroke: KEY, sw: 4 },
      ],
    },

    /** "Trainers, not socks." The sole is the recognisable part — tall heel,
     *  long low toe, white slab underneath — so it is drawn last and over the
     *  upper's bottom edge, giving one silhouette instead of two stacked ones. */
    's-shoe': {
      layers: [
        {
          d: 'M16 68V46q0-12 12-12h8q6 0 9 6l8 14q26 4 35 14H16Z',
          fill: 'theme',
          stroke: KEY,
          sw: 4,
        },
        { d: roundRectPath(8, 66, 84, 18, 9), fill: 'white', stroke: KEY, sw: 4 },
        { d: 'M32 42 44 46M30 50 46 55M31 58 50 62', stroke: 'ink', sw: 3 },
      ],
    },

    /** "Check nobody is behind you." A head, not a whole dog: a side-on body
     *  at this size is a brown smudge. Eyes only, to the §2.5 dimensions, with
     *  no nose and no brows — this is a friendly subject, so it gets a mouth.
     *
     *  The ears hang down PAST the jaw. Round ears sitting on top of a round
     *  head is a bear, which is what the first draft drew; length is the only
     *  thing separating the two at this size. */
    's-dog': {
      layers: [
        {
          d: 'M30 32q-20 6-18 28t18 10ZM70 32q20 6 18 28t-18 10Z',
          fill: '#C98B4B',
          stroke: KEY,
          sw: 4,
        },
        { d: circlePath(50, 52, 30), fill: '#C98B4B', stroke: KEY, sw: 4 },
        { d: circlePath(50, 64, 13), fill: 'white' },
        { d: circlePath(38, 46, 5) + circlePath(62, 46, 5), fill: 'ink' },
        { d: 'M43 64q7 7 14 0', stroke: 'ink', sw: 3 },
      ],
    },

    /** "Look out of the window at something far away." The sun in one pane is
     *  what puts the view OUTSIDE the glass; without it the four panes read as
     *  a grid. Mullions last, in keyline, so they read as frame not as glass. */
    's-window': {
      layers: [
        { d: roundRectPath(14, 14, 72, 72, 10), fill: 'theme', stroke: KEY, sw: 4 },
        { d: circlePath(32, 32, 9), fill: 'accent' },
        { d: 'M50 18v64M18 50h64', stroke: KEY, sw: 6 },
      ],
    },

    /** "Have a glass of water." Tumbler, water, then the tumbler's outline a
     *  second time: the water can be drawn generously and the re-stroke puts
     *  the glass back in front of it, the same trick `target` uses for its
     *  rings. */
    's-cup': {
      layers: [
        {
          d: 'M24 24h52l-6 52q-1 8-9 8H39q-8 0-9-8Z',
          fill: 'white',
          stroke: KEY,
          sw: 4,
        },
        { d: 'M29 46h42l-4 25q-1 6-8 6H41q-7 0-8-6Z', fill: 'theme' },
        { d: 'M24 24h52l-6 52q-1 8-9 8H39q-8 0-9-8Z', stroke: KEY, sw: 4 },
      ],
    },

    /** Stretch. Same skeleton as the badges, so the rest screen looks like it
     *  belongs to the same game: arms up and locked overhead, torso bowed one
     *  unit off vertical, and two effort arcs at the ribs. */
    's-stretch': {
      layers: [
        ...figure([
          [50, 38, 53, 50, 50, 62],
          [51, 44, 33, 32, 41, 13],
          [51, 44, 69, 32, 59, 13],
          [50, 62, 45, 74, 43, 87],
          [50, 62, 55, 74, 57, 87],
        ], [[50, 28]]),
        mark('M24 46q-6 8 0 14M78 46q6 8 0 14', 5),
      ],
    },

    /** Dancing — a loading screen, so it has to look happy at a glance. Every
     *  limb at a different angle: a symmetric figure reads as exercise. */
    's-dance': {
      layers: [
        ...figure([
          [48, 30, 52, 44, 50, 58],
          [50, 36, 34, 28, 28, 12],
          [50, 36, 64, 44, 76, 38],
          [50, 58, 40, 70, 32, 82],
          [50, 58, 64, 68, 78, 74],
        ], [[46, 20]]),
        { d: starPath(18, 56, 8, 4, 0.3) + starPath(86, 22, 7, 4, 0.3), fill: 'accent' },
      ],
    },

    /** Running — the other loading screen. Head ahead of the hips, opposite
     *  arm and leg forward, trailing heel up, speed lines behind. The lean is
     *  what carries it; the speed lines only confirm the direction. */
    's-run': {
      layers: [
        ...figure([
          [54, 30, 50, 44, 48, 58],
          [52, 36, 68, 42, 72, 28],
          [52, 36, 38, 42, 30, 32],
          [48, 58, 62, 66, 66, 82],
          [48, 58, 34, 68, 26, 58],
        ], [[56, 20]]),
        mark('M10 34h11M8 50h13M12 66h10', 5),
      ],
    },
  });
}

export {};
