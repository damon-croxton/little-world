# Evidence-led vanguard correction — 2026-10-08 follow-up

The first checkpoint b8998df03a67bb1f505c2e5663cebb246cfa5185 completed all
release gates in run 37725552125: 414 tests, 26 built-browser checks, 26 exact
public-browser checks. The parent requested useful continuation until the
original 04:46:41 UTC deadline, reusing the saved trace and fixing at most one
clearly evidenced issue. No further natural sweep or new feature was added.

At cycle 500, saved army g1232 had 26 survivors and a visible tactical strength
ratio of 2.37, yet settlement raid logic ordered retreat as outmatched. Its
five-unit civic-center count omitted nearby ranged soldiers already fighting.
The ratio used for that second retreat decision now comes from the same pulse's
active tactical engagement. Morale penalties use the same assessment. Physical
arrival, stores access, siege pressure and capture gates remain independent.
Supply exhaustion, low morale, actual tactical disadvantage and civilian/military
accounting retain their existing checks.

A new regression failed on the published checkpoint and passed after the fix,
including an added hidden garrison that cannot affect the local decision. The
62-test tactical/campaign/ownership set passed in 31.256 seconds. A controlled
one-pulse replay from the existing cycle-500 snapshot changes retreat to continued
engagement at the same 2.37 ratio, with the same population, town health and stores.
This replay is not a fresh natural run or a prediction of eventual victory.
Evidence: screenshots/recovery-frontline/vanguard-{before,focused,replay}.*.

First-stage measured check execution totals 643.450 seconds (10m43.450s), including
all measured local test runs, the one natural observation, shared local browser,
and CI test/built/public checks. Build/setup, waiting, and an untimed short
screenshot correction are excluded; this is cumulative execution, not wall time.
The final receipt adds the second stage and final exact-source release evidence.

# Veteran recovery and focused frontline coordination — 2026-10-08

One cloud lead; authorized discretionary window 03:46:41–04:46:41 UTC, with
publication reserved before its end. Started from verified live main
1a7fa4271c3d792453b5ac9997e8037a8ccd0f95. No agents, video, long sweeps or
external debug file; this does not reproduce a particular user save.

Inspection found withdrawing soldiers were permanently excluded from expeditions:
there was no healing or withdrawal-clear path. Safe home treatment now restores
2% of maximum health per cycle, at most six patients per home, with fair rotation.
Treatment requires physical arrival, eight cycles since that soldier's last hit
or attack, a functioning uncontested home, ordinary needs met, and supplies above
the existing training reserve. It charges the consumed resource ledger using
native unit costs; one full health bar costs 40% of new-unit supplies. Severely
wounded soldiers resume duty at 75% health. Identity, population, position,
weapon clocks, and deployed cargo remain unchanged. Neither field resupply nor
return itself heals anyone. The home inspector and downloaded debug report
explain treatment or its current block.

Production rallies now follow the leading supplied army for their selected
objective, excluding unrelated fronts, returning parties and depot visits.
A sufficient physically assembled force can commit at its existing deadline
when distant reinforcements would otherwise prolong the wait indefinitely.
The reported-defender strength floor remains mandatory; unsupported rallies
still retreat. No hidden enemy data or extra scouting knowledge is introduced.

Prepublication evidence in screenshots/recovery-frontline/:
- 89 focused tests passed in 5.003 seconds, including all species, exact costs,
  supply/combat blocks, no resurrection/teleportation, redeployment, foreign
  privacy, debug export, command accounting and the two coordination regressions.
- One natural first-light observation completed 500 cycles in 62.539 seconds,
  with resource and retained-soldier audits every 25 cycles. There were 22
  treatment returns to duty across 21 distinct veterans, seven coordinated
  assaults, eight protection parties, 486 deliveries, and zero captures.
  Median/p95 ten-pulse Node batch costs were 129.31/229.66 ms. These are not
  browser frame timings, victory pacing, or a long balance sweep.
- Built asset graph verified: 53 modules. Local real WebGL shared smoke passed
  all 26 checks in 68.195 seconds with no runtime/module/HTTP errors, including
  touch-emulated mobile controls and debug saves. System Chromium 151 is
  diagnostic; the locked Chromium 153 CI run is authoritative. The recovery
  screenshot was subsequently corrected to scroll the explanation into view.

CI retains the full Node suite, exact built-browser gate, deployment, and exact
public-build/browser gate with existing limits. The final SHA, gate results,
public screenshot artifact ID and file ID belong in the ignored release receipt
under screenshots/recovery-frontline/ after publication completes. Prior evidence
and instructions below are retained.

# Local debug report — 2026-10-07

User approved a narrow cloud-only Download debug report feature at 22:07 UTC.
One lead, no agents, long sweeps or videos. Settings now prepares a local gzip
JSON report (plain JSON fallback), with an explicit save link and optional native
file share. No telemetry or automatic transmission. Schema and omission rules
are documented in DEBUG-REPORT.md. Full-world hidden information is confined to
the downloaded report; existing faction projection remains unchanged.

Read-only decisions sample at most every two wall seconds; movement every ten.
History caps at 768 records/512 KiB. Snapshot rows cap at 3 MiB and final JSON at
4 MiB, with per-collection truncation. Soldier rosters are read only on export.
No simulation source or RNG behavior changed. Errors omit messages, stacks and
URLs. Reset clears history and revokes prepared downloads even for the same seed.

Focused parsing, identity/health, current versus stale knowledge, bounds, reset,
no-roster-scan and exact-state invariance checks pass. One six-faction 200-cycle
fixture contained 685 people, 233 roster records and 43 groups: diagnostic samples
averaged 0.318 ms (p95 0.500 ms), snapshot 9.652 ms; candidate JSON 649,872 bytes /
gzip 71,494 bytes. Later visibility-field corrections retain the same sampling
path; final public file measurements come from the exact-source browser gate.
Local actual desktop gzip and touch-emulated mobile JSON/manual save downloads
passed without export HTTP requests, runtime errors or state changes in 42.81s.
Local system Chromium is diagnostic; pinned CI and exact live build verification
remain the release authority, recorded under screenshots/debug-report/.

# Late offensive and production-rally follow-up — 2026-10-07

The 56cd83fc647d673cd3e251a0516c9e1d2a7389db biome/protection release completed
all Actions gates in run 37685936758 and is the verified live fallback. The user
then explicitly added concentration, exploitation after victory, threat-based
reserves (including zero-reserve all-in), and dynamic production rallies within
the same 21:33:55 UTC deadline. No agents or videos were used.

This follow-up removes fixed 30-percent/12-person reserve rules and the original
force-estimate ceiling on campaign reinforcements. Current visible/freshly
reported home attacks determine the military reserve. Fit tower crews may join
an unharassed offensive; wounded people retain their HP, cooldowns and identities.
Recruits physically assemble toward a reachable forward destination and depart
as funded batches rather than individual sacrificial arrivals. Civilian labor,
actual supply requirements, fog, and departure commitments remain authoritative.
Successful survivors may continue to nearby observed economic targets; a funded
held forward depot can refill them on arrival without healing or forced origin
return. Genuine tactical retreat remains. A resupply leg suppresses optional
economic attacks so a low-supply force can actually reach its depot.

Constructed before/after movement trace (screenshots/late-offensive/): 100 fit
home soldiers previously dispatched 70 and held 30; now all 100 depart with zero
reserve when no home harassment is known. Every ID is preserved and resource
residuals remain zero. The 24-soldier completed-raid scenario at about 54% supply
and 60 morale previously returned home; it now selects nearby known workers.
These are controlled late-state scenarios, not reproduction of the user's exact
100-versus-40 save or a natural late-game balance claim. The inspector explains
fit/recovering/reserved/deployed distinctions and any paid supply limit.

Old fixed-reserve test expectations were replaced by explicit all-in and
observed-threat reserve contracts under the user's superseding policy. Hidden
casualty/withdrawal invariance and exact identity/cargo accounting gates remain.
Final exact-SHA CI/public-browser evidence and IDs are recorded in the release
receipt under screenshots/late-offensive/ once complete.

# Uniform biome and remote protection pass — 2026-10-07

Single cloud lead, authorized 20:33:55 UTC through 21:33:55 UTC. No agents,
video, or long seed sweeps. Cloud commands, ordinary Git pushes and Pages
publication remain the supported workflow; no user computer is required.

New generated worlds use exactly one Grassland, Desert or Alien meadow biome
for scenery and terrain rules. Settings include explicit choice or a seeded
choice; seed/count/biome repeat the world. Balanced districts keep equal
fertility, resources, approaches and neutral habitat effects. Legacy terrain
fixture keys still decode, and old artifacts are preserved.

Founding and protection share delivered-report threat assessment, actual
military/tower coverage and ready reinforcement travel. Every route segment is
sampled for reported danger. Six-to-twelve-person paid guard rotations use real
existing soldiers, keep the home reserve and eighteen cycles of home upkeep,
and fund the round trip plus forty cycles on station. They protect remote
worksites, escort colonists and continue guarding a physically founded outpost.
They intercept locally visible raiders, keep bounded missions and physically
return; returning guards cannot be merged into offensive campaigns.

Validation before commit: 389 full tests passed in 112.89 seconds; after the
final provisioning/reinforcement refinement, 27 focused contracts passed in
0.695 seconds. The earlier full run had one stale config-object assertion,
which was updated for the new public biome field; no release gate was weakened.
A final natural first-light 250-cycle trace took 18.12 seconds: thirteen census,
individual-roster and resource-accounting checkpoints passed; 226 deliveries,
two remote guard rotations, no shortages and no worker combat deaths. No colony
formed during this short natural window. Controlled funded-founding, stale-threat
expiry and escort-to-outpost scenarios pass. This is not a balance/pacing sweep.
The user's report of ordinary-play worker raids remains user observation.

The browser release command now checks each biome through actual settings,
captures all three worlds, and checks the selector in a 390×844 viewport. Exact
commit Actions/public-marker/browser receipts and screenshot IDs are recorded
under screenshots/uniform-frontier/ after publication. Until that receipt is
present, the preceding live baseline is 02b1f2252505dd2e3573044de5474df2c33f5630.
Cloud SwiftShader timings do not establish physical GPU/iPhone performance;
the historical roughly 41m30 nominal-2× browser pacing limit is not superseded.

# Cloud worker-combat follow-up — 2026-10-07

Latest verified simulation checkpoint: ef0bc06a736b3f903d862592701fa62200955dc6.
Actions 37618448297 passed all gates: 373 tests (158.64s), 21 built checks (85.68s)
and 21 public checks (75.68s), with the exact public marker and pinned Chromium
153.0.8010.12 WebGL boot. Public artifact 11480639270 /
file_00000000e5d88230a60aabd37348aa3b; receipt and images are preserved under
screenshots/worker-combat/ef0bc06-public-ci/. No returning army was stuck in the
250 or 300-cycle final observations. The previously affected expedition returned
with nine of seventeen soldiers at cycle 204; the specific formerly stranded
soldier died in combat at time 169.4 in this fresh replay. Do not claim that this
individual returned or rejoined another expedition.

This final small presentation change moves existing owned-crew health beside
the work assignment, above the inspector fold. 17 existing UI tests pass; actual
desktop and 390×844 touch-emulated renders show the 12-to-11 count change and
343/352 remaining health without scrolling, with panel open/close preserved.
These local Chromium 151 renders are diagnostic, not release browser parity or
a physical iPhone claim. Final exact-source CI/publication is recorded separately.

An unaccelerated 20-second fresh-world browser observation at nominal 2× measured
2.86 FPS and 1.04 simulation cycles per wall second, with no browser errors.
This is cloud SwiftShader behaviour, not physical GPU performance. The historical
roughly 41m30 browser pacing limitation is not superseded by short Node checks.
The user asked to finish by 12:40:29 UTC: no further broad features or sweeps.

Follow-up cdd8181469e16da45de0454e369b421e3b7e06c9 is now published and verified.
Actions 37616857626 completed green: 372 tests (177.19s), 21 built browser checks
(89.79s), 21 public checks (88.08s). The public marker matched exactly and pinned
Chromium 153.0.8010.12 booted WebGL without errors. Verified public artifact
11480198085 / file_00000000ac0c820b89f5129f30ba1d7c, digest
e500ac8dc9085802c9c50ce5d1fa7e6f5955a06c3b8de3904ad88c53abd01863. Receipt and
same-camera worker before/after images: screenshots/worker-combat/cdd8181-public-ci/.

Fresh 250-cycle observation of cdd8181: 222 deliveries, one colony, 25 passing
accounting checkpoints, no shortages and no invalid group/soldier footing.
Every returning army was moving at the final checkpoint. A subsequent 50-cycle
continuation reached 269 deliveries; the new colony briefly ran short at 260 and
recovered by 270. Five more accounting checkpoints passed. No natural worker
casualties occurred through 300; do not substitute controlled combat for that fact.

Next narrow correction removes civilian-count-as-military-strength from field
opportunity selection: four supplied survivors may select a reported twelve-worker
crew, while stale activity, recent escorts and reported garrisons veto it. Home
dispatch shares the protection check and retains its 48-unit range, reserves and
paid supply limits. A bounded exact-coordinate cache avoids repeated immutable
terrain-footprint work; gates/walls remain dynamic. Replaying the same 50 cycles
matched the complete simulation state exactly (8.91s cached vs 9.33s uncached in
one Node comparison; not browser or GPU performance evidence). 50 focused checks
pass, including navigation, physical troops, worker combat and economy. Final
exact-source CI and publication must still be verified for this next correction.

Published worker-combat checkpoint: 3f8bfbd63ad3ab825ee6d69288915d2418b3fb03.
Actions 37613137184 build/deploy/live-qa passed: 362 tests (89.72s), 21 built
browser checks (51.56s), 21 public checks (82.70s). Public build.json matched that
exact SHA; pinned Chromium 153.0.8010.12 booted WebGL with no browser errors.
Public artifact 11479571207 / file_000000004ac881fabc4b2aa3e391d8f4, preserved in
screenshots/worker-combat/public-ci/ with release-receipt.json. Library's required
prepared-upload helper failed its hosted tools/list request with a network error;
no Library image IDs were created. The downloadable evidence remains available.

The next source follow-up adds in-range worker fire during rallies, physical
return after a futile harassment chase, continued attacks after a loot transfer,
and hostility on actual campaign worker attacks so defenders can respond. Funded
economic scouts revisit observed worksites using delivered reports, avoid known
defenders and return when they actually see danger. No hidden worker tracking.

Short natural observations (200 then 250 cycles) retained exact accounting and
no shortages, but produced no natural worker casualties. Economic surveys did
dispatch naturally; a scout saw defenders and returned with six observations and
over 92% supply. Controlled tactical/browser fixtures separately prove attacks,
losses, escape, defense response and count badges. These are not win-rate tests.

Observation also found a riverbank footing bug: sideways strip movement could
leave a soldier unable to turn, and group movement used less clearance than its
replan. Full endpoint footprint checks and equal movement/planning clearance now
prevent those invalid steps. Shared route breadcrumbs compress straight segments
and retain more actual turns/gates for lagging survivors; no per-body A* or
teleport recovery was added. Final follow-up acceptance and exact publication
receipt must be checked before treating this revision as the live checkpoint.

# Balanced districts checkpoint and authorized worker-combat pass — 2026-10-07

Balanced map release 65211a77c485dded5bad962479ca29597268d0bd is live and
verified: Actions 37611246460 build/deploy/live-qa green; 350 tests; 20 built
and 20 public browser checks, pinned Chromium 153.0.8010.12. Exact public marker
and WebGL boot are in screenshots/balanced-starts/release-receipt.json. Public
artifact 11477728467 / file_000000002b1481faa8a467016b1710f1.

Worker combat now uses canonical soldier attacks against aggregate civilian
health (32 per real civilian). Impacts recheck hostility, cover and physical
aim, consume damage once, and update native population, survivors, capacity and
proportional cargo loss. Empty crews are eligible. Severe visible defense forces
retreat; defenders interrupt raids; pursuit expires after ten seconds or 3.5
without actual soldier closing/damage. Crews detect actual visible troops during
travel and harvest and take reachable escape steps if home lies behind danger.
Fully lost crews are removed in the same strategy pulse. Fog projections redact
retained worker target/attacker references. The inspector and real count badge
reflect casualties; effects mark the actual aggregate crew impact position.

Worker pass pre-publication evidence: 361 full tests passed in 122.96s; 21 local
browser checks in 74.39s (Chromium 151 is diagnostic only); focused late fog/effect
checks retained under screenshots/worker-combat/. Browser raid images deliberately
arrange a stationary 12-worker crew against six actual soldiers; they are controlled
render evidence, not a natural-match or balance claim. Final exact-source CI
acceptance remains required. No agents or videos were started. Execution remained
functional after the platform disconnect callback at 11:08 UTC.

User approved balanced starts, then a ONE-LEAD improvement window from 10:40:29
until 12:40:29 UTC. No agents, long sweeps, videos or redundant unchanged runs.
Checkpoint balanced maps first; next priority is real worker-crew combat: attacks
on exposed crews including empty crews, individual weapon clocks/damage, exact
represented-worker casualties/cargo, escape and defender response, bounded
pursuit and local threat assessment. Keep fog and survival/replacement economics.
Halfway status around 11:40 UTC; stop new features at 12:40 UTC and report exact
validated live SHA plus remaining limits. Development remains cloud-only.

Balanced generation preserves public seed/RNG and biome art, with an explicit
internal terrainSeed keyed by seed/count/version. Every terrain/render/route/sight
consumer uses this key. Plain-seed terrain fixtures retain legacy physical ground.
Home and first-expansion pads have radius 20; supplies at radius 16; expansion
centre is 48 units inward on a real eight-unit-wide approach to the shared centre.
All count settings 3–6 have deterministic physical districts. Fertility .8,
movement 1, base farm factor 1.15, ordinary power and neutral biome research/siege
bonuses apply locally. Species upkeep, weapons, tech, seeded advantages and outer
biome rules remain. Guaranteed deposits have declared equal stocks, .7 richness
and renewal; outer scarcity retains 160 total sites and normal finite deposits.
Expansion coordinates travel only in actually observed resource reports. Existing
browser worlds require reload/reset. Inspector/guide explain district rules.

Static before/after and timed checks are under ignored screenshots/balanced-starts/.
The original audit found 14–18 starter route lengths and unequal fertility. New
static tests assert real 16-unit supply routes and 48-unit first expansion routes,
350+ maximum starting-upkeep cycles in deposits, land clearance, population/cargo
ledgers, count-key separation, fog and seed-reset determinism. These are opening
access guarantees, not win-rate or whole-map equality evidence.

# Strategic planner, enclosing walls and comparison — 2026-10-07

Single cloud lead; no agents, videos, long sweeps or optional polish. This pass
supersedes front-only screens with funded enclosing perimeters. A cached blueprint
uses the civic footprint and traversable terrain, grows joined sections from a
useful gate, preserves friendly extraction routes, repairs destroyed spans and
expands around new buildings. Multiple gates remain open to friendly traffic.
Unbuildable terrain defers a bounded retry; no unfunded instant enclosure.

Faction planning runs at most every four cycles. Persistent role/target IDs serve
home reserves, worksite guards, recovery, harvesting, scouting and expansion.
Campaigns concentrate affordable supplied troops at a shared forward rally and
commit on actual arrived healthy bodies versus dated reported defenders. Weak
rallies expire; stuck movement gets one path invalidation/retry, then a physical
return and objective cooldown. Urgent defenders interrupt assembly, while casual
raids do not scatter it. Existing individual IDs, wounds, home reserves, housing,
training and paid cargo remain authoritative. No hidden foreign truth informs
strategic target choice. Screeps is design inspiration only, not a runtime.

Societies now includes a compact worker/military comparison with faction colors,
shared scale, explicit native-census definitions and mobile collapse. Foreign
counts AND scale contribution are withheld in faction perspective. Zero/collapsed
rows and resets are covered. Browser acceptance checks the chart and mobile panel.

Validation is focused regressions plus three natural 200-cycle observations,
then the unchanged required build/test/browser/deploy/public-browser pipeline.
All 60 natural audit checkpoints preserved resources, population and persistent
rosters; short-run results are not a claim about long-game balance. Raw evidence
and elapsed check times are retained under ignored screenshots/planner-pass/.
Locked Chromium 153 in CI is release acceptance; local system Chromium 151 is
explicitly diagnostic. No physical phone, desktop GPU or nominal-speed claim.

# Recovery, frontlines and live scouts — 2026-10-07

One cloud lead; no specialists, videos, long seed sweeps or optional polish.
User requested fixes for inactivity, isolated army return loops, colonial
expansion, live scout intelligence, hostile contacts and futile scout pursuits.

Harvest planning now tries reachable affordable alternatives, supports smaller
crews and reserves survival dispatch before discretionary spending. Empty stores
can launch small nearby recovery crews with only actually paid rations; existing
field starvation and exact cargo ledgers still apply. Distress releases research
labor. Colonies reserve 24–48 actual civilians from viable homes, fund journey
and construction separately, and choose surveyed resources away from reported
threats using routes without unseen enemy wall geometry.

Scouts share actual LOS observations and surveyed cells live. Old unseen records
remain stale; other field parties retain courier delivery. This supersedes older
instructions requiring delayed scout reports. Current control still owns sight.

Healthy returning armies interrupt march for hostile contact and then resume
return. Genuine retreat stays targetable and does not initiate another battle.
Brief scout pursuits stop for poor catchability, no progress or a short leash.
Reinforcements rally to a shared front; same-origin parties may merge at physical
contact while keeping canonical soldier objects, HP, clocks and paid stores.
Different native homes keep separate rosters. No remote demographic transfer.

Focused recovery/contact/intelligence/accounting tests and one 200-cycle normal
first-light observation precede the existing required release pipeline. That
observation had 179 deliveries, four battles, 36 combat deaths and no starvation
deaths or abandonments; no colony formed within that short horizon. Do not claim
universal strategy quality or long-game balance. Evidence/timings are under
ignored screenshots/frontline-pass/. Final release is verified by exact SHA,
terminal build/deploy/live gates and real public browser boot.

# Scarcity, housing and responsive frames — 2026-10-07

User requested an economical single-lead pass: no specialists, long sweeps, videos,
or optional polishing. The screenshot libfile_6f917c70df388191a33faffe326f1dd0
could not be downloaded through the supported Library materialization helper;
no image-dependent claim was made. Keep work exclusively in this cloud checkout.

Implemented the scoped scarcity, housing, single-scout/harassment, defensive
placement and frame-budget changes documented in README. Resident walkers were
render-only representations of census/local jobs; housing now represents those
citizens. Preserve housedIndividuals separately from visible/cull/model counts.
Do not restore decorative residents or fabricate military/civilian population.

A 200-cycle CPU profile took 9.72 seconds and showed terrain/formation work as
the largest sampled costs. Interactive catch-up is now at most four pulses and
an 8 ms budget, with at most 0.5 requested simulation seconds queued. A pulse
cannot be preempted; missed requested time does not advance the world.
Defense route planning is deferred until defense construction is actually eligible,
and formation movement reuses individual goals instead of recomputing ranks.

Checks and release receipts are under ignored screenshots/scarcity-pass/.
Required per-push CI remains unchanged; public smoke now also observes the
per-frame pulse limit at nominal 2x and the separate housed census. Avoid
repeating unchanged local suites or adding long balance runs to this request.

# Persistent soldiers in the main civilisation world — 2026-10-07

The user approved moving the validated individual combat into LittleWorld itself.
This section supersedes the older prototype-only boundary below. Development
continues exclusively in this saved cloud checkout; ordinary main pushes and
Pages publishing are authorized. Preserve previous release evidence.

Native settlements retain permanent soldier records. Paid completed training
creates identities, expeditions reference them, and exact casualties debit the
same population and cargo ledgers once. Deployment, retreat, reinforcement and
return preserve individual HP, weapon clocks and identity. Civilian work crews
remain aggregated and count-badged. The battle sandbox remains a regression fixture.

Individual combat uses spatial target queries, physical line of sight, bounded
pursuit, local spacing and shared navigation. Every eligible soldier can attack;
only visual effect retention is capped. Towers reserve actual ranged identities
and require their physical presence. Captures and delayed impacts recheck current
control. Army route anchors provide no sight independently of actual troops.
Soldier sightings extend the fog mask without telepathically delivering field
reports. Scoped views contain a flat visible roster, with foreign health, intent,
weapon clocks and hidden identity references removed.

The new main-world harness is `tests/world-individual-browser.mjs`, alongside
`tests/world-individual-audit.mjs` and focused roster/combat/presentation tests.
It discovers an untouched natural seeded battle, clicks an actual soldier mesh,
records nominal 1x canvas playback, and checks portrait/landscape touch emulation.
Record actual simulated and wall seconds separately. Node and software-browser
measurements do not establish physical-phone or foreground-GPU performance.

A long campaign caught an unreachable withdrawal path storing infinite length;
its cache now retains an explicit unreachable result with null length, without
moving the soldier or weakening the finite-state audit. Severely wounded troops
remain in their actual native ledger and cannot be remobilized into an expedition
whose marching order they cannot follow. This adds no healing, civilian reminting,
or new military quota policy.

Release status is determined by the exact source SHA, terminal build/deploy/live
Actions results, public `build.json`, and saved reports under ignored
`screenshots/world-*`. Per-push CI remains bounded; deep suites remain manual.
The earlier 600–1,200-cycle balance target is historical, not an acceptance timer
or a current measured promise. Do not force campaign outcomes to meet a horizon.

# Individual-soldier prototype — 2026-10-07

The user approved starting the combat rebuild with a separate 24-vs-24 battle.
`battle.html` is accessible from the civilisation sidebar. Persistent soldiers
own health, cooldowns, position, target and orders. Melee and ballistic arrows
resolve against the exact named individual; fixed arrows can miss or meet cover.
Wounded soldiers withdraw independently and remain attackable. Bounded pursuit
rejects impossible chases; ranged units space and share visible focus targets.
Team views conceal unseen enemies and private enemy intent. Whole-field mode
only changes observation, never AI knowledge.

This is an isolated prototype. The civilisation economy, campaigns, training,
garrisons, pooled group combat and aggregated civilian crews remain in place.
Integrating the individual lifecycle into those systems is separate work.
Do not describe this prototype as a completed replacement of world combat.

Focused tests cover target identity, independent cooldowns, simultaneous melee,
withdrawal, pursuit feasibility, projectiles, navigation and fog invariance.
`tests/battle-audit.mjs` checks five untouched 24-vs-24 seeds for exact HP/death
ledgers and natural behavior. All 48 soldiers fired in every seed; there were no
friendly shots or unexplained HP changes. Crossing ended in red victory at 44.2s
and redoubt in blue victory at 65.6s. The other three seeds remained ongoing at
120 simulated seconds. No outcome is forced to meet the audit horizon.

The ordinary built/public smoke now includes sandbox boot, real soldier picking,
team sight, play/pause, named damage and seed/size reset. Both entries are built
and their complete asset graphs verified. The larger browser capture records an
actual unmodified seeded fight at nominal 1x, keeps a selected casualty's exact
identity, and checks portrait touch controls. Software rendering can slow the
simulation: report actual simulation and wall time separately. Cloud Chromium
151 diagnostics do not establish parity with strict Actions Chromium 153 or
physical-phone/hardware performance. CPU benchmarks at 48/96/192 soldiers are
Node timings only. Do not make thousand-soldier capacity claims.

Reproduce focused checks with:

    node --test tests/battle-simulation.test.mjs tests/battle-micro.test.mjs
    node tests/battle-audit.mjs --output screenshots/battle-audit.json
    npm run build
    node tools/verify-build.mjs
    QA_SOFTWARE_RENDERING=1 npm run test:smoke

The source commit and public `build.json`, followed by terminal build/deploy/live
Actions results, determine publication status. Evidence and Library receipts
live in ignored `screenshots/battle-*`; preserve earlier releases' artifacts.

# Fast publishing and browser parity — 2026-10-07

The user explicitly replaced the earlier per-push deep-check policy. Main pushes
now run the full fast Node regression suite, build/asset verification, and the
bounded `npm run test:smoke` command against the exact built preview. After Pages
deployment, the same command checks the exact public commit. Full simulation,
mobile, visual, video and isolated performance suites remain in the manual
`LittleWorld deep QA` workflow; README documents when each suite is required.

`npm run preview` serves only `dist/` under `/little-world/` on port 4176. Both CI
and development use this server, the same acceptance command, viewport and
software-rendering flags. Playwright is lockfile-pinned; strict smoke checks its
browser version. The saved cloud currently has Chromium 151, while the locked
Playwright browser is Chromium 153.0.8010.12. The normal installer, including an
explicit command-level network request, receives `403 Domain forbidden` from the
Playwright CDN. Do not claim exact local browser parity while that remains true.
Explicit diagnostic mode records the mismatch and cannot report `passed` for a
mismatched browser. Use a supported environment provisioning route to resolve it;
no user PC, credentials or persistent permission expansion is required here.

Two earlier Actions failures were harness setup errors: a fixed 500ms delay
inspected labels before the next render, and a projected worker center was behind
a nearer building. Real rendered-frame synchronization and exposed-target
preparation fixed them while preserving the actual click and identity assertions.
The corrected `64e8e641dc19a7cfb83e31d1e221d8af9d38a029` browser job passed 61 controls,
24 unique tactical cases, five interaction/battle checks and 12 visual checks.
Application source remains unchanged by the CI/server/smoke work below.
Its complete run `37558202879` finished with all five jobs green, including public
boot. All 20 seeds passed conservation; six reached victory and 14 remained
ongoing at cycle 2,000. Both 3,000-cycle extensions passed (first-light continued
after victory; domination-06 remained ongoing). The simulation job took 34m19s
and browser QA 11m14s. The user asked to move these long checks off routine pushes
after that run completed; none of those audit assertions were removed.

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
