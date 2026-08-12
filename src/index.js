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
//   PUT  /api/object?key=foo/bar.txt      -> upload (body = file contents)
//   GET  /api/object?key=foo/bar.txt      -> download
//   DELETE /api/object?key=foo/bar.txt    -> soft-delete (moves into .trash/)
//   POST /api/mkdir?key=foo/bar/          -> create an empty folder
//   GET  /api/trash/list                  -> everything currently in the trash
//   POST /api/trash/restore?key=.trash/x  -> move back to original location
//   DELETE /api/trash/object?key=.trash/x -> delete permanently
//   POST /api/trash/empty                 -> permanently delete the whole trash
//   *    everything else                  -> the UI (login page when signed out)
//
// A daily cron (see wrangler.jsonc "triggers") purges trash entries older
// than TRASH_RETENTION_DAYS.

const TRASH = ".trash/";
const SESSION_DAYS = 30;
const TRASH_RETENTION_DAYS = 30;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/login" && request.method === "POST") {
      return handleLogin(request, env);
    }

    if (!(await isAuthed(request, env))) {
      if (url.pathname.startsWith("/api/")) {
        return new Response("Unauthorized", { status: 401 });
      }
      return htmlResponse(LOGIN_HTML);
    }

    try {
      if (url.pathname === "/api/logout" && request.method === "POST") {
        return handleLogout();
      }
      if (url.pathname === "/api/list" && request.method === "GET") {
        return await handleList(url, env);
      }
      if (url.pathname === "/api/object") {
        if (request.method === "PUT") return await handleUpload(request, url, env);
        if (request.method === "GET") return await handleDownload(url, env);
        if (request.method === "DELETE") return await handleSoftDelete(url, env);
      }
      if (url.pathname === "/api/mkdir" && request.method === "POST") {
        return await handleMkdir(url, env);
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
      return new Response(`Error: ${err.message}`, { status: 500 });
    }

    // Anything else (including "/") serves the UI.
    return htmlResponse(HTML);
  },

  // Daily cron: purge trash entries older than the retention window.
  async scheduled(controller, env) {
    const cutoff = Date.now() - TRASH_RETENTION_DAYS * 86400 * 1000;
    const expired = (await listAllTrash(env))
      .filter((o) => new Date(o.uploaded).getTime() < cutoff)
      .map((o) => o.key);
    for (let i = 0; i < expired.length; i += 1000) {
      await env.DRIVE_BUCKET.delete(expired.slice(i, i + 1000));
    }
  },
};

function htmlResponse(body) {
  return new Response(body, { headers: { "content-type": "text/html;charset=UTF-8" } });
}

// ---------- Auth ----------

async function handleLogin(request, env) {
  let body = {};
  try {
    body = await request.json();
  } catch {}

  const passOk = !!env.AUTH_PASS && (await safeEqual(body.password || "", env.AUTH_PASS));
  const codeOk = !!env.TOTP_SECRET && (await verifyTotp(env.TOTP_SECRET, body.code || ""));
  if (!passOk || !codeOk) {
    await new Promise((r) => setTimeout(r, 800)); // slow down brute-force attempts
    return new Response("Invalid credentials", { status: 401 });
  }

  const maxAge = SESSION_DAYS * 86400;
  const exp = Math.floor(Date.now() / 1000) + maxAge;
  const token = exp + "." + (await hmacHex(sessionKey(env), String(exp)));
  return new Response("OK", {
    headers: {
      "Set-Cookie": `session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`,
    },
  });
}

function handleLogout() {
  return new Response("OK", {
    headers: { "Set-Cookie": "session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0" },
  });
}

// Sessions are self-contained: "<expiry>.<hmac>". Changing either secret
// invalidates every outstanding session.
function sessionKey(env) {
  return env.AUTH_PASS + "|" + env.TOTP_SECRET;
}

async function isAuthed(request, env) {
  if (!env.AUTH_PASS || !env.TOTP_SECRET) return false;
  const cookie = request.headers.get("Cookie") || "";
  const m = cookie.match(/(?:^|;\s*)session=([^;]+)/);
  if (!m) return false;
  const [expStr, sig] = m[1].split(".");
  const exp = parseInt(expStr, 10);
  if (!exp || Math.floor(Date.now() / 1000) > exp) return false;
  const expected = await hmacHex(sessionKey(env), expStr);
  return safeEqual(sig || "", expected);
}

async function hmacHex(secret, msg) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Constant-time-ish comparison: compare fixed-length digests instead of the
// raw variable-length strings.
async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

// ---------- TOTP (RFC 6238, SHA-1, 30s steps, 6 digits) ----------

async function verifyTotp(secretB32, code) {
  if (!/^\d{6}$/.test(code)) return false;
  const key = base32Decode(secretB32);
  const step = Math.floor(Date.now() / 1000 / 30);
  for (let w = -1; w <= 1; w++) { // allow one step of clock drift either way
    if ((await hotp(key, step + w)) === code) return true;
  }
  return false;
}

async function hotp(keyBytes, counter) {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setUint32(4, counter); // counters fit in 32 bits until year ~6000
  const key = await crypto.subtle.importKey(
    "raw", keyBytes, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, buf));
  const off = sig[19] & 0xf;
  const bin =
    ((sig[off] & 0x7f) << 24) | (sig[off + 1] << 16) | (sig[off + 2] << 8) | sig[off + 3];
  return String(bin % 1000000).padStart(6, "0");
}

function base32Decode(s) {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, val = 0;
  const out = [];
  for (const c of s.replace(/=+$/, "").toUpperCase()) {
    const idx = A.indexOf(c);
    if (idx === -1) continue;
    val = (val << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((val >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

// ---------- Drive ----------

async function handleList(url, env) {
  const prefix = url.searchParams.get("prefix") || "";
  const listed = await env.DRIVE_BUCKET.list({ prefix, delimiter: "/" });

  const folders = (listed.delimitedPrefixes || []).filter((p) => p !== TRASH).sort();
  const files = listed.objects
    .filter((o) => o.key !== prefix) // hide the folder's own zero-byte marker, if any
    .map((o) => ({ key: o.key, size: o.size, uploaded: o.uploaded }))
    .sort((a, b) => a.key.localeCompare(b.key));

  return Response.json({ prefix, folders, files });
}

async function handleUpload(request, url, env) {
  const key = url.searchParams.get("key");
  if (!key) return new Response("Missing key", { status: 400 });
  if (key.startsWith(TRASH)) return new Response("Reserved prefix", { status: 400 });

  await env.DRIVE_BUCKET.put(key, request.body, {
    httpMetadata: {
      contentType: request.headers.get("content-type") || "application/octet-stream",
    },
  });
  return new Response("OK");
}

async function handleDownload(url, env) {
  const key = url.searchParams.get("key");
  if (!key) return new Response("Missing key", { status: 400 });

  const object = await env.DRIVE_BUCKET.get(key);
  if (!object) return new Response("Not found", { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("Content-Disposition", `attachment; filename="${key.split("/").pop()}"`);
  return new Response(object.body, { headers });
}

async function handleSoftDelete(url, env) {
  const key = url.searchParams.get("key");
  if (!key) return new Response("Missing key", { status: 400 });
  if (key.startsWith(TRASH)) return new Response("Use /api/trash/*", { status: 400 });
  await moveObject(env, key, TRASH + key);
  return new Response("OK");
}

async function handleMkdir(url, env) {
  const key = url.searchParams.get("key");
  if (!key) return new Response("Missing key", { status: 400 });
  if (key.startsWith(TRASH)) return new Response("Reserved prefix", { status: 400 });
  const folderKey = key.endsWith("/") ? key : key + "/";
  await env.DRIVE_BUCKET.put(folderKey, new Uint8Array());
  return new Response("OK");
}

// ---------- Trash ----------

async function handleTrashList(env) {
  const files = (await listAllTrash(env))
    .filter((o) => !o.key.endsWith("/")) // hide folder markers
    .map((o) => ({
      key: o.key,
      original: o.key.slice(TRASH.length),
      size: o.size,
      deleted: o.uploaded, // moving into the trash resets the upload time
    }))
    .sort((a, b) => a.original.localeCompare(b.original));
  return Response.json({ files });
}

async function handleTrashRestore(url, env) {
  const key = url.searchParams.get("key");
  if (!key || !key.startsWith(TRASH)) return new Response("Bad key", { status: 400 });
  await moveObject(env, key, key.slice(TRASH.length));
  return new Response("OK");
}

async function handleTrashDelete(url, env) {
  const key = url.searchParams.get("key");
  if (!key || !key.startsWith(TRASH)) return new Response("Bad key", { status: 400 });
  await env.DRIVE_BUCKET.delete(key);
  return new Response("OK");
}

async function handleTrashEmpty(env) {
  const keys = (await listAllTrash(env)).map((o) => o.key);
  for (let i = 0; i < keys.length; i += 1000) {
    await env.DRIVE_BUCKET.delete(keys.slice(i, i + 1000));
  }
  return new Response("OK");
}

async function listAllTrash(env) {
  const out = [];
  let cursor;
  do {
    const page = await env.DRIVE_BUCKET.list({ prefix: TRASH, cursor });
    out.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out;
}

// R2 has no server-side copy in the binding API; stream the object across.
// FixedLengthStream keeps this working for objects of any size.
async function moveObject(env, from, to) {
  const src = await env.DRIVE_BUCKET.get(from);
  if (!src) return;
  if (src.size === 0) {
    await env.DRIVE_BUCKET.put(to, new Uint8Array(), { httpMetadata: src.httpMetadata });
  } else {
    const { readable, writable } = new FixedLengthStream(src.size);
    await Promise.all([
      src.body.pipeTo(writable),
      env.DRIVE_BUCKET.put(to, readable, { httpMetadata: src.httpMetadata }),
    ]);
  }
  await env.DRIVE_BUCKET.delete(from);
}

// NOTE ON THESE TEMPLATES: HTML is built with String.raw so that backslashes meant
// for the CLIENT-side script (e.g. the regex /\/$/) survive untouched. Because of
// that, the client-side scripts below deliberately avoid backtick template literals
// and ${...} interpolation entirely (string concatenation + DOM APIs instead) —
// otherwise those would either get evaluated too early, in this Worker's own scope,
// or be escaped incorrectly by the time they reach the browser. Keep it that way if
// you edit them.

const LOGIN_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>dmzs-drive — sign in</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #ffffff;
    --fg: #1a1a1a;
    --muted: #6b7280;
    --border: #e5e7eb;
    --accent: #2563eb;
    --danger: #dc2626;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #14161a;
      --fg: #f1f1f1;
      --muted: #9aa0a6;
      --border: #2b2f36;
      --accent: #5b8cff;
      --danger: #f87171;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: var(--bg);
    color: var(--fg);
  }
  form {
    width: 100%;
    max-width: 340px;
    padding: 32px 28px;
    border: 1px solid var(--border);
    border-radius: 14px;
    margin: 16px;
  }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: var(--muted); font-size: 13px; margin: 0 0 24px; }
  label { display: block; font-size: 13px; color: var(--muted); margin-bottom: 16px; }
  input {
    width: 100%;
    margin-top: 6px;
    padding: 10px 12px;
    font: inherit;
    color: var(--fg);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  input:focus { outline: 2px solid var(--accent); outline-offset: -1px; border-color: transparent; }
  button {
    width: 100%;
    padding: 10px;
    font: inherit;
    font-weight: 600;
    color: white;
    background: var(--accent);
    border: none;
    border-radius: 8px;
    cursor: pointer;
  }
  button:disabled { opacity: .6; cursor: default; }
  #err { color: var(--danger); font-size: 13px; min-height: 18px; margin-bottom: 12px; }
</style>
</head>
<body>
<form id="loginForm">
  <h1>dmzs-drive</h1>
  <p class="sub">Sign in to your drive</p>
  <label>Password
    <input type="password" id="password" autocomplete="current-password" required autofocus />
  </label>
  <label>6-digit code
    <input id="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6"
           autocomplete="one-time-code" placeholder="From your authenticator app" required />
  </label>
  <div id="err"></div>
  <button type="submit" id="submitBtn">Sign in</button>
</form>
<script>
document.getElementById("loginForm").onsubmit = function (e) {
  e.preventDefault();
  var btn = document.getElementById("submitBtn");
  var err = document.getElementById("err");
  btn.disabled = true;
  err.textContent = "";
  fetch("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      password: document.getElementById("password").value,
      code: document.getElementById("code").value,
    }),
  }).then(function (res) {
    if (res.ok) { window.location.reload(); return; }
    btn.disabled = false;
    err.textContent = "Wrong password or code. Try again.";
    document.getElementById("code").value = "";
  }).catch(function () {
    btn.disabled = false;
    err.textContent = "Network error. Try again.";
  });
};
</script>
</body>
</html>`;

const HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>dmzs-drive</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #ffffff;
    --fg: #1a1a1a;
    --muted: #6b7280;
    --border: #e5e7eb;
    --accent: #2563eb;
    --danger: #dc2626;
    --hover: #f3f4f6;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #14161a;
      --fg: #f1f1f1;
      --muted: #9aa0a6;
      --border: #2b2f36;
      --accent: #5b8cff;
      --danger: #f87171;
      --hover: #1e2127;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: var(--bg);
    color: var(--fg);
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 8px;
    padding: 16px 24px;
    border-bottom: 1px solid var(--border);
  }
  header h1 { font-size: 16px; margin: 0; font-weight: 600; }
  #breadcrumb { font-size: 13px; color: var(--muted); margin-top: 4px; }
  #breadcrumb span { cursor: pointer; }
  #breadcrumb span:hover { color: var(--accent); }
  main { max-width: 900px; margin: 0 auto; padding: 24px; }
  #dropzone {
    border: 2px dashed var(--border);
    border-radius: 10px;
    padding: 28px;
    text-align: center;
    color: var(--muted);
    margin-bottom: 20px;
    transition: border-color .15s, color .15s;
  }
  #dropzone.drag { border-color: var(--accent); color: var(--accent); }
  .toolbar { display: flex; gap: 8px; flex-wrap: wrap; }
  button {
    font: inherit;
    padding: 6px 12px;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--bg);
    color: var(--fg);
    cursor: pointer;
  }
  button:hover { background: var(--hover); }
  button.primary { background: var(--accent); color: white; border-color: var(--accent); }
  button.danger { color: var(--danger); }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th { text-align: left; color: var(--muted); font-weight: 500; font-size: 12px; padding: 8px; border-bottom: 1px solid var(--border); }
  td { padding: 8px; border-bottom: 1px solid var(--border); }
  tr.row:hover { background: var(--hover); }
  .name { cursor: pointer; overflow-wrap: anywhere; }
  .name:hover { color: var(--accent); }
  .size, .date { color: var(--muted); white-space: nowrap; }
  .actions { text-align: right; white-space: nowrap; }
  .actions button { padding: 3px 8px; font-size: 12px; margin-left: 4px; }
  #empty { color: var(--muted); text-align: center; padding: 40px 0; }
  #progress { font-size: 13px; color: var(--muted); margin-bottom: 12px; }
  @media (max-width: 600px) {
    header { padding: 12px 16px; }
    main { padding: 16px; }
    .date { display: none; }
  }
</style>
</head>
<body>
<header>
  <div>
    <h1>dmzs-drive</h1>
    <div id="breadcrumb"></div>
  </div>
  <div class="toolbar">
    <button id="newFolderBtn">New folder</button>
    <button id="uploadBtn" class="primary">Upload</button>
    <button id="trashBtn">Trash</button>
    <button id="backBtn" style="display:none">&larr; Back to files</button>
    <button id="emptyTrashBtn" class="danger" style="display:none">Empty trash</button>
    <button id="logoutBtn">Log out</button>
    <input id="fileInput" type="file" multiple style="display:none" />
  </div>
</header>
<main>
  <div id="dropzone">Drag files here, or click Upload</div>
  <div id="progress"></div>
  <table>
    <thead><tr><th>Name</th><th class="size">Size</th><th class="date" id="dateHeader">Modified</th><th></th></tr></thead>
    <tbody id="rows"></tbody>
  </table>
  <div id="empty" style="display:none"></div>
</main>
<script>
var currentPrefix = "";
var inTrash = false;

function humanSize(bytes) {
  if (bytes === 0) return "0 B";
  var units = ["B", "KB", "MB", "GB", "TB"];
  var i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + " " + units[i];
}

function humanDate(iso) {
  var d = new Date(iso);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

// Any API response that comes back 401 means the session expired: reload to
// land on the login page.
function checkAuth(res) {
  if (res.status === 401) { window.location.reload(); throw new Error("session expired"); }
  return res;
}

function setView(trash) {
  inTrash = trash;
  document.getElementById("newFolderBtn").style.display = trash ? "none" : "";
  document.getElementById("uploadBtn").style.display = trash ? "none" : "";
  document.getElementById("trashBtn").style.display = trash ? "none" : "";
  document.getElementById("backBtn").style.display = trash ? "" : "none";
  document.getElementById("emptyTrashBtn").style.display = trash ? "" : "none";
  document.getElementById("dropzone").style.display = trash ? "none" : "";
  document.getElementById("dateHeader").textContent = trash ? "Deleted" : "Modified";
}

function renderBreadcrumb() {
  var bc = document.getElementById("breadcrumb");
  bc.innerHTML = "";

  var root = document.createElement("span");
  root.textContent = "dmzs-drive";
  root.onclick = function () { setView(false); load(""); };
  bc.appendChild(root);

  if (inTrash) {
    bc.appendChild(document.createTextNode(" / "));
    var t = document.createElement("span");
    t.textContent = "Trash";
    bc.appendChild(t);
    return;
  }

  var acc = "";
  currentPrefix.split("/").filter(Boolean).forEach(function (p) {
    acc += p + "/";
    bc.appendChild(document.createTextNode(" / "));
    var el = document.createElement("span");
    el.textContent = p;
    var prefixCopy = acc;
    el.onclick = function () { load(prefixCopy); };
    bc.appendChild(el);
  });
}

function makeRow(nameText, icon, sizeText, dateText, onNameClick, actionButtons) {
  var tr = document.createElement("tr");
  tr.className = "row";

  var nameTd = document.createElement("td");
  nameTd.className = "name";
  nameTd.textContent = icon + " " + nameText;
  if (onNameClick) nameTd.onclick = onNameClick;
  tr.appendChild(nameTd);

  var sizeTd = document.createElement("td");
  sizeTd.className = "size";
  sizeTd.textContent = sizeText || "";
  tr.appendChild(sizeTd);

  var dateTd = document.createElement("td");
  dateTd.className = "date";
  dateTd.textContent = dateText || "";
  tr.appendChild(dateTd);

  var actionsTd = document.createElement("td");
  actionsTd.className = "actions";
  (actionButtons || []).forEach(function (btn) {
    var b = document.createElement("button");
    b.textContent = btn.label;
    if (btn.danger) b.className = "danger";
    b.onclick = btn.onClick;
    actionsTd.appendChild(b);
  });
  tr.appendChild(actionsTd);

  return tr;
}

function showEmpty(count, message) {
  var el = document.getElementById("empty");
  el.textContent = message;
  el.style.display = count === 0 ? "block" : "none";
}

function load(prefix) {
  currentPrefix = prefix;
  renderBreadcrumb();
  return fetch("/api/list?prefix=" + encodeURIComponent(prefix))
    .then(checkAuth)
    .then(function (res) { return res.json(); })
    .then(function (data) {
      var rows = document.getElementById("rows");
      rows.innerHTML = "";

      data.folders.forEach(function (folder) {
        var name = folder.slice(prefix.length).replace(/\/$/, "");
        rows.appendChild(makeRow(name, "📁", "", "", function () { load(folder); }, [
          { label: "Delete", onClick: function () { removeFolder(folder); } }
        ]));
      });

      data.files.forEach(function (file) {
        var name = file.key.slice(prefix.length);
        rows.appendChild(makeRow(name, "📄", humanSize(file.size), humanDate(file.uploaded),
          function () { download(file.key); }, [
            { label: "Download", onClick: function () { download(file.key); } },
            { label: "Delete", onClick: function () { removeFile(file.key); } }
          ]));
      });

      showEmpty(data.folders.length + data.files.length, "This folder is empty.");
    });
}

function loadTrash() {
  renderBreadcrumb();
  return fetch("/api/trash/list")
    .then(checkAuth)
    .then(function (res) { return res.json(); })
    .then(function (data) {
      var rows = document.getElementById("rows");
      rows.innerHTML = "";

      data.files.forEach(function (file) {
        rows.appendChild(makeRow(file.original, "🗑️", humanSize(file.size), humanDate(file.deleted),
          null, [
            { label: "Restore", onClick: function () { restoreFile(file.key); } },
            { label: "Delete forever", danger: true, onClick: function () { purgeFile(file.key); } }
          ]));
      });

      showEmpty(data.files.length, "Trash is empty. Deleted files are kept here for 30 days.");
    });
}

function refresh() { return inTrash ? loadTrash() : load(currentPrefix); }

function download(key) {
  window.location = "/api/object?key=" + encodeURIComponent(key);
}

function removeFile(key) {
  if (!confirm("Move " + key.split("/").pop() + " to the trash?")) return;
  fetch("/api/object?key=" + encodeURIComponent(key), { method: "DELETE" })
    .then(checkAuth).then(refresh);
}

function removeFolder(prefix) {
  if (!confirm("Move folder " + prefix + " and everything inside it to the trash?")) return;
  deleteFolderContents(prefix).then(refresh);
}

// Recursively soft-deletes everything under prefix, then the folder marker itself.
// Lists only the first 1000 entries per level (no cursor pagination) — plenty
// for a personal drive, but a folder with 1000+ direct items would need re-running.
function deleteFolderContents(prefix) {
  return fetch("/api/list?prefix=" + encodeURIComponent(prefix))
    .then(checkAuth)
    .then(function (res) { return res.json(); })
    .then(function (data) {
      var deletes = data.files.map(function (f) {
        return fetch("/api/object?key=" + encodeURIComponent(f.key), { method: "DELETE" });
      });
      var subfolders = data.folders.map(function (sub) { return deleteFolderContents(sub); });
      return Promise.all(deletes.concat(subfolders));
    })
    .then(function () {
      return fetch("/api/object?key=" + encodeURIComponent(prefix), { method: "DELETE" });
    });
}

function restoreFile(key) {
  fetch("/api/trash/restore?key=" + encodeURIComponent(key), { method: "POST" })
    .then(checkAuth).then(refresh);
}

function purgeFile(key) {
  if (!confirm("Permanently delete " + key.split("/").pop() + "? This cannot be undone.")) return;
  fetch("/api/trash/object?key=" + encodeURIComponent(key), { method: "DELETE" })
    .then(checkAuth).then(refresh);
}

function uploadFiles(fileList) {
  var files = Array.prototype.slice.call(fileList);
  var progress = document.getElementById("progress");
  var i = 0;
  function next() {
    if (i >= files.length) {
      progress.textContent = "";
      refresh();
      return;
    }
    var file = files[i];
    progress.textContent = "Uploading " + (i + 1) + "/" + files.length + ": " + file.name;
    var key = currentPrefix + file.name;
    fetch("/api/object?key=" + encodeURIComponent(key), {
      method: "PUT",
      headers: { "content-type": file.type || "application/octet-stream" },
      body: file,
    }).then(checkAuth).then(function () { i++; next(); });
  }
  next();
}

document.getElementById("uploadBtn").onclick = function () { document.getElementById("fileInput").click(); };
document.getElementById("fileInput").onchange = function (e) { uploadFiles(e.target.files); };

document.getElementById("newFolderBtn").onclick = function () {
  var name = prompt("Folder name:");
  if (!name) return;
  fetch("/api/mkdir?key=" + encodeURIComponent(currentPrefix + name + "/"), { method: "POST" })
    .then(checkAuth).then(refresh);
};

document.getElementById("trashBtn").onclick = function () { setView(true); loadTrash(); };
document.getElementById("backBtn").onclick = function () { setView(false); load(currentPrefix); };

document.getElementById("emptyTrashBtn").onclick = function () {
  if (!confirm("Permanently delete everything in the trash? This cannot be undone.")) return;
  fetch("/api/trash/empty", { method: "POST" }).then(checkAuth).then(refresh);
};

document.getElementById("logoutBtn").onclick = function () {
  fetch("/api/logout", { method: "POST" }).then(function () { window.location.reload(); });
};

var dropzone = document.getElementById("dropzone");
["dragenter", "dragover"].forEach(function (evt) {
  dropzone.addEventListener(evt, function (e) { e.preventDefault(); dropzone.classList.add("drag"); });
});
["dragleave", "drop"].forEach(function (evt) {
  dropzone.addEventListener(evt, function (e) { e.preventDefault(); dropzone.classList.remove("drag"); });
});
dropzone.addEventListener("drop", function (e) { uploadFiles(e.dataTransfer.files); });

setView(false);
load("");
</script>
</body>
</html>`;
