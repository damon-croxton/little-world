# Desktop verification — 2026-10-06

Source input: `LittleWorld-final-source.zip`, 511,745 bytes, SHA-256 `b05fa9f033034f368cbd28c63e535f624ce4e538712e2c9dbeaf308b4a6add66`. All 61 source hashes matched the archive's manifest. The cloud patch applied cleanly over `c6cb3902fd557e90ab194af2145841752deb1425`.

## Hosted browser regression correction

The first final-source workflow (`37534052226`) passed build and simulation QA but correctly blocked deployment after browser QA failed. Inspector refresh compared authored SVG markup with browser-serialized HTML, repeatedly replacing the Follow button even when paused. The correction preserves that button across refreshes and compares cached authored markup for other unchanged content. Three new DOM identity regressions reproduce the old failure and verify the correction. All **165 Node tests** and the 37-module build check pass.

Observer tests now wait for actual pulse progress instead of assuming a software-rendered frame arrives within one second. Their progress, pause, cancellation and interaction assertions remain intact; screenshot and label-action timeouts allow slow software WebGL. A Windows Chrome SwiftShader run verified the formerly failing Resume, 16x, world-label, Follow and drag interactions. The complete hosted workflow remains the release gate; no checks were removed or bypassed.

A second hosted run (`37536598183`) exposed four further timing/lifecycle problems. Follow's accessible state was refreshed before its state assignment; the action now updates it synchronously. The controls harness now releases its completed desktop WebGL page before touch contexts and requests low quality at initial boot. A bundled Chromium reproduction had also timed out on mobile boot; isolated portrait and landscape boot checks now passed in approximately two seconds each. The visual harness waits for actual renderer updates before camera-dependent snapshots: the failed run's stale snapshot counted 266 visible people, while its subsequent same-camera screenshot correctly counted all 1,045. Harvest recording now remains at live 1x and pauses upon the selected crew's completion; 16x had skipped the whole return between two slow frames. Exact population and selected-crew receipt/visible-return assertions remain. All **169 Node tests**, synchronous Follow/isolated touch checks, and the build passed before submitting this correction to the unchanged complete release workflow.

## Passed

- Clean lockfile install; all **162 Node tests** passed, zero failed/skipped. Static build and **37-module relative asset graph** passed.
- **57 browser control checks** and **12 supplemental mobile checks** passed. Real DOM clicks, keyboard input and CDP touch emulation exercised pause, speeds, reset, seed/count changes, interrupted advance, selection, resources, views, overlays and scroll containment.
- **12 visual checks** passed: natural growth/conquest, exact individual accounting, resource conservation, literal instance-buffer motion within cycles, paused stillness, visible depletion, layouts and real harvesting video.
- Actual military rendering showed paid training queues, all three species' walls/towers, faction fog and a naturally occurring projectile battle without injected showcase state. A 12-second live 1x combat-canvas video was captured.
- Harvesting video followed real crew `g44`, observed its carried materials and 190 visible returning frames, then matched its own home receipt for 81 materials. The clip includes live 1x work, pause, explicit 16x acceleration and a live 1x return.

Environment: installed Chrome 153.0.8010.53, headless, ANGLE Direct3D11 on an NVIDIA RTX 3080 Ti. Desktop viewports were 1440×900 and 1600×1000. Mobile emulation used coarse-pointer touch contexts at 390×844 and 844×390. No physical iPhone/Android testing is claimed.

## Active late-world measurements

An isolated browser advanced the actual `first-light` world to each checkpoint, then sampled five seconds of live 2x play at a 1600×1000 overview. High-quality results:

| Approximate cycle | Actual individuals at sample end | Mean rendered FPS | 95th-percentile frame interval | Simulation cycles per wall second |
|---|---:|---:|---:|---:|
| 1200 | 1053 | 50.0 | 25.2 ms | 2.000 |
| 3000 | 5295 | 50.0 | 29.0 ms | 2.007 |
| 5000 | 5263 | 50.0 | 27.6 ms | 2.002 |

Every represented count matched the actual census. The final browser naturally reached victory at cycle **4979**; the victory UI paused and its Keep watching action resumed real simulation. That is approximately **41m30s nominal at 2x**, substantially outside the intended 5–10-minute pacing and much later than this seed's Node result. This is a known browser pacing limitation; no balance retuning was included in the integration pass.

## Reproducibility limit

Within Chrome, pure simulation, live 25-cycle batches and `advance(1200)` matched full serialized state exactly at every checkpoint. Paused rendering did not mutate simulation state. Node batches matched the Node one-shot result.

Across Node 24.19 and Chrome 153, minute terrain-coordinate differences produced a different retreat formation at pulse 1631 and different later combat results. At cycle 1200, the same seed had 1,009 people in Node and 1,045 in Chrome. Cross-engine outcomes are not bit-identical; seed calibration and nominal victory timing must name the runtime. This integration did not change balance to conceal that difference.

## Evidence and interpretation

Reproducible scripts are committed under `tests/desktop-*.mjs`, alongside the main browser suites. Reports, screenshots and videos are under ignored local `screenshots/final-*` and `screenshots/mobile-final-*` paths. Selected actual images and recordings were saved separately to Library. CI retains its own browser and simulation artifacts for 14 days.

Frame-rate observations describe this headless GPU run and can be limited by display/RAF cadence. They do not establish phone performance, foreground-PC FPS or a GPU-time measurement. Active simulation throughput is reported separately from paused rendering. The landscape Inspect overlay covers the top-right time controls while open; its Close button and bottom navigation stay reachable.

The cloud 20-seed pacing calibration remains a finite Node sample, not a universal guarantee: 18 victories by 2000 cycles, 11 within the nominal 5–10-minute window at 2x, two early, five late and two unresolved. Browser outcomes can differ as described above.
