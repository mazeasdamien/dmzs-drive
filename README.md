# dmzs-drive

A private file drive that runs entirely on Cloudflare: one Worker serves the web app and the API, and the files live in an R2 bucket that is never exposed publicly.

## What it does

- **File manager in the browser**: folder tree, list and grid views, desktop-style selection, drag-and-drop moves, rename, search. Installable as an app (PWA) on mobile.
- **Previews**: PDFs, images, audio, video and text open in the page. Photos and videos get real thumbnails, generated on the fly and never stored.
- **Big transfers**: uploads over 90 MB go up in parts. Folders download as one ZIP, built in the browser (ZIP64 past 4 GiB).
- **Trash**: deleted or replaced files go to a trash that is purged after 30 days.
- **Share links**: links that expire and can be revoked.
- **Ask your documents**: a chat that answers from the PDFs and Word files in `Ressources/`, with a citation for every claim (Cloudflare AI Search finds the passages, Claude writes the answer). Monthly spending is capped.
- **MCP server**: Claude Desktop, Claude Code or claude.ai (through OAuth) can search and list the same `Ressources/` documents. Nothing outside that folder is reachable.
- **Folder sync**: rclone can mount or sync a local folder straight to the bucket.

## How it's built

```
browser ─┐
         ├─▶ Worker (src/index.js) ─▶ R2 bucket
Claude ──┘     auth · drive · thumbs · chat · mcp · oauth
```

There is no database and no build step. The pages are plain HTML in `src/pages/`, and state such as sessions, shares, tokens and the file index lives in the bucket under `.config/`. Sign-in takes a password plus a TOTP code. Tests run in Node against an in-memory bucket (`npm test`).

## What it costs

| Item | Price |
|---|---|
| R2 storage | $0.015 per GB per month after the first 10 GB (about $15 per TB). No egress fees. |
| R2 operations | 1 M writes and 10 M reads free per month; a single user stays well under. |
| Worker | Free plan (100k requests a day), or $5 a month for Workers Paid. |
| AI Search | 1,000 searches a month included, then $0.75 per 1,000. |
| Ask your documents (Claude API) | About $0.05–0.08 a question with Claude Sonnet 5.5, capped by `CHAT_MONTHLY_BUDGET` ($20 a month by default). |
| MCP | Nothing extra: the connected Claude does the work on its own subscription. |

So the bill is mostly storage, plus whatever the chat is used for.

Setup and deployment: [docs/SETUP.md](docs/SETUP.md).
