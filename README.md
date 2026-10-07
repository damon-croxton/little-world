# LittleWorld

An observer-first domination simulation of human settlers, scavenger machines and alien hives. Civilisations gather physical resources, grow settlements, train infantry and ranged forces, build defenses, scout through fog of war, and compete to control the world. Each resource crew appears as one worker with its actual count, such as 11×. Soldiers and home inhabitants remain individual bodies; temporary falling markers depict recorded deaths.

All architecture, terrain, characters and effects are original procedural geometry. Built with vanilla JavaScript and Three.js 0.160.1; no downloaded artwork is required.

## Individual-soldier battle sandbox

Open **Battle sandbox · 24 vs 24** in the civilisation view, or visit
`battle.html`. This separate prototype lets two AIs fight with infantry, ranged
soldiers and scouts. Select a soldier to inspect its own health, target and
decision. Start/pause, seed replay and team perspectives make the fight observable.
The sandbox remains a small regression fixture alongside the full civilisation simulation.

Battle soldiers have persistent identities, individual health and weapon clocks.
Their physical positions determine reach and sight, hits damage the named target,
and that individual dies when its health reaches zero. Squad objectives guide
unit decisions; nearby threats, wounded withdrawal, ranged spacing and feasible
pursuit affect each soldier. Team views hide unseen enemies. Whole-field viewing
is an observer option and does not give the AI additional knowledge.

The main civilisation simulation now uses persistent infantry and ranged soldiers
through paid training, home defense, expeditions, combat, retreat and return.
A settlement retains each native citizen's identity; armies reference those same
records. Wounds, weapon clocks and exact casualties survive transfers. Strategic
objectives and home reserves guide the troops, while each soldier chooses reachable
local engagements. Civilian crews retain their count badges and full economic
accounting. Select an individual soldier to inspect its health and current action,
then navigate to its army or home. Faction views expose only physically visible
foreign soldiers and hide their health, clocks and orders.

Benchmark reports distinguish Node CPU timings from browser and GPU performance;
a tested small battle does not establish thousand-unit capacity.

Focused verification:

```sh
node --test tests/battle-simulation.test.mjs tests/battle-micro.test.mjs
node tests/battle-audit.mjs --output screenshots/battle-audit.json
node tests/world-individual-audit.mjs first-light tidal-garden iron-valley
node tests/world-individual-browser.mjs
```

The ordinary seeded audit checks exact health/death ledgers and records AI
decisions; its increasing-count benchmark is CPU-only. The shared built/public
browser smoke also boots the sandbox, picks an actual soldier, checks team sight,
uses play/pause and observes a natural targeted hit.

## Run

Install Node.js 24 or later:

```sh
npm ci
npm start
```

Open http://127.0.0.1:4174 in a WebGL-capable browser. On Windows, `Start-LittleWorld.cmd` installs missing dependencies and opens the app. A browser with hardware acceleration is recommended.

The default world has four civilisations and starts at 2x. Settings provide a seed and a 3-6 civilisation slider; 3-5 is the usual range. Reset applies both together. The same seed and settings reproduce the same simulation within the same JavaScript runtime; different engine versions can diverge through floating-point terrain and formation calculations. URL parameters also work: `?seed=first-light&civs=4`.

## Observe

- Desktop: left-drag orbits, right-drag pans, scroll zooms; click a person, building, party or resource to inspect. Buildings show their own condition and purpose; people resolve to their real colony or party.
- Click a civilisation in the left menu to focus its home and switch to its fog-of-war view. The menu remains available for switching between perspectives; private enemy census and stores stay hidden.
- Touch: one finger pans; two fingers pinch to zoom and drag to orbit. The canvas contains its gestures; inspector panels scroll vertically.
- On smaller screens, Societies, Inspect and Views are collapsed until requested. Map returns to the overview.
- Space pauses; 1–5 select 1x, 2x, 4x, 16x, 32x. F follows, C toggles the cinematic camera, H hides/shows the interface, Escape returns to the overview.
- Whole world is an observer perspective. A civilisation perspective shows its current sight and remembered places; switching perspective never changes what its AI knows.
- The Developed world control runs the same simulation forward 1,200 cycles; it does not insert population, stocks or showcase structures.

One neutral cycle is one simulation second at 1x. The simulation advances in fixed 0.1-second pulses, independently of rendering. Pausing preserves fractional time and animated poses.

## Domination and variation

A civilisation wins when no independent opposing settlements or viable field armies remain. Defeated settlements can be occupied: their native inhabitants and species remain, and captured stores stay at the physical location. Conquest does not delete civilians, transform species or teleport inventory to a capital. A surviving field army can still try to liberate its home before capitulation. If a sovereign loses all native bases but still holds a foreign town, one held producer can recruit paid native auxiliaries under its command. Their species and population identity do not change.

Campaigns reserve troops for home defense and may field bounded simultaneous expeditions. Command decisions use delivered intelligence and local home sightings; a field force uses its own visible contacts. Supplied survivors can press an undefended objective and continue from a captured depot after paying for the next route's rations. Low supplies, strong defenders and home threats can still justify withdrawal. Nearby soldiers can engage different hostile formations at once, while scouts intercepted at physical contact retreat with their people and reports intact.

Inspectors distinguish native identity from current control. Buildings retain their native architecture; military command colors identify their controller. Combat checks current allegiance again when a delayed strike lands, so capture or capitulation cannot turn an old attack into friendly damage.

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
node tests/interaction-campaign-browser.mjs
node tests/ai-readability-browser.mjs
```

Browser tests default to bundled Chromium. `BASE_URL` accepts a local server or hosted project subpath; `QA_CIVS` selects the start count. `QA_TIER=full` includes the 3,000-cycle/high-quality tier. `QA_QUALITY=low` selects performance rendering, `BROWSER_CHANNEL=chrome` selects installed Chrome, and `QA_VIDEO=0` explicitly skips recording. Software-WebGL CI is labelled as such.

Every push to `main` runs the Node regression suite, builds and verifies the assets, and runs a short browser smoke against that exact built artifact. The same smoke command verifies the public Pages artifact after deployment. Each smoke has a 180-second total budget and checks the commit marker, real WebGL boot, simulation progress/pause, faction selection and fog privacy, building picking, pointer/keyboard input, weighted census and runtime errors. Failed predeployment checks keep the previous deployment. This fast path does not claim long-term balance or hardware performance.

Development and CI use the same built preview, URL prefix, 1280×800 viewport, software-rendering flags and locked Playwright browser:

```sh
npm ci
npx playwright install --with-deps chromium --only-shell
npm run build
npm run preview # keep running in a separate terminal
QA_SOFTWARE_RENDERING=1 npm run test:smoke
```

The preview serves only `dist/` at `http://127.0.0.1:4176/little-world/`, matching the Pages project prefix. `EXPECTED_COMMIT` defaults to the checkout SHA; `BASE_URL` selects another host. The smoke rejects a browser version that differs from Playwright's lockfile-selected browser. `BROWSER_EXECUTABLE_PATH` plus `QA_BROWSER_PARITY=diagnostic` can gather explicitly labelled diagnostic evidence when browser installation is blocked; a mismatched run is never reported as release acceptance. CPU, OS, GPU and scheduling can still differ between runners, and the report records the environment and timings.

Use **Actions → LittleWorld deep QA → Run workflow** for comprehensive checks. Choose `simulation` after economy, population, combat, campaign, navigation or victory changes; `browser` after substantial rendering, input, fog or inspection changes; `performance` after expensive simulation/rendering changes; or `all` before a substantial release. The retained suites include all 20 fixed domination/conservation seeds, both 3,000-cycle extensions, full observer/mobile controls, tactical scenarios, natural battle/harvesting videos, visual accounting and isolated advancing performance through cycle 5,000. Deep runs are manual and are not cancelled by routine main pushes. Their simulation job has a 60-minute execution budget; no seeds, invariants or audit intervals are removed. Reuse deep evidence only when its application source is unchanged, and run targeted regressions for every relevant correction.

Smoke and deep evidence are retained as Actions artifacts for 14 days. See `HANDOFF.md` for current cloud ownership and `DESKTOP-VALIDATION.md` for historical Windows browser verification and its limits.

## Measurement and model boundaries

This is a simulation-first tech demo, not a historical prediction or a directly controlled multiplayer RTS. Strategic decisions and logistics operate through settlements and groups. Resource crews use one articulated model with a count badge, while their complete workforce and cargo remain in the simulation. Home residents and local jobs are represented by housing and census totals; decorative resident walkers are removed. Military bodies and single scouts follow physical state. Local congestion can queue soldiers; individual soldiers do not run global route planners.

The live diagnostics distinguish actual/scoped population, people represented in the view, and actual drawn models. A visible 11-person crew contributes eleven people and one model. Count badges hide at the widest zoom and avoid overlap; selecting a visible crew keeps its badge available. In a civilisation perspective, the census includes owned and observable foreign people. Paused, active and advancing timing windows are separate.

Node render benchmarks measure CPU simulation/crowd work and geometry only. They do not measure GPU, buildings, landscape, interface or screen refresh. Browser frame measurements describe their recorded runner, viewport and quality, not a guarantee for other hardware. DOM and synthetic pointer tests are not evidence of actual mobile layout or native gestures.

New births stop at 900 people per settlement; each independent faction can maintain up to four active settlements. Limits stop new commitments rather than deleting existing people. Supplies, housing, geography, war and reserves constrain growth earlier. No save/load or direct faction orders are included.

## Source map

- `src/sim/core.js`, `economy.js`: physical work, settlement growth, paid construction and conservation.
- `src/sim/soldiers.js`, `military.js`: authoritative retained soldier records, paid recruitment, deployment and demographic accounting.
- `src/sim/defenses.js`: funded defensive planning and real tower operator assignments.
- `src/sim/strategy.js`, `combat.js`, `individual-combat.js`, `formations.js`, `conquest.js`, `control.js`: scouting, tactical decisions, physical contact, impacts, occupation and sovereignty.
- `src/sim/knowledge.js`, `progression.js`: visibility, returned intelligence, technology and commerce.
- `src/world.js`, `config.js`, `sim/navigation.js`: seeded geography, civilisation count and collision-aware routes.
- `src/render/`: terrain, buildings, instanced bodies, count-badged workers, fog and combat effects.
- `src/main.js`, `clock.js`, `input.js`, `ui.js`: observer integration, timing, gestures and interface.

Three.js is MIT licensed. Playwright and Linkedom are development-only verification dependencies.

### Scarcity and responsiveness pass

World resources use 160 sites instead of 520, with one starter site per resource,
smaller deposits, and 45% of the former regeneration rate. Housing provides 28
places per completed house, plus 16 at a standing hub. Residents each need one
place; serving soldiers and funded trainees need one additional quarters place.
The AI builds housing ahead of demand. Destroyed houses lose capacity immediately,
disappear from rendering, and their plots can be reused for funded construction.

Scouts are individual citizens. They avoid locally visible defenders and can
ambush only one- or two-person unprotected work parties. Hostile troops prioritize
visible scouts; a lone scout caught at physical contact loses its undelivered
observations. Small paid harassment parties use fresh delivered worker reports,
keep a home reserve, and interrupt raids for defenders. Funded armies can continue
to a suitable nearby reported objective with sufficient existing supplies.

Front screens can extend through five joined wall spans on each side of a gate.
Known hostile approaches can supersede an obsolete rear-facing screen, and
towers favor nearby actual work parties while retaining physical crew requirements.

Interactive frames run at most four simulation pulses, stopping after an 8 ms
CPU budget once the current pulse finishes. Requested backlog is bounded at half
a simulation second; excess requested time is recorded, never credited as computed
world progress. This prioritizes input responsiveness under load and does not
guarantee the selected nominal speed. Actual simulated cycles per second remain
available in performance diagnostics.
