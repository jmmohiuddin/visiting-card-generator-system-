/* Area and perimeter of a drawn path.
 *
 * A finish plate is choked by stroking its own outline at zero tint, which is
 * geometrically exact but has a consequence somebody has to be told about: a
 * 0.3mm choke removes 0.6mm from the width of every stem, and a monogram set
 * at 5mm has stems around 0.7mm. The plate survives or it does not, and the
 * only way to know which is to measure it. Area minus perimeter × choke is
 * that measurement, to first order, and first order is enough to tell a plate
 * that lost a fifth of itself from one that lost nearly all of it.
 */

/* Curves are flattened to eight chords each. The error at that subdivision is
   under a micrometre on a glyph this size, which is three orders of magnitude
   below the number this feeds. */
const STEPS = 8;

const cubic = (t, a, b, c, d) => {
  const u = 1 - t;
  return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
};

/** Signed area (shoelace) and perimeter of a path in `Content` operator form,
 *  as `lib/pdf/text.mjs` emits it. Area is returned unsigned and summed over
 *  contours with their winding respected, so counters subtract. */
export function pathMetrics(ops) {
  let area = 0, perimeter = 0;
  let sx = 0, sy = 0, cx = 0, cy = 0;

  const seg = (x, y) => {
    area += cx * y - x * cy;
    perimeter += Math.hypot(x - cx, y - cy);
    cx = x; cy = y;
  };

  for (const op of ops) {
    if (op[0] === 'm') { sx = cx = op[1]; sy = cy = op[2]; }
    else if (op[0] === 'l') seg(op[1], op[2]);
    else if (op[0] === 'c') {
      const [, x1, y1, x2, y2, x3, y3] = op;
      const p0x = cx, p0y = cy;
      for (let i = 1; i <= STEPS; i++) {
        const t = i / STEPS;
        seg(cubic(t, p0x, x1, x2, x3), cubic(t, p0y, y1, y2, y3));
      }
    }
    else if (op[0] === 'h') seg(sx, sy);
  }
  return { area: Math.abs(area / 2), perimeter };
}
