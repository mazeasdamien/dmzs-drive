// dmzs-drive — a small personal file drive backed by Cloudflare R2.
//
// Auth: session cookie obtained via POST /api/login with the password AND a
// 6-digit TOTP code from an authenticator app (Microsoft/Google Authenticator).
// Secrets (set with `npx wrangler secret put <NAME>`):
//   AUTH_PASS   — the password
//   TOTP_SECRET — base32 seed for the authenticator app
//
// Routes (all /api/* require a valid session unless noted):
//   POST /api/login {password, code}      -> sets session cookie (public)
//   POST /api/logout                      -> clears the cookie
//   GET  /api/list?prefix=foo/            -> { prefix, folders: [...], files: [...] }
//   PUT  /api/object?key=foo/bar.txt      -> upload (body = file contents); 409 if it
//                                            exists, unless &replace=1 (old one to .trash/)
//   GET  /api/object?key=foo/bar.txt      -> download
//   POST /api/upload/create|complete|abort, PUT /api/upload/part
//                                         -> uploads over 100 MB, in 50 MB parts
//   DELETE /api/object?key=foo/bar.txt    -> soft-delete (moves into .trash/)
//   POST /api/mkdir?key=foo/bar/          -> create an empty folder
//   GET  /api/trash/list                  -> everything currently in the trash
//   POST /api/trash/restore?key=.trash/x  -> move back to original location
//   DELETE /api/trash/object?key=.trash/x -> delete permanently
//   POST /api/trash/empty                 -> permanently delete the whole trash
//   POST /api/chat {messages}             -> answer from the indexed documents (NDJSON stream)
//   GET  /api/chat/usage                  -> this month's chat cost: {month, questions, cost, ...}
//   POST /mcp                             -> MCP server (bearer MCP_TOKEN): search_documents,
//                                            list_documents over Ressources/
//   *    everything else                 -> the UI (login page when signed out)
//
// A daily cron (see wrangler.jsonc "triggers") purges trash entries older
// than TRASH_RETENTION_DAYS.

import { ICON_192, ICON_512, APPLE_ICON } from "./icons.js";
import { SESSIONS, SHARES, TRASH_RETENTION_DAYS } from "./shared.js";
import { handleLogin, handleLogout, handleShareRevoke, handleShareRevokeAll, handleSharesList, handleSign, isAuthed, verifySignedUrl } from "./auth.js";
import { bumpIndex, handleMultipart, handleDownload, handleKeys, handleList, handleMkdir, handleRename, handleSearch, handleSoftDelete, handleTrashDelete, handleTrashEmpty, handleTrashList, handleTrashRestore, handleUpload, handleUsage, listAllTrash } from "./drive.js";
import { handleThumb } from "./thumbs.js";
import { handleChat, handleChatUsage } from "./chat.js";
import { handleMcp } from "./mcp.js";
import LOGIN_HTML from "./pages/login.html";
import HTML from "./pages/app.html";

const MANIFEST = {
  id: "/",
  name: "Damien's Drive",
  short_name: "Drive",
  description: "A personal file drive",
  start_url: "/",
  scope: "/",
  display: "standalone",
  background_color: "#14161a",
  theme_color: "#2563eb",
  icons: [
    { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
  ],
};


// The offline shell. Pages still come from the network; the last good copy
// of "/" is kept so the installed app opens with no connection (its API calls
// then fail and the error bar says so). Nothing from /api/ is ever cached,
// and "/" is whatever the server last sent: the app, or the sign-in page.
const SERVICE_WORKER = `const CACHE = "drive-shell-v1";
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(
  caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim())
));
self.addEventListener("fetch", (e) => {
  if (e.request.mode !== "navigate") return;
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok && new URL(e.request.url).pathname === "/") {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put("/", copy));
    }
    return res;
  }).catch(() => caches.match("/").then((r) => r || Response.error())));
});
`;

// The two pages' own CSP. Their scripts are inline, so they're allowed by
// hash (worked out once per isolate from the page text) rather than with
// 'unsafe-inline'; anything injected would have no hash and not run.
const pageCsp = new Map();
async function cspFor(html) {
  if (pageCsp.has(html)) return pageCsp.get(html);
  const hashes = [];
  for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(m[1]));
    hashes.push("'sha256-" + btoa(String.fromCharCode(...new Uint8Array(digest))) + "'");
  }
  const csp = [
    "default-src 'self'",
    "script-src " + hashes.join(" "),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "media-src 'self' blob:",
    "frame-src 'self' https://view.officeapps.live.com",
    "worker-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
  pageCsp.set(html, csp);
  return csp;
}

export default {
  async fetch(request, env, ctx) {
    const res = await route(request, env, ctx);
    // Whatever changed the bucket makes the cached index stale. Awaited, not
    // left to waitUntil: the page lists again straight after, and must not
    // get the old index back.
    const url = new URL(request.url);
    if (!["GET", "HEAD"].includes(request.method) && res.ok && url.pathname.startsWith("/api/") &&
        !["/api/login", "/api/logout", "/api/chat"].includes(url.pathname)) {
      await bumpIndex(url.origin);
    }
    // Headers on a fetched or cached response can be read-only: copy first.
    const out = new Response(res.body, res);
    out.headers.set("x-content-type-options", "nosniff");
    out.headers.set("referrer-policy", "same-origin");
    out.headers.set("strict-transport-security", "max-age=31536000");
    return out;
  },

  // Daily cron: purge old trash entries and expired share-link records.
  async scheduled(controller, env) {
    const cutoff = Date.now() - TRASH_RETENTION_DAYS * 86400 * 1000;
    const expired = (await listAllTrash(env))
      .filter((o) => new Date(o.uploaded).getTime() < cutoff)
      .map((o) => o.key);
    for (let i = 0; i < expired.length; i += 1000) {
      await env.DRIVE_BUCKET.delete(expired.slice(i, i + 1000));
    }
    // The cached bucket index isn't bumped here (its key needs the site's
    // hostname, which a cron run doesn't have); it expires within INDEX_TTL.

    const now = Math.floor(Date.now() / 1000);
    const staleShares = [];
    let cursor;
    do {
      const page = await env.DRIVE_BUCKET.list({ prefix: SHARES, cursor, include: ["customMetadata"] });
      for (const o of page.objects) {
        if (parseInt((o.customMetadata || {}).exp || "0", 10) < now) staleShares.push(o.key);
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    for (let i = 0; i < staleShares.length; i += 1000) {
      await env.DRIVE_BUCKET.delete(staleShares.slice(i, i + 1000));
    }

    const staleSessions = [];
    cursor = undefined;
    do {
      const page = await env.DRIVE_BUCKET.list({ prefix: SESSIONS, cursor, include: ["customMetadata"] });
      for (const o of page.objects) {
        if (parseInt((o.customMetadata || {}).exp || "0", 10) < now) staleSessions.push(o.key);
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    for (let i = 0; i < staleSessions.length; i += 1000) {
      await env.DRIVE_BUCKET.delete(staleSessions.slice(i, i + 1000));
    }
  },
};

async function route(request, env, ctx) {
  const url = new URL(request.url);

  // Browsers say where a request comes from. Anything that changes state
  // (every non-GET, and /api/sign, which records share links) must come from
  // this site's own pages: SameSite=Lax alone still lets other *.agentxr.app
  // sites, and top-level GETs from anywhere, carry the cookie.
  const site = request.headers.get("sec-fetch-site");
  const changes = !["GET", "HEAD"].includes(request.method) || url.pathname === "/api/sign";
  if (changes && site && site !== "same-origin") {
    return new Response("Cross-site request refused", { status: 403 });
  }

  if (url.pathname === "/api/login" && request.method === "POST") {
    return handleLogin(request, env);
  }

  // MCP clients authenticate with their own bearer token, not the cookie.
  if (url.pathname === "/mcp") return handleMcp(request, env);

  // PWA assets are public: they contain nothing sensitive and the browser
  // fetches the manifest without credentials.
  if (request.method === "GET") {
    if (url.pathname === "/manifest.json") {
      return Response.json(MANIFEST, { headers: { "cache-control": "public, max-age=3600" } });
    }
    if (url.pathname === "/icon-192.png") return pngResponse(ICON_192);
    if (url.pathname === "/icon-512.png") return pngResponse(ICON_512);
    if (url.pathname === "/apple-touch-icon.png") return pngResponse(APPLE_ICON);
    if (url.pathname === "/sw.js") {
      return new Response(SERVICE_WORKER, {
        headers: { "content-type": "text/javascript;charset=UTF-8", "cache-control": "no-cache" },
      });
    }
  }

  // Time-limited signed links: lets the Office preview's external viewer
  // fetch a document without our session cookie. Signed, single-file, 5 min.
  if (url.pathname === "/api/object" && request.method === "GET" && url.searchParams.has("sig")) {
    if (await verifySignedUrl(url, env)) return handleDownload(request, url, env);
    return new Response("Invalid or expired link", { status: 403 });
  }

  if (!(await isAuthed(request, env))) {
    if (url.pathname.startsWith("/api/")) {
      return new Response("Unauthorized", { status: 401 });
    }
    return htmlResponse(LOGIN_HTML);
  }

  try {
    if (url.pathname === "/api/logout" && request.method === "POST") {
      return await handleLogout(request, env);
    }
    if (url.pathname === "/api/list" && request.method === "GET") {
      return await handleList(url, env);
    }
    if (url.pathname === "/api/object") {
      if (request.method === "PUT") return await handleUpload(request, url, env);
      if (request.method === "GET") return await handleDownload(request, url, env);
      if (request.method === "DELETE") return await handleSoftDelete(url, env);
    }
    if (url.pathname.startsWith("/api/upload/")) {
      return await handleMultipart(request, url, env);
    }
    if (url.pathname === "/api/thumb" && request.method === "GET") {
      return await handleThumb(request, url, env, ctx);
    }
    if (url.pathname === "/api/mkdir" && request.method === "POST") {
      return await handleMkdir(url, env);
    }
    if (url.pathname === "/api/sign" && request.method === "GET") {
      return await handleSign(url, env);
    }
    if (url.pathname === "/api/rename" && request.method === "POST") {
      return await handleRename(url, env);
    }
    if (url.pathname === "/api/keys" && request.method === "GET") {
      return await handleKeys(url, env);
    }
    if (url.pathname === "/api/shares" && request.method === "GET") {
      return await handleSharesList(env);
    }
    if (url.pathname === "/api/shares/revoke" && request.method === "POST") {
      return await handleShareRevoke(url, env);
    }
    if (url.pathname === "/api/shares/revokeall" && request.method === "POST") {
      return await handleShareRevokeAll(env);
    }
    if (url.pathname === "/api/search" && request.method === "GET") {
      return await handleSearch(url, env);
    }
    if (url.pathname === "/api/usage" && request.method === "GET") {
      return await handleUsage(url, env);
    }
    if (url.pathname === "/api/chat" && request.method === "POST") {
      return await handleChat(request, env, ctx);
    }
    if (url.pathname === "/api/chat/usage" && request.method === "GET") {
      return await handleChatUsage(env);
    }
    if (url.pathname === "/api/trash/list" && request.method === "GET") {
      return await handleTrashList(env);
    }
    if (url.pathname === "/api/trash/restore" && request.method === "POST") {
      return await handleTrashRestore(url, env);
    }
    if (url.pathname === "/api/trash/object" && request.method === "DELETE") {
      return await handleTrashDelete(url, env);
    }
    if (url.pathname === "/api/trash/empty" && request.method === "POST") {
      return await handleTrashEmpty(env);
    }
  } catch (err) {
    // Shows in the dashboard's Workers Logs (observability in wrangler.jsonc).
    console.error(request.method, url.pathname, err && err.stack ? err.stack : err);
    return new Response(`Error: ${err.message}`, { status: 500 });
  }

  // Anything else (including "/") serves the UI.
  return htmlResponse(HTML);
}

async function htmlResponse(body) {
  return new Response(body, {
    headers: { "content-type": "text/html;charset=UTF-8", "content-security-policy": await cspFor(body) },
  });
}

function pngResponse(b64) {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new Response(bytes, {
    headers: { "content-type": "image/png", "cache-control": "public, max-age=86400" },
  });
}
