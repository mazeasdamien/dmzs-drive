# dmzs-drive

My own Google Drive on Cloudflare, for about 20 €/month instead of a NAS.

```
Browser / Claude ──▶ Cloudflare Worker (auth, UI, API, MCP) ──▶ private R2 bucket
```

- **What it does**: upload, browse, preview, share files, and search or chat with my documents using AI.
- **Claude connector**: an MCP endpoint (with OAuth) lets Claude search the `Ressources/` folder.
- **Security**: password + TOTP login, and the bucket has no public URL.
- **Stack**: one Worker (`src/`), plain HTML pages, no database, no build step.

```sh
npm install && npm run deploy
```

Setup details: [docs/SETUP.md](docs/SETUP.md).
