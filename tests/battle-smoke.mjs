import assert from 'node:assert/strict';

// This runs inside the existing strict browser session on both the built
// artifact and Pages. The longer seeded audit and videos remain separate.
export async function battleSmoke({ page, check, screenshotPath }) {
  const rendered = async () => {
    const frame = await page.evaluate(() => littleworldBattle.renderer.info.render.frame);
    await page.waitForFunction(frame => littleworldBattle.renderer.info.render.frame >= frame + 2, frame);
  };
  await check('Battle sandbox opens from the civilisation mode', async () => {
    await page.locator('a.battle-mode-link').click();
    await page.waitForFunction(() => window.littleworldBattle?.state?.units?.length > 0);
    assert.match(new URL(page.url()).pathname, /\/battle\.html$/);
    await rendered();
    const facts = await page.evaluate(() => {
      const w = littleworldBattle;
      return { count: w.state.units.length, ids: w.state.units.map(u => u.id), teams: w.state.units.map(u => u.team), roles: [...new Set(w.state.units.map(u => u.role))], paused: w.view.paused, contextLost: w.renderer.getContext().isContextLost() };
    });
    assert.equal(facts.count, 48); assert.equal(new Set(facts.ids).size, 48);
    assert.equal(facts.teams.filter(t => t === 'blue').length, 24); assert.equal(facts.teams.filter(t => t === 'red').length, 24);
    assert.deepEqual(facts.roles.sort(), ['infantry', 'ranged', 'scout']); assert.equal(facts.paused, true); assert.equal(facts.contextLost, false);
    return { people: facts.count, roles: facts.roles };
  });
  await check('Actual soldier canvas picking opens individual health and identity', async () => {
    const point = await page.evaluate(() => {
      const w = littleworldBattle;
      return w.state.units.map(u => ({ id: u.id, ...w.projectUnit(u.id) })).find(p => p.visible !== false && p.x > 10 && p.y > 10 && p.x < innerWidth - 10 && p.y < innerHeight - 10 && document.elementFromPoint(p.x, p.y)?.tagName === 'CANVAS');
    });
    assert.ok(point, 'No exposed individual soldier to pick');
    await page.mouse.click(point.x, point.y); await rendered();
    assert.equal(await page.locator('#unit-inspector').getAttribute('data-selected-id'), point.id);
    assert.match(await page.locator('#unit-inspector').innerText(), /health|hp/i);
    return { selected: point.id };
  });
  await check('Battle faction view does not expose unseen enemy soldiers', async () => {
    await page.locator('#battle-perspective').selectOption('blue'); await rendered();
    const seen = await page.evaluate(() => littleworldBattle.shownState.units.map(u => ({ id: u.id, team: u.team })));
    assert.equal(seen.filter(u => u.team === 'blue').length, 24);
    assert.equal(seen.filter(u => u.team === 'red').length, 0);
    await page.locator('#battle-perspective').selectOption('all'); await rendered();
    return { own: 24, hiddenEnemiesExposed: 0 };
  });
  await check('Battle start and pause use the real simulation clock', async () => {
    const before = await page.evaluate(() => littleworldBattle.state.time);
    await page.locator('#battle-pause').click();
    await page.waitForFunction(t => littleworldBattle.state.time > t, before);
    await page.locator('#battle-pause').click(); await rendered();
    const paused = await page.evaluate(() => ({ time: littleworldBattle.state.time, paused: littleworldBattle.view.paused }));
    assert.ok(paused.paused && paused.time > before); await rendered();
    assert.equal(await page.evaluate(() => littleworldBattle.state.time), paused.time);
    return paused;
  });
  await check('Natural battle produces damage to named hostile soldiers', async () => {
    await page.locator('#battle-seed').fill('crossing');
    await page.locator('#battle-size').selectOption('24');
    await page.locator('#battle-reset').click();
    const facts = await page.evaluate(() => {
      const w = littleworldBattle, initialIds = w.state.units.map(u => u.id);
      let pulses = 0;
      while (pulses < 1000 && !w.state.events.some(e => e.type === 'impact' && e.damage > 0)) { w.stepPulses(10); pulses += 10; }
      const impacts = w.state.events.filter(e => e.type === 'impact' && e.damage > 0);
      return { pulses, initialIds, units: w.state.units.map(u => ({ id: u.id, team: u.team, hp: u.hp, maxHp: u.maxHp, alive: u.alive })), impacts };
    });
    assert.ok(facts.impacts.length, 'No actual hit in the bounded ordinary seeded battle');
    assert.deepEqual(facts.units.map(u => u.id), facts.initialIds, 'Soldier identities changed');
    for (const e of facts.impacts) {
      const source = facts.units.find(u => u.id === e.sourceId), target = facts.units.find(u => u.id === e.targetId);
      assert.ok(source && target, 'Impact lacks real soldier identities'); assert.notEqual(source.team, target.team);
      assert.ok(target.hp < target.maxHp, 'Named hit did not damage its soldier');
    }
    assert.ok(facts.units.every(u => u.hp >= 0 && u.hp <= u.maxHp && u.alive === (u.hp > 0)));
    await rendered();
    return { pulses: facts.pulses, impacts: facts.impacts.length, damaged: facts.units.filter(u => u.hp < u.maxHp).map(u => ({ id: u.id, hp: u.hp })) };
  });
  await page.screenshot({ path: screenshotPath });
  await check('Battle setup preserves edited seed and army size through reset', async () => {
    await page.locator('#battle-seed').fill('redoubt');
    await page.locator('#battle-size').selectOption('48');
    await rendered();
    await page.locator('#battle-reset').click(); await rendered();
    const setup = await page.evaluate(() => ({ seed: littleworldBattle.state.seed, units: littleworldBattle.state.units.length, paused: littleworldBattle.view.paused }));
    assert.deepEqual(setup, { seed: 'redoubt', units: 96, paused: true });
    return setup;
  });
}
