// Per-game roulette / countdown / results icons: one distinct badge per game.
//
// Same rules as sprites.ts (ART.md): 100x100 box, keyline silhouettes at 4,
// ink detail lines at 3, palette roles only, faces only where §2.5 allows.
// The main body is `theme` so the game's own hue tints the icon.
import {
  circlePath, defineSprites, roundRectPath, starPath, polyPath,
  type SpriteLayer,
} from './sprite';

{
  const KEY = 'keyline';
  const solid = (d: string, fill: SpriteLayer['fill'], sw = 4): SpriteLayer =>
    ({ d, fill, stroke: KEY, sw });
  const fillOnly = (d: string, fill: SpriteLayer['fill']): SpriteLayer => ({ d, fill });
  const ink = (d: string, sw = 3): SpriteLayer => ({ d, stroke: 'ink', sw });
  const line = (d: string, sw = 4, stroke: SpriteLayer['stroke'] = KEY): SpriteLayer =>
    ({ d, stroke, sw });
  const n = (v: number): string => String(Math.round(v * 100) / 100);
  /** Ring-shaped (donut) path: outer circle clockwise, inner circle reversed. */
  const donut = (cx: number, cy: number, r: number, ri: number): string =>
    `${circlePath(cx, cy, r)}M${cx - ri} ${cy}a${ri} ${ri} 0 1 1 ${ri * 2} 0a${ri} ${ri} 0 1 1 ${-ri * 2} 0Z`;
  /** Two ink dots for eyes. */
  const eyes = (x1: number, x2: number, y: number, r = 3): string =>
    circlePath(x1, y, r) + circlePath(x2, y, r);
  /** Filled ink smile (crescent) centred on x. */
  const smile = (x: number, y: number, w: number): string =>
    `M${n(x - w / 2)} ${y}Q${x} ${n(y + w * 0.7)} ${n(x + w / 2)} ${y}Q${x} ${n(y + w * 0.3)} ${n(x - w / 2)} ${y}Z`;
  /** Capsule (rounded bar) from p1 to p2 with radius r. */
  const capsule = (x1: number, y1: number, x2: number, y2: number, r: number): string => {
    const dx = x2 - x1, dy = y2 - y1, l = Math.hypot(dx, dy);
    const nx = (-dy / l) * r, ny = (dx / l) * r;
    return `M${n(x1 + nx)} ${n(y1 + ny)}L${n(x2 + nx)} ${n(y2 + ny)}A${r} ${r} 0 0 0 ${n(x2 - nx)} ${n(y2 - ny)}` +
      `L${n(x1 - nx)} ${n(y1 - ny)}A${r} ${r} 0 0 0 ${n(x1 + nx)} ${n(y1 + ny)}Z`;
  };
  /** The star-fish person, scaled by s about (50,50) then moved to (ox,oy). */
  const FIG = [44, 36, 32, 24, 24, 32, 40, 48, 40, 62, 30, 82, 38, 88, 50, 70, 62, 88, 70, 82, 60, 62, 60, 48, 76, 32, 68, 24, 56, 36];
  const person = (ox: number, oy: number, s: number): string => {
    let d = '';
    for (let i = 0; i < FIG.length; i += 2) {
      d += `${i ? 'L' : 'M'}${n(ox + (FIG[i]! - 50) * s)} ${n(oy + (FIG[i + 1]! - 50) * s)}`;
    }
    return `${d}Z`;
  };

  defineSprites({
    // 모기 박수: two palms about to squash a mosquito.
    'gi-mosquito-clap': {
      layers: [
        solid('M10 44Q12 30 22 30H27Q31 30 31 36V46H34Q38 46 38 52V60Q38 72 28 78H18Q10 78 10 68ZM90 44Q88 30 78 30H73Q69 30 69 36V46H66Q62 46 62 52V60Q62 72 72 78H82Q90 78 90 68Z', 'accent', 5),
        ink('M19 34V46M25 34V46M81 34V46M75 34V46'),
        solid('M47 46Q35 42 37 28Q46 28 49 44ZM53 46Q65 42 63 28Q54 28 51 44Z', 'white'),
        solid('M50 32C57 32 59 40 55 46C60 52 58 70 50 80C42 70 40 52 45 46C41 40 43 32 50 32Z', 'theme', 4),
        fillOnly(eyes(47, 53, 39, 2.6), 'ink'),
        line('M50 8V16M38 12L41 18M62 12L59 18', 4, 'warn'),
      ],
    },

    // 사탕비 받아요: a smiling candy dropping into a basket.
    'gi-candy-rain-catch': {
      layers: [
        solid('M38 34L16 22V46ZM62 34L84 22V46Z', 'white'),
        solid(circlePath(50, 34, 15), 'theme', 5),
        fillOnly(eyes(44, 56, 32, 2.8) + smile(50, 38, 10), 'ink'),
        solid('M18 60H82L72 90H28Z', 'accent'),
        solid(roundRectPath(13, 54, 74, 11, 5), 'theme'),
        ink('M36 68V86M50 68V88M64 68V86'),
      ],
    },

    // 파도 넘기: a kid leaps over a curling wave.
    'gi-wave-jump': {
      layers: [
        solid('M8 92V58Q22 40 36 56Q50 72 64 54Q78 38 92 58V92Z', 'themeDark', 5),
        solid('M8 92V74Q22 58 36 72Q50 86 64 70Q78 56 92 74V92Z', 'theme', 5),
        line('M16 82Q24 76 30 80M58 78Q66 72 72 76', 3, 'white'),
        solid(person(50, 30, 0.6), 'accent'),
        solid(circlePath(50, 14, 6), 'accent'),
      ],
    },

    // 하늘 두더지: a mole peeks out of a hole and a fist swings down.
    'gi-air-whack-mole': {
      layers: [
        solid('M10 80a40 11 0 1 0 80 0a40 11 0 1 0 -80 0Z', '#8A6A4A'),
        fillOnly('M22 76a28 9 0 1 0 56 0a28 9 0 1 0 -56 0Z', 'ink'),
        solid('M30 78C26 44 38 30 50 30C62 30 74 44 70 78Q50 86 30 78Z', 'theme', 5),
        fillOnly(eyes(42, 58, 52, 4), 'ink'),
        solid(circlePath(72, 22, 13), 'accent', 5),
        ink('M65 15V26M72 12V24M79 15V26'),
      ],
    },

    // 팔 펌프 풍선: a hand pump inflates a balloon.
    'gi-arm-pump-inflate': {
      layers: [
        line('M30 80Q52 92 62 66', 5),
        solid('M36 36a26 26 0 1 1 52 0a26 26 0 1 1 -52 0ZM62 62L56 70H68Z', 'danger', 5),
        fillOnly('M48 22a6 10 0 0 1 8-8Q52 22 50 32Q46 28 48 22Z', 'white'),
        solid(roundRectPath(8, 40, 28, 8, 4) + roundRectPath(19, 48, 6, 10, 2), 'accent'),
        solid(roundRectPath(12, 58, 20, 30, 5) + roundRectPath(8, 86, 28, 6, 3), 'theme'),
      ],
    },

    // 풍선 폭발 파티: a balloon pops in a burst of confetti.
    'gi-balloon-pop-party': {
      layers: [
        solid(starPath(50, 50, 40, 10, 0.62), 'accent', 5),
        fillOnly(starPath(50, 50, 24, 10, 0.6), 'white'),
        solid('M10 24L24 14L26 30Z', 'theme'),
        solid('M90 26L78 12L74 30Z', 'danger'),
        solid('M88 84L76 90L72 74Z', 'success'),
        solid('M12 82L26 90L28 74Z', 'danger'),
      ],
    },

    // 자전거 페달: a side-on bike with ring wheels.
    'gi-bike-pedal': {
      layers: [
        solid(donut(25, 64, 20, 12) + donut(75, 64, 20, 12), 'theme'),
        line('M25 64L42 38H66L75 64M42 38L50 64L66 38', 5),
        solid(roundRectPath(32, 28, 20, 8, 4), 'accent'),
        line('M66 38L70 28H82', 5),
        solid(circlePath(50, 64, 6), 'accent'),
      ],
    },

    // 청기백기: a blue flag up, a white flag down.
    'gi-blue-flag-white-flag': {
      layers: [
        line('M30 10V92M64 36V92', 5, 'themeDark'),
        solid('M30 12H62L53 26L62 40H30Z', 'theme', 5),
        solid('M64 38H92L84 52L92 66H64Z', 'white', 5),
        solid(circlePath(30, 10, 5) + circlePath(64, 36, 5), 'accent'),
      ],
    },

    // 성 지키기: a castle and a rock that has to be knocked away.
    'gi-castle-defense': {
      layers: [
        solid('M14 90V46H18V39H24V46H30V39H36V46H40V58H60V46H64V39H70V46H76V39H82V46H86V90Z', 'theme'),
        solid('M42 90V76a8 8 0 0 1 16 0V90Z', 'ink', 3),
        line('M24 39V18', 3),
        solid('M24 18L42 24L24 30Z', 'danger', 3),
        solid('M64 20L72 8L86 12L90 24L80 32L68 30Z', '#6B7390', 4),
        ink('M72 18L80 22L76 28'),
      ],
    },

    // 응원 콤보: two cheering pom-poms.
    'gi-cheer-combo': {
      layers: [
        solid('M24 52L46 90H56L36 52Z', 'white'),
        solid('M76 52L54 90H44L64 52Z', 'white'),
        solid(starPath(30, 34, 22, 16, 0.76), 'theme', 5),
        solid(starPath(70, 34, 22, 16, 0.76), 'accent', 5),
        fillOnly(circlePath(23, 27, 4) + circlePath(63, 27, 4), 'white'),
      ],
    },

    // 색깔 방패: a shield cut into colour quarters.
    'gi-color-shield-block': {
      layers: [
        fillOnly('M16 20L50 8V50H16Z', 'theme'),
        fillOnly('M50 8L84 20V50H50Z', 'danger'),
        fillOnly('M16 50H50V92C32 84 16 72 16 50Z', 'accent'),
        fillOnly('M50 50H84C84 72 68 84 50 92Z', 'success'),
        { d: 'M50 8L84 20V50C84 72 68 84 50 92C32 84 16 72 16 50V20Z', stroke: KEY, sw: 5 },
        solid(circlePath(50, 50, 9), 'white'),
      ],
    },

    // 점 잇기: dots joined in order, a pencil drawing the next line.
    'gi-connect-dots-order': {
      layers: [
        line('M18 80L36 36L58 66', 5, 'themeDark'),
        solid(circlePath(18, 80, 9) + circlePath(36, 36, 9) + circlePath(58, 66, 9), 'theme'),
        solid('M58 66L68 60L92 25L84 19L62 52Z', 'accent'),
        solid('M58 66L62 52L68 60Z', 'white', 3),
        ink('M72 50L78 54'),
      ],
    },

    // 과일 쓱싹: a watermelon sliced in two by a swipe.
    'gi-fruit-slash': {
      layers: [
        solid('M66 18A34 34 0 0 0 18 66Z', 'success', 5),
        fillOnly('M61 23A27 27 0 0 0 23 61Z', 'danger'),
        solid('M34 82A34 34 0 0 0 82 34Z', 'success', 5),
        fillOnly('M39 77A27 27 0 0 0 77 39Z', 'danger'),
        fillOnly(circlePath(36, 36, 2.6) + circlePath(28, 46, 2.6) + circlePath(46, 30, 2.6) + circlePath(60, 64, 2.6) + circlePath(66, 52, 2.6) + circlePath(52, 66, 2.6), 'ink'),
        line('M12 88L88 12', 5, 'accent'),
      ],
    },

    // 골키퍼 선방: a keeper's glove meets a soccer ball.
    'gi-goalkeeper-save': {
      layers: [
        solid(roundRectPath(12, 28, 8, 28, 4) + roundRectPath(22, 22, 9, 34, 4) + roundRectPath(33, 22, 9, 34, 4) + roundRectPath(45, 28, 9, 28, 4), 'accent'),
        solid(roundRectPath(12, 48, 42, 30, 12), 'accent'),
        solid(roundRectPath(16, 76, 34, 14, 5), 'theme'),
        solid(circlePath(72, 42, 20), 'white', 5),
        solid(polyPath(72, 42, 8, 5), 'ink', 3),
        ink('M72 34V26M79 40L88 37M76 49L81 57M68 49L63 57M65 40L56 37'),
      ],
    },

    // 코코코 눈!: a friendly face, a finger on the nose.
    'gi-koko-ko-touch': {
      layers: [
        solid(circlePath(44, 46, 34), 'accent', 5),
        fillOnly(eyes(33, 55, 38, 4.5) + smile(44, 60, 18), 'ink'),
        fillOnly(circlePath(24, 54, 5) + circlePath(64, 54, 5), 'danger'),
        solid(capsule(82, 82, 50, 50, 8), 'white'),
        solid(circlePath(82, 82, 12), 'white', 4),
      ],
    },

    // 쭉쭉 스트레칭: a person stretching, arrows pointing outward.
    'gi-max-reach-stretch': {
      layers: [
        solid(person(50, 52, 0.9), 'theme', 5),
        solid(circlePath(50, 25, 9), 'accent', 4),
        solid('M10 10L26 12L12 26ZM90 10L74 12L88 26Z', 'accent', 3),
        solid('M10 92L12 76L24 88ZM90 92L88 76L76 88Z', 'accent', 3),
      ],
    },

    // OX 퀴즈: a big O and a big X.
    'gi-ox-quiz-zone': {
      layers: [
        solid(donut(28, 50, 20, 10), 'theme', 5),
        solid('M60 30L72 42L84 30L92 38L80 50L92 62L84 70L72 58L60 70L52 62L64 50L52 38Z', 'danger', 5),
      ],
    },

    // 제자리 달리기: a sneaker with speed lines.
    'gi-run-in-place-sprint': {
      layers: [
        line('M6 40H22M10 52H26M6 64H22', 4, 'themeDark'),
        solid('M28 70V30Q28 26 32 26H46Q48 40 58 46Q70 52 86 56Q92 60 92 70Z', 'theme', 5),
        solid(roundRectPath(24, 68, 68, 14, 7), 'white'),
        ink('M50 38L58 34M56 44L64 40M62 49L70 45'),
        fillOnly('M30 58Q44 58 52 66H30Z', 'accent'),
      ],
    },

    // 별똥별 낚아채기: a smiling shooting star with a tail.
    'gi-shooting-star-grab': {
      layers: [
        solid('M52 34L8 60Q8 88 38 92L66 54Z', 'theme'),
        solid(starPath(66, 38, 28, 5, 0.46), 'accent', 5),
        fillOnly(eyes(60, 72, 36, 3) + smile(66, 43, 10), 'ink'),
        line('M22 72L38 62M32 82L46 70', 3, 'white'),
        solid(starPath(20, 24, 9, 4, 0.3) + starPath(82, 82, 8, 4, 0.3), 'white', 3),
      ],
    },

    // 눈싸움: a snowball in flight and a mitten.
    'gi-snowball-fight': {
      layers: [
        line('M6 26H24M10 38H28M6 50H22', 4, 'themeDark'),
        solid(circlePath(64, 38, 26), 'white', 5),
        fillOnly(circlePath(58, 40, 3) + circlePath(70, 32, 3) + circlePath(72, 48, 3) + circlePath(60, 52, 2.4), 'themeLight'),
        solid(roundRectPath(14, 58, 30, 26, 12) + circlePath(46, 70, 7), 'theme'),
        solid(roundRectPath(14, 80, 30, 10, 4), 'white'),
      ],
    },

    // 거미 손 터치: a cute spider and the dots to touch.
    'gi-spider-touch': {
      layers: [
        solid(circlePath(15, 17, 7) + circlePath(85, 17, 7), 'accent'),
        line('M50 8V34', 3),
        line('M40 50L24 34L12 44M38 56L16 52L8 62M38 64L18 70L10 82M42 72L30 86L24 92M60 50L76 34L88 44M62 56L84 52L92 62M62 64L82 70L90 82M58 72L70 86L76 92', 5),
        solid(circlePath(50, 62, 17), 'theme', 5),
        solid(circlePath(50, 40, 11), 'theme', 5),
        fillOnly(eyes(45, 55, 39, 3.2), 'ink'),
      ],
    },

    // 거미줄 자르기: a web with a slash through it.
    'gi-web-cut': {
      layers: [
        line(polyPath(50, 50, 38, 8) + polyPath(50, 50, 24, 8) + polyPath(50, 50, 10, 8), 3, 'themeDark'),
        line('M50 12V88M12 50H88M23 23L77 77M77 23L23 77', 3),
        solid(capsule(50, 56, 22, 22, 4) + capsule(50, 56, 14, 40, 4), 'white', 3),
        solid(donut(70, 80, 8, 4) + donut(84, 72, 8, 4), 'accent', 3),
        solid(starPath(16, 20, 9, 4, 0.3), 'warn', 3),
      ],
    },

    // 레이저 과녁: a laser from a fingertip hits the bullseye.
    'gi-wrist-aim-target': {
      layers: [
        solid(circlePath(62, 40, 32), 'white', 5),
        fillOnly(donut(62, 40, 21, 13) + circlePath(62, 40, 5), 'theme'),
        line('M18 84L62 40', 8),
        line('M18 84L62 40', 4, 'danger'),
        solid(circlePath(16, 86, 8), 'white'),
        solid(starPath(62, 40, 8, 4, 0.3), 'warn', 3),
      ],
    },

    // 손끝 미로: a glowing orb in a maze.
    'gi-wrist-maze': {
      layers: [
        solid(roundRectPath(10, 10, 80, 80, 12), 'white', 5),
        line('M10 34H46V56H70V34M70 10V22M30 56V90M50 74H70M70 74V90M90 56H70', 5, 'theme'),
        solid(circlePath(22, 22, 9), 'accent', 4),
        fillOnly(circlePath(19, 19, 3), 'white'),
        solid(starPath(80, 80, 7, 5, 0.45), 'danger', 3),
      ],
    },
  });
}
