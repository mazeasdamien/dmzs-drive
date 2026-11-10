# dmzs-drive

Personal Google-Drive-style storage: a Cloudflare Worker and a single-page UI over a private R2 bucket. About 20 €/month instead of a NAS.

## Features

- Upload (multipart for big files), browse, search, preview, rename, move, trash
- Downloads of whole folders as ZIP64 archives
- Expiring, revocable share links
- Thumbnails for photos and videos; installable as an app (PWA)
- "Ask your documents": AI search and chat over `Ressources/`
- MCP endpoint with OAuth, so Claude (claude.ai, Desktop, Code) can search `Ressources/`

## Security

- Password + TOTP login, `__Host-` session cookie, same-origin check on every write
- The bucket has no public URL; everything goes through the Worker
- OAuth: owner approval, PKCE S256, redirects only to claude.ai/claude.com/loopback
- An OAuth token only opens `/mcp`, and only for `Ressources/`
- Changing `AUTH_PASS` or `TOTP_SECRET` revokes every session, link and OAuth token

## Deploy

```sh
npm install
npx wrangler login
npx wrangler secret put AUTH_PASS
npx wrangler secret put TOTP_SECRET
npx wrangler secret put ANTHROPIC_API_KEY
npm run deploy   # tests, then wrangler deploy
```

Full setup (TOTP enrolment, AI Search, MCP, folder sync): [docs/SETUP.md](docs/SETUP.md).
