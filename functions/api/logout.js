// /api/logout — clears the session cookie and returns to the password screen.
// The lock button in the demo header points here so staff can re-lock a phone.
export async function onRequest(context) {
  const h = new Headers({ location: new URL('/login', context.request.url).toString() });
  h.append('set-cookie', 'demo_auth=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
  return new Response(null, { status: 302, headers: h });
}
