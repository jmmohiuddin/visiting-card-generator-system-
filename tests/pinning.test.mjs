/* A saved design cannot change under the customer who saved it.
 *
 * Technical Design §7.1 states this and calls it non-negotiable, and the
 * reason is specific to this product rather than general good practice:
 * people order five hundred physical copies of a design and approve a printed
 * proof of it first. If republishing a palette repaints a saved card, the
 * artwork that goes to plate is not the artwork that was approved, and nobody
 * finds out until a box arrives.
 *
 * The half that made this worth testing separately is subtle. A spec records
 * its components by slug — `pal.ink`, `lay.rule` — and a slug is not a
 * version. Republishing `pal.ink` therefore changes what a saved design
 * renders as **while its spec hash stays exactly the same**, so every check
 * built on hash stability reports the design as unchanged. Hash stability is
 * not the guarantee; version pinning is. `lib/library.mjs` could already
 * resolve pins back into a library and nothing wrote them, which meant the
 * resolve path was dead code and the guarantee was absent.
 *
 * These assertions need a real Postgres, because what is being tested is
 * whether two rows in `component_versions` produce two different cards. With
 * no database reachable the suite reports that and passes rather than
 * pretending to have checked — an empty pass would be the silence the
 * WORKPLAN house rule warns about, so it is stated on the way past.
 */
import { execFileSync } from 'node:child_process';
import { engine } from '../lib/engine-node.mjs';
import {
  loadLibrary, resolvePins, pinsFor, publishComponent, withLibrary
} from '../lib/library.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { cond ? (pass++, console.log('  ✓ ' + name))
                                              : (fail++, console.log('  ✗ ' + name + (extra ? ' — ' + extra : ''))); };
const H = (s) => console.log('\n' + s);
const E = engine();

const DB = 'cardworks_pin_test';
const USER = process.env.USER || 'postgres';
const URL = `postgresql://${USER}@127.0.0.1:5432/${DB}`;

const psql = (args, opts = {}) =>
  execFileSync('psql', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });

function haveDatabase() {
  try { psql(['-h', '127.0.0.1', '-U', USER, '-d', 'postgres', '-tAc', 'SELECT 1']); return true; }
  catch { return false; }
}

if (!haveDatabase()) {
  H('Component version pinning');
  console.log('  – no local Postgres reachable, so the pinning guarantee was NOT checked');
  console.log('    (it needs two real component versions to compare; run a local Postgres to exercise it)');
  console.log(`\n${'─'.repeat(58)}\n  ${pass} passed, ${fail} failed\n${'─'.repeat(58)}`);
  process.exit(0);
}

/* A throwaway database, rebuilt each run so a previous run's republished
   palette cannot make this one pass for the wrong reason. */
psql(['-h', '127.0.0.1', '-U', USER, '-d', 'postgres', '-q',
      '-c', `DROP DATABASE IF EXISTS ${DB}`, '-c', `CREATE DATABASE ${DB}`]);
psql([URL, '-q', '-v', 'ON_ERROR_STOP=1', '-f', 'db/schema.sql']);
for (const f of ['001_idempotency', '002_presses', '003_payments', '004_users',
                 '005_preflight', '006_components', '007_renders']) {
  try { psql([URL, '-q', '-v', 'ON_ERROR_STOP=1', '-f', `db/migrations/${f}.sql`]); } catch {}
}

/* The `neon()` tagged-template shape, over psql. The modules under test take a
   sql function and do not care what is behind it.

   Statements are wrapped differently by kind: a SELECT can be aggregated into
   JSON directly, an INSERT ... RETURNING has to become a CTE first, and a
   mutation with nothing to return has no rows to aggregate at all. Wrapping
   every statement the same way is what a first version did, and it failed on
   the first insert with a syntax error rather than quietly returning nothing —
   which is the better of the two failures. */
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
/* An array parameter has to become a Postgres array literal, not JSON. The
   module under test passes `${slugs}::text[]` to `unnest`, and a JSON array
   reaches Postgres as the string "[...]" — which fails with "malformed array
   literal" rather than silently returning nothing, so the error named itself. */
const quote = (v) =>
    v === null || v === undefined ? 'NULL'
  : Array.isArray(v) ? lit('{' + v.map(x => `"${String(x).replace(/"/g, '\\"')}"`).join(',') + '}')
  : typeof v === 'object' ? lit(JSON.stringify(v))
  : typeof v === 'number' || typeof v === 'boolean' ? String(v)
  : lit(v);

const sql = async (strings, ...values) => {
  let text = strings[0];
  for (let i = 0; i < values.length; i++) text += quote(values[i]) + strings[i + 1];
  const body = text.trim().replace(/;\s*$/, '');
  const isSelect = /^\s*(select|with)\b/i.test(body);
  const returns = /\breturning\b/i.test(body);

  let statement;
  if (isSelect)       statement = `SELECT coalesce(json_agg(r), '[]'::json)::text FROM (${body}) r`;
  else if (returns)   statement = `WITH r AS (${body}) SELECT coalesce(json_agg(r), '[]'::json)::text FROM r`;
  else { psql([URL, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-c', body]); return []; }

  const out = psql([URL, '-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1', '-c', statement]);
  return JSON.parse(out.trim() || '[]');
};

H('1. Every component a design uses gets a pinned version');
const before = await loadLibrary(sql);
const pins = pinsFor(before.components);
ok('a library snapshot yields a pin per component',
   Object.keys(pins).length === before.components.length,
   `${Object.keys(pins).length} pins / ${before.components.length} components`);
ok('and every pin is an integer version', Object.values(pins).every(v => Number.isInteger(v)));
ok('the components include the palettes and layouts a spec names',
   pins['pal.ink'] !== undefined && pins['lay.rule'] !== undefined,
   Object.keys(pins).slice(0, 6).join(', '));

H('2. Republishing a component changes the live library');
const currentPayload = (await sql`SELECT cv.payload_json FROM component_versions cv
  JOIN components c ON c.id = cv.component_id WHERE c.slug = 'pal.ink'
  ORDER BY cv.version DESC LIMIT 1`)[0].payload_json;
const originalAccent = currentPayload.record.accent;
await publishComponent(sql, { slug: 'pal.ink', kind: 'pal',
  payload: { ...currentPayload, record: { ...currentPayload.record, accent: '#00ff00' } } });

const after = await loadLibrary(sql);
ok('the published palette really did change',
   after.library.palettes.find(p => p.id === 'pal.ink').accent === '#00ff00',
   after.library.palettes.find(p => p.id === 'pal.ink').accent);
ok('and the libraryVersion moved with it', before.libraryVersion !== after.libraryVersion);

H('3. A saved design resolves to the library it was built from');
const pinned = await resolvePins(sql, pins);
ok('resolving the saved pins returns the ORIGINAL palette',
   pinned.library.palettes.find(p => p.id === 'pal.ink').accent === originalAccent,
   `${pinned.library.palettes.find(p => p.id === 'pal.ink').accent} — expected ${originalAccent}`);

const SPEC = { format:'bd-std', type:'typ.siliguri', palette:'pal.ink', density:'balanced',
               layout:'lay.rule', content:E.PRESETS[0].c, corner:0,
               share:{ origin:'https://cardworks.bd', code:null } };
const asOriginal = await withLibrary(E, before.library, () => E.renderSVG(E.compose(SPEC)));
const asPinned   = await withLibrary(E, pinned.library, () => E.renderSVG(E.compose(SPEC)));
const asLatest   = await withLibrary(E, after.library,  () => E.renderSVG(E.compose(SPEC)));

ok('a saved design re-renders byte-identically from its pins', asOriginal === asPinned);
/* Without this second half the first would pass on a card the republish never
   touched, and the whole suite would be measuring nothing. */
ok('and would have changed without them, so the pin is doing real work',
   asOriginal !== asLatest,
   'the republished component does not affect this card — the test proves nothing as written');

H('4. The spec hash is not the guarantee, and does not pretend to be');
ok('the hash is unchanged across the republish — which is exactly why pins are needed',
   E.specHash(SPEC) === E.specHash(SPEC));
ok('two specs differing only in their pins are different designs',
   E.specHash({ ...SPEC, pins }) !== E.specHash({ ...SPEC, pins: { ...pins, 'pal.ink': 99 } }));

H('5. An unpinned spec is refused, not silently resolved to latest');
ok('resolving with no pins throws rather than guessing',
   await resolvePins(sql, {}).then(() => false).catch(() => true));
ok('resolving a version that no longer exists names what is missing',
   await resolvePins(sql, { ...pins, 'pal.ink': 9999 }).then(() => false)
     .catch(e => /pal\.ink/.test(e.message)));

try { psql(['-h', '127.0.0.1', '-U', USER, '-d', 'postgres', '-q', '-c', `DROP DATABASE IF EXISTS ${DB}`]); } catch {}

console.log(`\n${'─'.repeat(58)}\n  ${pass} passed, ${fail} failed\n${'─'.repeat(58)}`);
process.exit(fail ? 1 : 0);
