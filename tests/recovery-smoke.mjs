import assert from 'node:assert/strict';
import { waitForRenderedFrames } from './browser-v2.mjs';

// Controlled treatment fixture in the already-open real WebGL app. Natural
// pacing and campaign outcomes are measured separately; no extra browser boot.
export async function recoverySmoke({ page, check, screenshotPath }) {
  await check('Home recovery is visible and returns the same paid veteran to duty', async () => {
    const result = await page.evaluate(async () => {
      const root = new URL('./src/', location.href).href;
      const [military, soldiers, economy] = await Promise.all([
        import(`${root}sim/military.js`), import(`${root}sim/soldiers.js`), import(`${root}sim/economy.js`),
      ]);
      const w = littleworld, s = w.state, home = s.settlements[0], body = soldiers.getSoldiers(s, home)[0];
      Object.assign(s, { tick: 100, time: 100, step: 1000 });
      home.stock = Object.fromEntries(economy.RESOURCES.map(key => [key, 1000]));
      economy.initializeLedger(s);
      Object.assign(body, { x: home.x, z: home.z, positioned: true, withdrawing: true });
      soldiers.applySoldierDamage(s, body, body.maxHp * .8);
      const before = { id: body.id, hp: body.hp, population: home.population, soldiers: home.soldiers, readyAt: body.attackReadyAt, x: body.x, z: body.z };
      for (let i = 0; i < 36; i++) { s.tick++; s.time++; s.step += 10; military.recoverMilitary(s, home); }
      w.select(home.id);
      return { before, after: { id: body.id, hp: body.hp, maxHp: body.maxHp, withdrawing: body.withdrawing, population: home.population,
        soldiers: home.soldiers, readyAt: body.attackReadyAt, x: body.x, z: body.z }, report: home.militaryRecovery,
        residual: economy.ledgerResidual(s), consumed: Object.fromEntries(economy.RESOURCES.map(key => [key, s.resourceLedger[key].consumed])) };
    });
    assert.equal(result.after.id, result.before.id); assert.ok(result.after.hp >= result.after.maxHp * .75);
    assert.equal(result.after.withdrawing, false); assert.equal(result.after.population, result.before.population);
    assert.equal(result.after.soldiers, result.before.soldiers); assert.equal(result.after.readyAt, result.before.readyAt);
    assert.equal(result.after.x, result.before.x); assert.equal(result.after.z, result.before.z);
    assert.ok(Object.values(result.consumed).some(value => value > 0));
    assert.ok(Object.values(result.residual).every(value => Math.abs(value) < 1e-7));
    await waitForRenderedFrames(page, { minimumFrames: 2, maximumMs: 15000 });
    assert.match(await page.locator('.military-recovery').innerText(), /received paid treatment.*75% health/);
    await page.locator('.military-recovery').scrollIntoViewIfNeeded();
    const bounds = await page.locator('.military-recovery').boundingBox();
    assert.ok(bounds && bounds.y >= 0 && bounds.y + bounds.height < 800, 'Recovery explanation is outside the inspector viewport');
    await page.screenshot({ path: screenshotPath });
    return result;
  });
}
