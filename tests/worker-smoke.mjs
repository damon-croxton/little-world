import assert from 'node:assert/strict';
import { waitForRenderedFrames } from './browser-v2.mjs';

// Deliberately arranged combat and render scenario, separate from the natural
// world/control checks. People come from the existing native home census.
export async function workerSmoke({ page, check, screenshotBefore, screenshotAfter }) {
  await check('Controlled worker raid visibly reduces a twelve-person badge and its real census', async () => {
    const before = await page.evaluate(async () => {
      const root = new URL('./src/', location.href).href;
      const [military, soldiers, economy, combat, civilians] = await Promise.all([
        import(`${root}sim/military.js`), import(`${root}sim/soldiers.js`), import(`${root}sim/economy.js`), import(`${root}sim/combat.js`), import(`${root}sim/civilians.js`),
      ]);
      const w = littleworld, s = w.state, [a, b] = s.factions, [ha, hb] = s.settlements;
      const center = s.terrain.districts.find(d => d.kind === 'expansion');
      s.groups = []; s.events = []; s.pendingCombat = []; s.combatEvents = [];
      for (const home of s.settlements) { home.buildings = []; military.initializeMilitary(home, undefined, { state: s }); }
      a.relations[b.id] = { status: 'hostile', trust: 0 }; b.relations[a.id] = { status: 'hostile', trust: 0 };
      const units = { infantry: 4, ranged: 2 };
      soldiers.createSoldierRecords(ha, units, { state: s, faction: a, source: 'controlled-browser-fixture', statsByRole: Object.fromEntries(['infantry', 'ranged'].map(role => [role, military.unitStats(a, role)])) });
      soldiers.syncSoldierCounts(s, ha);
      const raider = { id: 'qa-worker-raider', kind: 'army', factionId: a.id, originId: ha.id, ...center, x: center.x - 2, prevX: center.x - 2, prevZ: center.z,
        targetX: center.x + 12, targetZ: center.z, targetId: null, size: 6, initialSize: 6, units, speed: 2.8, morale: 100, supply: 100, phase: 'outbound', carrying: economy.emptyResources() };
      // The map district's kind/id are not a group's identity.
      raider.id = 'qa-worker-raider'; raider.kind = 'army';
      military.deployMilitary(s, ha, raider);
      for (const body of soldiers.getSoldiers(s, raider)) { body.x = raider.x; body.z = raider.z; body.prevX = body.x; body.prevZ = body.z; }
      const worker = { id: 'qa-worker-crew', kind: 'worker', factionId: b.id, originId: hb.id, size: 12, initialSize: 12, x: center.x + 2, z: center.z, prevX: center.x + 2, prevZ: center.z,
        phase: 'working', speed: 2.65, targetId: null, carrying: economy.emptyResources(), capacity: 72, cargoCapacity: 72, supply: 100, morale: 100 };
      s.groups.push(raider, worker); economy.initializeLedger(s); combat.initializeSoldierPositions(s);
      const refreshCensus = () => { for (const faction of s.factions) {
        const homes = s.settlements.filter(h => h.factionId === faction.id);
        Object.assign(faction.economy, { population: homes.reduce((n, h) => n + h.population, 0), workers: homes.reduce((n, h) => n + h.workers, 0), soldiers: homes.reduce((n, h) => n + h.soldiers, 0) });
      } };
      refreshCensus();
      w.actions.setPerspective('omniscient'); w.actions.follow(worker.id);
      window.workerCombatFixture = { worker, raider, home: hb, combat, civilians, economy, refreshCensus, population: hb.population };
      return { population: hb.population, size: worker.size, health: civilians.civilianHealth(worker), source: 'Controlled stationary crew; real military weapons and renderer. Not a natural match.' };
    });
    await page.waitForFunction(() => littleworld.getMotionSamples().some(p => p.groupId === 'qa-worker-crew' && p.visible && p.badgeText === '12×'));
    await waitForRenderedFrames(page, { minimumFrames: 3 });
    await page.screenshot({ path: screenshotBefore });
    const after = await page.evaluate(() => {
      const w = littleworld, s = w.state, q = window.workerCombatFixture;
      let pulses = 0;
      while (q.worker.size === 12 && pulses < 100) {
        s.step++; s.time = s.step / 10; s.tick = Math.floor(s.time); q.combat.stepCombat(s, .1); pulses++;
      }
      q.refreshCensus(); w.select(q.worker.id);
      return { size: q.worker.size, health: q.civilians.civilianHealth(q.worker), population: q.home.population, pulses,
        residual: q.economy.ledgerResidual(s), hits: s.combatEvents.filter(e => e.targetId === q.worker.id && e.type === 'impact').map(e => ({ damage: e.damage, deaths: e.deaths, sourceSoldierId: e.sourceSoldierId })),
        military: q.raider.size, workerCombatDeaths: s.stats.workerCombatDeaths, phase: q.worker.phase };
    });
    assert.ok(after.size > 0 && after.size < 12); assert.equal(before.population - after.population, 12 - after.size);
    assert.equal(after.workerCombatDeaths, 12 - after.size); assert.equal(after.phase, 'returning');
    assert.ok(after.hits.every(hit => hit.damage > 0 && hit.sourceSoldierId));
    assert.ok(Object.values(after.residual).every(value => Math.abs(value) < 1e-7));
    await page.waitForFunction(size => littleworld.getMotionSamples().some(p => p.groupId === 'qa-worker-crew' && p.visible && p.badgeText === `${size}×`), after.size);
    await waitForRenderedFrames(page, { minimumFrames: 2 });
    const rendered = await page.evaluate(() => {
      const w = littleworld, sample = w.getMotionSamples().find(p => p.groupId === 'qa-worker-crew'), d = w.diagnostics.crowds;
      return { badge: sample.badgeText, represented: sample.representedCount, drawnWorkerModels: d.drawnWorkerModels, military: d.militaryIndividuals, workerCrewCount: d.workerCrewCount, populationAccountingDelta: d.populationAccountingDelta };
    });
    assert.equal(rendered.badge, `${after.size}×`); assert.equal(rendered.represented, after.size); assert.equal(rendered.drawnWorkerModels, 1);
    assert.equal(rendered.military, 6); assert.equal(rendered.workerCrewCount, 1); assert.equal(rendered.populationAccountingDelta, 0);
    assert.match(await page.locator('.crew-health').innerText(), new RegExp(`${after.size} surviving workers`));
    await page.screenshot({ path: screenshotAfter });
    await page.evaluate(() => { delete window.workerCombatFixture; });
    return { before, after, rendered };
  });
}
