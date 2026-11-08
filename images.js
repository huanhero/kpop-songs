'use strict';

/* ------------------------------------------------------------------ */
/* Pictures: group photos/logos and album covers                       */
/* ------------------------------------------------------------------ */
/*
 * Every picture is turned into a small thumbnail before it is stored:
 *   groups -> fits inside 480×320, albums -> 300×300 square.
 * The thumbnail is made by drawing the picture onto a <canvas> and saving
 * the canvas as a new file. That has two security/privacy benefits:
 *   - Hidden metadata is dropped. Phone photos carry EXIF data (camera,
 *     date, often GPS location) and only pixels survive the redraw.
 *   - Whatever was uploaded, what gets stored is a plain new image file
 *     made by the browser, not the original bytes.
 *
 * Thumbnails are committed to the repo as images/groups/… and
 * images/albums/…. Until "Save to GitHub" is pressed they wait in
 * IndexedDB, a database built into the browser that can hold files
 * (localStorage only holds text and fills up at about 5 MB).
 */

const IMG_PATH = /^images\/(groups|albums)\/[A-Za-z0-9_-]{1,60}\.(jpg|webp)$/;
const MAX_IMAGE_INPUT = 15 * 1024 * 1024;
const THUMB = {
  groups: { width: 480, height: 320, crop: false },
  albums: { width: 300, height: 300, crop: true },
};

const pendingImages = new Map(); // repo path -> Blob, not yet on GitHub
const imageUrls = new Map(); // repo path -> blob: URL, so unsaved pictures can be shown
const failedImageUrls = new Set(); // remote pictures that couldn't be copied this session

/** A stored picture reference: either a repo path (images/…) or an https:// link. */
const imgRef = (v) => {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  return IMG_PATH.test(s) ? s : httpsUrl(s);
};

/** What to put in <img src>: the in-browser copy if it isn't on GitHub yet. */
const imgSrc = (ref) => imageUrls.get(ref) || ref;

/* ---------- IndexedDB (one store: path -> Blob) ---------- */

const imageDb = (() => {
  let opening;
  const open = () => (opening ||= new Promise((resolve, reject) => {
    const req = indexedDB.open('kpop-lyrics', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('pending');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
  const run = async (mode, fn) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('pending', mode);
      const req = fn(tx.objectStore('pending'));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
    });
  };
  return {
    put: (key, blob) => run('readwrite', (s) => s.put(blob, key)),
    del: (key) => run('readwrite', (s) => s.delete(key)),
    keys: () => run('readonly', (s) => s.getAllKeys()),
    get: (key) => run('readonly', (s) => s.get(key)),
  };
})();

async function loadPendingImages() {
  try {
    for (const key of await imageDb.keys()) {
      const blob = await imageDb.get(key);
      if (typeof key === 'string' && IMG_PATH.test(key) && blob instanceof Blob) {
        pendingImages.set(key, blob);
        imageUrls.set(key, URL.createObjectURL(blob));
      }
    }
  } catch (err) {
    console.warn('Picture storage unavailable (private window?)', err);
  }
}

/** Keep a new thumbnail until the next save. Returns its future repo path. */
function addPendingImage(kind, id, blob) {
  const ext = blob.type === 'image/webp' ? 'webp' : 'jpg';
  // A fresh name each time, so browsers never show an old cached picture.
  const path = `images/${kind}/${safeId(id)}-${uid().slice(0, 6)}.${ext}`;
  pendingImages.set(path, blob);
  imageUrls.set(path, URL.createObjectURL(blob));
  imageDb.put(path, blob).catch(() => { /* memory copy still works this session */ });
  return path;
}

/** Called after a save: these are on GitHub now. (The blob: URLs stay for this visit.) */
function forgetPendingImages(paths) {
  for (const p of paths) {
    pendingImages.delete(p);
    imageDb.del(p).catch(() => {});
  }
}

/** Every picture path the current data points at. */
function referencedImages(data = state) {
  const refs = new Set();
  for (const g of data.groups) {
    if (IMG_PATH.test(g.image)) refs.add(g.image);
    for (const a of g.albums) if (IMG_PATH.test(a.cover)) refs.add(a.cover);
  }
  return refs;
}

/* ---------- Making thumbnails ---------- */

async function makeThumb(blob, { width, height, crop }) {
  if (!(blob instanceof Blob) || blob.size > MAX_IMAGE_INPUT) throw new Error('Picture missing or too big');
  const bmp = await createImageBitmap(blob); // fails if it isn't really a picture
  let sx = 0, sy = 0, sw = bmp.width, sh = bmp.height, dw, dh;
  if (crop) {
    const want = width / height;
    if (sw / sh > want) { sw = sh * want; sx = (bmp.width - sw) / 2; } else { sh = sw / want; sy = (bmp.height - sh) / 2; }
    dw = width; dh = height;
  } else {
    const scale = Math.min(1, width / sw, height / sh);
    dw = Math.max(1, Math.round(sw * scale));
    dh = Math.max(1, Math.round(sh * scale));
  }
  const canvas = document.createElement('canvas');
  canvas.width = dw;
  canvas.height = dh;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, dw, dh);
  bmp.close?.();
  const toBlob = (type, q) => new Promise((resolve) => canvas.toBlob(resolve, type, q));
  // WebP keeps transparent logos transparent and is small. Browsers that
  // can't write WebP fall back to JPEG on a white background.
  let out = await toBlob('image/webp', 0.85);
  if (!out || out.type !== 'image/webp') {
    ctx.globalCompositeOperation = 'destination-over';
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, dw, dh);
    out = await toBlob('image/jpeg', 0.85);
  }
  if (!out) throw new Error('Could not make the picture');
  return out;
}

async function fetchImage(url, signal) {
  const res = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', signal });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.blob();
}

/**
 * Before saving, copy any pictures that are still links to other websites
 * (e.g. album covers from the Cover Art Archive) into the repo, so the
 * site doesn't depend on those websites staying up.
 * If a site doesn't allow it (no CORS permission), the link is kept as-is.
 */
async function localiseImages(progress) {
  const jobs = [];
  for (const g of state.groups) {
    if (g.image.startsWith('https:') && !failedImageUrls.has(g.image)) jobs.push({ obj: g, key: 'image', kind: 'groups' });
    for (const a of g.albums) {
      if (a.cover.startsWith('https:') && !failedImageUrls.has(a.cover)) jobs.push({ obj: a, key: 'cover', kind: 'albums' });
    }
  }
  if (!jobs.length) return;
  const total = jobs.length;
  let done = 0;
  const worker = async () => {
    while (jobs.length) {
      const { obj, key, kind } = jobs.shift();
      const url = obj[key];
      try {
        const thumb = await makeThumb(await fetchImage(url), THUMB[kind]);
        if (obj[key] === url) obj[key] = addPendingImage(kind, obj.id, thumb);
      } catch (err) {
        failedImageUrls.add(url);
        if (err.status === 404 && obj[key] === url) obj[key] = ''; // no picture exists there
      }
      progress?.(`Copying pictures… ${++done} of ${total}`);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  saveLocal();
}

/* ---------- Finding a group picture online ---------- */
/*
 * MusicBrainz links each artist to its Wikidata entry (Wikipedia's
 * database of facts). Wikidata may name a photo (property P18) and a logo
 * (P154) stored on Wikimedia Commons, a library of freely licensed media.
 * Commons pictures must be credited, so the photographer and licence are
 * saved and shown on the group page.
 */

async function getJson(url, params, signal) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const res = await fetch(u, { credentials: 'omit', referrerPolicy: 'no-referrer', signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Commons returns credits as HTML. Parse it in an inert document and keep only the text. */
function plainText(html, max = 80) {
  if (typeof html !== 'string') return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script, style').forEach((n) => n.remove());
  return (doc.body.textContent || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

async function findGroupPictures(artistMbid, signal) {
  if (!mbid(artistMbid)) return [];
  const artist = await mbFetch(`artist/${artistMbid}`, { inc: 'url-rels' }, signal);
  const rel = list(artist?.relations, 300).find((r) => r?.type === 'wikidata');
  const qid = /\/(Q\d{1,12})$/.exec(rel?.url?.resource || '')?.[1];
  if (!qid) return [];
  const wd = await getJson('https://www.wikidata.org/w/api.php',
    { action: 'wbgetentities', ids: qid, props: 'claims', format: 'json', origin: '*' }, signal);
  const claims = wd?.entities?.[qid]?.claims || {};
  const fileOf = (p) => {
    const v = claims[p]?.[0]?.mainsnak?.datavalue?.value;
    return typeof v === 'string' && v.length < 250 ? v : '';
  };
  const found = [];
  for (const [prop, label] of [['P18', 'Photo'], ['P154', 'Logo']]) {
    const file = fileOf(prop);
    if (!file) continue;
    const info = await getJson('https://commons.wikimedia.org/w/api.php', {
      action: 'query', titles: `File:${file}`, prop: 'imageinfo', iiprop: 'url|extmetadata',
      iiurlwidth: 500, format: 'json', origin: '*',
    }, signal);
    const ii = Object.values(info?.query?.pages || {})[0]?.imageinfo?.[0];
    const thumb = httpsUrl(ii?.thumburl);
    if (!thumb || !new URL(thumb).hostname.endsWith('.wikimedia.org')) continue;
    const meta = ii.extmetadata || {};
    const by = plainText(meta.Artist?.value);
    const licence = plainText(meta.LicenseShortName?.value, 40);
    found.push({
      label,
      thumb,
      source: httpsUrl(ii.descriptionurl),
      credit: text([label, by && `by ${by}`, licence && `(${licence})`, 'via Wikimedia Commons'].filter(Boolean).join(' '), 200),
    });
  }
  return found;
}

/** Turn a found picture into a stored thumbnail (or keep the link if copying isn't allowed). */
async function pictureFromCandidate(cand) {
  try {
    return { blob: await makeThumb(await fetchImage(cand.thumb), THUMB.groups), credit: cand.credit, source: cand.source };
  } catch {
    return { url: cand.thumb, credit: cand.credit, source: cand.source };
  }
}

/** Store a picture choice on a group or album. */
function applyPicture(obj, key, kind, choice) {
  if (!choice) return;
  if (choice.remove) obj[key] = '';
  else if (choice.blob) obj[key] = addPendingImage(kind, obj.id, choice.blob);
  else if (choice.url) obj[key] = choice.url;
  if (kind === 'groups') {
    obj.imageCredit = choice.remove ? '' : text(choice.credit || '', 200);
    obj.imageSource = choice.remove ? '' : httpsUrl(choice.source || '');
  }
}

/** After adding a group from search: quietly look for a picture. */
async function autoGroupPicture(group) {
  try {
    const [first] = await findGroupPictures(group.mbid);
    if (!first || group.image || !state.groups.includes(group)) return;
    applyPicture(group, 'image', 'groups', await pictureFromCandidate(first));
    commit(`Found a picture for ${group.name}`);
  } catch (err) {
    console.warn('No group picture found', err);
  }
}

/* ---------- The picture box used in the group and album forms ---------- */

function imageField({ kind, current, finder }) {
  let choice = null; // null = leave as it is
  const preview = el('div', { class: `img-preview ${kind}` });
  const status = el('small', { class: 'hint' });
  const candidates = el('div', { class: 'img-candidates' });
  const show = (src) => preview.replaceChildren(src
    ? el('img', { src, alt: '', referrerpolicy: 'no-referrer' })
    : el('span', {}, 'No picture'));
  show(current ? imgSrc(current) : '');

  const fileId = `f-pic-${kind}`;
  const file = el('input', { type: 'file', id: fileId, accept: 'image/*', hidden: true });
  file.addEventListener('change', async () => {
    const f = file.files[0];
    file.value = '';
    if (!f) return;
    status.textContent = 'Preparing picture…';
    try {
      const blob = await makeThumb(f, THUMB[kind]);
      choice = { blob };
      show(URL.createObjectURL(blob));
      status.textContent = 'New picture ready — press Save.';
    } catch {
      status.textContent = 'That file isn’t a picture that can be used.';
    }
  });

  const link = el('input', { type: 'url', placeholder: 'or paste a picture link (https://…)', autocomplete: 'off', 'aria-label': 'Picture link' });
  link.addEventListener('change', () => {
    if (!link.value.trim()) return;
    const u = httpsUrl(link.value);
    if (!u) { status.textContent = 'The link must start with https://'; return; }
    choice = { url: u };
    show(u);
    status.textContent = 'It will be copied into GitHub when you save.';
  });

  const findBtn = finder ? el('button', { type: 'button' }, '🔍 Find online') : null;
  findBtn?.addEventListener('click', async () => {
    findBtn.disabled = true;
    status.textContent = 'Looking…';
    try {
      const found = await finder();
      status.textContent = found.length ? 'Tap one to use it:' : 'No picture found online — try uploading one.';
      candidates.replaceChildren(...found.map((c) => el('button', {
        type: 'button', class: 'img-candidate', title: c.credit,
        onclick: async () => {
          status.textContent = 'Getting picture…';
          choice = await pictureFromCandidate(c);
          show(choice.blob ? URL.createObjectURL(choice.blob) : c.thumb);
          status.textContent = c.credit;
        },
      }, el('img', { src: c.thumb, alt: '', referrerpolicy: 'no-referrer', loading: 'lazy' }), el('span', {}, c.label))));
    } catch (err) {
      console.warn(err);
      status.textContent = 'Search didn’t work — try again in a moment.';
    } finally {
      findBtn.disabled = false;
    }
  });

  const node = el('div', { class: 'field img-field' },
    el('span', { class: 'label' }, kind === 'groups' ? 'Group picture' : 'Album cover'),
    el('div', { class: 'img-row' },
      preview,
      el('div', { class: 'img-actions' },
        el('label', { class: 'button', for: fileId }, '📁 Upload'),
        file,
        findBtn,
        el('button', { type: 'button', onclick: () => { choice = { remove: true }; show(''); status.textContent = 'Picture will be removed.'; } }, 'Remove'))),
    link, status, candidates);

  return { node, apply: (obj, key) => applyPicture(obj, key, kind, choice) };
}
