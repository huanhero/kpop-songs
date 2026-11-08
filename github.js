'use strict';

/* ------------------------------------------------------------------ */
/* Saving to GitHub                                                     */
/* ------------------------------------------------------------------ */
/*
 * The site is static, so there is no server to save to. Instead the
 * browser talks straight to the GitHub REST API (api.github.com) and
 * makes a commit, the same as uploading a file by hand.
 *
 * To be allowed to do that it needs an access key: a fine-grained
 * personal access token (PAT). Create it with the least power that works:
 *   - only this one repository
 *   - only "Contents: Read and write"
 *   - an expiry date
 * so a leaked key can't touch your other repos, account or settings.
 *
 * The key is kept in this browser only (localStorage, or sessionStorage
 * if "remember" is off) and is sent only to api.github.com. Visitors
 * without a key just read the published data/songs.json.
 *
 * Two ways to be allowed to save:
 *   1. Login mode (when index.html names an "edit-server"): your son logs in
 *      with a username and password checked by a small Cloudflare Worker.
 *      The Worker holds the GitHub key; browsers only get a session pass
 *      that expires. See worker/README-worker.md.
 *   2. Key mode (no edit-server): the browser holds the GitHub key itself.
 *
 * One save = one commit made with the Git Data API:
 *   new files (blobs) -> new folder listing (tree) -> commit -> move branch.
 * So songs.json and all new pictures land together in a single commit,
 * and pictures nothing uses any more are deleted in that same commit.
 *
 * Two devices: each save remembers which version of songs.json it was
 * based on (its "sha", a fingerprint of the file). If GitHub's copy has
 * a different fingerprint, someone saved from elsewhere in the meantime,
 * and you're asked what to do instead of silently overwriting it.
 */

const GH_KEY = 'kpop-lyrics:github';
const SYNC_KEY = 'kpop-lyrics:sync';
const GH_API = 'https://api.github.com';
const SHA = /^[0-9a-f]{40}$/;

let gh = null; // { owner, repo, branch, token }
let sync = { baseSha: null, dirty: false };
let changeSeq = 0;
let saving = false;

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const BRANCH_RE = /^(?!.*\.\.)[A-Za-z0-9._\/-]{1,100}$/;
const TOKEN_RE = /^(github_pat_[A-Za-z0-9_]{20,255}|ghp_[A-Za-z0-9]{36})$/;
const SESSION_RE = /^v1\.[A-Za-z0-9_-]{10,500}\.[A-Za-z0-9_-]{20,100}$/;

/** The login server named in index.html (<meta name="edit-server">), or '' for key mode. */
const EDIT_SERVER = (() => {
  const v = document.querySelector('meta[name="edit-server"]')?.content?.trim() || '';
  try {
    const u = new URL(v);
    if (u.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(u.hostname)) return u.origin;
  } catch { /* not set */ }
  return '';
})();

function validGh(v) {
  if (!v || !OWNER_RE.test(v.owner) || !REPO_RE.test(v.repo) || !BRANCH_RE.test(v.branch)) return false;
  if (EDIT_SERVER) {
    return v.mode === 'login' && v.server === EDIT_SERVER && SESSION_RE.test(v.token)
      && Number(v.exp) * 1000 > Date.now() && typeof v.user === 'string';
  }
  return v.mode === undefined && TOKEN_RE.test(v.token);
}

function storages() {
  const out = [];
  try { out.push(sessionStorage); } catch { /* blocked */ }
  try { out.push(localStorage); } catch { /* blocked */ }
  return out;
}

function loadGh() {
  for (const store of storages()) {
    try {
      const v = JSON.parse(store.getItem(GH_KEY) || 'null');
      if (validGh(v)) return v;
      // Login mode is on but this device still holds an old GitHub key
      // (or an expired login): remove it, it's no longer needed.
      if (v) store.removeItem(GH_KEY);
    } catch { /* ignore */ }
  }
  return null;
}

function storeGh(cfg, remember) {
  for (const store of storages()) try { store.removeItem(GH_KEY); } catch { /* ignore */ }
  if (!cfg) return;
  const target = remember ? localStorage : sessionStorage;
  try { target.setItem(GH_KEY, JSON.stringify(cfg)); } catch { /* memory only */ }
}

function loadSync() {
  try {
    const v = JSON.parse(localStorage.getItem(SYNC_KEY) || 'null');
    if (v && typeof v === 'object') return { baseSha: SHA.test(v.baseSha) ? v.baseSha : null, dirty: v.dirty === true };
  } catch { /* ignore */ }
  // No record, but lyrics in this browser = made with the older version
  // of the site, so treat them as unsaved work.
  let hasDraft = false;
  try { hasDraft = !!localStorage.getItem(STORAGE_KEY); } catch { /* ignore */ }
  return { baseSha: null, dirty: hasDraft };
}

function saveSync() {
  try { localStorage.setItem(SYNC_KEY, JSON.stringify(sync)); } catch { /* ignore */ }
}

/** Work out owner/repo from a github.io address, to pre-fill the form. */
function guessRepo() {
  const host = location.hostname.toLowerCase();
  if (!host.endsWith('.github.io')) return '';
  const owner = host.slice(0, -'.github.io'.length);
  const first = location.pathname.split('/').filter(Boolean)[0];
  return `${owner}/${first || host}`;
}

/** Same picture straight from the repo, used while GitHub Pages is still publishing. */
function rawUrl(ref) {
  if (!gh || !IMG_PATH.test(ref)) return '';
  return `https://raw.githubusercontent.com/${gh.owner}/${gh.repo}/${gh.branch.split('/').map(encodeURIComponent).join('/')}/${ref}`;
}

/* ---------- API calls ---------- */

async function ghApi(path, { method = 'GET', body } = {}, cfg = gh) {
  const url = cfg.mode === 'login'
    ? `${cfg.server}/gh${path}` // the Worker adds the real GitHub key
    : `${GH_API}/repos/${cfg.owner}/${cfg.repo}${path}`;
  const res = await fetch(url, {
    method,
    cache: 'no-store', // always ask GitHub, never a stale copy in the browser cache
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${cfg.token}`,
      ...(cfg.mode === 'login' ? {} : { 'X-GitHub-Api-Version': '2022-11-28' }), // the Worker adds this itself
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = new Error(`GitHub HTTP ${res.status}`);
    err.status = res.status;
    try { err.ghMessage = String((await res.json()).message || ''); } catch { /* ignore */ }
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

function ghErrorText(err) {
  if (gh?.mode === 'login' || EDIT_SERVER) {
    if (err?.status === 401) return 'Your login has run out — please log in again.';
    if ([403, 429, 500, 502].includes(err?.status) && err.ghMessage) return err.ghMessage;
    if (!err?.status && !err?.message?.startsWith('GitHub: ')) return 'Couldn’t reach the login server — check the internet connection.';
  }
  switch (err?.status) {
    case 401: return 'GitHub didn’t accept the key — it may be wrong or expired. Press ⚙️ GitHub to enter a new one.';
    case 403: return /rate limit/i.test(err.ghMessage || '')
      ? 'GitHub says too many requests — wait a few minutes and try again.'
      : 'The key isn’t allowed to change this repo. It needs “Contents: Read and write”.';
    case 404: return 'Repository not found. Check the name, and that the key was given access to it.';
    case 409: return 'The repository is empty — add a README on GitHub first.';
    default:
      if (err?.status) return `GitHub error ${err.status}: ${err.ghMessage || 'unknown problem'}`;
      if (err?.message?.startsWith('GitHub: ')) return err.message.slice(8);
      return 'Couldn’t reach GitHub — check the internet connection.';
  }
}

const utf8FromBase64 = (b64) =>
  new TextDecoder().decode(Uint8Array.from(atob(String(b64).replace(/\s/g, '')), (c) => c.charCodeAt(0)));

const blobToBase64 = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1] || '');
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

/** Read the latest songs.json straight from the repo (not the Pages copy, which lags). */
async function ghLoad() {
  let file;
  try {
    file = await ghApi(`/contents/${DATA_URL}?ref=${encodeURIComponent(gh.branch)}`);
  } catch (err) {
    if (err.status === 404) return { data: { version: 1, groups: [] }, sha: null };
    throw err;
  }
  let b64 = file.content;
  if (!b64 && file.size > 0) b64 = (await ghApi(`/git/blobs/${file.sha}`)).content; // files over 1 MB
  let parsed;
  try { parsed = JSON.parse(utf8FromBase64(b64 || '') || '{}'); } catch {
    throw new Error('GitHub: data/songs.json in the repo isn’t valid JSON');
  }
  return { data: normalise(parsed), sha: SHA.test(file.sha) ? file.sha : null };
}

/** Make one commit with songs.json + new pictures (and remove unused pictures). */
async function ghCommit(progress) {
  const branch = gh.branch.split('/').map(encodeURIComponent).join('/');
  const json = JSON.stringify(state, null, 2) + '\n';
  const refs = referencedImages();
  const pendingAtStart = new Set(pendingImages.keys());

  for (let attempt = 0; attempt < 2; attempt++) {
    progress('Talking to GitHub…');
    const head = (await ghApi(`/git/ref/heads/${branch}`)).object.sha;
    const baseTree = (await ghApi(`/git/commits/${head}`)).tree.sha;
    const tree = await ghApi(`/git/trees/${baseTree}?recursive=1`);
    const files = new Map(list(tree.tree, 100000).filter((e) => e?.type === 'blob').map((e) => [e.path, e.sha]));
    const remoteSha = files.get(DATA_URL) || null;

    if (remoteSha !== sync.baseSha) return { conflict: true, remote: await ghLoad() };

    const entries = [];
    const toUpload = [...refs].filter((p) => !files.has(p) && pendingImages.has(p));
    for (const [i, p] of toUpload.entries()) {
      progress(`Uploading pictures… ${i + 1} of ${toUpload.length}`);
      const blob = await ghApi('/git/blobs', { method: 'POST', body: { content: await blobToBase64(pendingImages.get(p)), encoding: 'base64' } });
      entries.push({ path: p, mode: '100644', type: 'blob', sha: blob.sha });
    }
    if (!tree.truncated) {
      for (const p of files.keys()) {
        if (/^images\/(groups|albums)\//.test(p) && !refs.has(p)) entries.push({ path: p, mode: '100644', type: 'blob', sha: null });
      }
    }

    progress('Saving songs…');
    const dataBlob = await ghApi('/git/blobs', { method: 'POST', body: { content: json, encoding: 'utf-8' } });
    if (dataBlob.sha === remoteSha && !entries.length) {
      forgetPendingImages([...pendingAtStart].filter((p) => files.has(p) || !refs.has(p)));
      return { sha: remoteSha, changed: false };
    }
    entries.push({ path: DATA_URL, mode: '100644', type: 'blob', sha: dataBlob.sha });

    const newTree = await ghApi('/git/trees', { method: 'POST', body: { base_tree: baseTree, tree: entries } });
    const newCommit = await ghApi('/git/commits', {
      method: 'POST',
      body: { message: 'Update songs from the website', tree: newTree.sha, parents: [head] },
    });
    try {
      // force:false = refuse if the branch moved since we looked (another save sneaked in).
      await ghApi(`/git/refs/heads/${branch}`, { method: 'PATCH', body: { sha: newCommit.sha, force: false } });
    } catch (err) {
      if (err.status === 422 && attempt === 0) continue; // look again and retry once
      throw err;
    }
    forgetPendingImages([...pendingAtStart].filter((p) => refs.has(p) || !referencedImages().has(p)));
    return { sha: dataBlob.sha, changed: true };
  }
  throw new Error('GitHub: the repo kept changing while saving — try again');
}

/* ---------- What the buttons do ---------- */

function setSyncStatus(message) {
  const s = $('#syncStatus');
  if (s) s.textContent = message;
}

function updateSyncUi() {
  const btn = $('#saveBtn');
  btn.disabled = saving;
  btn.textContent = saving ? 'Saving…' : '☁️ Save to GitHub';
  btn.classList.toggle('primary', sync.dirty && !saving);
  $('#editToggle').textContent = editMode ? '✏️ Editing'
    : !gh && EDIT_SERVER ? '🔑 Log in'
    : gh && sync.dirty ? '✏️ Edit •' : '✏️ Edit';
  if (!saving) {
    setSyncStatus(sync.dirty
      ? '● Not saved yet — press ☁️ Save to GitHub to share your changes.'
      : '✓ Everything is saved to GitHub.');
  }
}

/** Mark that something changed (called by commit() in app.js). */
function markChanged() {
  changeSeq++;
  sync.dirty = true;
  saveSync();
}

function adoptRemote(remote) {
  state = remote.data;
  sync = { baseSha: remote.sha, dirty: false };
  saveLocal();
  saveSync();
  forgetPendingImages([...pendingImages.keys()].filter((p) => !referencedImages().has(p)));
}

/** Load from GitHub, keeping unsaved work in this browser if there is any. */
async function syncFromGitHub() {
  const remote = await ghLoad();
  const draft = loadLocal();
  if (draft && sync.dirty) {
    state = draft;
    if (sync.baseSha !== remote.sha) conflictDialog('load', remote);
  } else {
    adoptRemote(remote);
  }
}

async function saveToGitHub() {
  if (!gh) return connectDialog();
  if (saving) return;
  saving = true;
  updateSyncUi();
  const seqAtStart = changeSeq;
  try {
    await localiseImages(setSyncStatus);
    const result = await ghCommit(setSyncStatus);
    if (result.conflict) {
      saving = false;
      conflictDialog('save', result.remote);
      return;
    }
    sync = { baseSha: result.sha, dirty: changeSeq !== seqAtStart };
    saveSync();
    toast(result.changed ? 'Saved to GitHub ✓ The public site updates in a minute or two.' : 'Already up to date ✓');
  } catch (err) {
    console.warn(err);
    toast(ghErrorText(err));
    if (err.status === 401 && gh?.mode === 'login') { saving = false; await logOut(true); loginDialog(); }
  } finally {
    saving = false;
    render();
  }
}

/** Two copies disagree: let the person choose instead of losing anything silently. */
function conflictDialog(when, remote) {
  const neverSaved = when === 'load' && !sync.baseSha;
  const msg = neverSaved
    ? 'This browser has songs that were never saved to GitHub, and GitHub has its own copy.'
    : 'Someone saved changes from another device or browser since you started editing here.';
  openPanel({
    title: 'Two different versions',
    body: el('div', { class: 'picker' },
      el('p', {}, msg),
      el('p', {}, 'Which one do you want to keep? If unsure, download a backup of yours first.'),
      el('button', { type: 'button', onclick: exportData }, '⬇️ Download a backup of mine')),
    actions: [
      el('button', {
        type: 'button',
        onclick: () => { adoptRemote(remote); $('#formDialog').close(); render(); toast('Loaded the GitHub version'); },
      }, 'Use GitHub’s version'),
      el('button', {
        type: 'button', class: 'primary',
        onclick: () => {
          sync.baseSha = remote.sha; // accept that ours replaces theirs
          sync.dirty = true;
          saveSync();
          $('#formDialog').close();
          if (when === 'save') saveToGitHub(); else { render(); toast('Keeping yours — press ☁️ Save to GitHub to replace GitHub’s copy'); }
        },
      }, when === 'save' ? 'Replace it with mine' : 'Keep mine'),
    ],
  });
}

/* ---------- Login mode ---------- */

function loginDialog() {
  const userInput = el('input', { id: 'login-user', autocomplete: 'username', spellcheck: 'false', autocapitalize: 'none', maxlength: 100 });
  const passInput = el('input', { id: 'login-pass', type: 'password', autocomplete: 'current-password', maxlength: 200 });
  const remember = el('input', { type: 'checkbox', id: 'login-remember', checked: true });
  const status = el('p', { class: 'pick-status', role: 'alert' });
  const loginBtn = el('button', { type: 'button', class: 'primary' }, 'Log in');

  const submit = async () => {
    if (!userInput.value.trim() || !passInput.value) { status.textContent = 'Type your username and password.'; return; }
    loginBtn.disabled = true;
    status.textContent = 'Checking…';
    try {
      const res = await fetch(`${EDIT_SERVER}/login`, {
        method: 'POST',
        cache: 'no-store',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: userInput.value.trim(), password: passInput.value, remember: remember.checked }),
      });
      const data = await res.json().catch(() => ({}));
      passInput.value = ''; // don't keep the password around in the page
      if (!res.ok) { status.textContent = String(data.message || `Login failed (${res.status})`).slice(0, 200); return; }
      const cfg = {
        mode: 'login', server: EDIT_SERVER, token: data.token, exp: data.exp, user: text(data.user, 100),
        owner: data.owner, repo: data.repo, branch: data.branch,
      };
      if (!validGh(cfg)) { status.textContent = 'The login server sent something unexpected — check its settings.'; return; }
      gh = cfg;
      storeGh(cfg, remember.checked);
      $('#formDialog').close();
      editMode = true;
      try { localStorage.setItem(EDIT_KEY, '1'); } catch { /* ignore */ }
      await syncFromGitHub();
      render();
      toast(`Hi ${cfg.user}! You can edit now.`);
    } catch (err) {
      console.warn(err);
      status.textContent = 'Couldn’t reach the login server — check the internet connection.';
    } finally {
      loginBtn.disabled = false;
    }
  };
  loginBtn.addEventListener('click', submit);
  for (const input of [userInput, passInput]) {
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
  }

  openPanel({
    title: 'Log in to edit',
    body: el('div', { class: 'picker' },
      el('p', { class: 'pick-status' }, 'Only the editor can change songs. Everyone else can just browse.'),
      el('div', { class: 'field' }, el('label', { for: 'login-user' }, 'Username'), userInput),
      el('div', { class: 'field' }, el('label', { for: 'login-pass' }, 'Password'), passInput),
      el('label', { class: 'check-row', for: 'login-remember' }, remember, ' Stay logged in for 30 days (untick on shared computers)'),
      status),
    actions: [
      el('button', { type: 'button', onclick: () => $('#formDialog').close() }, 'Cancel'),
      loginBtn,
    ],
  });
  userInput.focus();
}

/** Forget the login on this device. Unsaved changes stay in the browser. */
async function logOut(quiet = false) {
  storeGh(null);
  gh = null;
  editMode = false;
  try { localStorage.setItem(EDIT_KEY, '0'); } catch { /* ignore */ }
  state = await loadPublished();
  render();
  if (!quiet) toast('Logged out');
}

function connectDialog() {
  if (EDIT_SERVER) return loginDialog();
  const repoInput = el('input', { id: 'gh-repo', autocomplete: 'off', spellcheck: 'false', placeholder: 'your-username/kpop-lyrics' });
  repoInput.value = gh ? `${gh.owner}/${gh.repo}` : guessRepo();
  const tokenInput = el('input', { id: 'gh-token', type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: 'github_pat_…' });
  const remember = el('input', { type: 'checkbox', id: 'gh-remember', checked: true });
  const status = el('p', { class: 'pick-status' });
  const connectBtn = el('button', { type: 'button', class: 'primary' }, 'Connect');

  connectBtn.addEventListener('click', async () => {
    const m = /^(?:https:\/\/github\.com\/)?([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(repoInput.value.trim());
    const token = tokenInput.value.trim();
    if (!m || !OWNER_RE.test(m[1]) || !REPO_RE.test(m[2])) { status.textContent = 'Repository should look like username/kpop-lyrics.'; return; }
    if (!TOKEN_RE.test(token)) { status.textContent = 'That doesn’t look like a GitHub key. Fine-grained keys start with github_pat_'; return; }
    const cfg = { owner: m[1], repo: m[2], branch: 'main', token };
    connectBtn.disabled = true;
    status.textContent = 'Checking…';
    try {
      const info = await ghApi('', {}, cfg);
      if (info.permissions && info.permissions.push === false) throw Object.assign(new Error('GitHub'), { status: 403 });
      cfg.branch = BRANCH_RE.test(info.default_branch) ? info.default_branch : 'main';
      gh = cfg;
      storeGh(cfg, remember.checked);
      $('#formDialog').close();
      editMode = true;
      try { localStorage.setItem(EDIT_KEY, '1'); } catch { /* ignore */ }
      await syncFromGitHub();
      render();
      toast(token.startsWith('ghp_')
        ? 'Connected — tip: a fine-grained key limited to this repo is safer than this classic key'
        : `Connected to ${cfg.owner}/${cfg.repo} ✓`);
    } catch (err) {
      console.warn(err);
      status.textContent = ghErrorText(err);
      connectBtn.disabled = false;
    }
  });

  const link = (href, label) => el('a', { href, target: '_blank', rel: 'noopener noreferrer' }, label);
  openPanel({
    title: 'Connect to GitHub to edit',
    body: el('div', { class: 'picker' },
      el('p', { class: 'pick-status' }, 'Visitors can just browse. To add or change songs, this browser needs a GitHub key for the site’s repository.'),
      el('div', { class: 'field' }, el('label', { for: 'gh-repo' }, 'Repository'), repoInput),
      el('div', { class: 'field' }, el('label', { for: 'gh-token' }, 'GitHub key (fine-grained personal access token)'), tokenInput),
      el('label', { class: 'check-row', for: 'gh-remember' }, remember, ' Remember on this device (untick on shared computers)'),
      el('details', { class: 'help' },
        el('summary', {}, 'How do I make a key?'),
        el('ol', {},
          el('li', {}, 'Open ', link('https://github.com/settings/personal-access-tokens/new', 'GitHub → New fine-grained token'), ' (signed in as the repo owner).'),
          el('li', {}, 'Name it e.g. “kpop-lyrics site” and pick an expiry date.'),
          el('li', {}, 'Repository access: “Only select repositories” → this site’s repo.'),
          el('li', {}, 'Permissions → Repository permissions → Contents: “Read and write”. Nothing else.'),
          el('li', {}, 'Generate, copy the key (starts with github_pat_) and paste it here.'))),
      status),
    actions: [
      el('button', { type: 'button', onclick: () => $('#formDialog').close() }, 'Cancel'),
      connectBtn,
    ],
  });
  (repoInput.value ? tokenInput : repoInput).focus();
}

function settingsDialog() {
  if (!gh) return connectDialog();
  if (gh.mode === 'login') {
    openPanel({
      title: 'Your login',
      body: el('div', { class: 'picker' },
        el('p', {}, 'Logged in as ', el('strong', {}, gh.user), '. Saving to ', el('strong', {}, `${gh.owner}/${gh.repo}`), '.'),
        el('p', { class: 'pick-status' }, `This device stays logged in until ${new Date(gh.exp * 1000).toLocaleString()}. Unsaved changes stay here after logging out.`)),
      actions: [
        el('button', { type: 'button', class: 'danger', onclick: () => { $('#formDialog').close(); logOut(); } }, 'Log out'),
        el('button', { type: 'button', class: 'primary', onclick: () => $('#formDialog').close() }, 'Close'),
      ],
    });
    return;
  }
  openPanel({
    title: 'GitHub connection',
    body: el('div', { class: 'picker' },
      el('p', {}, 'Saving to ', el('strong', {}, `${gh.owner}/${gh.repo}`), ` (branch ${gh.branch}).`),
      el('p', { class: 'pick-status' }, 'Disconnecting removes the key from this browser. Unsaved changes stay here and are offered again when you reconnect.')),
    actions: [
      el('button', { type: 'button', onclick: () => { $('#formDialog').close(); connectDialog(); } }, 'Change key'),
      el('button', {
        type: 'button', class: 'danger',
        onclick: async () => {
          storeGh(null);
          gh = null;
          editMode = false;
          try { localStorage.setItem(EDIT_KEY, '0'); } catch { /* ignore */ }
          $('#formDialog').close();
          state = await loadPublished();
          render();
          toast('Disconnected — key removed from this browser');
        },
      }, 'Disconnect'),
      el('button', { type: 'button', class: 'primary', onclick: () => $('#formDialog').close() }, 'Close'),
    ],
  });
}
