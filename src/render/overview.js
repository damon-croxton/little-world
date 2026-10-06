import { WORLD_RADIUS } from '../world.js';
// Fit the living island, not its decorative offshore islets. This pure helper
// uses the same perspective basis as the observer camera, with room for the
// coastline and tallest structures at every viewport aspect ratio.
export function overviewFrame(aspect = 1.6, fov = 40, radius = WORLD_RADIUS) {
  aspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1.6;
  const norm = Math.hypot(250, 255, 320), dx = 250 / norm, dy = 255 / norm, dz = 320 / norm;
  const horizontal = Math.hypot(dx, dz), hx = dx / horizontal, hz = dz / horizontal;
  // Looking slightly toward the near shore balances perspective foreshortening.
  const target = { x: hx * radius * .24, y: 4, z: hz * radius * .24 };
  const tangent = Math.tan(fov * Math.PI / 360);
  const fits = distance => {
    for (let i = 0; i < 128; i++) for (const height of [-4, 12]) {
      const a = i / 128 * Math.PI * 2, x = Math.cos(a) * radius - target.x, y = height - target.y, z = Math.sin(a) * radius - target.z;
      const depth = distance - (x * dx + y * dy + z * dz);
      if (depth <= 0) return false;
      const screenX = (x * hz - z * hx) / (depth * tangent * aspect);
      const screenY = (-x * dy * hx + y * horizontal - z * dy * hz) / (depth * tangent);
      if (Math.abs(screenX) > .92 || screenY < -.80 || screenY > .74) return false;
    }
    return true;
  };
  let lo = radius, hi = radius * 2;
  while (!fits(hi)) hi *= 2;
  for (let i = 0; i < 32; i++) { const mid = (lo + hi) / 2; if (fits(mid)) hi = mid; else lo = mid; }
  return { target, position: { x: target.x + dx * hi, y: target.y + dy * hi, z: target.z + dz * hi }, distance: hi };
}
