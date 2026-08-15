/* The composed card, painted into a content stream.
 *
 * This is the print-side twin of the engine's `renderSVG`: it switches on the
 * same generic `slot.kind`, never on a layout id, so adding a thirteenth
 * layout stays a library edit on both sides. Where it diverges from the SVG
 * it diverges deliberately, and each of those places says why — the bleed
 * extension, the flattened overlays, and the die-cut corner are all things a
 * screen does not need and a press cannot do without.
 */
import { toCmyk, flatten } from './cmyk.mjs';
import { drawRun, measureRun } from './text.mjs';
import { refuse } from './refusal.mjs';

const PT = 0.352778;                          // 1pt in mm, as the engine defines it

/** The ground a given box actually sits on — the innermost panel that
 *  contains it, or the card background. Mirrors preflight's `groundOf`,
 *  because a flattened overlay has to be composited against the same colour
 *  preflight measured contrast against. */
function groundHex(c, geom) {
  const panels = c.elements.filter(e => e.kind === 'panel');
  const inside = panels.filter(p =>
    geom.x >= p.geom.x - 0.01 && geom.y >= p.geom.y - 0.01 &&
    geom.x + geom.w <= p.geom.x + p.geom.w + 0.01 && geom.y + geom.h <= p.geom.y + p.geom.h + 0.01);
  return inside.length ? (c.pal[inside[inside.length - 1].color] || c.pal.bg) : c.pal.bg;
}

/* A ground drawn to the trim edge prints as a white frame once the sheet is
   cut, because the guillotine never lands exactly on the line. Anything that
   is meant to reach an edge is therefore pushed out to the bleed box here.
   The engine's `printDocSVG` does not do this — it centres trim-sized artwork
   in a bleed-sized page — which is fine for a proof and wrong for a plate. */
function bled(geom, fmt) {
  const b = fmt.bleed, t = 0.01;
  const x0 = geom.x <= t ? -b : geom.x;
  const y0 = geom.y <= t ? -b : geom.y;
  const x1 = geom.x + geom.w >= fmt.w - t ? fmt.w + b : geom.x + geom.w;
  const y1 = geom.y + geom.h >= fmt.h - t ? fmt.h + b : geom.y + geom.h;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Paint the card. Returns what the caller needs to check the file it is
 *  about to hand a customer: every colour that was actually laid down, and
 *  the extent of every run as the real face measured it. */
export function paintCard(content, c, { gridFor }) {
  const { fmt, pal } = c;
  const colours = [];
  const extents = [];
  const ink = (hex, ref) => { colours.push({ hex, ref }); return toCmyk(hex); };
  const col = k => pal[k] || k;

  content.fillCmyk(ink(pal.bg, 'background')).rect(-fmt.bleed, -fmt.bleed,
    fmt.w + 2 * fmt.bleed, fmt.h + 2 * fmt.bleed).fill();

  for (const el of c.elements) {
    const g = el.geom;
    const hex = col(el.color);

    switch (el.kind) {
      case 'panel': {
        const b = bled(g, fmt);
        content.fillCmyk(ink(hex, el.ref || 'panel')).rect(b.x, b.y, b.w, b.h).fill();
        break;
      }

      case 'rule':
        content.fillCmyk(ink(hex, el.ref || 'rule')).rect(g.x, g.y, g.w, Math.max(g.h, 0.18)).fill();
        break;

      /* The SVG draws gridlines at 55% and the ghost monogram at 14% opacity.
         Both sit on one flat ground, so the composite is computed against
         that ground and laid down opaque — the file then contains no
         transparency at all, which is a stronger promise to a RIP than a
         transparency group it is free to flatten its own way. */
      case 'gridlines': {
        const flat = flatten(hex, 0.55, groundHex(c, g));
        content.strokeCmyk(ink(flat, 'gridlines')).lineWidth(0.08);
        const { cols, rows } = gridFor(fmt);
        for (let i = 1; i < cols; i++) {
          const x = i * fmt.w / cols;
          content.moveTo(x, -fmt.bleed).lineTo(x, fmt.h + fmt.bleed);
        }
        for (let j = 1; j < rows; j++) {
          const y = j * fmt.h / rows;
          content.moveTo(-fmt.bleed, y).lineTo(fmt.w + fmt.bleed, y);
        }
        content.stroke();
        break;
      }

      case 'ghost': {
        const flat = flatten(hex, 0.14, groundHex(c, g));
        centredGlyph(content, c, el.glyph || 'N', {
          cssStack: c.type.latin, weight: 800, sizeMm: g.h,
          cx: g.x + g.w / 2, baseline: g.y + g.h * 0.86, cmyk: ink(flat, 'ghost')
        });
        break;
      }

      case 'mark': {
        if (el.logo) refuse('logo_not_supported',
          'This design carries an uploaded logo, and the print writer places only vector shapes it ' +
          'generated itself. Importing an SVG/EPS path or placing a raster at a verified 300 dpi in ' +
          'DeviceCMYK is not built yet, and a logo placed at the wrong resolution or in the wrong ' +
          'colour space is a defect the customer only sees on the printed card. Export the card ' +
          'without the logo, or supply the mark to the press separately, until that path exists.');
        content.strokeCmyk(ink(hex, 'mark')).lineWidth(0.5).rect(g.x, g.y, g.w, g.h).stroke();
        centredGlyph(content, c, el.glyph || 'N', {
          cssStack: c.type.latin, weight: 700, sizeMm: g.h * 0.58,
          cx: g.x + g.w / 2, baseline: g.y + g.h * 0.72, cmyk: toCmyk(hex)
        });
        extents.push({ ref: el.ref || 'mark', x: g.x, y: g.y, w: g.w, h: g.h });
        break;
      }

      case 'mono': case 'bigmono':
        centredGlyph(content, c, el.glyph || 'N', {
          cssStack: c.type.latin, weight: 700, sizeMm: g.h * 0.9,
          cx: g.x + g.w / 2, baseline: g.y + g.h * 0.80, cmyk: ink(hex, el.kind)
        });
        extents.push({ ref: el.ref || el.kind, x: g.x, y: g.y, w: g.w, h: g.h });
        break;

      case 'qr': {
        if (!el.qr) break;
        content.fillCmyk(ink(pal.bg, 'qr ground')).rect(g.x, g.y, g.w, g.h).fill();
        const n = el.qr.size, m = el.moduleMm, o = m * 4;   // the 4-module quiet zone is part of the symbol
        content.fillCmyk(ink(hex, 'qr'));
        for (let i = 0; i < n; i++) for (let j = 0; j < n; j++)
          if (el.qr.matrix[i][j]) content.rect(g.x + o + j * m, g.y + o + i * m, m, m);
        content.fill();
        extents.push({ ref: 'qr', x: g.x, y: g.y, w: g.w, h: g.h });
        break;
      }

      case 'text': case 'static': case 'contact': {
        const f = el.fit;
        if (!f) break;
        const sizeMm = f.sizePt * PT;
        const cmyk = ink(hex, el.ref || el.kind);
        f.lines.forEach((line, i) => {
          const w = measureRun(line, f.family, f.weight, f.track, sizeMm);
          const x = el.align === 'center' ? g.x + (g.w - w) / 2
                  : el.align === 'right' ? g.x + g.w - w
                  : g.x;
          const y = g.y + f.ascent + i * f.lineHeight;
          drawRun(content, line, { cssStack: f.family, weight: f.weight, sizeMm, trackEm: f.track, x, y, cmyk });
          extents.push({ ref: el.ref || el.kind, x, y: g.y + i * f.lineHeight, w, h: f.lineHeight, line });
        });
        break;
      }
    }
  }

  return { colours, extents };
}

/* Centred like the SVG's `text-anchor="middle"`, which means the run has to
   be measured before it can be placed. The extent this contributes is the
   slot box, not the glyph box: preflight compares marks and monograms by
   their reserved box (assets/engine.js `extentOf`), and a second, tighter
   rule here would fail cards that already passed for no reason a customer
   could see. */
function centredGlyph(content, c, glyph, o) {
  const w = measureRun(glyph, o.cssStack, o.weight, 0, o.sizeMm);
  drawRun(content, glyph, { cssStack: o.cssStack, weight: o.weight, sizeMm: o.sizeMm,
                            trackEm: 0, x: o.cx - w / 2, y: o.baseline, cmyk: o.cmyk });
}
