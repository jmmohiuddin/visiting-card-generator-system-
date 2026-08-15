/* Re-vendor the OFL font binaries the print writer outlines from.
 *
 *   node lib/pdf/vendor-fonts.mjs assets/fonts
 *
 * The faces are checked into this repository rather than fetched at render
 * time on purpose. A press file is built from whatever binary is on disk, and
 * a binary that arrives over the network at render time is a binary nobody
 * reviewed: Google can reissue a family, the metrics shift by a hair, and the
 * cards printed on Tuesday stop matching the cards printed on Monday. Pinning
 * them here is what makes "the same spec yields the same bytes" true across
 * machines as well as across runs.
 *
 * Only the weights the engine can actually ask for are fetched — 400, plus
 * each type system's `weightName`, plus the 700 and 800 the mark and ghost
 * monograms use. A family that does not publish a weight is simply absent,
 * and `lib/pdf/fonts.mjs` resolves the request to the nearest published one
 * exactly as a browser would.
 */
import fs from 'node:fs';
import path from 'node:path';

const OUT = process.argv[2];
if (!OUT) { console.error('usage: node lib/pdf/vendor-fonts.mjs <dir>'); process.exit(1); }
fs.mkdirSync(OUT, { recursive: true });

/* Google's CSS API serves WOFF2 to a modern user agent, EOT to an ancient
   one, and plain TrueType to a bare `Mozilla/5.0`. TrueType is the only one
   of the three this reader can walk, so the bare string is deliberate. */
const UA = 'Mozilla/5.0';
const WEIGHTS = [400, 600, 700, 800];

const FAMILIES = [
  { family: 'Archivo',           dir: 'archivo',         subset: 'latin,latin-ext' },
  { family: 'Libre Franklin',    dir: 'librefranklin',   subset: 'latin,latin-ext' },
  { family: 'Playfair Display',  dir: 'playfairdisplay', subset: 'latin,latin-ext' },
  { family: 'IBM Plex Mono',     dir: 'ibmplexmono',     subset: 'latin,latin-ext' },
  { family: 'Hind Siliguri',     dir: 'hindsiliguri',    subset: 'bengali,latin,latin-ext' },
  { family: 'Noto Sans Bengali', dir: 'notosansbengali', subset: 'bengali,latin,latin-ext' },
  { family: 'Tiro Bangla',       dir: 'tirobangla',      subset: 'bengali,latin,latin-ext' },
  { family: 'Baloo Da 2',        dir: 'balooda2',        subset: 'bengali,latin,latin-ext' }
];

const slug = f => f.toLowerCase().replace(/[^a-z0-9]+/g, '-');
const get = (url) => fetch(url, { headers: { 'user-agent': UA } });

let missing = 0;

for (const F of FAMILIES) {
  for (const w of WEIGHTS) {
    const css = await get(`https://fonts.googleapis.com/css?family=${encodeURIComponent(F.family).replace(/%20/g, '+')}:${w}&subset=${F.subset}`);
    if (css.status !== 200) { console.log(`  ${F.family} ${w}: not published`); continue; }
    const m = /url\((https:\/\/[^)]+\.ttf)\)/.exec(await css.text());
    if (!m) { console.log(`  ${F.family} ${w}: no TrueType instance`); continue; }

    const buf = Buffer.from(await (await get(m[1])).arrayBuffer());
    if (buf.readUInt32BE(0) !== 0x00010000 && buf.subarray(0, 4).toString('latin1') !== 'true') {
      console.log(`  !! ${F.family} ${w}: response is not TrueType`); missing++; continue;
    }
    const file = `${slug(F.family)}-${w}.ttf`;
    fs.writeFileSync(path.join(OUT, file), buf);
    console.log(`  ${F.family} ${w} → ${file} (${buf.length} B)`);
  }

  /* The OFL requires its own text to travel with the binary. A face vendored
     without its licence is a face we are not allowed to ship. */
  const ofl = await get(`https://raw.githubusercontent.com/google/fonts/main/ofl/${F.dir}/OFL.txt`);
  if (ofl.status === 200) fs.writeFileSync(path.join(OUT, `${slug(F.family)}.OFL.txt`), await ofl.text());
  else { console.log(`  !! ${F.family}: OFL.txt not found at ofl/${F.dir}`); missing++; }
}

if (missing) { console.error(`\n${missing} item(s) could not be vendored — do not ship this state.`); process.exit(1); }
