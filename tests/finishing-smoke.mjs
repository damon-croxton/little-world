import assert from 'node:assert/strict';
import { waitForRenderedFrames } from './browser-v2.mjs';

export async function finishingSmoke({ page, check, screenshotBefore, screenshotAfter }) {
  await check('A contacted undefended town is physically destroyed despite nearby incidental workers', async () => {
    await page.evaluate(async () => {
      const root = new URL('./src/', location.href).href;
      const military = await import(`${root}sim/military.js`), economy = await import(`${root}sim/economy.js`), strategy = await import(`${root}sim/strategy.js`);
      const w = littleworld, s = w.state, [home, target, third] = s.settlements, centre = s.terrain.districts.find(d => d.kind === 'expansion');
      Object.assign(s, { tick: 400, time: 400, step: 4000, groups: [], nodes: [], events: [], pendingCombat: [], combatEvents: [] });
      for (const h of s.settlements) { h.buildings = []; military.initializeMilitary(h, { infantry: 0, ranged: 0 }, { state: s }); }
      for (const f of s.factions) { f.knowledge = {}; f.campaignOrders = {}; f.strategy = null; }
      Object.assign(home, { x: centre.x - 35, z: centre.z });
      Object.assign(target, { x: centre.x, z: centre.z, health: 10, status: 'active', razed: false });
      target.buildings = [{ id: 'qa-finish-hub', kind: 'hub', x: target.x, z: target.z, rotation: 0, progress: 1, hp: 160, maxHp: 160 }];
      military.initializeMilitary(home, { infantry: 24, ranged: 0 }, { state: s });
      const g = { id: 'qa-finisher', kind: 'army', factionId: home.factionId, originId: home.id, units: { infantry: 24, ranged: 0 }, size: 24, initialSize: 24,
        x: target.x, z: target.z, prevX: target.x, prevZ: target.z, targetId: target.id, targetX: target.x, targetZ: target.z, missionTargetX: target.x, missionTargetZ: target.z,
        phase: 'engaging', campaign: true, supply: 100, morale: 95, speed: 2.9, createdTick: 400, observations: [], carrying: economy.emptyResources() };
      military.deployMilitary(s, home, g); s.groups.push(g);
      for (const [i, body] of military.getSoldiers(s, g).entries()) Object.assign(body, { positioned: true, x: target.x + (i % 6 - 2.5) * .7, z: target.z + (Math.floor(i / 6) - 1.5) * .7, prevX: target.x, prevZ: target.z });
      s.groups.push({ id: 'qa-incidental-labor', kind: 'worker', factionId: third.factionId, originId: third.id, size: 12, initialSize: 12,
        x: target.x + 12, z: target.z, prevX: target.x + 12, prevZ: target.z, phase: 'working', supply: 100, morale: 90, capacity: 72, carrying: economy.emptyResources() });
      const refreshCensus = () => { for (const f of s.factions) {
        const homes = s.settlements.filter(h => h.factionId === f.id);
        Object.assign(f.economy, { population: homes.reduce((n, h) => n + h.population, 0), workers: homes.reduce((n, h) => n + h.workers, 0), soldiers: homes.reduce((n, h) => n + h.soldiers, 0) });
      } };
      refreshCensus(); economy.initializeLedger(s); w.actions.setPerspective('omniscient'); w.actions.follow(g.id);
      window.finishingFixture = { target, g, strategy, economy, refreshCensus, population: target.population };
    });
    await page.waitForFunction(() => littleworld.getMotionSamples().some(p => p.groupId === 'qa-finisher' && p.visible));
    await waitForRenderedFrames(page, { minimumFrames: 3 });
    await page.screenshot({ path: screenshotBefore });
    const after = await page.evaluate(() => {
      const s = littleworld.state, q = window.finishingFixture;
      for (let i = 0; i < 30; i++) {
        s.step++; s.time = s.step / 10; s.tick = Math.floor(s.time);
        for (const f of s.factions) { f.lastScout = s.tick; f.lastArmy = s.tick; }
        q.strategy.stepStrategy(s, .1);
      }
      q.refreshCensus();
      return { health: q.target.health, razed: q.target.razed, hubDestroyed: q.target.buildings[0].destroyed, population: q.target.population,
        priorPopulation: q.population, armySize: q.g.size, supply: q.g.supply, residual: q.economy.ledgerResidual(s), scope: 'Controlled physical contact fixture; no claim of exact user-log replay or natural balance.' };
    });
    assert.equal(after.health, 0); assert.equal(after.razed, true); assert.equal(after.hubDestroyed, true);
    assert.equal(after.population, after.priorPopulation); assert.equal(after.armySize, 24); assert.ok(after.supply < 100);
    assert.ok(Object.values(after.residual).every(value => Math.abs(value) < 1e-7));
    await waitForRenderedFrames(page, { minimumFrames: 3 });
    await page.screenshot({ path: screenshotAfter });
    await page.evaluate(() => { delete window.finishingFixture; });
    return after;
  });
}
