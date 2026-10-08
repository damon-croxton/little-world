# LittleWorld cloud handoff

Source: https://github.com/damon-croxton/little-world (`main`).
Public site: https://damon-croxton.github.io/little-world/.

The saved cloud environment owns development, tests and ordinary authorized main pushes. No user desktop is required. Use the normal repository Git remote; do not retry the old read-only generic connector or create credentials. Keep one source writer.

## Current implementation

- Complete 3–6 faction simulation with physical resource/civilian/military accounting, individual soldiers, fog, production, research, trade and domination.
- Version 1 match settings: reserves 125%, upkeep 85%, aggression 100%, economic focus 115%. Bounded controls apply only on Start match and are exported with their schema. Seeded personalities remain.
- Civilian crews use small grey count badges. Army parties use larger red counts only for at least three living, visible, unique roster members. Faction ownership uses a distinct deterministic palette and species-number display names.
- Exposed settlement finishing is bounded by real remaining pressure, fit bodies, time, return supplies and fresh threats. Existing emergency retreats remain. Runtime combat destroys settlements and buildings; it never calls the retained legacy occupation helper. Native survivors enter the existing camp/refugee lifecycle, and razed plots permit funded rebuilding.
- Local debug export includes active configuration, identities, economy, knowledge, decisions and finish/return budgets.

## Release procedure

Run focused regressions for the change, then retain the full automated release gate. `npm test`, `npm run build`, and `node tools/verify-build.mjs` must pass. Use the lockfile-selected Playwright Chromium and `QA_SOFTWARE_RENDERING=1 npm run test:smoke` against the built preview. Software-rendered timing is not hardware performance evidence.

Push a meaningful commit through ordinary Git. Wait for all three Pages workflow jobs: build, deploy and live-qa. Public acceptance must match the exact pushed SHA in build.json and boot actual WebGL. Return the Actions link and evidence artifact IDs. Do not finish while deployment is pending or call a mismatched browser an acceptance pass.

Broad sweeps and videos are opt-in. Preserve all accounting, tactical, fog and input invariants. A failed gate requires a fix or an explicit blocker, not relaxed assertions. Browser contexts run sequentially to limit software-WebGL contention; the smoke has a hard 180-second budget.

## Boundaries and evidence

Short natural traces are observations of the named seed/build, not general balance certification. Node throughput, requested playback speed and browser wall-clock pacing differ. No physical iPhone or GPU performance claim follows from cloud emulation. Match duration remains variable.

The previous chronological handoff is preserved in `evidence/historical/handoff-before-match-settings-20261008.md`. Historical desktop and earlier cloud evidence remains untouched. The current README is the public setup, controls, architecture and publishing guide. See DEBUG-REPORT.md for diagnostic limits.
