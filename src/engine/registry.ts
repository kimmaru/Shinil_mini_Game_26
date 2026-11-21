// ══ FROZEN CONTRACT ══ the integration point.
//
// Adding a game is creating a folder. There is no central list to edit, which
// is the whole reason many authors can work in parallel: a design that requires
// touching a shared `games.ts` serializes every one of them behind one file.
//
// Two-tier glob is the crux:
//   manifest.ts  eager  -> tiny, data only, lands in the shell chunk so the
//                          lobby can render 58 cards while shipping zero game code
//   index.ts     lazy   -> one Rollup chunk per game, loaded at round start
import type { GameId, MiniGameFactory, MiniGameManifest, SpaceNeed } from './types';
import { ALL_PLANNED_IDS } from './catalog';

// `_`-prefixed folders (e.g. _template) are excluded: the template is a
// reference for authors, not a playable game.
const manifestMods = import.meta.glob<MiniGameManifest>(
  ['../games/*/manifest.ts', '!../games/_*/**'],
  { eager: true, import: 'manifest' },
);

const loaderMods = import.meta.glob<MiniGameFactory>(
  ['../games/*/index.ts', '!../games/_*/**'],
  { import: 'default' },
);

const folderOf = (path: string): string => path.split('/').at(-2) ?? '';

/** Every authored game, enabled or not. Keyed by id. */
export const ALL: ReadonlyMap<GameId, MiniGameManifest> = (() => {
  const m = new Map<GameId, MiniGameManifest>();
  for (const [path, man] of Object.entries(manifestMods)) {
    const folder = folderOf(path);
    if (!man) throw new Error(`[registry] ${path} has no exported \`manifest\``);
    if (man.id !== folder) {
      throw new Error(`[registry] ${path}: manifest.id "${man.id}" !== folder "${folder}"`);
    }
    if (m.has(man.id)) throw new Error(`[registry] duplicate id "${man.id}"`);
    if (!loaderMods[`../games/${folder}/index.ts`]) {
      throw new Error(`[registry] ${folder}: manifest.ts exists but index.ts is missing`);
    }
    m.set(man.id, man);
  }
  return m;
})();

/** Only games the lead has played and switched on. This is the roulette pool. */
export const ENABLED: ReadonlyMap<GameId, MiniGameManifest> = new Map(
  [...ALL].filter(([, m]) => m.enabled !== false),
);

const cache = new Map<GameId, Promise<MiniGameFactory>>();

/** Dynamically import a game's module. Cached, so a retry is free. */
export function load(id: GameId): Promise<MiniGameFactory> {
  let p = cache.get(id);
  if (!p) {
    const loader = loaderMods[`../games/${id}/index.ts`];
    if (!loader) return Promise.reject(new Error(`[registry] unknown game "${id}"`));
    p = loader();
    cache.set(id, p);
  }
  return p;
}

/** Warm a chunk without using it. Called during the 3-2-1 countdown for the
 *  next game, so the transition between rounds has no load pause. */
export function preload(id: GameId): void {
  void load(id).catch(() => cache.delete(id));
}

export interface PoolFilter {
  /** How many people are playing. */
  players: number;
  /** Which space needs are acceptable right now. */
  space: readonly SpaceNeed[];
  /** False in keyboard-only mode: filters to games with a real fallback. */
  cameraOn: boolean;
  /** Cap exertion — set to 1 after two hard games, or on a slow device. */
  maxIntensity?: 1 | 2 | 3;
  /** False when the camera cannot see the player's legs/feet ("small room"). */
  lowerBodyVisible?: boolean;
  /** Include games the lead has not switched on yet (dev `?all=1`). */
  includeDisabled?: boolean;
}

/** The candidate set for the roulette. */
export function pickPool(f: PoolFilter): MiniGameManifest[] {
  const src = f.includeDisabled ? ALL : ENABLED;
  return [...src.values()].filter((m) => {
    if (f.players < m.players.min || f.players > m.players.max) return false;
    if (!f.space.includes(m.space)) return false;
    if (!f.cameraOn && !m.a11y.keyboardFallback) return false;
    if (f.maxIntensity !== undefined && m.intensity > f.maxIntensity) return false;
    if (f.lowerBodyVisible === false) {
      // Degrade the rule, not the data: hide games that genuinely need legs
      // rather than letting them fail silently on an invisible ankle.
      if (m.requiredLandmarks.some((g) => g === 'legs' || g === 'feet' || g === 'fullBody')) {
        return false;
      }
    }
    return true;
  });
}

/** Authored vs planned, for the completeness test and the dev overlay. */
export function coverage(): {
  authored: string[];
  missing: string[];
  unplanned: string[];
  enabled: number;
} {
  const authored = [...ALL.keys()].sort();
  const planned = new Set(ALL_PLANNED_IDS);
  return {
    authored,
    missing: ALL_PLANNED_IDS.filter((id) => !ALL.has(id)),
    unplanned: authored.filter((id) => !planned.has(id)),
    enabled: ENABLED.size,
  };
}
