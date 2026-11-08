# Editor login (Cloudflare Worker)

This gives the site a real username/password login. Only the editor (your son) can change songs; everyone else just views.

```
Browser ──username+password──▶ Worker ──checks──▶ gives a session pass (expires)
Browser ──session pass + change──▶ Worker ──GitHub key (secret)──▶ GitHub repo
```

The GitHub key lives only inside the Worker as an encrypted secret. Browsers never see it.

Cost: the Cloudflare free plan (100,000 requests a day; the site uses a handful per save).

## Step 1: Make a new GitHub key for the Worker

1. https://github.com/settings/personal-access-tokens/new
2. Name `kpop-lyrics worker`. Pick an expiry (e.g. 1 year).
3. **Repository access:** Only select repositories → `kpop-lyrics`.
4. **Repository permissions → Contents → Read and write.** Nothing else.
5. Generate and copy it (`github_pat_…`).
6. If your son's devices used a key before, **delete that old key** on the same GitHub page. The site also removes old keys from devices automatically when they next open it.

## Step 2: Make the password hash

1. Open `worker/make-password-hash.html` on your own computer (double-click it). It works offline and sends nothing.
2. Type the password you'll give your son twice, and press **Make hash**. Three or four random words work well (e.g. `purple-tiger-moon-42`).
3. Keep the page open. You'll copy **EDITOR_PASSWORD_HASH** and **SESSION_SECRET** from it in step 4.

## Step 3: Create the Worker

1. Sign up / log in at https://dash.cloudflare.com (free plan).
2. **Workers & Pages → Create → Worker** (start from "Hello World"). Name it e.g. `kpop-lyrics-editor` → **Deploy**.
3. **Edit code**, delete everything there, paste the whole of `worker/worker.js` → **Deploy**.
4. Note its address, e.g. `https://kpop-lyrics-editor.yourname.workers.dev`.

## Step 4: Settings

In the Worker: **Settings → Variables and Secrets → Add**. Add each line below, then **Deploy**.

| Name | Type | Value |
|------|------|-------|
| `REPO` | Text | `your-username/kpop-lyrics` |
| `BRANCH` | Text | `main` |
| `ALLOWED_ORIGIN` | Text | `https://your-username.github.io` (no path, no slash at the end) |
| `EDITOR_USERNAME` | Text | the username you'll give your son |
| `SESSION_VERSION` | Text | `1` |
| `EDITOR_PASSWORD_HASH` | **Secret** | from the hash page |
| `SESSION_SECRET` | **Secret** | from the hash page |
| `GITHUB_TOKEN` | **Secret** | the key from step 1 |

Secrets are encrypted, and the dashboard won't show them again, not even to you.

**Recommended: the guess-blocker.** It locks out after 10 wrong passwords from one address, or 100 in total, for 15 minutes.
1. **Storage & Databases → KV → Create** a namespace named `LOGIN_LIMITS`.
2. In the Worker: **Settings → Bindings → Add → KV namespace**, variable name `LOGIN_LIMITS`, pick that namespace → **Deploy**.

Without it, login still works, but nothing slows down someone guessing passwords.

## Step 5: Point the website at the Worker

In `index.html` (on GitHub: open the file → ✏️ edit), put the Worker address in **two** places:

1. `<meta name="edit-server" content="https://kpop-lyrics-editor.yourname.workers.dev">`
2. At the end of `connect-src` in the Content-Security-Policy line: `… https://*.archive.org https://kpop-lyrics-editor.yourname.workers.dev;`

Optional tightening: also remove `https://api.github.com` from `connect-src`, since browsers no longer talk to GitHub directly.

Commit. After a minute the site shows **🔑 Log in** instead of **✏️ Edit**.

## Everyday use

- Your son: **🔑 Log in** → username + password. "Stay logged in for 30 days" is ticked by default; untick it on shared computers (the login then lasts 12 hours).
- **⚙️ → Log out** ends the login on that device.

## If something goes wrong

| Problem | Fix |
|---------|-----|
| "Couldn't reach the login server" | The Worker address in `index.html` is wrong, or it's missing from `connect-src`. |
| "Not allowed from this website" | `ALLOWED_ORIGIN` must exactly match the site address, e.g. `https://your-username.github.io`. |
| "GitHub refused the Worker's key" | `GITHUB_TOKEN` is wrong or expired. Make a new one (step 1) and update the secret. |
| "Server error" | A setting is missing. Check the Worker's **Logs** in the dashboard. |
| Password forgotten or leaked | Make a new hash (step 2), replace `EDITOR_PASSWORD_HASH`, Deploy. |
| Log out **every** device | Change `SESSION_VERSION` (e.g. `1` → `2`) and Deploy. |
| Locked out after wrong tries | Wait 15 minutes. |

## What the Worker protects against

- **Password guessing:** the KV guess-blocker, plus a 0.6-second wait after every wrong try.
- **Stolen password storage:** only a salted PBKDF2 hash is stored. It's 20,000 rounds, sized to fit the free plan's 10 ms CPU limit per request.
- **Forged or edited session passes:** they're signed with HMAC-SHA256, so changing any character makes them invalid.
- **Other websites using it:** only `ALLOWED_ORIGIN` gets browser access (CORS).
- **A stolen session, or a bug in the site:** the Worker only allows the exact GitHub steps the editor needs. Writes are limited to `data/songs.json` and `images/groups|albums/*.jpg|webp`, it never force-pushes, and it can't fake the commit author. Nobody can replace `index.html` or `app.js` with harmful code through it.
- **Limits that remain:** a stolen session can still change songs until it expires or you bump `SESSION_VERSION`. Every save is a Git commit, so any change can be seen and undone in the repo history.
