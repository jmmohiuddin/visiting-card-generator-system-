/* Headless verification of the free tier — what it gives, what it withholds,
   and the two things that must never be true of the watermark that marks it.

   Run: node tests/entitlements.test.mjs
   Prints the same pass/fail format as cardworks-engine.test.cjs, because a
   second reporting style is a second thing to read before you can tell whether
   the build is green.

   Master PRD §9 defines the free tier exactly: unlimited briefs, six concepts,
   watermarked previews, no export, no order. Four properties are protected
   here, and each of them would be expensive to discover later.

   The first is that the free tier is genuinely generous. §3.2's Farhana is
   price-sensitive, mobile-only and on metered data, and her success case is a
   watermarked preview she can screenshot and post in under two minutes with no
   signup. So §2 drives the whole funnel — brief, six concepts, refinement,
   preflight — with no session, no owner key and no database, and requires all
   of it to work. A gate that crept upstream would fail there rather than in a
   support ticket.

   The second is that the watermark never reaches a plate. It is asserted three
   ways because one way is not enough: the function refuses a press document
   outright, no print document or PDF byte carries its marker, and — the check
   that would catch a mechanism nobody anticipated — the print bytes for a
   design are identical whether or not its preview was marked first.

   The third is that an entitlement is attached to a design and not to a
   person. §7 buys the file for one spec hash and requires a second design by
   the same holder to stay locked, against a real Postgres, because that is a
   property of a WHERE clause rather than of the fold above it.

   The fourth is that nothing a client sends can grant one. §8 drives the
   endpoint with a hostile query string, and drives `grantFromPayment` with a
   hostile options object, a fabricated payment reference and an uncaptured
   payment, and requires the entitlements table to be empty after all of it. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { engine } from '../lib/engine-node.mjs';
import {
  FREE_TIER, FILE_PACK, KINDS, ACTIONS, SPEC_HASH_RE, REFUSAL_CODE,
  WATERMARK_MARKER, WATERMARK_TEXT,
  watermarkPreviewSVG, isPreviewSVG, isWatermarked,
  holderFrom, actorFrom, freeEntitlement, entitlementFrom, entitlementsFor,
  refuse, assertEntitled, grantFromPayment, revokeForRefund
} from '../lib/entitlements.mjs';
import entitlementsFn from '../netlify/functions/entitlements.mjs';
import preflightFn from '../netlify/functions/preflight.mjs';
import { renderPrintPDF } from '../lib/pdf/index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { cond ? (pass++, console.log('  ✓ ' + name))
                                             : (fail++, console.log('  ✗ ' + name + (extra ? ' — ' + extra : ''))); };
const H = (s) => console.log('\n' + s);

const E = engine();

/* One design used all the way through, so "the same card" means the same
   object every time rather than one assembled twice slightly differently. */
const CONTENT = { name: 'Farhana Rahman', role: 'Private tutor — Physics & Chemistry',
  company: 'Rahman Tutorials', p1: '01755-889900', email: 'farhana@rahmantutorials.bd',
  addr: 'Road 7, Dhanmondi, Dhaka-1205' };
const spec = (over = {}) => ({ format: 'bd-std', type: 'typ.siliguri', palette: 'pal.ink',
  density: 'balanced', layout: 'lay.rule', content: CONTENT, corner: 0,
  share: { origin: 'https://cardworks.bd', code: null }, ...over });
const SPEC = spec();
const SPEC_HASH = E.specHash(SPEC);
const OTHER = spec({ palette: 'pal.gold' });
const OTHER_HASH = E.specHash(OTHER);

const PREVIEW = E.renderSVG(E.compose(SPEC));
const PRINT_DOC = E.printDocSVG(E.compose(SPEC));

const req = (url, init = {}) => new Request(url, init);
const body = async (res) => { try { return await res.json(); } catch { return {}; } };

/* A stand-in for the Neon tagged template. It answers with whatever rows it
   was handed and records nothing else, which is all the pure paths need — the
   statements themselves are exercised against a real Postgres in §7 and §8. */
const rowsSql = (rows) => { const f = () => Promise.resolve(rows); return f; };
const brokenSql = () => () => Promise.reject(new Error('relation "entitlements" does not exist'));

/* ────────────────────────────────────────────────────────────────────────
   1. The tier is a record, not a description
   ──────────────────────────────────────────────────────────────────────── */
H('1. The free tier PRD §9 actually specifies');

ok('unlimited briefs', FREE_TIER.briefs === 'unlimited');
ok('six concepts, the number §5.1 and §9 both name', FREE_TIER.concepts === 6);
ok('typed refinement is free — it is the product, not an upsell', FREE_TIER.refine === true);
ok('the preflight report is free, because a card that cannot print is worth knowing about either way',
   FREE_TIER.preflight === true);
ok('no signup stands between someone and any of it (PRD §3.2)', FREE_TIER.signupRequired === false);
ok('the preview is watermarked', FREE_TIER.preview === 'watermarked');
ok('export is withheld', FREE_TIER.export === false);
ok('and so is an order', FREE_TIER.order === false);

ok('the file pack is a one-off inside §9\'s ৳199–499 band, not a subscription',
   FILE_PACK.amount === 199 && FILE_PACK.band[0] === 199 && FILE_PACK.band[1] === 499 &&
   FILE_PACK.amount >= FILE_PACK.band[0] && FILE_PACK.amount <= FILE_PACK.band[1],
   JSON.stringify(FILE_PACK));
ok('nothing in the price record is periodic',
   !/month|\/mo|per year|annual|subscri/i.test(JSON.stringify(FILE_PACK)));
ok('the two actions a tier can gate are export and order, and only those',
   ACTIONS.join(',') === 'export,order');
ok('every kind is a thing somebody bought or was given, never a plan tier',
   KINDS.join(',') === 'file_pack,print_order,shop_channel,comp');

/* ────────────────────────────────────────────────────────────────────────
   2. The whole funnel works for a stranger with no account and no database
   ──────────────────────────────────────────────────────────────────────── */
H('2. An anonymous visitor gets the entire product up to the file');

const gen = E.generate({ industry: 'doctor', personality: ['traditional', 'premium'],
  format: 'bd-std', density: 'balanced', script: 'latin' }, CONTENT);
ok('a brief with no session generates concepts at all', !!gen && Array.isArray(gen.picked));
ok('and it generates six of them, which is the number §9 promises',
   gen.picked.length === 6, String(gen.picked.length));
ok('every concept carries a real score rather than a placeholder',
   gen.picked.every(c => c.score && Number.isFinite(c.score.total) && c.score.total > 0 &&
                         c.score.parts && Number.isFinite(c.score.parts.legibility)),
   JSON.stringify(gen.picked.map(c => c.score && c.score.total)));
ok('every concept composes into something renderable',
   gen.picked.every(c => typeof E.renderSVG(E.compose(spec({ layout: c.layout,
     palette: c.palette, type: c.type }))) === 'string'));

const instr = E.classifyInstruction('make the name bigger', { design: SPEC, content: CONTENT });
ok('typed refinement answers a stranger', !!instr && typeof instr === 'object');
ok('and it maps to a real operation rather than refusing anonymous callers',
   !!(instr.ops && instr.ops.length) || !!instr.op || !!instr.kind,
   JSON.stringify(instr).slice(0, 160));

const pf = E.preflight(E.compose(SPEC));
ok('preflight runs with no account and returns findings', Array.isArray(pf) && pf.length > 0);

/* The endpoint, not just the engine — because the gate that could creep
   upstream would creep into a function, and a 401 there is what would actually
   stop Farhana. No Authorization header, no owner key, no DATABASE_URL. */
const savedDb = process.env.DATABASE_URL;
delete process.env.DATABASE_URL;
const pfRes = await preflightFn(req('https://cardworks.bd/api/preflight', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ design: { layout: 'lay.rule', palette: 'pal.ink', type: 'typ.siliguri',
    density: 'balanced', format: 'bd-std', back: 'back.contact', script: 'latin', finishes: [] },
    content: CONTENT }) }));
const pfBody = await body(pfRes);
ok('the preflight endpoint answers an anonymous caller with a report, not a 401',
   pfRes.status === 200 && Array.isArray(pfBody.findings) && pfBody.findings.length > 0,
   pfRes.status + ' ' + JSON.stringify(pfBody).slice(0, 120));
ok('and it never mentions signing in',
   !/sign in|sign_in/i.test(JSON.stringify(pfBody)));

/* ────────────────────────────────────────────────────────────────────────
   3. The watermark: what it marks, and what it refuses to mark
   ──────────────────────────────────────────────────────────────────────── */
H('3. The preview carries a watermark');

const MARKED = watermarkPreviewSVG(PREVIEW);
ok('the renderer\'s own output is recognised as a preview', isPreviewSVG(PREVIEW));
ok('an unmarked preview does not claim to be marked', !isWatermarked(PREVIEW));
ok('marking a preview changes it', MARKED !== PREVIEW);
ok('the mark is findable by the name every other check uses',
   isWatermarked(MARKED) && MARKED.includes(WATERMARK_MARKER));
ok('and it reads as CARDWORKS rather than as an anonymous smudge',
   (MARKED.match(new RegExp(WATERMARK_TEXT, 'g')) || []).length >= 2);
ok('the card underneath is untouched — the mark is appended, never woven in',
   MARKED.startsWith(PREVIEW.slice(0, PREVIEW.lastIndexOf('</svg>'))));
ok('the result is still one closed SVG',
   MARKED.endsWith('</svg>') && (MARKED.match(/<svg\b/g) || []).length === 1);
ok('marking twice marks once', watermarkPreviewSVG(MARKED) === MARKED);
ok('the mark cannot be clicked through to and does not steal the pointer',
   /pointer-events="none"/.test(MARKED));
ok('it is legible rather than a token gesture — the pill is opaque enough to read',
   /fill-opacity="0\.88"/.test(MARKED));
ok('and the wordmark across the card is faint enough not to ruin a screenshot',
   /fill-opacity="0\.16"/.test(MARKED));

/* The mark has to be derived from the card or it is tuned to one format. Two
   formats of different height must produce two different mark sizes, and the
   ratio must be the ratio of the cards — anything else is a constant with a
   viewBox read next to it. */
const sizeOf = (s) => {
  const at = s.indexOf(WATERMARK_MARKER);
  if (at < 0) return 0;
  const m = /font-size="([\d.]+)"/.exec(s.slice(at));
  return m ? +m[1] : 0;
};
const tall = E.FORMATS.find(f => f.h !== E.FORMATS.find(x => x.id === 'bd-std').h);
const other = tall && E.compose(spec({ format: tall.id, layout: 'lay.centered' }));
const otherSVG = other && !other.eliminated ? E.renderSVG(other) : null;
ok('a second format composed, so the scaling check has something to compare',
   !!otherSVG, tall ? tall.id : 'no second format');
if (otherSVG) {
  const om = watermarkPreviewSVG(otherSVG);
  const stdH = E.FORMATS.find(f => f.id === 'bd-std').h;
  ok('the mark is sized from the viewBox, so a different format is not a different watermark',
     isWatermarked(om) && Math.abs(sizeOf(om) / sizeOf(MARKED) - tall.h / stdH) < 0.001,
     `${sizeOf(MARKED)} vs ${sizeOf(om)} for ${stdH}mm vs ${tall.h}mm`);
} else {
  ok('the mark is sized from the viewBox, so a different format is not a different watermark',
     false, 'the second format did not compose');
}

/* Positive identification. Anything that is not the preview renderer's output
   comes back unchanged, which is what makes a print path that has never heard
   of this function safe by default rather than safe by discipline. */
ok('a print document is refused, not marked',
   !isPreviewSVG(PRINT_DOC) && watermarkPreviewSVG(PRINT_DOC) === PRINT_DOC);
const sep = E.separationSVG(E.compose(spec({ layout: 'lay.corner' })), 'Gold foil');
ok('a separation plate is refused too',
   !!sep && !isPreviewSVG(sep.svg) && watermarkPreviewSVG(sep.svg) === sep.svg);
ok('an SVG that is not ours is left alone',
   watermarkPreviewSVG('<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>') ===
   '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>');
ok('so is a string that only looks like one',
   watermarkPreviewSVG('') === '' && watermarkPreviewSVG(null) === null &&
   watermarkPreviewSVG('<svg class="card">') === '<svg class="card">');
ok('a preview with no viewBox is left alone rather than marked at a guessed size',
   watermarkPreviewSVG('<svg class="card" width="100">' + 'x'.repeat(64) + '</svg>')
     === '<svg class="card" width="100">' + 'x'.repeat(64) + '</svg>');

/* ────────────────────────────────────────────────────────────────────────
   4. The watermark never reaches the print path
   ──────────────────────────────────────────────────────────────────────── */
H('4. No print byte carries the mark');

/* The needle is the marker, not the word. Both print producers put CARDWORKS
   in their own <desc> — a press document saying what it is — and searching for
   the wordmark would report every honest one of those as a leak. What must
   never appear is the mark itself: its attribute, and the opacity it is drawn
   at, which no other element in this codebase uses. */
const leaks = (s) => s.includes(WATERMARK_MARKER) || s.includes('fill-opacity="0.16"');

let printsChecked = 0, printLeaks = 0, sepsChecked = 0, sepLeaks = 0;
for (const layout of E.LAYOUTS.filter(l => l.face === 'front')) {
  for (const pal of ['pal.ink', 'pal.gold']) {
    const c = E.compose(spec({ layout: layout.id, palette: pal }));
    if (!c || c.eliminated) continue;
    /* Marking the preview first, so a mechanism that mutated shared state
       would have already done so by the time the print document is built. */
    watermarkPreviewSVG(E.renderSVG(c));
    const doc = E.printDocSVG(c);
    if (doc) { printsChecked++; if (leaks(doc)) printLeaks++; }
    const s = E.separationSVG(c, 'Gold foil');
    if (s) { sepsChecked++; if (leaks(s.svg)) sepLeaks++; }
  }
}
ok('there were print documents to check', printsChecked >= 8, String(printsChecked));
ok(`no printDocSVG output carries the mark (${printsChecked} documents)`, printLeaks === 0, String(printLeaks));
ok('there were separations to check', sepsChecked >= 2, String(sepsChecked));
ok(`no separationSVG output carries the mark (${sepsChecked} plates)`, sepLeaks === 0, String(sepLeaks));

/* The strongest form of the same claim, and the one that would catch a
   mechanism nobody here anticipated: the bytes a press receives are identical
   whether or not the preview of that design was marked first. "CARDWORKS"
   itself is not a usable needle in a PDF — the writer stamps it into XMP as
   the producer, honestly — so the marker is the needle, and byte identity is
   the argument. */
/* The writer re-measures against the real outlines and refuses content the
   composer's estimate let through, so this uses a card short enough that the
   refusal under test is the entitlement one and never the geometry one. */
const PDF_SPEC = spec({ content: { name: 'Farhana Rahman', role: 'Private tutor',
  company: 'Rahman Tutorials', p1: '01755-889900' } });
const pdfBefore = renderPrintPDF(PDF_SPEC, { finishes: [], stock: 'coated' }).composite;
watermarkPreviewSVG(E.renderSVG(E.compose(PDF_SPEC)));
const pdfAfter = renderPrintPDF(PDF_SPEC, { finishes: [], stock: 'coated' }).composite;
const pdfText = Buffer.from(pdfBefore).toString('latin1');
ok('the print PDF was actually produced', pdfBefore.length > 10000, String(pdfBefore.length));
ok('no PDF byte carries the watermark marker', !pdfText.includes(WATERMARK_MARKER));
ok('nor the opacity the mark is drawn at', !pdfText.includes('fill-opacity="0.16"'));
ok('and the file is byte-identical whether or not the preview was marked first',
   Buffer.compare(Buffer.from(pdfBefore), Buffer.from(pdfAfter)) === 0);

/* Controls. Every assertion above rests on the marker being a needle that
   would actually be found, and on `leaks` being able to say so — an extractor
   that finds nothing must fail rather than pass (WORKPLAN.md). */
ok('the needle would be found if it were there',
   leaks(watermarkPreviewSVG(PREVIEW)) &&
   Buffer.from(String(pdfText) + WATERMARK_MARKER).toString('latin1').includes(WATERMARK_MARKER));
ok('and the print document is not being credited for merely being empty',
   PRINT_DOC.length > 1000 && PRINT_DOC.includes('CARDWORKS print document'));

/* ────────────────────────────────────────────────────────────────────────
   5. The browser's copy of the watermark is the same watermark
   ──────────────────────────────────────────────────────────────────────── */
H('5. The screen and the server draw the same mark');

/* assets/ui-misc.js is a classic script and cannot import an ES module, so it
   carries a second copy of this function. The copy is lifted out here by
   brace-matching from its declaration — not by a content regex, so the only
   thing that has to stay stable is the declaration existing at all — and run
   against the same inputs. An extraction that comes back empty must fail
   outright rather than quietly compare nothing, which is the house rule
   WORKPLAN.md records twice. */
const misc = read('assets/ui-misc.js');
const declFrom = (src, at) => {
  const open = src.indexOf('{', at);
  if (at < 0 || open < 0) return '';
  let d = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') d++;
    else if (c === '}') { d--; if (d === 0) return src.slice(at, i + 1); }
  }
  return '';
};
let clientMark = null;
const clientSrc = declFrom(misc, misc.search(/function\s+cwWatermarkPreviewSVG\s*\(/));
try {
  if (clientSrc.length > 800)
    clientMark = new Function(`${clientSrc}\nreturn cwWatermarkPreviewSVG;`)();
} catch { /* reported by the assertion below, not swallowed */ }

ok('the browser copy was found and is a whole function, not a fragment',
   typeof clientMark === 'function' && clientSrc.length > 800,
   `${clientSrc.length} characters extracted`);

if (typeof clientMark === 'function') {
  const corpus = [PREVIEW, PRINT_DOC, sep ? sep.svg : '<svg/>', MARKED, '',
    '<svg class="card" viewBox="0 0 10 10">' + 'x'.repeat(64) + '</svg>',
    '<svg viewBox="0 0 89 51"><rect/></svg>'];
  const drift = corpus.filter(s => clientMark(s) !== watermarkPreviewSVG(s));
  ok(`the two copies agree byte for byte over ${corpus.length} inputs`,
     drift.length === 0, `${drift.length} disagreements`);
  ok('and the browser copy refuses a press document exactly as the server one does',
     clientMark(PRINT_DOC) === PRINT_DOC);
} else {
  ok('the two copies agree byte for byte', false, 'the browser copy could not be loaded');
  ok('and the browser copy refuses a press document exactly as the server one does', false, 'not loaded');
}

/* ────────────────────────────────────────────────────────────────────────
   6. The gates, and what a refusal has to say
   ──────────────────────────────────────────────────────────────────────── */
H('6. Export and order refuse, with a price and a next step');

const free = freeEntitlement(SPEC_HASH);
ok('nothing held is the free tier, as a value rather than a null',
   free.tier === 'free' && free.may.export === false && free.may.order === false);
ok('and the free tier is the watermarked tier', free.watermark === true);

const held = entitlementFrom(SPEC_HASH, [{ ref: 'ENT-001000', kind: 'file_pack',
  source: 'payment', source_ref: 'PAY-000001', granted_at: '2026-08-15T00:00:00Z' }]);
ok('a file pack unlocks the file', held.may.export === true);
ok('and takes the watermark off', held.watermark === false);
ok('a revoked grant is not a grant',
   entitlementFrom(SPEC_HASH, [{ ref: 'ENT-001000', kind: 'file_pack', source: 'payment',
     source_ref: 'PAY-000001', revoked_at: '2026-08-16T00:00:00Z' }]).may.export === false);
ok('a kind nobody defined grants nothing',
   entitlementFrom(SPEC_HASH, [{ ref: 'ENT-x', kind: 'pro_annual', source: 'staff' }]).may.export === false);

for (const action of ACTIONS) {
  const r = refuse(action, { specHash: SPEC_HASH });
  const b = await body(r);
  ok(`${action} is refused with a price, not a bare no`,
     r.status === 402 && b.error.code === REFUSAL_CODE &&
     b.error.price.amount === FILE_PACK.amount && b.error.price.currency === 'BDT',
     r.status + ' ' + JSON.stringify(b.error).slice(0, 120));
  ok(`the ${action} refusal names the figure in the sentence a customer reads`,
     b.error.message.includes(String(FILE_PACK.amount)), b.error.message);
  ok(`the ${action} refusal offers a next step as a token the screen can branch on`,
     b.error.remediation === 'buy_file_pack');
  ok(`and carries the sentence that token has no table entry for yet`,
     typeof b.error.remediationText === 'string' && b.error.remediationText.length > 40);
  ok(`the ${action} refusal says what stays free, so it reads as a price and not a wall`,
     /free/i.test(b.error.remediationText));
}
ok('the order refusal says the file pack is credited rather than charged twice',
   /credited/i.test((await body(refuse('order', {}))).error.message));

/* The refusal a customer must never meet: a deploy that cannot read purchases
   telling someone who has paid that they have not. */
const unreadable = await body(refuse('export', { unreadable: 'migration-008-not-applied' }));
ok('a deploy that cannot read purchases says so instead of quoting a price',
   unreadable.error.code === 'unavailable' && !/199/.test(unreadable.error.message));
ok('and points at support rather than at a payment screen',
   unreadable.error.remediation === 'contact_support' &&
   typeof unreadable.error.remediationText === 'string');

/* assertEntitled, the two-line surface every endpoint adopts. */
const gateFree = await assertEntitled(rowsSql([]), 'export',
  { specHash: SPEC_HASH, ownerKey: 'abcdefgh12345678' });
ok('assertEntitled refuses a holder with nothing, and hands back the refusal ready to return',
   gateFree.ok === false && gateFree.refusal.status === 402);
const gatePaid = await assertEntitled(rowsSql([{ ref: 'ENT-001000', kind: 'file_pack',
  source: 'payment', source_ref: 'PAY-000001' }]), 'export',
  { specHash: SPEC_HASH, ownerKey: 'abcdefgh12345678' });
ok('and lets a holder with a file pack through with no refusal at all',
   gatePaid.ok === true && gatePaid.refusal === null);
const gateBadHash = await assertEntitled(rowsSql([]), 'export', { specHash: 'not-a-hash' });
ok('a design nobody has saved is a bad request, not a sales pitch',
   gateBadHash.ok === false && gateBadHash.refusal.status === 400);
const gateBroken = await assertEntitled(brokenSql(), 'export',
  { specHash: SPEC_HASH, ownerKey: 'abcdefgh12345678' });
ok('a missing migration 008 degrades to a 503, never to a silent unlock',
   gateBroken.ok === false && gateBroken.refusal.status === 503);
let threw = null;
try { await assertEntitled(rowsSql([]), 'print', { specHash: SPEC_HASH }); }
catch (e) { threw = e; }
ok('an action nobody defined throws here rather than being quietly allowed', !!threw);

ok('an anonymous caller with no key at all is free tier without touching the database',
   (await entitlementsFor(rowsSql([{ kind: 'file_pack' }]), { specHash: SPEC_HASH })).may.export === false);
ok('a malformed owner key is treated as absent rather than passed to the query',
   holderFrom({ ownerKey: "'; DROP TABLE entitlements; --" }).ownerKey === null &&
   holderFrom({ ownerKey: 'abcdefgh12345678' }).ownerKey === 'abcdefgh12345678');
ok('a spec hash is the sixteen-hex content address the rest of the schema uses',
   SPEC_HASH_RE.test(SPEC_HASH) && !SPEC_HASH_RE.test('ZZZZ') && SPEC_HASH !== OTHER_HASH);

/* `actorFrom` is the one place the "authenticate with sql" rule is decided for
   every endpoint that gates. It has to read a browser key off a request with
   no session on it, and drop one that could never have been minted. */
const anonActor = await actorFrom(req('https://cardworks.bd/api/x?owner=abcdefgh12345678'), null);
ok('a request with no session is a browser holder, not a refusal',
   anonActor.userId === null && anonActor.ownerKey === 'abcdefgh12345678');
const junkActor = await actorFrom(req("https://cardworks.bd/api/x?owner=" + encodeURIComponent("' OR 1=1 --")), null);
ok('and a key that could never have owned a design is dropped rather than queried',
   junkActor.ownerKey === null);
const bodyActor = await actorFrom(req('https://cardworks.bd/api/x'), null, 'zzzzzzzz99999999');
ok('a key sent in the body reaches the same place as one in the query string',
   bodyActor.ownerKey === 'zzzzzzzz99999999');
const forgedActor = await actorFrom(req('https://cardworks.bd/api/x',
  { headers: { authorization: 'Bearer v1.forged.signature' } }), null);
ok('a forged bearer token yields no account, so a holder cannot be asserted by header',
   forgedActor.userId === null);

/* ────────────────────────────────────────────────────────────────────────
   7 & 8. Against a real Postgres
   ──────────────────────────────────────────────────────────────────────── */
H('7. The entitlement is a design\'s, not a person\'s (live Postgres)');

const pgUser = os.userInfo().username;
const pgBase = process.env.CARDWORKS_TEST_PG || `postgresql://${pgUser}@127.0.0.1/postgres`;
const dbName = `cardworks_ent_${process.pid}`;
const dbUrl = pgBase.replace(/\/[^/]*$/, '/' + dbName);

const psqlRaw = (url, args) =>
  execFileSync('psql', [url, '-X', '-q', '-v', 'ON_ERROR_STOP=1', ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

let live = false;
try { psqlRaw(pgBase, ['-c', 'SELECT 1']); live = true; }
catch (e) { live = false; }

if (!live) {
  /* Loudly, and as a failure of the section rather than a silent skip: the
     whole point of putting these guarantees in the schema is that they do not
     depend on application code keeping them, and a run that never checked them
     has not checked them. */
  ok('a local Postgres is reachable for the schema guarantees', false,
     `no server at ${pgBase} — start Postgres 16 or set CARDWORKS_TEST_PG`);
  ok('7 and 8 could not run', false, 'skipped for want of a database');
} else {
  /* The database is named after this process, so two suites running at once
     cannot drop each other's — a fixed name is a cross-run race, and one cost
     a green suite an unrelated failure while this was being written. Dropped
     in a `finally` for the same reason: a throw anywhere below must not leave
     a database behind on someone's machine. */
  psqlRaw(pgBase, ['-c', `DROP DATABASE IF EXISTS ${dbName}`]);
  psqlRaw(pgBase, ['-c', `CREATE DATABASE ${dbName}`]);
  try {
  try {
    psqlRaw(dbUrl, ['-f', path.join(ROOT, 'db/schema.sql')]);
    for (const f of fs.readdirSync(path.join(ROOT, 'db/migrations')).sort())
      psqlRaw(dbUrl, ['-f', path.join(ROOT, 'db/migrations', f)]);
    ok('the schema and every migration apply cleanly, 008 included', true);
    /* Re-runnable, like every migration before it. */
    psqlRaw(dbUrl, ['-f', path.join(ROOT, 'db/migrations/008_entitlements.sql')]);
    ok('and 008 applies twice without complaint', true);
  } catch (e) {
    ok('the schema and every migration apply cleanly, 008 included', false,
       String(e.stderr || e.message).slice(0, 300));
  }

  /* A tagged template over psql, so lib/entitlements.mjs's real statements run
     against a real planner rather than against a mock that agrees with them.
     Values are rendered as literals because psql binds no parameters; the
     statements are wrapped in a CTE so an INSERT … RETURNING and a SELECT come
     back the same way, as JSON. */
  const lit = (v) => {
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (Array.isArray(v)) return 'ARRAY[' + v.map(lit).join(',') + ']::text[]';
    return "'" + String(v).replace(/'/g, "''") + "'";
  };
  const sql = (strings, ...vals) => {
    const text = strings.reduce((s, part, i) => s + part + (i < vals.length ? lit(vals[i]) : ''), '');
    const out = psqlRaw(dbUrl, ['-A', '-t', '-c',
      `WITH q AS (${text}) SELECT coalesce(json_agg(q), '[]'::json) FROM q`]).trim();
    return Promise.resolve(JSON.parse(out || '[]'));
  };
  const rows = (text) => JSON.parse(psqlRaw(dbUrl, ['-A', '-t', '-c',
    `SELECT coalesce(json_agg(q), '[]'::json) FROM (${text}) q`]).trim() || '[]');
  const raises = (text) => {
    try { psqlRaw(dbUrl, ['-c', text]); return null; }
    catch (e) { return String(e.stderr || e.message); }
  };
  const count = () => rows('SELECT count(*)::int AS n FROM entitlements')[0].n;

  /* Two designs, one buyer, one paid print order against the first. */
  const KEY = 'farhana01browserkey';
  psqlRaw(dbUrl, ['-c', `
    INSERT INTO users (phone, name) VALUES ('+8801755889900', 'Farhana Rahman');
    INSERT INTO design_specs (spec_hash, short_code, spec_json, owner_key, user_id)
      VALUES ('${SPEC_HASH}', '${SPEC_HASH.slice(0, 8)}', '{}'::jsonb, '${KEY}',
              (SELECT id FROM users LIMIT 1)),
             ('${OTHER_HASH}', '${OTHER_HASH.slice(0, 8)}', '{}'::jsonb, '${KEY}',
              (SELECT id FROM users LIMIT 1));
    INSERT INTO orders (owner_key, user_id, short_code, qty, press, subtotal, total)
      VALUES ('${KEY}', (SELECT id FROM users LIMIT 1), '${SPEC_HASH.slice(0, 8)}',
              500, 'nilkhet-offset', 980, 1300);
    INSERT INTO payments (order_ref, provider, amount, capture_key, status)
      SELECT ref, 'bkash', 1300, 'idem-1', 'intent' FROM orders LIMIT 1;`]);
  const PAY = rows('SELECT ref FROM payments LIMIT 1')[0].ref;

  ok('an uncaptured payment grants nothing',
     (await grantFromPayment(sql, PAY)).granted.length === 0 && count() === 0);

  psqlRaw(dbUrl, ['-c', `UPDATE payments SET status = 'captured' WHERE ref = '${PAY}'`]);
  const granted = await grantFromPayment(sql, PAY);
  ok('a captured payment grants exactly one entitlement', granted.granted.length === 1 && count() === 1);

  const row = rows('SELECT * FROM entitlements')[0];
  ok('and every column of it was read out of the database, not handed in',
     row.spec_hash === SPEC_HASH && row.owner_key === KEY &&
     Number(row.amount) === 1300 && row.source === 'payment' && row.source_ref === PAY,
     JSON.stringify(row));
  ok('its reference came from the table\'s own sequence',
     /^ENT-\d{6}$/.test(row.ref), row.ref);

  ok('granting from the same payment twice grants once',
     (await grantFromPayment(sql, PAY)).granted.length === 0 && count() === 1);

  /* The property the whole model rests on. */
  const bought = await entitlementsFor(sql, { specHash: SPEC_HASH, ownerKey: KEY });
  const notBought = await entitlementsFor(sql, { specHash: OTHER_HASH, ownerKey: KEY });
  ok('the design that was paid for is unlocked', bought.may.export === true && bought.tier === 'paid');
  ok('and the clean preview goes with it', bought.watermark === false);
  ok('a second design the same buyer owns stays locked — this is not a plan',
     notBought.may.export === false && notBought.tier === 'free' && notBought.watermark === true);
  ok('and a stranger holding neither key nor account gets nothing for the paid design',
     (await entitlementsFor(sql, { specHash: SPEC_HASH, ownerKey: 'zzzzzzzz99999999' })).may.export === false);
  ok('the account that owns the order holds it too, so a device change does not lose it',
     (await entitlementsFor(sql, { specHash: SPEC_HASH,
        userId: Number(rows('SELECT id FROM users LIMIT 1')[0].id) })).may.export === true);

  const gateLive = await assertEntitled(sql, 'export', { specHash: OTHER_HASH, ownerKey: KEY });
  ok('assertEntitled against a real database refuses the unpaid design with the price',
     gateLive.ok === false && gateLive.refusal.status === 402);

  /* The short code is what a screen and the order endpoint have to hand, so it
     resolves to the same answer as the hash — through design_specs, never by
     being trusted. This is the form both server call sites use. */
  ok('a short code resolves to the same answer as the hash it names',
     (await entitlementsFor(sql, { shortCode: SPEC_HASH.slice(0, 8), ownerKey: KEY })).may.export === true &&
     (await entitlementsFor(sql, { shortCode: OTHER_HASH.slice(0, 8), ownerKey: KEY })).may.export === false);
  ok('a code naming no saved design unlocks nothing and says which of the two it is',
     (await entitlementsFor(sql, { shortCode: 'deadbeef', ownerKey: KEY })).unreadable === 'bad_spec_hash');
  ok('and a code the caller made up cannot stand in for a hash they do not hold',
     (await assertEntitled(sql, 'export', { shortCode: 'deadbeef', ownerKey: KEY })).ok === false);

  /* A refund withdraws it, as a second row rather than an edit. */
  psqlRaw(dbUrl, ['-c', `UPDATE payments SET status = 'refunded', refunded = amount WHERE ref = '${PAY}'`]);
  ok('a refund revokes the entitlement it paid for',
     (await revokeForRefund(sql, PAY)).revoked.length === 1);
  ok('and the grant row survives the revocation, because it is the evidence',
     count() === 1 &&
     (await entitlementsFor(sql, { specHash: SPEC_HASH, ownerKey: KEY })).may.export === false);
  ok('revoking twice revokes once', (await revokeForRefund(sql, PAY)).revoked.length === 0);

  H('8. Nothing a client sends can grant an entitlement');

  const before = count();

  ok('an entitlement cannot be updated — the database refuses, not the endpoint',
     /append-only/.test(raises(`UPDATE entitlements SET kind = 'comp' WHERE id = 1`) || ''));
  ok('nor deleted', /append-only/.test(raises('DELETE FROM entitlements WHERE id = 1') || ''));
  ok('a revocation cannot be edited away either',
     /append-only/.test(raises('DELETE FROM entitlement_revocations WHERE id = 1') || ''));
  ok('an entitlement nobody holds is refused by a check constraint',
     /entitlements_has_holder|violates check constraint/.test(raises(
       `INSERT INTO entitlements (kind, spec_hash, source, source_ref)
        VALUES ('file_pack', '${SPEC_HASH}', 'staff', 'x')`) || ''));
  ok('a spec hash that is not a content address is refused',
     /violates check constraint/.test(raises(
       `INSERT INTO entitlements (kind, spec_hash, owner_key, source, source_ref)
        VALUES ('file_pack', 'not-a-hash', '${KEY}', 'staff', 'x')`) || ''));
  ok('an owner key that could never have owned a design is refused',
     /violates check constraint/.test(raises(
       `INSERT INTO entitlements (kind, spec_hash, owner_key, source, source_ref)
        VALUES ('file_pack', '${OTHER_HASH}', 'x', 'staff', 'x')`) || ''));
  ok('a kind nobody defined is refused',
     /violates check constraint/.test(raises(
       `INSERT INTO entitlements (kind, spec_hash, owner_key, source, source_ref)
        VALUES ('pro_annual', '${OTHER_HASH}', '${KEY}', 'staff', 'x')`) || ''));
  ok('one payment cannot grant the same design twice',
     /duplicate key|entitlements_source_ix/.test(raises(
       `INSERT INTO entitlements (kind, spec_hash, owner_key, source, source_ref)
        VALUES ('file_pack', '${SPEC_HASH}', '${KEY}', 'payment', '${PAY}')`) || ''));

  /* The grant function takes a payment reference and nothing else that lands
     in a column. Handing it hostile everything changes nothing. */
  const hostile = await grantFromPayment(sql, 'PAY-999999',
    { specHash: OTHER_HASH, kind: 'comp', userId: 1, ownerKey: KEY, amount: 0 });
  ok('a payment reference that names nothing grants nothing',
     hostile.granted.length === 0 && count() === before);
  ok('a reference that is not even a reference grants nothing',
     (await grantFromPayment(sql, "' OR 1=1 --")).granted.length === 0 && count() === before);
  ok('and the design a caller asks for is not the design that gets unlocked',
     (await entitlementsFor(sql, { specHash: OTHER_HASH, ownerKey: KEY })).may.export === false);

  } finally {
    psqlRaw(pgBase, ['-c', `DROP DATABASE IF EXISTS ${dbName}`]);
  }
}

/* ────────────────────────────────────────────────────────────────────────
   9. The endpoint has no verb that could grant one
   ──────────────────────────────────────────────────────────────────────── */
H('9. The endpoint reads and never writes');

for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
  const res = await entitlementsFn(req('https://cardworks.bd/api/entitlements', {
    method, headers: { 'content-type': 'application/json' },
    body: method === 'DELETE' ? undefined : JSON.stringify({
      specHash: SPEC_HASH, kind: 'file_pack', grant: true, userId: 1 }) }));
  const b = await body(res);
  ok(`a ${method} is refused outright`, res.status === 405, String(res.status));
  ok(`and the ${method} refusal says grants come from a captured payment`,
     /captured payment/i.test(b.error.message), b.error.message);
}

const tiers = await body(await entitlementsFn(req('https://cardworks.bd/api/entitlements?tiers=1')));
ok('the price list is answerable with no database, so a screen never invents the figure',
   tiers.filePack.amount === FILE_PACK.amount && tiers.free.concepts === 6);
ok('and it states the free tier as the record, not as prose',
   tiers.free.export === false && tiers.free.order === false && tiers.free.preview === 'watermarked');

const hostileGet = await entitlementsFn(req(
  'https://cardworks.bd/api/entitlements?specHash=' + SPEC_HASH +
  '&grant=1&kind=file_pack&may=export&tier=paid&user_id=1'));
ok('a GET carrying every field a forger would try answers 503 without a database, never a grant',
   hostileGet.status === 503, String(hostileGet.status));

if (savedDb === undefined) delete process.env.DATABASE_URL;
else process.env.DATABASE_URL = savedDb;

/* ────────────────────────────────────────────────────────────────────────
   10. The migration keeps the patterns the earlier ones proved
   ──────────────────────────────────────────────────────────────────────── */
H('10. The migration follows the house patterns');

const MIG = read('db/migrations/008_entitlements.sql');
ok('the migration was actually read', MIG.length > 2000, String(MIG.length));
ok('every object is IF NOT EXISTS, so applying it twice is a no-op',
   (MIG.match(/CREATE (TABLE|INDEX|UNIQUE INDEX|SEQUENCE)/g) || []).length ===
   (MIG.match(/CREATE (TABLE|INDEX|UNIQUE INDEX|SEQUENCE) IF NOT EXISTS/g) || []).length,
   `${(MIG.match(/CREATE (TABLE|INDEX|UNIQUE INDEX|SEQUENCE)/g) || []).length} created`);
ok('the reference comes from a sequence, not from a row count',
   /CREATE SEQUENCE IF NOT EXISTS entitlements_ref_seq/.test(MIG) && /nextval/.test(MIG) &&
   !/count\(\*\)/.test(MIG));
ok('append-only is enforced by a trigger rather than by every caller remembering',
   /CREATE TRIGGER entitlements_immutable/.test(MIG) &&
   /CREATE TRIGGER entitlement_revocations_immutable/.test(MIG));
ok('the migration says why the shape is a spec hash and not a flag on a user',
   /§9/.test(MIG) && /subscription/i.test(MIG) && /spec hash/i.test(MIG));

console.log(`\n${'─'.repeat(58)}\n  ${pass} passed, ${fail} failed\n${'─'.repeat(58)}`);
process.exit(fail ? 1 : 0);
