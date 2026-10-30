// CPU mirror of the shader's terrain and tree placement. It uses the same
// integer hash, so walking height and trunk collisions match the GPU world.

const World = (() => {
  const CELL = 9.0;
  const K = 1103515245;

  function ihash(x, y) {
    const qx = Math.imul(K, (x >>> 1) ^ y) >>> 0;
    const qy = Math.imul(K, (y >>> 1) ^ x) >>> 0;
    return Math.imul(K, qx ^ (qy >>> 3)) >>> 0;
  }
  function hashI(ix, iy) {
    return ihash((ix + 1048576) >>> 0, (iy + 1048576) >>> 0) / 4294967296;
  }
  function hashS(ix, iy, s) {
    const x = ((ix + 1048576) ^ Math.imul(s, 0x9E3779B9)) >>> 0;
    const y = ((iy + 1048576) ^ Math.imul(s, 0x85EBCA6B)) >>> 0;
    return ihash(x, y) / 4294967296;
  }
  // 256x256 lattice, 4 corners per texel; uploaded as the shader's uLattice.
  const lattice = new Float32Array(256 * 256 * 4);
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
    const i = (y * 256 + x) * 4;
    lattice[i] = hashI(x, y);
    lattice[i + 1] = hashI((x + 1) & 255, y);
    lattice[i + 2] = hashI(x, (y + 1) & 255);
    lattice[i + 3] = hashI((x + 1) & 255, (y + 1) & 255);
  }
  function noise2(px, py) {
    const fx = Math.floor(px), fy = Math.floor(py);
    const tx = px - fx, ty = py - fy;
    const ux = tx * tx * (3 - 2 * tx), uy = ty * ty * (3 - 2 * ty);
    const i = (((fy & 255) * 256) + (fx & 255)) * 4;
    const ab = lattice[i] + (lattice[i + 1] - lattice[i]) * ux;
    const cd = lattice[i + 2] + (lattice[i + 3] - lattice[i + 2]) * ux;
    return ab + (cd - ab) * uy;
  }
  function smoothstep(e0, e1, x) {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  }
  function pathX(z) { return 28 * Math.sin(z * 0.011) + 13 * Math.sin(z * 0.027 + 1.3); }

  function terrainH(x, z, oct) {
    let qx = x * 0.0028, qy = z * 0.0028;
    let a = 0, b = 0.5;
    for (let i = 0; i < oct; i++) {
      a += b * noise2(qx, qy);
      b *= 0.5;
      const nx = (0.8 * qx + 0.6 * qy) * 2.02;
      const ny = (-0.6 * qx + 0.8 * qy) * 2.02;
      qx = nx; qy = ny;
    }
    let h = (a - 0.45) * 85;
    h -= 0.35 * smoothstep(3.0, 0.5, Math.abs(x - pathX(z)));
    return h;
  }

  function getTree(cx, cz, density) {
    const h1 = hashS(cx, cz, 1), h2 = hashS(cx, cz, 2), h3 = hashS(cx, cz, 3), h4 = hashS(cx, cz, 4), h5 = hashS(cx, cz, 5);
    const x = (cx + 0.5 + (h2 - 0.5) * 0.22) * CELL;
    const z = (cz + 0.5 + (h3 - 0.5) * 0.22) * CELL;
    const dp = Math.abs(x - pathX(z));
    const type = h4 >= 0.62 ? 1 : 0;
    const h = type === 0 ? 10 + 9 * h5 : 8 + 5 * h5;
    if (dp > 6.5 && h1 < density) return { kind: 1, x, z, radius: 0.16 + h * 0.011 };
    if (dp > 2.8 && h4 < 0.28) return { kind: 2, x, z, radius: (0.5 + h5) * 1.2 };
    return { kind: 0 };
  }

  // Push a point out of tree trunks and rocks in the surrounding cells.
  function collide(pos, density, pad) {
    const cx = Math.floor(pos[0] / CELL), cz = Math.floor(pos[2] / CELL);
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const t = getTree(cx + dx, cz + dz, density);
      if (!t.kind) continue;
      const vx = pos[0] - t.x, vz = pos[2] - t.z;
      const d = Math.hypot(vx, vz);
      const min = t.radius + pad;
      if (d < min && d > 1e-4) {
        pos[0] = t.x + vx / d * min;
        pos[2] = t.z + vz / d * min;
      }
    }
  }

  return { CELL, lattice, pathX, terrainH, getTree, collide, smoothstep };
})();
