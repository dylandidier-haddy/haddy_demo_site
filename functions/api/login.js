// POST /api/login
//
// Checks the submitted password against the DEMO_PASSWORD environment variable.
// On success it sets a signed, HttpOnly session cookie (12 h) and sends the
// visitor on to the demo they were trying to reach.
//
// Works two ways so it's robust: a JSON fetch (from login.html) gets a JSON
// reply for inline errors; a plain <form> POST (no JavaScript) gets a redirect.

async function makeToken(env) {
  const secret = env.AUTH_SECRET || env.DEMO_PASSWORD || '';
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode('authed:v1'));
  let s = '';
  for (const b of new Uint8Array(sig)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function ctEqual(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function safeNext(n) {
  n = String(n || '/');
  return (n.startsWith('/') && !n.startsWith('//')) ? n : '/';
}

// 12 hours. HttpOnly (JS can't read it), Secure (HTTPS only), SameSite=Lax.
function cookie(token) {
  return `demo_auth=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=43200`;
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const expected = env.DEMO_PASSWORD || '';
  const wantsJson = (request.headers.get('content-type') || '').includes('application/json');

  let password = '', next = '/';
  if (wantsJson) {
    const b = await request.json().catch(() => ({}));
    password = String(b.password ?? ''); next = String(b.next ?? '/');
  } else {
    const f = await request.formData();
    password = String(f.get('password') ?? ''); next = String(f.get('next') ?? '/');
  }
  next = safeNext(next);

  function fail(status, code) {
    if (wantsJson) {
      const error = code === 'config'
        ? 'Server not configured: set the DEMO_PASSWORD environment variable.'
        : 'Incorrect code.';
      return new Response(JSON.stringify({ ok: false, error }),
        { status, headers: { 'content-type': 'application/json' } });
    }
    const to = new URL(`/login?e=${code}&next=${encodeURIComponent(next)}`, request.url);
    return Response.redirect(to.toString(), 302);
  }

  if (!expected) return fail(500, 'config');
  if (!ctEqual(password, expected)) return fail(401, '1');

  const set = cookie(await makeToken(env));
  if (wantsJson) {
    return new Response(JSON.stringify({ ok: true, redirect: next }),
      { status: 200, headers: { 'content-type': 'application/json', 'set-cookie': set } });
  }
  const h = new Headers({ location: new URL(next, request.url).toString() });
  h.append('set-cookie', set);
  return new Response(null, { status: 302, headers: h });
}

// A GET here (e.g. someone opening the URL directly) just bounces to the form.
export async function onRequestGet(context) {
  return Response.redirect(new URL('/login', context.request.url).toString(), 302);
}
