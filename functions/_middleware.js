// Cloudflare Pages Functions middleware.
//
// Gates every route behind a single shared password stored in the DEMO_PASSWORD
// environment variable (set it in the Pages project → Settings → Variables).
// A visitor who hasn't entered the code is redirected to /login; once they have,
// a signed HttpOnly cookie lets them move between demos without re-entering it.
//
// This is a shared-password gate, not per-user auth. The password is never sent
// to the browser — only an HMAC-signed marker cookie is.

/** HMAC-sign a fixed marker with the server secret → the expected cookie value. */
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

/** Constant-time string compare, so a valid cookie can't be guessed byte by byte. */
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

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  // Public routes: the password screen and the auth API must be reachable
  // without a cookie, plus a couple of well-known files browsers ask for.
  if (path === '/login' || path === '/login.html' ||
      path.startsWith('/api/') ||
      path === '/favicon.ico' || path === '/robots.txt') {
    return next();
  }

  const token = readCookie(request, 'demo_auth');
  if (token && ctEqual(token, await makeToken(env))) {
    return next();   // authenticated — serve the demo / its assets
  }

  // Not authenticated → send to the password screen, remembering the destination.
  const dest = path + url.search;
  const login = new URL('/login', url);
  login.searchParams.set('next', (dest.startsWith('/') && !dest.startsWith('//')) ? dest : '/');
  return Response.redirect(login.toString(), 302);
}
