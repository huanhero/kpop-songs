/*
 * kpop-lyrics editor login — a Cloudflare Worker.
 *
 * What it does
 *   The website is public and static, so it can't keep secrets. This Worker
 *   is a tiny server that does:
 *     POST /login    check username + password, hand out a signed session pass
 *     GET  /session  check a session pass is still valid
 *     *    /gh/...   do one GitHub step for a logged-in editor, using the
 *                    GitHub key that only this Worker knows
 *   The GitHub key never reaches any browser.
 *
 * Settings (Cloudflare dashboard -> this Worker -> Settings -> Variables and Secrets)
 *   REPO                  Text    your-username/kpop-lyrics
 *   BRANCH                Text    main
 *   ALLOWED_ORIGIN        Text    https://your-username.github.io
 *   EDITOR_USERNAME       Text    the login name you choose
 *   EDITOR_PASSWORD_HASH  Secret  made with make-password-hash.html
 *   SESSION_SECRET        Secret  long random text (also from that page)
 *   GITHUB_TOKEN          Secret  fine-grained token: this repo, Contents read+write
 *   SESSION_VERSION       Text    optional; change it (e.g. 1 -> 2) to log out every device
 *   LOGIN_LIMITS          KV binding, optional but recommended: blocks password guessing
 *
 * Defence in depth: even a logged-in session can only
 *   - read and write data/songs.json and images/groups|albums/*.jpg|webp
 *   - add commits on top of the branch (never force-push or rewrite history)
 * So a stolen session can't replace index.html or app.js with harmful code.
 */

const SESSION_LONG = 30 * 24 * 3600; // "remember me": 30 days
const SESSION_SHORT = 12 * 3600; // otherwise: 12 hours
const MAX_FAILS_PER_IP = 10; // per 15 minutes
const MAX_FAILS_TOTAL = 100; // per 15 minutes, all addresses together
const FAIL_WINDOW = 15 * 60;
const MAX_BODY = 3 * 1024 * 1024;

const SHA = /^[0-9a-f]{40}$/;
const EDITABLE_PATH = /^(data\/songs\.json|images\/(groups|albums)\/[A-Za-z0-9_-]{1,60}\.(jpg|webp))$/;

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const cors = corsHeaders(env, origin);
    // Browsers always send Origin on these cross-site calls. Refuse other
    // websites outright. (Not a password check: curl can fake Origin.
    // The real protection is the session pass and the GitHub key.)
    if (origin && !cors) return text('Not allowed from this website', 403);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors || {} });

    try {
      const url = new URL(request.url);
      let res;
      if (url.pathname === '/login' && request.method === 'POST') res = await login(request, env);
      else if (url.pathname === '/session' && request.method === 'GET') res = await session(request, env);
      else if (url.pathname === '/gh' || url.pathname.startsWith('/gh/')) res = await proxy(request, env, url);
      else res = json({ message: 'Not found' }, 404);
      for (const [k, v] of Object.entries(cors || {})) res.headers.set(k, v);
      return res;
    } catch (err) {
      console.log('error', err && err.stack); // shows in the Worker's logs, never sent to the browser
      return json({ message: 'Server error' }, 500, cors);
    }
  },
};

/* ---------------- helpers ---------------- */

function corsHeaders(env, origin) {
  if (!origin || origin !== env.ALLOWED_ORIGIN) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra } });
const text = (msg, status) => new Response(msg, { status, headers: { 'Content-Type': 'text/plain' } });

const enc = new TextEncoder();
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Compare without leaking, through timing, how many characters matched. */
function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function readJson(request) {
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > MAX_BODY) throw Object.assign(new Error('too big'), { status: 413 });
  const raw = await request.text();
  if (raw.length > MAX_BODY) throw Object.assign(new Error('too big'), { status: 413 });
  try { return JSON.parse(raw || 'null'); } catch { return null; }
}

/* ---------------- passwords ---------------- */
/*
 * The password is stored only as a PBKDF2 hash: a deliberately slow one-way
 * scramble with a random "salt". Even someone who saw the hash couldn't turn
 * it back into the password; they could only guess, slowly.
 * Format: pbkdf2-sha256$<iterations>$<salt>$<hash>
 */
async function verifyPassword(password, stored) {
  const m = /^pbkdf2-sha256\$(\d{4,7})\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/.exec(stored || '');
  if (!m) throw new Error('EDITOR_PASSWORD_HASH is missing or malformed');
  const iterations = Number(m[1]);
  const salt = fromB64(m[2]);
  const expected = fromB64(m[3]);
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, expected.length * 8));
  return sameBytes(bits, expected);
}

async function sameText(a, b) {
  // Hash both first so the comparison doesn't depend on their lengths.
  const [x, y] = await Promise.all([a, b].map((s) => crypto.subtle.digest('SHA-256', enc.encode(String(s)))));
  return sameBytes(new Uint8Array(x), new Uint8Array(y));
}

/* ---------------- stopping password guessing ---------------- */

async function tooManyFailures(env, ip) {
  if (!env.LOGIN_LIMITS) return false;
  const [mine, all] = await Promise.all([env.LOGIN_LIMITS.get(`fail:${ip}`), env.LOGIN_LIMITS.get('fail:all')]);
  return Number(mine || 0) >= MAX_FAILS_PER_IP || Number(all || 0) >= MAX_FAILS_TOTAL;
}

async function recordFailure(env, ip) {
  if (!env.LOGIN_LIMITS) return;
  for (const key of [`fail:${ip}`, 'fail:all']) {
    const n = Number((await env.LOGIN_LIMITS.get(key)) || 0) + 1;
    await env.LOGIN_LIMITS.put(key, String(n), { expirationTtl: FAIL_WINDOW });
  }
}

/* ---------------- session passes ---------------- */
/*
 * A session pass is  v1.<details>.<signature>.  The details (who, expiry)
 * are readable; the signature is an HMAC made with SESSION_SECRET. Changing
 * even one letter of the details breaks the signature, and without the
 * secret nobody can make a new valid one. So the Worker doesn't need to
 * store sessions anywhere.
 */
async function hmacKey(env) {
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) throw new Error('SESSION_SECRET missing or shorter than 32 characters');
  return crypto.subtle.importKey('raw', enc.encode(env.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function makeSession(env, user, seconds) {
  const details = b64url(enc.encode(JSON.stringify({ u: user, exp: Math.floor(Date.now() / 1000) + seconds, v: String(env.SESSION_VERSION || '1') })));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(env), enc.encode(`v1.${details}`));
  return `v1.${details}.${b64url(sig)}`;
}

async function checkSession(request, env) {
  const m = /^Bearer (v1\.([A-Za-z0-9_-]{10,500})\.([A-Za-z0-9_-]{20,100}))$/.exec(request.headers.get('Authorization') || '');
  if (!m) return null;
  const ok = await crypto.subtle.verify('HMAC', await hmacKey(env), fromB64(m[3]), enc.encode(`v1.${m[2]}`));
  if (!ok) return null;
  let details;
  try { details = JSON.parse(new TextDecoder().decode(fromB64(m[2]))); } catch { return null; }
  if (!details || details.exp < Date.now() / 1000 || details.v !== String(env.SESSION_VERSION || '1')) return null;
  return details;
}

/* ---------------- endpoints ---------------- */

async function login(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (await tooManyFailures(env, ip)) return json({ message: 'Too many wrong tries. Wait 15 minutes and try again.' }, 429);
  let body;
  try { body = await readJson(request); } catch (e) { return json({ message: 'Too big' }, e.status || 400); }
  const username = typeof body?.username === 'string' ? body.username.slice(0, 100) : '';
  const password = typeof body?.password === 'string' ? body.password.slice(0, 200) : '';
  // Always check both, so a wrong username takes as long as a wrong password.
  const [userOk, passOk] = await Promise.all([sameText(username.trim(), env.EDITOR_USERNAME || ''), verifyPassword(password, env.EDITOR_PASSWORD_HASH)]);
  if (!userOk || !passOk || !env.EDITOR_USERNAME) {
    await recordFailure(env, ip);
    await sleep(600); // waiting costs no CPU but slows down guessing
    return json({ message: 'Wrong username or password.' }, 401);
  }
  const seconds = body?.remember === true ? SESSION_LONG : SESSION_SHORT;
  return json({ ...(await sessionInfo(env, env.EDITOR_USERNAME, seconds)), token: await makeSession(env, env.EDITOR_USERNAME, seconds) });
}

async function sessionInfo(env, user, secondsOrExp, isExp = false) {
  const [owner, repo] = String(env.REPO || '').split('/');
  return {
    user,
    exp: isExp ? secondsOrExp : Math.floor(Date.now() / 1000) + secondsOrExp,
    owner,
    repo,
    branch: env.BRANCH || 'main',
  };
}

async function session(request, env) {
  const s = await checkSession(request, env);
  if (!s) return json({ message: 'Please log in again.' }, 401);
  return json(await sessionInfo(env, s.u, s.exp, true));
}

/** Check one GitHub step is something the lyrics editor needs; refuse anything else. */
function allowedStep(method, path, branch, body) {
  const ref = `/git/ref/heads/${branch}`;
  const refs = `/git/refs/heads/${branch}`;
  if (method === 'GET') {
    return path === '' || path === '/contents/data/songs.json' || path === ref
      || /^\/git\/(commits|trees|blobs)\/[0-9a-f]{40}$/.test(path);
  }
  if (method === 'POST' && path === '/git/blobs') {
    return body && typeof body.content === 'string' && (body.encoding === 'utf-8' || body.encoding === 'base64')
      && Object.keys(body).length === 2;
  }
  if (method === 'POST' && path === '/git/trees') {
    // Must build on the existing files (base_tree), and may only touch the editable paths.
    return body && SHA.test(body.base_tree) && Array.isArray(body.tree) && body.tree.length <= 1000
      && body.tree.every((e) => e && EDITABLE_PATH.test(e.path) && e.mode === '100644' && e.type === 'blob'
        && (e.sha === null ? e.path !== 'data/songs.json' : SHA.test(e.sha)) && Object.keys(e).length === 4);
  }
  if (method === 'POST' && path === '/git/commits') {
    return body && typeof body.message === 'string' && body.message.length <= 200 && SHA.test(body.tree)
      && Array.isArray(body.parents) && body.parents.length === 1 && SHA.test(body.parents[0]) && Object.keys(body).length === 3;
  }
  if (method === 'PATCH' && path === refs) {
    return body && SHA.test(body.sha) && body.force === false && Object.keys(body).length === 2;
  }
  return false;
}

async function proxy(request, env, url) {
  const s = await checkSession(request, env);
  if (!s) return json({ message: 'Please log in again.' }, 401);
  if (!/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(env.REPO || '') || !env.GITHUB_TOKEN) {
    throw new Error('REPO or GITHUB_TOKEN setting missing');
  }
  const branch = env.BRANCH || 'main';
  const path = url.pathname.slice('/gh'.length);
  let body;
  if (request.method === 'POST' || request.method === 'PATCH') {
    try { body = await readJson(request); } catch (e) { return json({ message: 'Too big' }, e.status || 400); }
  }
  if (!allowedStep(request.method, path, branch, body)) return json({ message: 'That change isn’t allowed from the website.' }, 403);

  // Only pass on the query options the site uses.
  const q = new URLSearchParams();
  if (path === '/contents/data/songs.json') q.set('ref', branch);
  if (path.startsWith('/git/trees/') && url.searchParams.get('recursive') === '1') q.set('recursive', '1');
  const search = q.toString() ? `?${q}` : '';

  const api = env.GITHUB_API || 'https://api.github.com';
  const gh = await fetch(`${api}/repos/${env.REPO}${path}${search}`, {
    method: request.method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'kpop-lyrics-editor-worker',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (gh.status === 401) {
    // GitHub rejected the Worker's own key: a setup problem, not the editor's login.
    return json({ message: 'GitHub refused the Worker’s key (GITHUB_TOKEN). It may have expired.' }, 502);
  }
  // Pass back GitHub's answer, but none of its other headers.
  return new Response(await gh.text(), { status: gh.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
