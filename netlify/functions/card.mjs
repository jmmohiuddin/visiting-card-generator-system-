/* /c/:code — where a scanned card lands.
 *
 * The engine's QR falls back to a short link whenever a full vCard cannot be
 * encoded at a scannable module size. This is the other end of that link, and
 * it is also the measurement loop from blueprint §16: the QR is ours, so a
 * scan is a recorded event and we can finally answer "does the card work?".
 *
 * Serves a real vCard download to a phone, and a readable page to a browser.
 */
import { neon } from '@neondatabase/serverless';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const vcardEscape = (s) => String(s ?? '').replace(/([,;\\])/g, '\\$1');

function buildVCard(c) {
  const L = ['BEGIN:VCARD', 'VERSION:3.0', `FN:${vcardEscape(c.name)}`];
  if (c.company) L.push(`ORG:${vcardEscape(c.company)}`);
  if (c.role) L.push(`TITLE:${vcardEscape(c.role)}`);
  if (c.p1) L.push(`TEL;TYPE=CELL:${vcardEscape(c.p1)}`);
  if (c.p2) L.push(`TEL;TYPE=CELL:${vcardEscape(c.p2)}`);
  if (c.email) L.push(`EMAIL:${vcardEscape(c.email)}`);
  if (c.web) L.push(`URL:${vcardEscape(c.web)}`);
  if (c.addr) L.push(`ADR;TYPE=WORK:;;${vcardEscape(c.addr)};;;;`);
  L.push('END:VCARD');
  return L.join('\r\n');
}

const page = (title, body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{color-scheme:light dark}
*{margin:0;padding:0;box-sizing:border-box}
html,body{max-width:100%;overflow-x:hidden}
body{font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
     background:#f3f2f2;color:#201e1d;padding:24px 16px}
@media(prefers-color-scheme:dark){body{background:#161514;color:#ece9e6}.card{background:#201e1d!important;border-color:#3a3634!important}}
/* A flex item will not shrink below its content unless min-width is cleared,
   which is how a 420px card overflows a 390px phone. This page is reached by
   scanning a QR — it is a phone page first, so it is laid out as one. */
.card{width:100%;max-width:420px;min-width:0;margin:0 auto;background:#fff;
      border:1px solid #d8d5d2;padding:28px 22px}
h1{font-size:22px;font-weight:700;letter-spacing:-.01em;margin-bottom:2px}
.role{color:#6f6b68;font-size:14px}
.org{margin-top:2px;font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:#c1121f}
hr{border:0;border-top:1px solid #d8d5d2;margin:18px 0}
a{color:inherit}
.row{display:flex;gap:10px;padding:7px 0;font-size:14px;word-break:break-word}
.k{flex:0 0 62px;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#6f6b68;padding-top:3px}
.btn{display:block;margin-top:18px;padding:13px;text-align:center;background:#201e1d;color:#fff;
     text-decoration:none;font-weight:600;font-size:14px}
.foot{margin-top:16px;font-size:11px;color:#6f6b68;text-align:center}
</style></head><body><div class="card">${body}</div></body></html>`;

export default async (req) => {
  const url = new URL(req.url);
  const code = (url.pathname.split('/').filter(Boolean).pop() || '').toLowerCase();

  if (!/^[0-9a-f]{6,16}$/.test(code)) {
    return new Response(page('Not found', '<h1>Not found</h1><p class="role">That link does not look like a card.</p>'),
      { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } });
  }

  const sql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;
  if (!sql) {
    return new Response(page('Unavailable', '<h1>Temporarily unavailable</h1><p class="role">This card cannot be looked up right now.</p>'),
      { status: 503, headers: { 'content-type': 'text/html; charset=utf-8' } });
  }

  try {
    const rows = await sql`SELECT spec_json FROM design_specs WHERE short_code = ${code} LIMIT 1`;
    if (!rows.length) {
      return new Response(page('Not found', '<h1>Card not found</h1><p class="role">This link may have expired or was never saved.</p>'),
        { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }

    const c = (rows[0].spec_json && rows[0].spec_json.content) || {};

    // ?vcf downloads the contact straight into the phone's address book.
    if (url.searchParams.has('vcf')) {
      await sql`INSERT INTO usage_events (type, short_code, meta) VALUES ('card.vcf', ${code}, '{}'::jsonb)`;
      return new Response(buildVCard(c), {
        headers: {
          'content-type': 'text/vcard; charset=utf-8',
          'content-disposition': `attachment; filename="${(c.name || 'contact').replace(/[^\w.-]+/g, '_')}.vcf"`
        }
      });
    }

    await sql`INSERT INTO usage_events (type, short_code, meta) VALUES ('card.scan', ${code},
      ${JSON.stringify({ ua: (req.headers.get('user-agent') || '').slice(0, 120) })}::jsonb)`;

    const rows2 = [
      ['Mobile', c.p1 && `<a href="tel:${esc(c.p1.replace(/\s/g, ''))}">${esc(c.p1)}</a>`],
      ['Mobile', c.p2 && `<a href="tel:${esc(c.p2.replace(/\s/g, ''))}">${esc(c.p2)}</a>`],
      ['Email', c.email && `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>`],
      ['Web', c.web && `<a href="https://${esc(c.web.replace(/^https?:\/\//, ''))}" rel="noopener">${esc(c.web)}</a>`],
      ['Address', c.addr && esc(c.addr)]
    ].filter(r => r[1]).map(([k, v]) => `<div class="row"><span class="k">${k}</span><span>${v}</span></div>`).join('');

    const bn = (c.bname || c.brole) ? `<hr><div class="row"><span class="k">বাংলা</span><span>${esc(c.bname || '')}${c.brole ? '<br>' + esc(c.brole) : ''}</span></div>` : '';

    return new Response(page(c.name || 'Card', `
      <h1>${esc(c.name || 'Card')}</h1>
      ${c.role ? `<div class="role">${esc(c.role)}${c.quals ? ' · ' + esc(c.quals) : ''}</div>` : ''}
      ${c.company ? `<div class="org">${esc(c.company)}</div>` : ''}
      <hr>${rows2}${bn}
      <a class="btn" href="?vcf">Save to contacts</a>
      <p class="foot">CARDWORKS</p>`),
      { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' } });

  } catch (err) {
    console.error('card function failed:', err && err.message);
    return new Response(page('Error', '<h1>Something went wrong</h1>'),
      { status: 500, headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
};
