# AI and readability integration contract

This focused revision starts from live commit `1ce023fe0214ccb97e6935d64e7684084b33dc55`, checkpoint branch `checkpoint/live-1ce023f`. The user explicitly replaces individually drawn civilian resource crews with a small worker model and a count badge. The population, allocation, cargo, military and resource ledgers remain authoritative. Existing observer controls, delayed reports and faction knowledge remain intact.

## Exclusive editing ownership

| Workstream | Owned files |
| --- | --- |
| Integration | `src/main.js`, `src/ui.js`, `src/style.css`, existing browser harness/controls/visual scripts, build/release/docs |
| Walls and routes | `src/sim/defenses.js`, `src/sim/navigation.js`, new wall/route tests |
| Tactical decisions | `src/sim/combat.js`, `src/sim/strategy.js`, new tactical tests |
| Individual combat movement | `src/sim/formations.js`, new formation tests |
| Civilian representation | `src/render/crowds.js`, optional new worker-badge module, `tests/rendering.test.mjs`, new civilian-render tests |
| World readability | `src/render/terrain.js`, `src/render/entities.js`, new geometry tests |
| Baseline and visual evidence | new `tests/ai-readability-browser.mjs`, ignored `screenshots/ai-readability-*` evidence |

Do not modify another owner's files; send a specific integration request. New test filenames must be distinct. No dependency, public deployment, git commit, or repository changes by workers. Root integrates and publishes. Use deterministic simulation time, stable IDs and seeded state. Renderers must never mutate the simulation. Do not run browser suites concurrently; the evidence worker has the first browser slot.

## Civilian renderer accounting

Only active `group.kind === 'worker'` resource crews become count-badged representatives; military remain individual real citizens. Worker badges track actual crew size at settlement/close views. At the full-world overview ordinary badges hide; a selected visible crew retains its badge. Deterministic screen-space packing prevents overlapping labels; workerBadgeCount counts actual labels and may be smaller than visibleWorkerCrews. At-home citizens and other roles may remain individually represented. No invented people or change to allocations/cargo.

Keep `totalPopulation` and `representedIndividuals` as the real census represented by all groups, including culled groups. `visibleIndividuals` is the weighted number of real citizens represented by visible models. `culledIndividuals = totalPopulation - visibleIndividuals`. `instances` and new `drawnModels` count actual drawn crowd mesh instances. Add `representedWorkerIndividuals`, `visibleWorkerIndividuals`, `workerCrewCount`, `visibleWorkerCrews`, `drawnWorkerModels`, and `workerBadgeCount`. Preserve `militaryIndividuals` and `visibleMilitaryIndividuals` as real individual soldiers. With one proxy per crew and all other people individual: `drawnModels = visibleIndividuals - visibleWorkerIndividuals + drawnWorkerModels`.

Motion samples must identify worker proxies by real group ID and include `representedCount`, role and crew size. Actual mesh matrix/motion attributes remain the proof of visible movement. Existing tests that equated every individual to a mesh must be intentionally updated to the weighted contract. UI must clearly distinguish people from drawn models.

## Shared combat and navigation interfaces

`src/sim/formations.js` owns `formationSize`, `combatFormationSlot`, and `updateCombatFormation`. `combat.js` imports and re-exports these names for compatibility. Existing arguments and return fields stay compatible. Every physical slot is a real soldier, indexed by role/ordinal, with previous/current positions for interpolation. Casualty, attack origin and rendered position use this same contract.

Tactical selection stays squad-level. Formation movement may use locally visible combat targets and nearby physical bodies/obstacles for separation; it must not run global pathfinding per soldier, use frame time, or independently select hidden enemies. The tactical owner should expose `entity.combat.targetId`, `targetKind`, `targetHomeId`, `active`, `yaw` and optional concise `intent`, `reason`, `decisionUntil`, `strengthRatio` fields. Movement and tactics owners must agree on any additional local target descriptors before using them. Per-soldier attack positions/ranges must stay physically reachable.

Walls use navigation's existing supported `from`/`to` endpoints (or center/rotation/length) and `kind`, `gateWidth`, `open`, `progress`, `hp`, `destroyed`. New planned connected segments should carry stable topology identity and useful placement reason. Gates must pass friendly/allied traffic and appropriate physical clearance. Construction must not strand home workers/soldiers. World renderer must honor arbitrary real segment length and joins; walls/navigation owner must communicate final metadata to renderer owner.

Walls/navigation owner should add a bounded, deterministic route assessment for tactical breach-versus-detour, agreed with tactical owner, accepting known/locally visible candidate obstacles. Physical collision may know real obstacles; strategic/tactical target selection must not read unseen enemy strengths/buildings. An unrelated nearby wall must not become an attack target. Threatening visible defenders can interrupt an economic/structure attack. Retreat and target changes need stable reasons/hysteresis rather than loops.

## Verification and evidence

Preserve meaningful existing unit tests and add bounded scenario tests for connected topology/gates, valid routes, useful breach versus detour, defender interruption, severe local disadvantage, worker/building raids, fog constraints, physical soldier separation and weighted render accounting. Integration runs all tests and multi-seed conservation checks, then critical outcomes in real Chrome (Node and Chrome are not bit-identical).

Before/after imagery must come from actual rendered app state. Baseline uses unchanged public build `1ce023f`; label speed/seed/cycle and distinguish natural runs from any controlled fixture. Normal-speed battle and worker video proof must not be a sped-up video labelled 1x. Capture screenshots and bounded metrics without concurrent browser contexts competing for GPU. Final release requires all CI jobs green, exact public build SHA and actual live Chrome smoke.
