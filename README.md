# My K-pop Lyrics

A small static website for GitHub Pages. Browse **Groups → Albums → Songs → Lyrics**, where each lyric line shows the Korean romanisation with the English translation underneath. Changes are saved straight into this GitHub repository, so everyone, on every device, sees the same songs and pictures.

## Files

| File | What it does |
|------|--------------|
| `index.html` | Page shell: top bar, buttons, pop-up box, security policy |
| `app.js` | Pages, add/edit forms, start-up |
| `musicbrainz.js` | Searching for groups and albums |
| `images.js` | Group pictures and album covers (thumbnails) |
| `github.js` | Saving to this repository through the GitHub API |
| `styles.css` | Look and feel (light + dark mode, mobile friendly) |
| `data/songs.json` | All groups, albums, songs and lyrics |
| `images/` | Saved thumbnails (created automatically on the first save) |
| `.nojekyll` | Tells GitHub Pages to serve files as-is |
| `worker/` | The optional login server (Cloudflare Worker) and its setup guide |

## 1. Put it on GitHub Pages

1. Create a **public** repository on GitHub (e.g. `kpop-lyrics`).
2. Upload everything in this folder, keeping `data/songs.json` inside a `data` folder.
3. **Settings → Pages → Build and deployment → Source: Deploy from a branch**, pick `main` and `/ (root)`, then Save.
4. After a minute the site is at `https://<your-username>.github.io/kpop-lyrics/`.

## 2. Choose how editing is unlocked

Visitors can only browse. Pick one way for your son to edit:

**A. Username + password login (recommended).** A small free Cloudflare Worker checks his password and keeps the GitHub key secret, so no key is ever on his devices. Setup: [`worker/README-worker.md`](worker/README-worker.md). Once set up, the site shows **🔑 Log in**.

**B. GitHub key on each device (simpler, no Cloudflare).** Leave `edit-server` empty in `index.html`. Then:
1. Make a fine-grained token at https://github.com/settings/personal-access-tokens/new. Choose *Only select repositories* → `kpop-lyrics`, and *Contents: Read and write*. Set an expiry.
2. On the site press **✏️ Edit**, paste the key, then **Connect**. Do this once per device; untick *Remember on this device* on shared computers.

## How your son edits

1. **+ Add group** → type the name → tap the right match. A photo or logo is looked up automatically.
2. The album list opens: use the filter chips, tick albums (or **Select all shown**), press **Add**. Track titles come too.
3. Open a song → **✏️ Edit lyrics**: romanised Korean on the left, English on the right, **same line numbers**. A blank line in both boxes starts a new verse.
4. Press **☁️ Save to GitHub**. The banner says *Not saved yet* until then. Unsaved work is kept in the browser, so closing the tab loses nothing.

Pictures: **✏️ Edit group** / the ✏️ on an album → **📁 Upload** (from the phone or computer), **🔍 Find online** (groups), a link, or **Remove**.

Other buttons (in edit mode): **⬇️ Backup** downloads `songs.json`, **⬆️ Import** loads one, **↺ Undo all** throws away unsaved changes, **⚙️** shows the connection, changes the key, or disconnects.

### Two devices editing

Each save checks that nobody else saved in the meantime. If someone did, a box asks whether to **use GitHub's version** or **replace it with yours** (with a backup button), so nothing is overwritten silently.

### How quickly others see changes

The save is in the repo instantly. The public site (GitHub Pages) rebuilds in about 1 minute and may be cached for up to 10 minutes, so press **Ctrl+F5** if a visitor sees the old version.

## Where data and pictures come from

- Group, album and track names: [MusicBrainz](https://musicbrainz.org) (max 1 request per second, as they ask).
- Album covers: Cover Art Archive. Group pictures: Wikidata / Wikimedia Commons, with the photographer and licence shown on the group page as the licence requires.
- On save, every picture is shrunk to a thumbnail (albums 300×300, groups up to 480×320) and stored in `images/`, so the site doesn't depend on other websites. Redrawing also strips hidden photo data such as GPS location. Pictures no longer used are deleted from the repo on the next save.
- Lyrics are always typed in by hand.

## Security notes

- **Login mode:** see the last section of `worker/README-worker.md`.
- **Key mode:** the key is stored only in the editing browser and is sent only to `api.github.com`. It can only change this one repository's files, and it expires. Anyone who gets it can change the site's files, so don't connect on computers you don't trust, and use **⚙️ → Disconnect** if you have to. All `*.github.io` sites of one account share browser storage, so only put your own code on them.
- The Content Security Policy in `index.html` limits which servers the page can contact and blocks inline or injected scripts.
- The Worker's code is public in this repo on purpose. Its safety comes from the secrets (password hash, session secret, GitHub key), not from hiding how it works.
