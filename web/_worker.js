// _worker.js — single-file Cloudflare Pages Worker ("advanced mode").
//
// The Pages dashboard drag-and-drop (Direct Upload) can't compile a functions/
// directory, but it DOES accept a pre-built _worker.js. This one file is the
// whole gate: it checks the shared password against the DEMO_PASSWORD
// environment variable, and serves the static site through the ASSETS binding.
//
// After uploading, set DEMO_PASSWORD in the Pages project →
// Settings → Variables and Secrets (add it as a Secret), then re-deploy.
//
// The password is never sent to the browser — only an HMAC-signed cookie is.

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

function readCookie(request, name) {
  const m = (request.headers.get('cookie') || '')
    .match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? m[1] : null;
}

function sessionCookie(token) {
  return `demo_auth=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=43200`;
}

function safeNext(n) {
  n = String(n || '/');
  return (n.startsWith('/') && !n.startsWith('//')) ? n : '/';
}

async function handleLogin(request, env, url) {
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
    return Response.redirect(new URL(`/login?e=${code}&next=${encodeURIComponent(next)}`, url).toString(), 302);
  }

  if (!expected) return fail(500, 'config');
  if (!ctEqual(password, expected)) return fail(401, '1');

  const set = sessionCookie(await makeToken(env));
  if (wantsJson) {
    return new Response(JSON.stringify({ ok: true, redirect: next }),
      { status: 200, headers: { 'content-type': 'application/json', 'set-cookie': set } });
  }
  const h = new Headers({ location: new URL(next, url).toString() });
  h.append('set-cookie', set);
  return new Response(null, { status: 302, headers: h });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // ---- auth API ----
    if (path === '/api/login') {
      if (request.method === 'POST') return handleLogin(request, env, url);
      return Response.redirect(new URL('/login', url).toString(), 302);
    }
    if (path === '/api/logout') {
      const h = new Headers({ location: new URL('/login', url).toString() });
      h.append('set-cookie', 'demo_auth=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
      return new Response(null, { status: 302, headers: h });
    }

    // ---- public: the access screen (+ well-known files) ----
    if (path === '/login' || path === '/login.html') {
      return env.ASSETS.fetch(new Request(new URL('/login.html', url), request));
    }
    if (path === '/favicon.ico' || path === '/robots.txt') {
      return env.ASSETS.fetch(request);
    }

    // ---- everything else needs a valid session cookie ----
    const token = readCookie(request, 'demo_auth');
    if (token && ctEqual(token, await makeToken(env))) {
      return env.ASSETS.fetch(request);   // serve the demo / its assets
    }

    const login = new URL('/login', url);
    const dest = path + url.search;
    login.searchParams.set('next', (dest.startsWith('/') && !dest.startsWith('//')) ? dest : '/');
    return Response.redirect(login.toString(), 302);
  }
};
