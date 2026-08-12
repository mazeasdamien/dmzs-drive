# dmzs-drive

A tiny personal file drive: a Cloudflare Worker + single-page UI backed by the
`dmzs-drive` R2 bucket (already created in your Cloudflare account). Upload,
browse folders, download, and delete — all from a browser, no app required.

## 1. Deploy it

You'll need [Node.js](https://nodejs.org) installed. Then, from this folder:

```sh
npx wrangler login       # opens a browser to authorize wrangler with your Cloudflare account
npx wrangler secret put AUTH_PASS   # choose a password — you'll be prompted to type it
npx wrangler deploy
```

`wrangler deploy` will print a URL like `https://dmzs-drive.<your-subdomain>.workers.dev`.
Open it, and your browser will prompt for a username/password — the username is
`damien` (set in `wrangler.jsonc`), the password is whatever you just chose.

That's it — no build step, no database, no separate frontend hosting.

### Using a custom domain (optional)

If you have a domain on Cloudflare, you can attach it instead of the `workers.dev`
URL: Cloudflare dashboard → Workers & Pages → `dmzs-drive` → Settings → Domains &
Routes → Add a custom domain.

### About the password gate

The whole thing is protected by HTTP Basic Auth, checked on every request. That's
adequate for personal use over HTTPS (which Cloudflare terminates automatically),
but it is a single shared password with no rate-limiting or 2FA. If you want
stronger protection later — e.g. login via your Google/GitHub account, or
restricting access to specific email addresses — Cloudflare Access (part of Zero
Trust, free for small teams) can be layered in front of the Worker without
changing any code.

## 2. Syncing a folder from your PC

The web UI is for browsing/uploading by hand. For an actual folder that stays in
sync automatically, use **rclone** — it talks to R2 directly (via R2's S3-compatible
API), completely independent of the Worker above. Both just read/write the same
`dmzs-drive` bucket, so anything rclone uploads shows up in the web UI and vice versa.

Steps:

1. **Create R2 API credentials** (rclone needs these; the web UI above doesn't).
   In the Cloudflare dashboard: R2 → Manage R2 API Tokens → Create API Token →
   give it read/write access to the `dmzs-drive` bucket only. Save the Access Key
   ID and Secret Access Key it shows you (shown once).
2. **Install rclone**: https://rclone.org/install/
3. **Configure it**: run `rclone config`, choose "New remote", type `s3`, provider
   `Cloudflare R2`, paste in the Access Key ID / Secret Access Key from step 1, and
   your Cloudflare account ID (dashboard → right sidebar) for the endpoint.
4. Then, to keep a folder in sync, either:
   - **Mount it as a drive** (behaves like a network drive — changes save straight
     to R2): `rclone mount dmzs-drive-remote:dmzs-drive ~/CloudDrive`
   - **One-way scheduled sync** (mirrors a local folder up to R2 on a timer, via
     Task Scheduler on Windows or cron/launchd on Mac): `rclone sync ~/Documents/SyncMe dmzs-drive-remote:dmzs-drive/Documents`
   - **Two-way sync** (changes on either side propagate both ways):
     `rclone bisync ~/Documents/SyncMe dmzs-drive-remote:dmzs-drive/Documents`

rclone runs independently of this Worker and of any Claude session — once set up,
it keeps working in the background on its own.
