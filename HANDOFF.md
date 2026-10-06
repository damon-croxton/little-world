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
