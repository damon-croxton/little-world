# Interaction and combat pass — 2026-10-07

Continue exclusively in this saved cloud checkout. This pass builds on released
`ab1b40193ca9f08bb529ea8ea1f2505b8abf423d`; the unchanged before capture was served
from `/workspace/little-world-baseline-interactions`. Resolve the new release
commit from Git and the public `build.json`, not a self-referential SHA here.

- Civilisation menu clicks focus a scoped home and switch fog perspective.
  Buildings retain their own inspection identity; visible bodies resolve to a
  real party or colony. Native identity and controller are shown separately.
- Home troops and locally controlled workers use command colours while retaining
  native body species. Native home civilians keep their original colours.
- Delayed strikes recheck ownership at impact. A controlled pre-fix reproduction
  damaged a newly captured farm from 160 to 29.44 HP; the browser regression now
  preserves 160 HP. The user's original visual sighting remains unconfirmed.
- Locally intercepted scouts return with their people, cargo and reports intact.
  Troops and garrisons can engage up to six visible contacts with shared, bounded
  role attack budgets. No per-soldier global target scan was introduced.
- Campaigns retain home reserves, support bounded simultaneous expeditions, and
  continue viable objectives after incidental contact. Route-based return rations
  and paid captured-depot provisions bound sustained campaigns. Departure orders
  persist through unseen losses until physical return or their report deadline;
  actual available soldiers separately constrain every allocation.

The final local Node run passed 255/255 tests, including targeted ownership,
inspection, fog, campaign, defence and simultaneous-combat regressions. The new
actual browser suite passed real menu/building/unit clicks, four controlled
combat scenarios, and natural battle capture without errors. Local application
source hash during that evidence was
`1f2a33aaeeb286ea421408aee3842ce56575bead0b2e37b6072888e41206dabd`.
These results precede the release workflow; its exact commit and terminal outcome
remain authoritative for publishing. Existing per-push pipeline cadence is kept.

New acceptance entry point:

    BROWSER_EXECUTABLE_PATH=/usr/bin/chromium QA_SOFTWARE_RENDERING=1 QA_OUTPUT_DIR=screenshots/interaction-campaign node tests/interaction-campaign-browser.mjs

Its controlled fixtures are labelled separately from natural-world screenshots
and normal 1x canvas recordings. Keep software rendering, touch emulation, Node
balance timings and physical-device performance distinct. Evidence remains in
ignored `screenshots/interaction-*` directories and saved Library files.

# Cloud ownership — 2026-10-06

Development now belongs exclusively to the user-selected saved cloud environment,
at `/workspace/little-world`. The desktop source and workers are frozen. Continue
here unless the user explicitly requests a different environment; no user PC is
required. Direct `main` pushes and the existing automatic Pages deployment are
authorised. Use ordinary repository Git access; do not retry the previously
rejected generic connector writes or create credentials.

The cloud adopted exact checkpoint `f54a67fd9604fcd8191674490359a95a39f2d31b`:
all 96 tracked files were present and all 15 committed simulation-manifest hashes
matched. A clean lockfile install, all 218 Node tests (zero failed/skipped), build,
and 39-module asset verification passed. Chromium 151 with SwiftShader booted the
actual app with no runtime errors and exact weighted population accounting.
Ordinary Git publishing was proven by source commit
`31c9db8885d62b2c01a0b6b20c82912b199a5966`, fixing the evidence harness's forced
Chrome channel. This does not certify completion of the remaining acceptance work.

Use `npm ci --cache /workspace/.cache/littleworld-npm` in this environment.
Its installed browser is selected with `BROWSER_EXECUTABLE_PATH=/usr/bin/chromium`;
use `QA_SOFTWARE_RENDERING=1` and label all cloud timing evidence accordingly.
Serialize browser suites and run active performance without competing audits.
The workspace network currently returns 403 for public Pages and Playwright's
download hosts. Ordinary Git push succeeds. Postdeployment `live-qa` verifies the
exact public build marker, actual WebGL boot, controls and weighted census from
the Actions runner, preserving screenshot and report artifacts.

The planned public bulk evidence release was not approved for upload. Do not
depend on or fetch it. The desktop is preserving that optional project evidence
privately in Library. Every required application asset is already in Git. The
historical manifest and reports below remain useful, with their provenance limits.

## Original frozen desktop handoff

# WIP cloud handoff — 2026-10-06

**Frozen at the user's immediate request to move all ongoing development to the cloud. This is a work-in-progress checkpoint, not a completed or fully verified release. Do not resume development on the Windows PC.**

Repository: https://github.com/damon-croxton/little-world . Resolve the exact checkpoint SHA with git rev-parse HEAD or the handover receipt. The preceding verified public revision was 1ce023fe0214ccb97e6935d64e7684084b33dc55. The normal Pages workflow may deploy this checkpoint only if all existing gates pass. Its CI and live deployment were not complete when this handoff was written.

Local project: C:\Users\Damon\Documents\Codex\2026-10-06\task-2\LittleWorld-v2. Deep Desert, Matraville and separate LittleWorld v1 were not modified. All runtime artwork is procedural source geometry; no external art, credentials or desktop-only asset paths are needed. package-lock.json specifies dependencies; do not copy node_modules.

## Materialize and run in the cloud

    git clone https://github.com/damon-croxton/little-world.git
    cd little-world
    git checkout <exact checkpoint SHA from handover>
    npm ci
    npm start

Node24 was used. Open/forward http://127.0.0.1:4174/ with a WebGL2-capable browser. Start-LittleWorld.cmd is the Windows convenience launcher. All implementation and tests are JavaScript.

Controls: drag/orbit, right-drag/pan, scroll/zoom; click/select; Space/pause; 1–5/speeds; F/follow; C/cinematic; H/interface; Escape/overview. Touch uses one-finger pan and two-finger zoom/orbit. Default: four civilisations at 2x. Settings change seed/start count. No save/load or direct faction orders.

## Current changes

- One animated model per resource crew with its real workforce badge; military/home inhabitants remain individuals. Weighted people and actual model counts are separate. Selected badges take priority; distant/overlapping badges are culled.
- Connected defensive screens, real gate openings, preserved friendly/resource routes, paid construction and shared navigation/render geometry.
- Local observable strength decisions; defenders interrupt raids; useful worker/building raids; stable severe-disadvantage retreat; breach versus detour; delayed shots respect late cover.
- Individually separated melee contact and ranged positions, shared body avoidance and gate following. Squad routing remains authoritative; local congestion can queue soldiers.
- Fewer decorative obstacles with all deposits and distinct biomes retained.
- Fog/report privacy corrections including hidden-wall invariance for mobilisation estimates. Physical movement still collides with actual walls.
- Destroyed storage clamps excess stocks once and records physical ledger losses.
- Tactical reasons/support estimates, crowd diagnostics, and expanded Node/browser tests.

See AI-READABILITY-CONTRACT.md for current interfaces. evidence/historical preserves superseded handoff/architecture; their old one-model-per-worker and file-ownership rules are historical. Eight Astra/xhigh specialists ran in stages, at most six workers plus lead concurrently.

## Passed checks and exact limits

- Integrated Node suite: 213/213 passed BEFORE final badge LOD, hidden-wall and inspector-copy refinements. Fresh full-suite verification of this exact checkpoint remains required. Later targeted suites passed: civilian/rendering17, strategy/tactical/trade29, UI/privacy17, UI/browser-harness/civilian31, independent accounting/knowledge4. Counts overlap; do not sum them.
- Build/module verification passed with39 modules before final inspector copy. Rebuild exact commit.
- Installed Chrome153.0.8010.53: 60/60 controls, zero runtime errors. Includes latest desktop and portrait/landscape mobile emulation, crew picking/count badges and weighted accounting. Not physical-phone testing.
- Chrome tactical module scenarios: 20/20 twice, zero page errors, identical paired evidence. Covers retreat, raid interruption, hidden information, cargo/workforce, breach/detour, late cover, spacing and gate passage. Controlled fixtures, not rendered showcase videos. Subsequent portable launch/hosted-path wrapper adjustment still needs CI.
- Natural220-cycle full-state replay matched batched/chunked/irregular rendering through four renderers with828 attacks. SHA256: 5bde81f9e2627f954b997ce457eaace9d091493d7bf8516b27c2f0bdc4235023.
- Only4 of20 natural2000-cycle runs completed: all conservation checks passed. Winners: first-light machine1599, tidal-garden machine627, iron-valley human988, amber-dawn machine630. Sixteen runs and two3000-cycle extensions remain. Partial sample cannot establish final balance/winner diversity.
- Long audit stopped during desktop transport recovery; no audit process remained at freeze. Whole-source hash changed because the inspector label copy changed during the run. Simulation files match the captured manifest; it was captured after seed4, not before, so preserve that provenance limit.

## Evidence

Original small reports are committed in evidence/cloud-handoff-20261006. The planned prerelease tag wip-cloud-handoff-20261006 carries LittleWorld-cloud-handoff-evidence-20261006.zip, SHA256 and per-file manifest; use the final upload receipt to confirm availability. The archive contains this project's screenshots, normal-speed WebM videos, reports and rollback archives, including older-stage evidence. Extract at project root to restore screenshots/, videos/ and checkpoints/.

BEFORE: exact public1ce023f, hardware Chrome/RTX3080Ti, high1600x1000, workers100, battle155–167, overview600–612; three12-second actual1x recordings; zero page errors.

Initial AFTER: natural workers100–111, battle143–155, overview600–612; same hardware/configuration; zero page errors. About50 headless RAF frames/sec, p95worker23.4/battle24.7/overview23.2ms. THIS PREDATES FINAL BADGE DECLUTTERING/AUDIT FIXES. It is not exact-checkpoint performance evidence. Initial overview shows overlapping badges; LOD/packing source and latest mobile control checks are newer. Fresh wide-view/gate-quarter/battle capture and isolated active performance remain required. The harness now includes a quarter-facing gate shot.

The attempted final full visual suite returned no process/session during transport failure. Do not claim it ran/passed. DESKTOP-VALIDATION.md is the preceding release's historical certification.

Confirmed Library artifacts:
- before battle image: libfile_20003c11e8608191a661eef53b9140cd
- before worker image: libfile_ff4801efbe9481918d427bc8bd749af8
- before normal1x battle video: libfile_0598f69edabc81919c03802a658a633b
- before overview image: libfile_409bc72c3dec819192b44e607456507e
No final AFTER Library upload is claimed.

## Continue in cloud

    npm test
    npm run build
    node tools/verify-build.mjs
    npx playwright install --with-deps chromium

Start npm start separately; serialize browser suites. Linux examples:

    BASE_URL=http://127.0.0.1:4174/ QA_SOFTWARE_RENDERING=1 QA_OUTPUT_DIR=screenshots/cloud-controls node tests/controls-v2.mjs
    BASE_URL=http://127.0.0.1:4174/ QA_SOFTWARE_RENDERING=1 QA_OUTPUT_DIR=screenshots/cloud-tactical node tests/tactical-browser.mjs
    BASE_URL=http://127.0.0.1:4174/ QA_SOFTWARE_RENDERING=1 QA_VIDEO=1 QA_OUTPUT_DIR=screenshots/cloud-visual node tests/visual-v2.mjs
    AI_AUDIT_DIR=screenshots/cloud-audit-remaining node tests/knowledge-accounting-long-audit.mjs winter-circuit moss-and-machine domination-01 domination-02 domination-03 domination-04 domination-05 domination-06 domination-07 domination-08 domination-09 domination-10 domination-11 domination-12 domination-13 domination-14
    AI_AUDIT_CYCLES=3000 AI_AUDIT_DIR=screenshots/cloud-audit-extensions node tests/knowledge-accounting-long-audit.mjs first-light tidal-garden
    QA_PHASE=after QA_BASELINE_REPORT=screenshots/ai-readability-before/report.json QA_OUTPUT_DIR=screenshots/cloud-after QA_SOFTWARE_RENDERING=1 node tests/ai-readability-browser.mjs
    QA_OUTPUT_DIR=screenshots/cloud-active-performance QA_SOFTWARE_RENDERING=1 node tests/desktop-active-performance.mjs

The audit runner truncates results: use NEW output directories when resuming. Preserve unfinished/failed seeds in the denominator. Label cloud software rendering honestly; it cannot establish Windows GPU/foreground performance. On a cloud GPU runner omit QA_SOFTWARE_RENDERING and record actual GPU. Same-runtime replay is supported; cross-engine bit identity is not promised.

Next: inspect exact checkpoint Actions results; fix failures IN CLOUD; inspect new overview/gate/battle images and normal-speed videos; finish multi-seed/post-victory checks; update validation; verify exact public build.json SHA and fresh live browser smoke. Existing workflow retains build/browser/simulation gates and adds tactical browser scenarios. Do not weaken assertions to pass CI.

## Desktop freeze and local leftovers

No local features or audits should resume. At freeze Get-Process node reported no Node process; audit owner verified PID77084 absent. Completed browser suites closed their owned browsers. Disconnected visual launch yielded no process/session, so a surviving browser is unverified; do not close unrelated user browsers. No other apps were stopped.

Ignored node_modules, .npm-cache, dist, browser installations and server logs are regenerable and excluded. All source/tests/lockfiles are committed; procedural assets are in src/. Evidence archive preserves screenshots/videos/checkpoint zips. Original ignored ARCHITECTURE-V2.md is copied into tracked historical evidence. Git internals, credentials and unrelated user files are excluded.

---

# Earlier handoff retained below — historical only

# Cloud handoff — historical snapshot

**Desktop integration update, 2026-10-06:** The source below has now been imported, all 61 hashes verified, and actual Chrome WebGL/control/mobile-emulation checks completed. See `DESKTOP-VALIDATION.md` for current evidence and remaining limits. The original handoff below records the cloud stage before desktop verification; its unpublished/unverified statements describe that earlier stage.

This working revision adds the requested domination, paid RTS forces, defensive structures, tactical terrain, faction fog and compact mobile observer controls. It is newer than the public checkpoint and is not yet published.

Base: `c6cb3902fd557e90ab194af2145841752deb1425` on https://github.com/damon-croxton/little-world

The public Pages site remains at that base commit. The available GitHub connection rejected source writes, so no source-publishing retry or new credential was used. The source can be published later through an authorised write-capable environment.

## Implemented

- Four civilisation starts by default; configurable 3–6, with 3–5 the usual range
- Default 2x; neutral fixed-step timing, pause and 1x/2x/4x/16x/32x controls
- Paid infantry and ranged producers, finite training, real citizen/role accounting and seeded economic/combat advantages
- Original species walls, gates and staffed shooting towers; construction, ammunition and physical ownership
- Larger usable island, cliffs, connected fords/passes, route collision, separated gathering arrivals and controlled gates
- Genuine scouting/report return, current sight versus stale memory, and occupation-safe observer views
- Deterministic attacks, projectiles, damage, casualties, retreat, occupation, capitulation and domination outcome
- Captured civilians keep their native species; resources remain at their physical location
- Canvas-first mobile interface, collapsible panels, safe-area rules and contained pointer gestures
- Main, render, unit, audit and prepared browser-test integration

## Validation status

Node, DOM, geometry, conservation and seeded simulation checks have been run throughout development. See the accompanying validation report and machine-readable evidence for exact revision hashes, counts and seed outcomes; evidence from an earlier revision is not certification of a later one.

Early domination calibration has genuine winners and meaningful seed variation, including economic and ranged advantages. The goal is usually 600–1,200 cycles, about 5–10 minutes nominal playback at 2x; it is a target, not a forced timer. Outliers and unfinished seeds must remain in the denominator.

Browser controls, WebGL screenshots/video, foreground GPU performance and actual mobile/native gestures are still unverified for this cloud revision. The available cloud browser could not create WebGL, and publication access prevented running the prepared browser CI. Pure DOM/geometry/pointer tests are not substitutes for those checks.

## Before publishing or calling it visually verified

```sh
npm ci
npm test
npm run build
node tools/verify-build.mjs
node tests/domination.mjs
```

Then run the prepared controls and visual/harvesting evidence suites in an authorised WebGL-capable environment. Review screenshots and the video, test actual touch interaction, and inspect the exact pushed commit's Actions results and live build marker. The workflow preserves the preceding public deployment if any gate fails.

## Model boundaries

The simulation remains observer-first. Citizens and military roles are actual counted individuals, while decisions and most economic work are grouped. Deployed armies have collision-aware formation positions and real combat events; civilian home walks and harvesting spreads remain representative motion around real settlement/party anchors. This is not independent per-civilian RTS pathfinding or individual tactical command.

The preserved pre-RTS archive provides a rollback point. No unrelated reference projects or local desktop files are needed to run this source.
