# LittleWorld

[Play LittleWorld](https://damon-croxton.github.io/little-world/) — an observer-first civilisation simulation built with JavaScript and Three.js. Humans, aliens and robots gather resources, found settlements, research, train armies and fight for domination. Each civilisation is hostile to every other, including its own species. All terrain, buildings and characters use original procedural geometry; no artwork download is required.

## Watch and inspect

- Select a civilisation in the list to focus its home and view its intelligence. The whole-world observer view does not give the AI hidden knowledge.
- Click a settlement, building, resource, party or individual soldier to inspect it. Follow keeps the camera with a moving selection.
- Drag to pan, use the wheel to zoom, or use the camera controls. **Space** pauses; **1–5** choose 1×, 2×, 4×, 16× or 32× speed; **F** focuses the selection; **C** toggles cinematic view; **H** hides the interface; **Escape** returns to overview.
- On mobile, use the civilisation, inspector and settings drawers, one-finger pan and pinch zoom. Panel gestures stay inside the interface. Browser touch emulation is checked in CI; this is not a physical-device performance claim.
- The population chart, record and inspector explain changes. A separate [battle sandbox](https://damon-croxton.github.io/little-world/battle.html) provides a small individual-soldier test scene.

Worker crews show one small representative and a **grey count**, such as `11×`. The full crew still consumes, harvests, carries cargo, suffers casualties and appears in the census. Soldiers remain individual bodies. A party with at least three living visible soldiers has a somewhat larger **red count**. These semantic badges do not replace faction ownership colours.

Civilisations are named `Human1`, `Robot1`, `Alien1`, `Human2`, and so on, numbered independently per species in creation order. Every supported faction slot has a distinct colour. Species geometry stays distinct; current matches never transfer an enemy settlement or its inhabitants to an attacker.

## Start a match

Open **Settings**, choose the seed, 3–6 civilisations (default 4), and a whole-world biome. Open **Match balance** for four bounded controls. Changes remain pending until **Start match**, which starts at cycle zero. **Restore balance defaults** changes the pending balance controls only. The same seed and complete settings reproduce the starting state and deterministic simulation decisions within the same application version.

| Control | Default | Range | Effect |
| --- | --- | --- | --- |
| Resource reserves | 125% | 50–200% | Scales initial and maximum deposit amounts. Harvest speed and regeneration are unchanged. |
| Upkeep & hardship | 85% | 50–150% | Scales daily needs, paid journey provisions and passive starvation losses. Weapons and combat casualties are unchanged. |
| Aggression | 100% | 50–150% | Changes offensive dispatch/reinforcement cooldowns. Existing personality, intelligence, force and supply checks remain. |
| Economic focus | 115% | 75–150% | Retains more civilian workers and lowers the population/cooldown thresholds for considering outposts. Colonies still need supplies, surveyed resources and safe routes. |

Controls move in five-percentage-point increments. Seeded traits and advantages still differentiate factions; these settings do not replace them. Defaults ease scarcity and support funded expansion without making towns immune to shortages or military defeat. They are conservative tuning, not a guarantee that every faction survives or that a match ends at a particular time.

## Physical systems and limits

Workers walk to reachable deposits, gather within range and deliver their actual cargo. Military training reserves existing citizens and pays construction/training costs. Soldiers retain identity, health, weapon clocks and casualties through deployment, recovery and return. Supplied quiet homes can treat wounded veterans using real stores.

Campaigns use delivered reports and current local sight. Armies concentrate at rallies, interrupt economic attacks for credible defenders, and compare local force with nearby support. Known exposed workers, housing and production can attract attacks. Before abandoning an exposed settlement, a fit force can budget a bounded finish using remaining integrity, physical siege pressure, morale, supply and the route home. There is no occupation timer or twelve-soldier capture threshold: actual contact applies damage until integrity reaches zero. Strong defenders, injuries, home threats and depleted supplies can force retreat. Inspectors and debug reports retain the decision reason and finishing budget.

Connected walls grow from funded gates around useful civic space, preserving friendly access where terrain permits. Towers need real crews and ammunition. Attackers compare a useful breach with a reachable detour. Fog separates current sight from stale reports; hidden stock, queues and enemy routes are unavailable to planners.

Combat destroys enemy infrastructure instead of capturing territory. When settlement integrity reaches zero, its remaining buildings collapse and production/training stop. Civilians retain their native census and become displaced under the existing camp lifecycle; field soldiers and cargo are not converted or duplicated. Camp abandonment records real stock losses. Survivors can walk to a friendly refuge or later fund rebuilding where the plot is clear. Destroyed plots no longer block funded founding, and destroyed building plots can be reused. Domination requires defeating independent active settlements and viable armies; there is no victory timer. The observer pauses on a new victory and can continue watching or replay.

New matches are strict free-for-all: no alliances, truces, shared intelligence or cross-civilisation coordination. Armies prioritize reachable enemy towns and civic hubs after checking visible defenders. Nearby hostile third parties remain valid threats.

Available civilian labor takes useful funded work after home production and construction reserves. Inspect a settlement for its unassigned labor reason: full stores, depleted reports, unsafe routes or insufficient rations can justify waiting. Expansion sites favor distance from known threats; healthy outposts can fund the same connected gate-and-wall plans as mature homes.

This is a grouped economic simulation with individual military combat, not independent AI for every civilian. Home inhabitants are represented by housing and census totals. Worker badges deliberately represent several people. Long games can slow down; selected playback speed is a requested simulation rate, not guaranteed wall-clock throughput. Natural match length and late-game balance remain variable. Short fixtures and Node timings do not establish GPU, iPhone or large-world performance.

## Run locally

Use Node.js 24 and npm. The lockfile pins dependencies, including the release browser tooling.

```sh
npm ci
npm start
```

Open the URL printed by the server. No account, backend or secret is required. Development is owned by the saved cloud checkout; no desktop machine is needed.

## Build and test

For a focused change, run its relevant `node --test tests/<name>.test.mjs` files. The full regression gate is:

```sh
npm test
npm run build
node tools/verify-build.mjs
```

The static `dist/` includes the application module graph, Three.js and its licence. The asset verifier checks both entry points and relative dependencies for project-path hosting.

To exercise the exact built artifact with the same smoke used in CI:

```sh
npx playwright install --with-deps chromium --only-shell
npm run preview
# In another terminal:
QA_SOFTWARE_RENDERING=1 npm run test:smoke
```

Preview serves `http://127.0.0.1:4176/little-world/`. `BASE_URL` chooses another host; `EXPECTED_COMMIT` defaults to the checkout SHA. The smoke verifies the exact `build.json`, actual WebGL boot, input, fog, accounting, mobile controls, debug downloads and controlled combat renders, with a 180-second budget. GitHub Actions software rendering has a fixed 240-second allowance after measured runner time reached 180.1 seconds for all 28 assertions; individual waits and assertions are identical. The report records the allowance used. A browser version mismatch fails acceptance. An executable override plus `QA_BROWSER_PARITY=diagnostic` is explicitly diagnostic evidence only.

Long seed sweeps, videos and performance suites remain opt-in through **Actions → LittleWorld deep QA**. Select simulation, browser, performance or all when that evidence is needed. Do not treat old evidence as validation of changed source or weaken invariants to obtain a pass. Routine development does not require every expensive suite after every edit.

## Publish

An ordinary push to `main` runs `.github/workflows/pages.yml`: install, full Node suite, build, asset verification and pinned-browser smoke, then GitHub Pages deployment. A second smoke checks the exact public commit and boots the real public application. A release is complete only when build, deploy and public QA are all green. Failed predeployment checks leave the previous public deployment in place. Evidence artifacts are retained for 14 days.

## Code map

| Path | Responsibility |
| --- | --- |
| `src/config.js`, `src/world.js` | Normalized match settings, seeded world and terrain |
| `src/sim/core.js`, `economy.js`, `progression.js` | Fixed-step lifecycle, resource accounting, expansion, research and legacy trade |
| `src/sim/strategy.js`, `planner.js`, `match-rules.js` | Reports, campaigns, rallies, reserves and bounded policy modifiers |
| `src/sim/soldiers.js`, `military.js`, `combat.js` | Canonical military bodies, paid training, tactical damage and recovery |
| `src/sim/knowledge.js`, `navigation.js`, `conquest.js` | Fog/intelligence, physical routes and ownership |
| `src/render/`, `src/ui.js`, `src/main.js` | Procedural rendering, inspectors and observer integration |
| `src/debug-report.js` | Bounded, local diagnostic export |
| `tests/`, `tools/`, `.github/workflows/` | Regression fixtures, build verification and release gates |

## Debug a world

Open **Settings → Download debug report**. This saves a bounded JSON or compressed JSON file locally; nothing is uploaded automatically. It includes the build, seed, all active match settings and their versioned definitions, recent decisions, economic ledgers, real soldier state, observations and return/finish budgets and labor planning reasons. Pending settings are not the active match. The report contains hidden full-world information: share it deliberately. See [DEBUG-REPORT.md](DEBUG-REPORT.md) for fields and limits.

[HANDOFF.md](HANDOFF.md) describes current maintenance practice. Historical reports in `evidence/` and [DESKTOP-VALIDATION.md](DESKTOP-VALIDATION.md) are retained as dated evidence, not current release certification.
