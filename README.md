# LittleWorld

A browser-based observer simulation of human settlers, scavenger machines and alien hives sharing a procedurally seeded miniature world. Six factions begin with different personalities and constraints. Watch work parties extract and carry resources, settlements build and grow, scouts bring imperfect reports home, and societies trade, research or mobilize.

Built with vanilla JavaScript and Three.js 0.160.1. All geometry is procedural. Simulation advances in deterministic 0.1-second pulses, independently of rendering; one neutral simulation cycle is ten pulses. The observer controls time and the camera, not faction orders.

## Run locally

Install Node.js 24 or later, then:

```sh
npm ci
npm start
```

Open **http://127.0.0.1:4174**. On Windows, double-click `Start-LittleWorld.cmd` to install dependencies if needed and open the local demo. It needs a browser with WebGL and hardware acceleration.

## Observe

- Drag to orbit, right-drag to pan and scroll to zoom.
- Click a settlement, moving party or resource site to inspect it.
- Pause with **Space**; **1–4** choose time speeds.
- **F** follows the selection, **C** toggles a cinematic camera, **H** opens the guide, **Escape** releases follow.
- Use overlays for territory, intelligence, routes and resources.
- **Developed world** advances the same simulation by 1,200 cycles. It does not inject a prebuilt population or free stock.
- Reset with any seed to begin another reproducible world.

The live scale display distinguishes actual population, represented individuals and bodies inside the camera frustum. Zooming changes visibility, not population. Resource inspection exposes depletion, visiting teams and the conservation ledger. Colony panels expose construction and the people allocated to work, research and military service.

## Build and deploy

```sh
npm test
npm run build
```

The self-contained static output is `dist/`. Three.js modules are copied there with their license; all application paths are relative, including project subpaths on GitHub Pages. `.github/workflows/pages.yml` tests, builds and deploys every push to `main`. Configure the repository's Pages source as **GitHub Actions**.

## Model boundaries

This is a tech demo, not a historical or economic prediction. Individuals are visible bodies, while strategic decisions and logistics operate through settlements, work parties, scouts and squads. Research follows differentiated trees with paid investment and prerequisites. Combat uses group strength, terrain, morale, supplies and reported intelligence; individual weapon hits are not simulated. Home activity is representative animation, while deployed teams follow simulation positions. Population and group caps keep the browser workload bounded. No save/load or direct faction control is included yet.

## Source map

- `src/sim/core.js`, `economy.js`: physical gathering, stores, population, paid construction and founding.
- `src/sim/strategy.js`: scouts, intelligence, expeditions, logistics and conflict.
- `src/sim/progression.js`: personalities, technology and trade.
- `src/world.js`, `src/render/`: terrain, resources, architecture and instanced bodies.
- `src/main.js`, `clock.js`, `ui.js`: fixed-step integration, camera and observer interface.

Runtime dependencies: [Three.js](https://threejs.org/) (MIT). Playwright is used only for local browser verification.
