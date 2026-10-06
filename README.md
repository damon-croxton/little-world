# LittleWorld

An observer-first domination simulation of human settlers, scavenger machines and alien hives. Civilisations gather physical resources, grow settlements, train infantry and ranged forces, build defenses, scout through fog of war, and compete to control the world. Each resource crew appears as one worker with its actual count, such as 11×. Soldiers and home inhabitants remain individual bodies; temporary falling markers depict recorded deaths.

All architecture, terrain, characters and effects are original procedural geometry. Built with vanilla JavaScript and Three.js 0.160.1; no downloaded artwork is required.

## Run

Install Node.js 24 or later:

```sh
npm ci
npm start
```

Open http://127.0.0.1:4174 in a WebGL-capable browser. On Windows, `Start-LittleWorld.cmd` installs missing dependencies and opens the app. A browser with hardware acceleration is recommended.

The default world has four civilisations and starts at 2x. Settings provide a seed and a 3-6 civilisation slider; 3-5 is the usual range. Reset applies both together. The same seed and settings reproduce the same simulation within the same JavaScript runtime; different engine versions can diverge through floating-point terrain and formation calculations. URL parameters also work: `?seed=first-light&civs=4`.

## Observe

- Desktop: left-drag orbits, right-drag pans, scroll zooms; click a place, party or resource to inspect.
- Touch: one finger pans; two fingers pinch to zoom and drag to orbit. The canvas contains its gestures; inspector panels scroll vertically.
- On smaller screens, Societies, Inspect and Views are collapsed until requested. Map returns to the overview.
- Space pauses; 1–5 select 1x, 2x, 4x, 16x, 32x. F follows, C toggles the cinematic camera, H hides/shows the interface, Escape returns to the overview.
- Whole world is an observer perspective. A civilisation perspective shows its current sight and remembered places; switching perspective never changes what its AI knows.
- The Developed world control runs the same simulation forward 1,200 cycles; it does not insert population, stocks or showcase structures.

One neutral cycle is one simulation second at 1x. The simulation advances in fixed 0.1-second pulses, independently of rendering. Pausing preserves fractional time and animated poses.

## Domination and variation

A civilisation wins when no independent opposing settlements or viable field armies remain. Defeated settlements can be occupied: their native inhabitants and species remain, and captured stores stay at the physical location. Conquest does not delete civilians, transform species or teleport inventory to a capital. A surviving field army can still try to liberate its home before capitulation. If a sovereign loses all native bases but still holds a foreign town, one held producer can recruit paid native auxiliaries under its command. Their species and population identity do not change.

The observer pauses on a newly declared victory and can keep watching, replay the seed or generate another world. The pacing target is roughly 5–10 minutes of playback at 2x, corresponding to 600–1,200 simulation cycles. This is a calibration target, not a timer that chooses a winner; see the validation report for measured seed outcomes and limitations.

Seeded advantages are independent of species. Examples include faster gathering and larger carried loads, quicker training, longer ranged reach, stronger weapons and tougher fortifications, with explicit tradeoffs. These modify actual production or combat calculations. There is no hidden victory deadline or fixed winning species.

## Physical systems

- Workers travel to finite or regenerating deposits, extract within reach, carry cargo and deliver it home. Journey provisions are funded before departure. Trapped or exhausted expeditions can lose real people and cargo.
- Each species has distinct infantry and ranged producers. Buildings require funded construction, and finite training queues pay their costs and reserve existing civilians. A cancelled or destroyed course cannot complete later.
- Defenses grow as connected screens facing known approaches, beginning with a usable gate and joined wings. The rear remains open, and planned construction preserves friendly routes. Staffed towers need two actual ranged operators and paid ammunition. Civilians can contest a paper resource claim until real troops or towers secure it.
- Terrain includes deep water, rocky barriers, fords and mountain passes. Group routes and body formation offsets respect physical obstacles; friendly/occupier gates preserve access.
- Infantry loosen into reachable contact positions; ranged soldiers seek firing distance. Local body separation and a shared squad route keep passage movement physical. Infantry strikes and ranged projectiles create real damage and casualty events; effects only read those events.
- Squads prioritize locally observed defenders, compare their supported strength with observable enemy types, and retreat when heavily overmatched. They can seize an exposed crew's real cargo or damage economic buildings. A useful breach must beat the cost of a detour. The inspector explains decisions and target interruptions. Lost storage records excess supplies as spoilage in the ledger.
- Field observations travel with scouts and parties; home reports and earned relays deliver command knowledge. Hidden enemy stores, queues, future routes and fresh deposit quantities are unavailable to AI planners.
- Technology and trade require resources and people. A resource ledger accounts for production, extraction, cargo, deliveries, consumption, construction, research, training and losses.

## Build and verify

```sh
npm test
npm run build
node tools/verify-build.mjs
node tests/domination.mjs
node tests/balance.mjs
node tests/render-performance.mjs
```

The self-contained static output is `dist/`. Three.js modules and their license are copied there; application URLs are relative and support GitHub Pages project paths. The asset verifier follows the real application module graph and rejects missing or root-relative dependencies.

With `npm start` running separately, browser verification can run in an authorised WebGL-capable test environment:

```sh
npx playwright install --with-deps chromium
node tests/controls-v2.mjs
node tests/visual-v2.mjs
node tests/tactical-browser.mjs
node tests/ai-readability-browser.mjs
```

Browser tests default to bundled Chromium. `BASE_URL` accepts a local server or hosted project subpath; `QA_CIVS` selects the start count. `QA_TIER=full` includes the 3,000-cycle/high-quality tier. `QA_QUALITY=low` selects performance rendering, `BROWSER_CHANNEL=chrome` selects installed Chrome, and `QA_VIDEO=0` explicitly skips recording. Software-WebGL CI is labelled as such.

The Pages workflow gates every push to `main` on Node tests, seeded simulation audits, controls and visual evidence. Failed predeployment verification keeps the previous deployment. After deployment, a separate live browser check verifies the exact public `build.json` commit, WebGL boot, working pause/resume controls and weighted census. Screenshots, measurements and harvesting video are retained as Actions artifacts for 14 days. See `HANDOFF.md` for current cloud ownership and `DESKTOP-VALIDATION.md` for historical Windows browser verification and its limits.

## Measurement and model boundaries

This is a simulation-first tech demo, not a historical prediction or a directly controlled multiplayer RTS. Strategic decisions and logistics operate through settlements and groups. Resource crews use one articulated model with a count badge, while their complete workforce and cargo remain in the simulation. Home civilian activity is representative motion; military bodies follow physical state. Local congestion can queue soldiers; individual soldiers do not run global route planners.

The live diagnostics distinguish actual/scoped population, people represented in the view, and actual drawn models. A visible 11-person crew contributes eleven people and one model. Count badges hide at the widest zoom and avoid overlap; selecting a visible crew keeps its badge available. In a civilisation perspective, the census includes owned and observable foreign people. Paused, active and advancing timing windows are separate.

Node render benchmarks measure CPU simulation/crowd work and geometry only. They do not measure GPU, buildings, landscape, interface or screen refresh. Browser frame measurements describe their recorded runner, viewport and quality, not a guarantee for other hardware. DOM and synthetic pointer tests are not evidence of actual mobile layout or native gestures.

New births and housing stop at 900 people per settlement; each independent faction can maintain up to four active settlements. Limits stop new commitments rather than deleting existing people. Supplies, housing, geography, war and reserves constrain growth earlier. No save/load or direct faction orders are included.

## Source map

- `src/sim/core.js`, `economy.js`: physical work, settlement growth, paid construction and conservation.
- `src/sim/military.js`, `defenses.js`: real role census, training and funded defensive planning.
- `src/sim/strategy.js`, `combat.js`, `formations.js`, `conquest.js`, `control.js`: scouting, tactical decisions, physical contact, impacts, occupation and sovereignty.
- `src/sim/knowledge.js`, `progression.js`: visibility, returned intelligence, technology and commerce.
- `src/world.js`, `config.js`, `sim/navigation.js`: seeded geography, civilisation count and collision-aware routes.
- `src/render/`: terrain, buildings, instanced bodies, count-badged workers, fog and combat effects.
- `src/main.js`, `clock.js`, `input.js`, `ui.js`: observer integration, timing, gestures and interface.

Three.js is MIT licensed. Playwright and Linkedom are development-only verification dependencies.
