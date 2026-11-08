'use strict';

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
      markChanged();
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
      image: '',
      imageCredit: '',
      imageSource: '',
      albums: [],
    };
    state.groups.push(group);
    markChanged();
    saveLocal();
    $('#formDialog').close();
    location.hash = href(group.id);
    toast(`${group.name} added`);
    albumPicker(group); // straight on to choosing albums
    autoGroupPicture(group); // meanwhile, look for a photo or logo
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
      markChanged();
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

