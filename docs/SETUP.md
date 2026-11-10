# Setup

## 1. Deploy

You need [Node.js](https://nodejs.org) and a Cloudflare account.

```sh
npm install
npx wrangler login
npx wrangler secret put AUTH_PASS          # your password
npx wrangler secret put TOTP_SECRET        # base32 seed for your authenticator app
npx wrangler secret put ANTHROPIC_API_KEY  # for "Ask your documents"
npx wrangler secret put MCP_TOKEN          # optional, for Claude Code / Desktop
npm run deploy                             # runs the tests, then deploys
```

**TOTP**: pick a random base32 string (A to Z and 2 to 7, about 32 characters). Store it as `TOTP_SECRET` and add it to an authenticator app, either by hand or with a QR code of:

```
otpauth://totp/dmzs-drive:<your-name>?secret=<TOTP_SECRET>&issuer=dmzs-drive
```

**Domain**: the drive is served on the domain set in `wrangler.jsonc`. Change it to yours, or remove the route to use the `workers.dev` URL.

**Tests**: `npm test` runs everything in Node against an in-memory bucket. No Cloudflare account needed.

## 2. Ask your documents

The chat answers from the PDFs and Word files in `Ressources/`. Do this once, before the first deploy:

1. In the Cloudflare dashboard, go to **AI > AI Search > Create instance**.
   - Name: `drive-ressources`
   - Source: R2, bucket `dmzs-drive`
   - Path filters: `Ressources/**/*.pdf` and `Ressources/**/*.docx`
   - Turn **OCR** on
2. Set `ANTHROPIC_API_KEY` (see above).
3. Deploy. Indexing runs in the background and re-syncs every hour.

Limits: PDFs up to 10 MiB, `.docx` up to 4 MiB. PowerPoint isn't supported, so export decks to PDF.

Cost: about $0.05 to $0.08 per question. The Worker stops answering once the month reaches `CHAT_MONTHLY_BUDGET` dollars (20 by default, in `wrangler.jsonc`).

## 3. Connect Claude (MCP)

The endpoint is `https://<your-domain>/mcp`. It can only search and list `Ressources/`.

- **claude.ai**: add it as a custom connector. You'll sign in to the drive and click Allow.
- **Claude Code / Desktop**: use the `MCP_TOKEN` secret as a bearer token.

Changing `AUTH_PASS` or `TOTP_SECRET` signs out every session and revokes every share link and OAuth token.

## 4. Sync a folder from your PC

Use [rclone](https://rclone.org/install/). It talks to R2 directly, and the files show up in the drive.

1. In the dashboard, go to **R2 > Manage R2 API Tokens** and create a token with read/write on `dmzs-drive` only.
2. Run `rclone config`: new remote, type `s3`, provider `Cloudflare R2`, then paste the keys and your account ID.
3. Pick one:

```sh
rclone mount remote:dmzs-drive ~/CloudDrive                      # use it like a network drive
rclone sync ~/Documents/SyncMe remote:dmzs-drive/Documents       # one-way mirror
rclone bisync ~/Documents/SyncMe remote:dmzs-drive/Documents     # two-way sync
```
