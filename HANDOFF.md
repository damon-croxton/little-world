# V2 checkpoint — validation in progress

This is a durable work-in-progress checkpoint, made before the development PC sleeps. The demo boots and naturally grows; the full release checklist below is unfinished.

## Verified so far

- Real Chrome on an RTX 3080 Ti: initial and naturally evolved world render without page/WebGL errors.
- Seed `first-light`, cycle 1,200: 7,971 actual individuals, 24 settlements, 523 buildings, 1,844 field workers. All 7,971 individuals were represented and visible in the overview, with no injected showcase population.
- Same-seed human colony grew from 96 individuals / 10 buildings to 618 / 39.
- Paused developed overview measured approximately 50 headless frames/second, 475 draw calls and 7.80 million triangles. This is one headless-PC measurement, not a guarantee of live simulation or other-device performance.
- Node first-light 1,200-cycle run: about 11 seconds after lookup optimization. Conservation residuals below 2e-8 across all four resources. Another seed reached 8,146 individuals in 24 settlements.
- All nine deterministic/frame-rate/pause/resource tests passed on the checkpoint source (about 5.5 seconds); `npm run build` also passed. This is not long-run certification.
- Initial 10 real UI checks passed: boot, pause/resume, speed buttons, keyboard controls and seed entry isolation.
- Seven integrated visual checks passed without browser errors: 53 motion frames contained 51 same-cycle intervals with changing positions at 1x; pause preserved exact motion samples for 700 ms. A salvage site visibly depleted from 5,848 to zero. Desktop panels did not overlap and smaller layouts had no horizontal overflow.
- Cycle 3,000 reached 29,501 visible individuals, 8,539 field workers and 386 groups. There were 30 settlement records, including 14 camps and six ruins. The scene fell to about 21 headless frames/second (522 calls / 15.42M triangles). This late-world population/performance and collapse balance needs attention.

## Continue from here

```sh
npm ci
npm test
npm start
# In another terminal, with Chrome installed:
node tests/controls-v2.mjs
node tests/visual-v2.mjs
node tests/balance.mjs
npm run build
```

Simulation modules are pure JavaScript and work headlessly on Linux. Browser tests currently request the installed Chrome channel. In cloud CI, install Chrome via Playwright or adapt the launch channel; do not imply cloud measurements reproduce the Windows GPU.

Outstanding:

1. Finish six-seed 5,000-cycle runs and inspect conflict, casualties, collapse, stable growth, stale intelligence, troop opportunity costs and all conservation/workforce bounds. The interrupted first harness used an overly strict refugee capacity assertion; the saved harness now exempts empty-cargo refugee groups. No completed 5,000-cycle certification yet.
2. Finish controls suite and capture an actual harvesting video. Integrated cycle 3,000, 1x sub-second motion, pause and resource depletion checks passed, but late-world performance and collapse balance require improvement.
3. Improve the overview framing: too much empty sea makes the developed island look small. Close settlement views already show strong population/construction growth.
4. Recheck the Developed world button after API-driven advance; a label-reset fix is included but awaits browser recheck.
5. Inspect actual resource depletion/regrowth alongside cargo and the ledger, and capture before/after growth at the same camera.
6. Enable GitHub Pages with Actions and verify the deployed commit, subpath assets and live boot. The workflow is included; a successful repository push alone does not prove deployment.

## Checkpoint boundaries

All collaborating source owners saved and froze their edits before this checkpoint. Source, tests, procedural assets and the deployment workflow are committed. `node_modules`, `dist`, local logs, screenshots/video, Library receipts and the preserved V1 archive are intentionally excluded. No downloaded private assets are required to run or build. V1 and the unrelated reference projects remain unchanged.

The original Windows workspace holds actual screenshots under `screenshots/visual-*` and other QA captures. Those files and foreground GPU access do not travel with this repository. Any interrupted local long-run process should be stopped or restarted from the saved scripts before trusting its output.
