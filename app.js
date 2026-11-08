'use strict';

/*
 * My K-pop Lyrics — a static site for GitHub Pages.
 *
 * Data model (data/songs.json):
 *   groups[] -> albums[] -> songs[] -> romanisation[] + english[]
 * Line N of `romanisation` is shown with line N of `english`.
 * An empty line in both = a gap between verses.
 *
 * Files:
 *   app.js         pages, forms and start-up (this file)
 *   musicbrainz.js searching for groups and albums
 *   images.js      group pictures and album covers
 *   github.js      saving straight to the GitHub repository
 *
 * Where data lives:
 *   1. data/songs.json + images/ in the repo = the shared copy everyone sees.
 *   2. localStorage in the editing browser   = a draft, so nothing is lost
 *      before "Save to GitHub" is pressed (or if the internet drops).
 *
 * Security notes:
 *   - All user text is inserted with textContent (via el()), never innerHTML,
 *     so typing <script> into a song title just shows the text.
 *   - Imported / fetched JSON is validated and rebuilt by normalise().
 *   - Pictures are either files inside images/ in the repo or https:// links.
 *   - Group/album search talks to the public MusicBrainz API. Its answers
 *     are treated as untrusted too: same el()/textContent path, same
 *     validation, and the search text is escaped before it goes into
 *     MusicBrainz's query language.
 */

const STORAGE_KEY = 'kpop-lyrics:data:v1';
const EDIT_KEY = 'kpop-lyrics:edit';
const DATA_URL = 'data/songs.json';
const DEFAULT_COLOR = '#8b5cf6';
const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

let state = { version: 1, groups: [] };
let editMode = false;
let practiceMode = false; // blurs English lines until tapped

const $ = (sel) => document.querySelector(sel);
const app = $('#app');

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function uid() {
  const raw = (window.crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return raw.replace(/-/g, '').slice(0, 12);
}

/** Build a DOM element safely. Text children always become text nodes. */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'vars') {
      for (const [k, v] of Object.entries(value)) node.style.setProperty(k, v);
    } else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

let toastTimer;
function toast(message) {
  const t = $('#toast');
  t.textContent = message;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2500);
}

/** Split textarea text into lines, dropping blank lines at the very end. */
function splitLines(value) {
  const arr = String(value).replace(/\r/g, '').split('\n');
  while (arr.length && !arr[arr.length - 1].trim()) arr.pop();
  return arr;
}

/* ------------------------------------------------------------------ */
/* Validation: rebuild any incoming data into a known-good shape       */
/* ------------------------------------------------------------------ */

const text = (v, max = 200) =>
  typeof v === 'string' ? v.slice(0, max).trim() : typeof v === 'number' ? String(v) : '';
const list = (v, max = 500) => (Array.isArray(v) ? v.slice(0, max) : []);
const lines = (v) =>
  (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/\r?\n/) : [])
    .slice(0, 1000)
    .map((l) => (typeof l === 'string' ? l.slice(0, 500) : ''));
const color = (v) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : DEFAULT_COLOR);
const mbid = (v) => (typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? v.toLowerCase() : '');
const safeId = (v) => (typeof v === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(v) ? v : uid());

function httpsUrl(v) {
  if (typeof v !== 'string' || !v.trim()) return '';
  try {
    const u = new URL(v.trim());
    return u.protocol === 'https:' ? u.href : '';
  } catch {
    return '';
  }
}

function normalise(data) {
  return {
    version: 1,
    groups: list(data && data.groups).map((g) => ({
      id: safeId(g?.id),
      name: text(g?.name, 100) || 'Untitled group',
      color: color(g?.color),
      mbid: mbid(g?.mbid),
      image: imgRef(g?.image),
      imageCredit: text(g?.imageCredit, 200),
      imageSource: httpsUrl(g?.imageSource),
      albums: list(g?.albums).map((a) => ({
        id: safeId(a?.id),
        title: text(a?.title, 150) || 'Untitled album',
        year: text(a?.year, 10),
        cover: imgRef(a?.cover),
        mbid: mbid(a?.mbid),
        songs: list(a?.songs).map((s) => ({
          id: safeId(s?.id),
          title: text(s?.title, 150) || 'Untitled song',
          romanisation: lines(s?.romanisation),
          english: lines(s?.english),
        })),
      })),
    })),
  };
}

/* ------------------------------------------------------------------ */
/* Storage                                                             */
/* ------------------------------------------------------------------ */

function saveLocal() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    toast('Could not save in this browser (storage full or blocked).');
  }
}

function loadLocal() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? normalise(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

async function loadPublished() {
  try {
    const res = await fetch(DATA_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return normalise(await res.json());
  } catch (err) {
    console.warn(`Could not load ${DATA_URL}:`, err);
    return { version: 1, groups: [] };
  }
}

/** Something changed: keep a draft, mark it unsaved, redraw. */
function commit(message) {
  markChanged();
  saveLocal();
  render();
  if (message) toast(message);
}

/* ------------------------------------------------------------------ */
/* Routing: #/groupId/albumId/songId                                   */
/* ------------------------------------------------------------------ */

function route() {
  const parts = location.hash
    .replace(/^#\/?/, '')
    .split('/')
    .filter(Boolean)
    .map((p) => {
      try { return decodeURIComponent(p); } catch { return ''; }
    });
  const group = state.groups.find((g) => g.id === parts[0]);
  const album = group?.albums.find((a) => a.id === parts[1]);
  const song = album?.songs.find((s) => s.id === parts[2]);
  return { group, album, song };
}

const href = (...ids) => '#/' + ids.map(encodeURIComponent).join('/');

/* ------------------------------------------------------------------ */
/* Pop-up form (used for every add / edit)                             */
/* ------------------------------------------------------------------ */

function openForm({ title, fields, values = {}, submitLabel = 'Save', onSave, onBuild }) {
  const dialog = $('#formDialog');
  const form = $('#dialogForm');
  const inputs = {};

  const fieldEls = fields.map((f) => {
    const fid = 'f-' + f.name;
    const input = f.type === 'textarea'
      ? el('textarea', { id: fid, name: f.name, rows: f.rows || 14, wrap: 'off', spellcheck: 'false', placeholder: f.placeholder })
      : el('input', { id: fid, name: f.name, type: f.type || 'text', placeholder: f.placeholder, required: f.required, maxlength: f.maxlength, autocomplete: 'off' });
    input.value = values[f.name] ?? '';
    inputs[f.name] = input;
    return el('div', { class: 'field' },
      el('label', { for: fid }, f.label),
      input,
      f.hint ? el('small', { class: 'hint' }, f.hint) : null);
  });

  form.replaceChildren(
    el('h2', {}, title),
    el('div', { class: 'fields' }, fieldEls),
    el('div', { class: 'dialog-actions' },
      el('button', { type: 'button', onclick: () => dialog.close() }, 'Cancel'),
      el('button', { type: 'submit', class: 'primary' }, submitLabel)),
  );

  dialog.onclose = null;
  form.onsubmit = (e) => {
    e.preventDefault();
    const out = {};
    for (const [k, input] of Object.entries(inputs)) out[k] = input.value;
    if (onSave(out) !== false) dialog.close();
  };

  if (onBuild) onBuild(inputs, form);
  dialog.showModal();
  inputs[fields[0].name]?.focus();
}

/* ------------------------------------------------------------------ */
/* Add / edit forms                                                    */
/* ------------------------------------------------------------------ */

function groupForm(group) {
  let picture;
  openForm({
    title: group ? 'Edit group' : 'Add a K-pop group',
    fields: [
      { name: 'name', label: 'Group name', required: true, maxlength: 100 },
      { name: 'color', label: 'Theme colour', type: 'color', hint: 'Used for this group’s pages.' },
    ],
    values: group ? { name: group.name, color: group.color } : { color: DEFAULT_COLOR },
    onBuild: (inputs, form) => {
      picture = imageField({
        kind: 'groups',
        current: group?.image,
        finder: group?.mbid ? () => findGroupPictures(group.mbid) : null,
      });
      form.querySelector('.fields').append(picture.node);
    },
    onSave: (v) => {
      const data = { name: text(v.name, 100) || 'Untitled group', color: color(v.color) };
      let target = group;
      if (group) Object.assign(group, data);
      else {
        target = { id: uid(), ...data, mbid: '', image: '', imageCredit: '', imageSource: '', albums: [] };
        state.groups.push(target);
      }
      picture.apply(target, 'image');
      commit(group ? 'Group updated' : 'Group added');
    },
  });
}

function albumForm(group, album) {
  let picture;
  openForm({
    title: album ? 'Edit album' : `Add an album to ${group.name}`,
    fields: [
      { name: 'title', label: 'Album title', required: true, maxlength: 150 },
      { name: 'year', label: 'Year (optional)', maxlength: 10, placeholder: 'e.g. 2025' },
    ],
    values: album ? { title: album.title, year: album.year } : {},
    onBuild: (inputs, form) => {
      picture = imageField({ kind: 'albums', current: album?.cover });
      form.querySelector('.fields').append(picture.node);
    },
    onSave: (v) => {
      const data = { title: text(v.title, 150) || 'Untitled album', year: text(v.year, 10) };
      let target = album;
      if (album) Object.assign(album, data);
      else {
        target = { id: uid(), ...data, cover: '', mbid: '', songs: [] };
        group.albums.push(target);
      }
      picture.apply(target, 'cover');
      commit(album ? 'Album updated' : 'Album added');
    },
  });
}

function songForm(album, song) {
  openForm({
    title: song ? `Edit “${song.title}”` : `Add a song to ${album.title}`,
    fields: [
      { name: 'title', label: 'Song title', required: true, maxlength: 150 },
      { name: 'romanisation', label: 'Korean (romanised) — one line per lyric line', type: 'textarea', placeholder: 'annyeonghaseyo\n…' },
      { name: 'english', label: 'English — same line number as the Korean', type: 'textarea', placeholder: 'hello\n…' },
    ],
    values: song
      ? { title: song.title, romanisation: song.romanisation.join('\n'), english: song.english.join('\n') }
      : {},
    onBuild: (inputs, form) => {
      // Live line counter so the two columns stay matched.
      const status = el('p', { class: 'line-status' });
      const update = () => {
        const r = splitLines(inputs.romanisation.value).length;
        const e = splitLines(inputs.english.value).length;
        const ok = r === e;
        status.textContent = `Korean: ${r} lines · English: ${e} lines — ` +
          (ok ? 'matched ✓' : 'counts differ ⚠ each Korean line needs one English line');
        status.classList.toggle('warn', !ok);
      };
      inputs.romanisation.addEventListener('input', update);
      inputs.english.addEventListener('input', update);
      update();
      // Scroll both boxes together so line 12 sits next to line 12.
      const linkScroll = (from, to) => from.addEventListener('scroll', () => { to.scrollTop = from.scrollTop; });
      linkScroll(inputs.romanisation, inputs.english);
      linkScroll(inputs.english, inputs.romanisation);
      form.querySelector('.fields').classList.add('lyrics-fields');
      form.querySelector('.fields').after(status);
    },
    onSave: (v) => {
      const data = {
        title: text(v.title, 150) || 'Untitled song',
        romanisation: lines(splitLines(v.romanisation)),
        english: lines(splitLines(v.english)),
      };
      if (song) Object.assign(song, data);
      else album.songs.push({ id: uid(), ...data });
      commit(song ? 'Song saved' : 'Song added');
    },
  });
}

/* ------------------------------------------------------------------ */
/* Shared bits for list items                                          */
/* ------------------------------------------------------------------ */

function move(arr, i, dir) {
  const j = i + dir;
  if (j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]];
  commit();
}

function itemControls(arr, item, onEdit, label) {
  const i = arr.indexOf(item);
  const stop = (fn) => (e) => { e.preventDefault(); e.stopPropagation(); fn(); };
  return el('div', { class: 'item-controls edit-only' },
    el('button', { type: 'button', 'aria-label': `Move ${label} up`, title: 'Move up', disabled: i === 0, onclick: stop(() => move(arr, i, -1)) }, '↑'),
    el('button', { type: 'button', 'aria-label': `Move ${label} down`, title: 'Move down', disabled: i === arr.length - 1, onclick: stop(() => move(arr, i, 1)) }, '↓'),
    el('button', { type: 'button', 'aria-label': `Edit ${label}`, title: 'Edit', onclick: stop(onEdit) }, '✏️'),
    el('button', {
      type: 'button', class: 'danger', 'aria-label': `Delete ${label}`, title: 'Delete',
      onclick: stop(() => {
        if (confirm(`Delete “${label}” and everything inside it?`)) {
          arr.splice(arr.indexOf(item), 1);
          commit('Deleted');
        }
      }),
    }, '🗑'));
}

const addButton = (label, onclick) => el('button', { type: 'button', class: 'primary edit-only', onclick }, label);

const emptyState = (title, hint) => el('div', { class: 'empty' }, el('p', { class: 'empty-title' }, title), el('p', {}, hint));

/**
 * Show a stored picture. If it fails (e.g. GitHub Pages hasn't published a
 * just-saved picture yet), try the copy in the repo, then a placeholder.
 */
function pictureEl(ref, cls, placeholder) {
  if (!ref) return placeholder();
  const img = el('img', { class: cls, src: imgSrc(ref), alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
  let triedRaw = false;
  img.addEventListener('error', () => {
    const raw = rawUrl(ref);
    if (raw && !triedRaw) { triedRaw = true; img.src = raw; } else img.replaceWith(placeholder());
  });
  return img;
}

const coverEl = (album, extraClass = '') => pictureEl(album.cover, `cover ${extraClass}`,
  () => el('div', { class: `cover ${extraClass}`, 'aria-hidden': 'true' }, (album.title[0] || '♪').toUpperCase()));

const groupPicEl = (g) => pictureEl(g.image, 'swatch photo',
  () => el('span', { class: 'swatch', vars: { '--c': g.color }, 'aria-hidden': 'true' }, (g.name[0] || '★').toUpperCase()));

function breadcrumbs({ group, album, song }) {
  const items = [el('li', {}, group ? el('a', { href: '#/' }, 'Groups') : 'Groups')];
  if (group) items.push(el('li', {}, album ? el('a', { href: href(group.id) }, group.name) : group.name));
  if (album) items.push(el('li', {}, song ? el('a', { href: href(group.id, album.id) }, album.title) : album.title));
  if (song) items.push(el('li', { 'aria-current': 'page' }, song.title));
  return el('nav', { class: 'crumbs', 'aria-label': 'Breadcrumb' }, el('ol', {}, items));
}

/* ------------------------------------------------------------------ */
/* Pages                                                               */
/* ------------------------------------------------------------------ */

function homeView() {
  const groups = state.groups;
  return el('section', {},
    el('div', { class: 'section-head' },
      el('h1', {}, 'My groups'),
      addButton('+ Add group', () => groupSearch())),
    groups.length
      ? el('ul', { class: 'card-grid' }, groups.map((g) =>
          el('li', { class: 'card' },
            el('a', { class: 'card-link', href: href(g.id) },
              groupPicEl(g),
              el('span', { class: 'card-title' }, g.name),
              el('span', { class: 'card-meta' }, plural(g.albums.length, 'album'))),
            itemControls(groups, g, () => groupForm(g), g.name))))
      : emptyState('No groups yet.', 'Press ✏️ Edit at the top, then “+ Add group”.'));
}

function groupView(group) {
  const albums = group.albums;
  const credit = group.image && group.imageCredit
    ? el('p', { class: 'credit' }, group.imageSource
      ? el('a', { href: group.imageSource, target: '_blank', rel: 'noopener noreferrer' }, group.imageCredit)
      : group.imageCredit)
    : null;
  return el('section', {},
    group.image ? el('figure', { class: 'group-hero' }, pictureEl(group.image, 'hero', () => el('span')), credit) : null,
    el('div', { class: 'section-head' },
      el('h1', {}, group.name),
      el('div', { class: 'head-actions' },
        el('button', { type: 'button', class: 'edit-only', onclick: () => groupForm(group) }, '✏️ Edit group'),
        el('button', { type: 'button', class: 'edit-only', onclick: () => albumForm(group) }, '⌨️ Type an album'),
        addButton('🔍 Find albums', () => albumPicker(group)))),
    albums.length
      ? el('ul', { class: 'card-grid' }, albums.map((a) =>
          el('li', { class: 'card' },
            el('a', { class: 'card-link', href: href(group.id, a.id) },
              coverEl(a),
              el('span', { class: 'card-title' }, a.title),
              el('span', { class: 'card-meta' }, [a.year, plural(a.songs.length, 'song')].filter(Boolean).join(' · '))),
            itemControls(albums, a, () => albumForm(group, a), a.title))))
      : emptyState('No albums yet.', 'Turn on ✏️ Edit and press “🔍 Find albums”.'));
}

function albumView(group, album) {
  const songs = album.songs;
  return el('section', {},
    el('div', { class: 'album-head' },
      coverEl(album, 'large'),
      el('div', {},
        el('p', { class: 'eyebrow' }, group.name),
        el('h1', {}, album.title),
        el('p', { class: 'card-meta' }, [album.year, plural(songs.length, 'song')].filter(Boolean).join(' · ')),
        el('div', { class: 'head-actions' },
          el('button', { type: 'button', class: 'edit-only', onclick: () => albumForm(group, album) }, '✏️ Edit album'),
          addButton('+ Add song', () => songForm(album))))),
    songs.length
      ? el('ol', { class: 'song-list' }, songs.map((s, i) =>
          el('li', {},
            el('a', { href: href(group.id, album.id, s.id) },
              el('span', { class: 'track' }, i + 1),
              el('span', { class: 'song-title' }, s.title),
              s.romanisation.length ? null : el('span', { class: 'badge' }, 'no lyrics yet')),
            itemControls(songs, s, () => songForm(album, s), s.title))))
      : emptyState('No songs yet.', 'Turn on ✏️ Edit and add a song.'));
}

function songView(group, album, song) {
  const rom = song.romanisation;
  const en = song.english;
  const total = Math.max(rom.length, en.length);

  const lyrics = el('div', { class: 'lyrics' + (practiceMode ? ' practice' : '') });
  for (let i = 0; i < total; i++) {
    const r = rom[i] ?? '';
    const e = en[i] ?? '';
    if (!r.trim() && !e.trim()) {
      lyrics.append(el('div', { class: 'verse-gap', 'aria-hidden': 'true' }));
      continue;
    }
    lyrics.append(el('div', { class: 'line-pair' },
      el('p', { class: 'rom', lang: 'ko-Latn' }, r),
      el('p', { class: 'en', lang: 'en' }, e)));
  }
  lyrics.addEventListener('click', (ev) => {
    if (!practiceMode) return;
    ev.target.closest('.line-pair')?.classList.toggle('reveal');
  });

  const idx = album.songs.indexOf(song);
  const prev = album.songs[idx - 1];
  const next = album.songs[idx + 1];

  return el('article', {},
    el('header', { class: 'song-head' },
      el('p', { class: 'eyebrow' }, `${group.name} · ${album.title}`),
      el('h1', {}, song.title)),
    el('div', { class: 'toolbar' },
      el('button', {
        type: 'button', 'aria-pressed': String(practiceMode),
        title: 'Blur the English so you can test yourself — tap a line to reveal it',
        onclick: () => { practiceMode = !practiceMode; render(); },
      }, '🙈 Practice mode'),
      el('button', { type: 'button', class: 'edit-only', onclick: () => songForm(album, song) }, '✏️ Edit lyrics')),
    total
      ? lyrics
      : emptyState('No lyrics yet.', 'Turn on ✏️ Edit and press “Edit lyrics”.'),
    el('nav', { class: 'song-nav', 'aria-label': 'Other songs on this album' },
      prev ? el('a', { href: href(group.id, album.id, prev.id) }, `← ${prev.title}`) : el('span'),
      next ? el('a', { href: href(group.id, album.id, next.id) }, `${next.title} →`) : el('span')));
}

/* ------------------------------------------------------------------ */
/* Render                                                              */
/* ------------------------------------------------------------------ */

function render() {
  const r = route();
  const { group, album, song } = r;
  document.body.classList.toggle('editing', editMode);
  $('#editToggle').setAttribute('aria-pressed', String(editMode));
  document.documentElement.style.setProperty('--accent', group?.color || DEFAULT_COLOR);
  document.title = [song?.title, album?.title, group?.name, 'My K-pop Lyrics'].filter(Boolean).join(' · ');

  let view;
  if (song) view = songView(group, album, song);
  else if (album) view = albumView(group, album);
  else if (group) view = groupView(group);
  else view = homeView();

  app.replaceChildren(breadcrumbs(r), view);
  updateSyncUi();
}

/* ------------------------------------------------------------------ */
/* Toolbar: edit / export / import / reset                             */
/* ------------------------------------------------------------------ */

function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2) + '\n'], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: 'songs.json' });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('Downloaded songs.json (a backup copy)');
}

function wireToolbar() {
  $('#editToggle').addEventListener('click', () => {
    if (!gh) return connectDialog(); // editing needs a GitHub key
    editMode = !editMode;
    try { localStorage.setItem(EDIT_KEY, editMode ? '1' : '0'); } catch { /* ignore */ }
    render();
  });

  $('#saveBtn').addEventListener('click', () => saveToGitHub());
  $('#ghBtn').addEventListener('click', () => settingsDialog());
  $('#exportBtn').addEventListener('click', exportData);

  $('#importFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) return toast('That file is too big (max 2 MB).');
    try {
      const data = normalise(JSON.parse(await file.text()));
      if (!confirm(`Replace everything here with ${plural(data.groups.length, 'group')} from “${file.name}”? (Nothing changes on GitHub until you press Save.)`)) return;
      state = data;
      location.hash = '#/';
      commit('Imported — press ☁️ Save to GitHub to keep it');
    } catch {
      toast('That file isn’t valid JSON.');
    }
  });

  $('#resetBtn').addEventListener('click', async () => {
    if (!confirm('Throw away the changes not yet saved to GitHub, and load the latest from GitHub?')) return;
    try {
      adoptRemote(await ghLoad());
      location.hash = '#/';
      render();
      toast('Loaded the latest version from GitHub');
    } catch (err) {
      toast(ghErrorText(err));
    }
  });

  window.addEventListener('hashchange', () => {
    render();
    window.scrollTo(0, 0);
  });
}

async function init() {
  wireToolbar();
  gh = loadGh();
  sync = loadSync();
  await loadPendingImages();
  if (gh) {
    // Editing browser: read the latest straight from the repo.
    try { editMode = localStorage.getItem(EDIT_KEY) === '1'; } catch { /* ignore */ }
    try {
      await syncFromGitHub();
    } catch (err) {
      console.warn(err);
      if (err.status === 401 && gh?.mode === 'login') {
        await logOut(true); // login expired or was cancelled
        toast('Your login has run out — press 🔑 Log in to edit again.');
        return;
      }
      state = loadLocal() || await loadPublished();
      toast(ghErrorText(err));
    }
  } else {
    // Visitors: read the published copy from GitHub Pages.
    state = await loadPublished();
    editMode = false;
  }
  render();
}

init();
