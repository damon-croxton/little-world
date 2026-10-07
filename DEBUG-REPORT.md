# Local diagnostic reports

Open **Settings → Download debug report**. The file downloads locally. If the
browser does not start it, tap **Save prepared report**. Browsers supporting file
sharing also offer **Share or save report…**. The user decides whether and where
to share it. There is no telemetry or automatic transmission. Reset/reload
discards history and the prepared file, including a reset using the same seed.

The report contains **full-world information hidden from individual factions**.
It never enters a faction inspector. It is not a save or deterministic replay;
there is no import command.

## Schema version 1

The filename identifies the build and simulation step. Files are UTF-8 JSON,
compressed to `.json.gz` with the browser's `CompressionStream` when available
and smaller. Missing/failed compression falls back to `.json`.

| Field | Meaning |
| --- | --- |
| `format`, `schemaVersion` | `littleworld-diagnostic`, `1`. |
| `build` | Version and exact deployed Git commit. Source previews say `development`. |
| `capturedAt`, `world` | UTC export time, seed, terrain seed, generation, configuration, pulse `step`, integer cycle `tick`, simulation seconds `time`. |
| `settings` | Applied speed/pause, quality, perspective, overlays and selection. Unsaved form edits are excluded. |
| `snapshot.factions` | Native identities, effective controller, economy, planner intent/target, shared operation, relations and departure commitments. Commitments are reported orders, not surviving field strength. |
| `snapshot.settlements` | Native/controller IDs, population/home counts, health, workforce, stocks/production/consumption, shortages, readiness/reserve, last mobilization, production rally and training. |
| `snapshot.groups` | Stable group/origin/target IDs, native/controller IDs, mission/phase/reason, tactical assessment, positions/goals, next route waypoint/index/length/reachability, stuck/progress/retry state, headcounts, soldier IDs, provisions and cargo. Worker health is surviving count × 32 minus wounds. |
| `snapshot.soldiers` | Canonical native-home rosters, including deployed troops: identity, native/effective command, group/tower, position, HP, status, withdrawal, target, weapon clock and individual order. Dead/non-serving records retain their status; not every record is fit. |
| `snapshot.nodes`, `buildings` | Physical resource amounts/claims, structures, ownership, construction, HP and tower staffing. |
| `snapshot.knowledge` | Delivered reports with observation/report times and confidence; visible IDs at the recorded visibility update step. Old reports are not current sight. No visibility grids or nested render projections. |
| `snapshot.resourceLedger`, `outcome`, `totals` | Recorded conservation accounts, world result and source collection counts. |
| `history` | Chronological sampled decisions, movement, existing chronicle events, settings, performance and redacted errors, with simulation stamp, elapsed tab `wallMs`, kind and structured data. |
| `truncation` | Omitted rows, evicted history, source-chronicle gaps, string limit. Missing records must not be interpreted as zero. |
| `recorder` | Sample count, cumulative/max sample CPU ms, retained count/UTF-8 bytes and synchronous snapshot capture ms. |

History copies existing target, retreat, defender interruption, wall-route,
rally, supply-limit, economy and failed-route reasons. It does not instrument
every attempted action or weapon strike. Changes that start and finish between
samples may be absent. No RNG state is advanced or order issued. A synchronous
read-only snapshot is copied at a completed JavaScript simulation boundary before
compression yields; later simulation changes cannot alter that copy.

## Bounds and performance

- Sampling: at most once per **2 wall seconds**, only while rendered frames run;
  movement at most once per **10 wall seconds**. Paused worlds record bounded
  performance/settings without rescanning unchanged decisions. Settings changes
  are also captured through the existing UI refresh.
- History: at most **768 records / 512 KiB UTF-8 record payloads**. Strings clip
  at 256 characters. Entity signatures are capped at 12 factions, 48 settlements
  and 480 groups. No live simulation object references are retained.
- Snapshot: **3 MiB row budget**, final uncompressed file **4 MiB hard limit**.
  Additional caps: 2,048 buildings, 6,000 soldier records, 256 nodes, 256 reports
  per faction, 16 newest observations per group, 1,000 soldier IDs per group,
  512 visibility IDs per faction. Omissions are explicit.
- Soldier rosters, knowledge and full snapshots are read only on export. No
  per-soldier per-frame scan, snapshot serialization or compression is added to
  simulation stepping. Only the latest prepared download is retained; a new
  export/reset revokes the preceding object URL.
- Performance describes this browser and its current quality/speed. CPU render
  submission is not GPU time. Errors retain category, standard class and
  line/column only: no message, stack, URL, cookies, storage, user-agent, arbitrary
  rejection payload or unrelated page data.

`node tests/debug-report-benchmark.mjs` measures one six-faction world naturally
evolved 200 cycles, then forty forced diagnostic samples. Its receipt goes to
ignored `screenshots/debug-report/benchmark.json`. Browser acceptance downloads
and parses gzip and plain JSON, including a touch-emulated mobile save link,
checks the exact build and unchanged simulation, and rejects export HTTP
requests. These are cloud checks, not physical-device certification.
