# dmzs-drive

A tiny personal file drive: a Cloudflare Worker + single-page UI backed by the
`dmzs-drive` R2 bucket (already created in your Cloudflare account). Upload,
browse with a folder tree, search, preview, rename, move (drag & drop or
multi-select), share via expiring links, download, and delete — all from a
browser. Installable as an app (PWA) on mobile, with storage usage shown in
the sidebar.

The file list behaves like a desktop file manager: **one click selects, a
double click opens** — files preview, folders open. Ctrl/Cmd-click adds to the
selection, Shift-click takes a range, Ctrl/Cmd+A selects everything in the
folder, Enter opens the selected item, Esc clears, and dragging a box across
blank space rubber-band-selects whatever it touches (hold Ctrl while dragging
to add to the current selection). The checkboxes still work too. Folders can be
selected alongside files, so Move and Delete in the selection bar act on both —
a folder brings everything inside it along. Dragging any selected item onto a
folder moves the whole selection.

On phones and tablets a single tap still opens, since double-tap is an awkward
gesture there; use the checkboxes to select several items.

Below 700px the layout goes compact: the folder tree slides in from a **☰**
button, the toolbar keeps only search, the view toggle and Upload while the rest
of the actions move into a **⋯** menu, and each row or tile carries its own **⋯**
instead of four buttons — which is what leaves the file name room to be read.
Because a touchscreen has no hover, the tile checkboxes and action buttons that
appear on hover elsewhere are shown permanently there, and the drag-and-drop
zone (useless from a phone) is hidden.

Grid view shows real thumbnails rather than icons. Photos are resized through
the Images binding; videos get a still frame pulled a second in via the Media
binding, marked with a ▶ badge. Both read the R2 bytes directly, so the bucket
stays private, and neither stores anything — the small copies live only in
Cloudflare's cache, keyed by the object's etag. A video the Media binding can't
read (an unsupported codec, or over its 100 MB input limit) falls back to a 🎬
icon.

Previews open in-page: PDFs, images, text, audio and video render directly in
the browser. Word/Excel/PowerPoint files render through Microsoft's embedded
Office viewer, which fetches the document via a short-lived (5 min) signed link
— i.e. those documents transit through Microsoft's viewer service when (and
only when) you preview them.

## 1. Deploy it

You'll need [Node.js](https://nodejs.org) installed. Then, from this folder:

```sh
npx wrangler login       # opens a browser to authorize wrangler with your Cloudflare account
npx wrangler secret put AUTH_PASS     # choose a password — you'll be prompted to type it
npx wrangler secret put TOTP_SECRET   # base32 seed for the authenticator app (see below)
npx wrangler deploy
```

The drive is served on the custom domain configured in `wrangler.jsonc`
(`drive.agentxr.app`). Signing in asks for the password plus a 6-digit code
from an authenticator app (Microsoft/Google Authenticator, etc.).

To enroll the authenticator: generate a random base32 string (A–Z, 2–7; e.g.
32 chars), store it as `TOTP_SECRET`, and add it to your authenticator app —
either by typing it in manually or via a QR code encoding
`otpauth://totp/dmzs-drive:damien?secret=<TOTP_SECRET>&issuer=dmzs-drive`.

That's it — no build step, no database, no separate frontend hosting.

### Using a custom domain (optional)

If you have a domain on Cloudflare, you can attach it instead of the `workers.dev`
URL: Cloudflare dashboard → Workers & Pages → `dmzs-drive` → Settings → Domains &
Routes → Add a custom domain.

### About the login gate

Every request is checked for a signed session cookie; sessions are created by
`POST /api/login` with the password **and** a valid TOTP code, and last 30 days.
Failed logins are slowed down (~800 ms) to blunt brute-forcing. Changing either
secret invalidates all outstanding sessions. If you ever want to go further,
Cloudflare Access (Zero Trust) can still be layered in front without code changes.

### Trash

Deleting a file moves it into a hidden `.trash/` area instead of destroying it.
The Trash view in the UI lets you restore or permanently delete entries, and a
daily cron (see `wrangler.jsonc`) purges anything older than 30 days.

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
