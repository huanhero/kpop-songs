'use strict';

/*
 * My K-pop Lyrics — a static site for GitHub Pages.
 *
 * Data model (data/songs.json):
 *   groups[] -> albums[] -> songs[] -> romanisation[] + english[]
 * Line N of `romanisation` is shown with line N of `english`.
 * An empty line in both = a gap between verses.
 *
 * Where data lives:
 *   1. data/songs.json in the repo  = the "published" copy everyone sees.
 *   2. localStorage in the browser  = your son's working copy while editing.
 *   Export downloads the working copy so it can be uploaded to the repo.
 *
 * Security notes:
 *   - All user text is inserted with textContent (via el()), never innerHTML,
 *     so typing <script> into a song title just shows the text.
 *   - Imported / fetched JSON is validated and rebuilt by normalise().
 *   - Cover images must be https:// URLs.
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
      albums: list(g?.albums).map((a) => ({
        id: safeId(a?.id),
        title: text(a?.title, 150) || 'Untitled album',
        year: text(a?.year, 10),
        cover: httpsUrl(a?.cover),
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

/** Save + redraw after any change. */
function commit(message) {
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
  openForm({
    title: group ? 'Edit group' : 'Add a K-pop group',
    fields: [
      { name: 'name', label: 'Group name', required: true, maxlength: 100 },
      { name: 'color', label: 'Theme colour', type: 'color', hint: 'Used for this group’s pages.' },
    ],
    values: group ? { name: group.name, color: group.color } : { color: DEFAULT_COLOR },
    onSave: (v) => {
      const data = { name: text(v.name, 100) || 'Untitled group', color: color(v.color) };
      if (group) Object.assign(group, data);
      else state.groups.push({ id: uid(), ...data, albums: [] });
      commit(group ? 'Group updated' : 'Group added');
    },
  });
}

function albumForm(group, album) {
  openForm({
    title: album ? 'Edit album' : `Add an album to ${group.name}`,
    fields: [
      { name: 'title', label: 'Album title', required: true, maxlength: 150 },
      { name: 'year', label: 'Year (optional)', maxlength: 10, placeholder: 'e.g. 2025' },
      { name: 'cover', label: 'Cover image link (optional)', type: 'url', placeholder: 'https://…', hint: 'Must start with https://' },
    ],
    values: album ? { title: album.title, year: album.year, cover: album.cover } : {},
    onSave: (v) => {
      if (v.cover.trim() && !httpsUrl(v.cover)) {
        toast('Cover link must start with https://');
        return false;
      }
      const data = { title: text(v.title, 150) || 'Untitled album', year: text(v.year, 10), cover: httpsUrl(v.cover) };
      if (album) Object.assign(album, data);
      else group.albums.push({ id: uid(), ...data, songs: [] });
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
      const sync = (from, to) => from.addEventListener('scroll', () => { to.scrollTop = from.scrollTop; });
      sync(inputs.romanisation, inputs.english);
      sync(inputs.english, inputs.romanisation);
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
/* MusicBrainz search: find a group, then tick the albums to add       */
/* ------------------------------------------------------------------ */
/*
 * MusicBrainz (musicbrainz.org) is a free, community-run music database.
 * Its web API needs no key and allows browser requests, but asks every
 * app to make at most ONE request per second, or the IP gets blocked.
 * So every call goes through mbFetch(), which queues requests and spaces
 * them ~1.1 s apart.
 */

const MB_API = 'https://musicbrainz.org/ws/2/';
const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/;
const GROUP_COLORS = ['#8b5cf6', '#ec4899', '#06b6d4', '#f97316', '#10b981', '#3b82f6', '#e11d48', '#a855f7'];

let mbQueue = Promise.resolve();
let mbLastCall = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mbFetch(path, params, signal) {
  const run = async () => {
    for (let attempt = 0; ; attempt++) {
      const wait = mbLastCall + 1100 - Date.now();
      if (wait > 0) await sleep(wait);
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      mbLastCall = Date.now();
      const url = new URL(path, MB_API);
      for (const [k, v] of Object.entries({ ...params, fmt: 'json' })) url.searchParams.set(k, v);
      // credentials:'omit' + no-referrer: send MusicBrainz nothing but the query itself.
      const res = await fetch(url, { signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (res.status === 503 && attempt < 1) { await sleep(2000); continue; } // "slow down" — retry once
      if (!res.ok) throw new Error(`MusicBrainz HTTP ${res.status}`);
      return res.json();
    }
  };
  const p = mbQueue.then(run, run);
  mbQueue = p.catch(() => {});
  return p;
}

/**
 * MusicBrainz searches use the Lucene query language, where characters like
 * : ( ) " * are operators. Escaping them means a search for "(G)I-DLE" is
 * looked up as text instead of being read as query syntax — the same idea
 * as escaping input before it goes into SQL.
 */
const luceneEscape = (q) => q.replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, '\\$&');

/** Prefer a Latin-letter name (e.g. "BTS") when the main name is in Hangul. */
function latinName(artist) {
  const name = text(artist?.name, 100);
  if (!HANGUL.test(name)) return name;
  const aliases = Array.isArray(artist?.aliases) ? artist.aliases : [];
  const pick = aliases.find((a) => a?.locale === 'en' && a?.primary)
    || aliases.find((a) => a?.locale === 'en')
    || aliases.find((a) => typeof a?.name === 'string' && !HANGUL.test(a.name));
  if (pick) return text(pick.name, 100);
  const sort = text(artist?.['sort-name'], 100);
  return sort && !HANGUL.test(sort) ? sort : name;
}

const coverFor = (releaseGroupId) => `https://coverartarchive.org/release-group/${releaseGroupId}/front-250`;

/** A modal panel with free-form content (the search and album picker use this). */
function openPanel({ title, body, actions, onClose }) {
  const dialog = $('#formDialog');
  const form = $('#dialogForm');
  form.onsubmit = (e) => e.preventDefault();
  form.replaceChildren(el('h2', {}, title), body, el('div', { class: 'dialog-actions' }, actions));
  // The browser fires 'close' a moment after close(). If another panel has
  // opened in the meantime, that late event isn't for us — ignore it.
  dialog.onclose = () => { if (dialog.open) return; dialog.onclose = null; onClose?.(); };
  dialog.showModal();
}

const mbCredit = () => el('small', { class: 'hint credit' }, 'Search results from MusicBrainz, the open music encyclopedia.');

/** Step 1 — search for a group. `linkTo` = an existing group to connect instead of adding a new one. */
function groupSearch(linkTo) {
  const input = el('input', {
    type: 'search', placeholder: 'e.g. NewJeans, SEVENTEEN, aespa', autocomplete: 'off',
    'aria-label': 'Group name', maxlength: 100, enterkeyhint: 'search',
  });
  input.value = linkTo?.name || '';
  const status = el('p', { class: 'pick-status' }, 'Type the group’s name.');
  const results = el('ul', { class: 'pick-list' });
  let ctrl;
  let timer;

  const choose = (artist) => {
    const id = mbid(artist?.id);
    if (!id) return;
    if (linkTo) {
      linkTo.mbid = id;
      saveLocal();
      $('#formDialog').close();
      albumPicker(linkTo);
      return;
    }
    const group = {
      id: uid(),
      name: latinName(artist) || 'Untitled group',
      color: GROUP_COLORS[state.groups.length % GROUP_COLORS.length],
      mbid: id,
      albums: [],
    };
    state.groups.push(group);
    saveLocal();
    $('#formDialog').close();
    location.hash = href(group.id);
    toast(`${group.name} added`);
    albumPicker(group); // straight on to choosing albums
  };

  const search = async () => {
    const q = input.value.trim();
    ctrl?.abort();
    if (q.length < 2) { results.replaceChildren(); status.textContent = 'Type at least 2 letters.'; return; }
    ctrl = new AbortController();
    status.textContent = 'Searching…';
    try {
      const data = await mbFetch('artist', { query: luceneEscape(q), limit: 12 }, ctrl.signal);
      const artists = list(data?.artists, 12).filter((a) => mbid(a?.id));
      status.textContent = artists.length ? 'Tap the right one:' : 'No matches — try another spelling, or type it in yourself.';
      results.replaceChildren(...artists.map((a) => {
        const shown = latinName(a);
        const original = text(a.name, 100);
        const already = state.groups.some((g) => g.mbid === a.id && g !== linkTo);
        const meta = [original !== shown ? original : '', text(a.type, 30), text(a.country, 4), text(a.disambiguation, 120)]
          .filter(Boolean).join(' · ');
        return el('li', {},
          el('button', { type: 'button', class: 'pick-item', disabled: already, onclick: () => choose(a) },
            el('span', { class: 'pick-title' }, shown),
            meta ? el('span', { class: 'pick-meta' }, meta) : null,
            already ? el('span', { class: 'badge' }, 'already added') : null));
      }));
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.warn(err);
      status.textContent = 'Search didn’t work (offline, or MusicBrainz is busy). Try again in a moment.';
    }
  };

  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 500); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer); search(); } });

  openPanel({
    title: linkTo ? `Find “${linkTo.name}” in the music database` : 'Add a K-pop group',
    body: el('div', { class: 'picker' }, input, status, results, mbCredit()),
    actions: [
      linkTo ? null : el('button', { type: 'button', onclick: () => groupForm() }, '⌨️ Type it in myself'),
      el('button', { type: 'button', onclick: () => $('#formDialog').close() }, 'Cancel'),
    ],
    onClose: () => { ctrl?.abort(); clearTimeout(timer); },
  });
  input.focus();
  if (input.value) search();
}

/** Pick the best release of an album to copy the track list from. */
async function mbTrackTitles(releaseGroupId, signal) {
  const data = await mbFetch('release', { 'release-group': releaseGroupId, inc: 'recordings', status: 'official', limit: 25 }, signal);
  const releases = list(data?.releases, 25).filter((r) => list(r?.media).length);
  if (!releases.length) return [];
  const score = (r) => (r.country === 'KR' ? 0 : r.country === 'XW' ? 1 : 2);
  releases.sort((a, b) => score(a) - score(b) || String(a.date || '9999').localeCompare(String(b.date || '9999')));
  return list(releases[0].media)
    .flatMap((m) => list(m?.tracks))
    .map((t) => text(t?.title || t?.recording?.title, 150))
    .filter(Boolean)
    .slice(0, 100);
}

/** Step 2 — list the group's albums with tick boxes. */
async function albumPicker(group) {
  if (!group.mbid) return groupSearch(group);

  const status = el('p', { class: 'pick-status' }, 'Loading albums…');
  const results = el('ul', { class: 'pick-list albums' });
  const filters = { Album: true, EP: true, Single: false, extras: false };
  const selected = new Set();
  const withSongs = el('input', { type: 'checkbox', checked: true, id: 'withSongs' });
  const addBtn = el('button', { type: 'button', class: 'primary', disabled: true }, 'Add albums');
  const selectAllBtn = el('button', { type: 'button', class: 'small' }, 'Select all shown');
  let releaseGroups = [];
  let busy = false;
  const ctrl = new AbortController();

  const owned = new Set(group.albums.map((a) => a.mbid).filter(Boolean));
  const visible = () => releaseGroups.filter((rg) =>
    filters[rg.type] && (filters.extras || !rg.secondary.length));

  const updateButton = () => {
    addBtn.disabled = busy || selected.size === 0;
    addBtn.textContent = selected.size ? `Add ${plural(selected.size, 'album')}` : 'Add albums';
  };

  const draw = () => {
    const shown = visible();
    if (!releaseGroups.length) return;
    status.textContent = shown.length
      ? `${plural(shown.length, 'release')} — tick the ones you want.`
      : 'Nothing matches these filters.';
    results.replaceChildren(...shown.map((rg) => {
      const have = owned.has(rg.id);
      const box = el('input', { type: 'checkbox', checked: have || selected.has(rg.id), disabled: have || busy });
      box.addEventListener('change', () => {
        if (box.checked) selected.add(rg.id); else selected.delete(rg.id);
        updateButton();
      });
      const thumb = el('img', { class: 'thumb', src: coverFor(rg.id), alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
      thumb.addEventListener('error', () => thumb.replaceWith(el('span', { class: 'thumb', 'aria-hidden': 'true' }, '♪')), { once: true });
      return el('li', {},
        el('label', { class: 'pick-item check' + (have ? ' owned' : '') },
          box, thumb,
          el('span', { class: 'pick-text' },
            el('span', { class: 'pick-title' }, rg.title),
            el('span', { class: 'pick-meta' }, [rg.year, rg.type === 'EP' ? 'EP / mini album' : rg.type, ...rg.secondary].filter(Boolean).join(' · '))),
          have ? el('span', { class: 'badge' }, 'added') : null));
    }));
  };

  const chip = (key, label) => {
    const b = el('button', { type: 'button', class: 'chip', 'aria-pressed': String(filters[key]) }, label);
    b.addEventListener('click', () => { filters[key] = !filters[key]; b.setAttribute('aria-pressed', String(filters[key])); draw(); });
    return b;
  };

  selectAllBtn.addEventListener('click', () => {
    for (const rg of visible()) if (!owned.has(rg.id)) selected.add(rg.id);
    draw(); updateButton();
  });

  addBtn.addEventListener('click', async () => {
    const chosen = releaseGroups.filter((rg) => selected.has(rg.id))
      .sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999')); // oldest first
    busy = true; updateButton(); draw();
    let songCount = 0;
    let failed = 0;
    let added = 0;
    for (const [i, rg] of chosen.entries()) {
      const album = { id: uid(), title: rg.title, year: rg.year, cover: coverFor(rg.id), mbid: rg.id, songs: [] };
      if (withSongs.checked) {
        status.textContent = `Getting songs for “${rg.title}” (${i + 1} of ${chosen.length})…`;
        try {
          album.songs = (await mbTrackTitles(rg.id, ctrl.signal))
            .map((title) => ({ id: uid(), title, romanisation: [], english: [] }));
          songCount += album.songs.length;
        } catch (err) {
          if (err.name === 'AbortError') break;
          console.warn(err);
          failed++;
        }
      }
      group.albums.push(album);
      added++;
      owned.add(rg.id);
      saveLocal();
    }
    busy = false;
    selected.clear();
    $('#formDialog').close();
    commit(`Added ${plural(added, 'album')}` +
      (withSongs.checked ? ` and ${plural(songCount, 'song')}` : '') +
      (failed ? ` (${failed} song list${failed === 1 ? '' : 's'} couldn’t load)` : ''));
  });

  openPanel({
    title: `Albums by ${group.name}`,
    body: el('div', { class: 'picker' },
      el('div', { class: 'chips' },
        chip('Album', 'Albums'), chip('EP', 'EPs / minis'), chip('Single', 'Singles'),
        chip('extras', 'Live / remix / compilations'), selectAllBtn),
      status, results,
      el('label', { class: 'check-row', for: 'withSongs' }, withSongs, ' Also add each album’s song list (lyrics stay for you to fill in)'),
      mbCredit()),
    actions: [
      el('button', { type: 'button', onclick: () => groupSearch(group) }, 'Wrong group?'),
      el('button', { type: 'button', onclick: () => $('#formDialog').close() }, 'Cancel'),
      addBtn,
    ],
    onClose: () => { ctrl.abort(); if (!busy) render(); },
  });

  try {
    const all = [];
    for (let offset = 0; offset < 300; offset += 100) {
      const data = await mbFetch('release-group', { artist: group.mbid, type: 'album|ep|single', limit: 100, offset }, ctrl.signal);
      const page = list(data?.['release-groups'], 100);
      all.push(...page);
      if (all.length >= (data?.['release-group-count'] ?? 0) || page.length < 100) break;
    }
    releaseGroups = all
      .filter((rg) => mbid(rg?.id))
      .map((rg) => {
        const date = text(rg['first-release-date'], 10);
        return {
          id: mbid(rg.id),
          title: text(rg.title, 150) || 'Untitled album',
          date,
          year: date.slice(0, 4),
          type: ['Album', 'EP', 'Single'].includes(rg['primary-type']) ? rg['primary-type'] : 'Album',
          secondary: list(rg['secondary-types'], 5).map((t) => text(t, 30)).filter(Boolean),
        };
      })
      .sort((a, b) => (b.date || '').localeCompare(a.date || '')); // newest first
    if (!releaseGroups.length) status.textContent = 'MusicBrainz has no albums listed for this group yet. You can still add them by hand.';
    draw();
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.warn(err);
    status.textContent = 'Couldn’t load albums (offline, or MusicBrainz is busy). Close and try again in a moment.';
  }
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

function coverEl(album, extraClass = '') {
  const placeholder = () => el('div', { class: `cover ${extraClass}`, 'aria-hidden': 'true' }, (album.title[0] || '♪').toUpperCase());
  if (!album.cover) return placeholder();
  const img = el('img', { class: `cover ${extraClass}`, src: album.cover, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
  img.addEventListener('error', () => img.replaceWith(placeholder()), { once: true });
  return img;
}

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
              el('span', { class: 'swatch', vars: { '--c': g.color }, 'aria-hidden': 'true' }, (g.name[0] || '★').toUpperCase()),
              el('span', { class: 'card-title' }, g.name),
              el('span', { class: 'card-meta' }, plural(g.albums.length, 'album'))),
            itemControls(groups, g, () => groupForm(g), g.name))))
      : emptyState('No groups yet.', 'Press ✏️ Edit at the top, then “+ Add group”.'));
}

function groupView(group) {
  const albums = group.albums;
  return el('section', {},
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
}

/* ------------------------------------------------------------------ */
/* Toolbar: edit / export / import / reset                             */
/* ------------------------------------------------------------------ */

function wireToolbar() {
  $('#editToggle').addEventListener('click', () => {
    editMode = !editMode;
    try { localStorage.setItem(EDIT_KEY, editMode ? '1' : '0'); } catch { /* ignore */ }
    render();
  });

  $('#exportBtn').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state, null, 2) + '\n'], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: 'songs.json' });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Downloaded songs.json — upload it to the data folder on GitHub');
  });

  $('#importFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) return toast('That file is too big (max 2 MB).');
    try {
      const data = normalise(JSON.parse(await file.text()));
      if (!confirm(`Replace everything here with ${plural(data.groups.length, 'group')} from “${file.name}”?`)) return;
      state = data;
      location.hash = '#/';
      commit('Imported');
    } catch {
      toast('That file isn’t valid JSON.');
    }
  });

  $('#resetBtn').addEventListener('click', async () => {
    if (!confirm('Throw away the changes saved in this browser and reload the published songs.json?')) return;
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
    state = await loadPublished();
    location.hash = '#/';
    render();
    toast('Reloaded the published version');
  });

  window.addEventListener('hashchange', () => {
    render();
    window.scrollTo(0, 0);
  });
}

async function init() {
  state = loadLocal() || await loadPublished();
  try { editMode = localStorage.getItem(EDIT_KEY) === '1'; } catch { /* ignore */ }
  wireToolbar();
  render();
}

init();
