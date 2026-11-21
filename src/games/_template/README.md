# Game template

```bash
cp -r src/games/_template src/games/my-game
# then: rename `id` in manifest.ts to 'my-game' (it MUST match the folder name)
```

Read in this order:
1. `AGENTS.md` — the rules. The engine is frozen; this folder is yours.
2. `docs/GAME_AUTHORING.md` — the craft: coordinates, threshold table, feel, Korean copy.
3. The archetype reference matching your game's shape:
   - **A, trigger** — `src/games/mosquito-clap/`
   - **B, overlap** — `src/games/candy-rain-catch/`
   - **C, locomotion** — `src/games/wave-jump/`

Then:
```bash
npx tsc --noEmit
npm run gate
npx vitest run src/games/__tests__ -t "my-game"
npm run shot -- my-game      # look at the PNG; a black image is a bug
```

`_`-prefixed folders are excluded from the registry and from the boundary
checks, so this template never ships as a game.
