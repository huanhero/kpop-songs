# My K-pop Lyrics

A small static website for GitHub Pages. Browse **Groups → Albums → Songs → Lyrics**, where each lyric line shows the Korean romanisation with the English translation underneath.

## Files

| File | What it does |
|------|--------------|
| `index.html` | The page shell (top bar, edit buttons, pop-up form) |
| `app.js` | All the logic: pages, add/edit forms, saving, export/import |
| `styles.css` | Look and feel (light + dark mode, mobile friendly) |
| `data/songs.json` | The published list of groups, albums, songs and lyrics |
| `.nojekyll` | Tells GitHub Pages to serve files as-is |

## Put it on GitHub Pages

1. Create a new repository on GitHub (e.g. `kpop-lyrics`).
2. Upload everything in this folder, keeping `data/songs.json` inside a `data` folder.
3. In the repo: **Settings → Pages → Build and deployment → Source: Deploy from a branch**, pick `main` and `/ (root)`, then Save.
4. After a minute the site is at `https://<your-username>.github.io/kpop-lyrics/`.

## How your son edits it

1. Open the site and press **✏️ Edit**.
2. **+ Add group** → start typing the name → tap the right match.
3. The album list opens straight away. Use the filter chips (Albums, EPs / minis, Singles, Live / remix / compilations), tick as many as you like (or **Select all shown**), then **Add**. Leave “Also add each album’s song list” ticked to get the track titles too.
4. Later, **🔍 Find albums** on a group page adds more. Albums already added show as “added”.
5. Open a song → **✏️ Edit lyrics** to add the romanisation and English. Lyrics are always typed or pasted in by hand.

No match, or no internet? **⌨️ Type it in myself** and **⌨️ Type an album** still work the old way. Anything imported can be renamed with ✏️.

### Where the search data comes from

Group, album and track names come from [MusicBrainz](https://musicbrainz.org), a free community music database. Cover images come from the Cover Art Archive. The site waits at least 1 second between requests, as MusicBrainz asks. Searches are sent to musicbrainz.org without cookies or a referrer.

### Song form tips

In the song form, paste the romanised Korean in the left box and the English in the right box — **one line each, same line numbers**. A counter turns orange if the counts don't match. Leave a blank line in both boxes to split verses.

Changes save automatically in that browser.

## Publishing his changes

Edits live only in his browser until published:

1. Press **⬇️ Export** — this downloads `songs.json`.
2. In GitHub, open the `data` folder → **Add file → Upload files** → drop in `songs.json` → Commit.
3. The live site updates within a minute or two.

On another computer, **⬆️ Import** loads a `songs.json`, and **↺ Reset** throws away local edits and reloads the published version.

## Extra

- **🙈 Practice mode** on a song blurs the English; tap a line to reveal it.
- Album covers can use any `https://` image link.
