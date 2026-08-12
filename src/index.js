// dmzs-drive — a small personal file drive backed by Cloudflare R2.
//
// Routes:
//   GET  /api/list?prefix=foo/        -> { prefix, folders: [...], files: [...] }
//   PUT  /api/object?key=foo/bar.txt  -> upload (body = file contents)
//   GET  /api/object?key=foo/bar.txt  -> download
//   DELETE /api/object?key=foo/bar.txt-> delete
//   POST /api/mkdir?key=foo/bar/      -> create an empty folder
//   *    everything else              -> the single-page UI
//
// Every request must pass HTTP Basic Auth (env.AUTH_USER / env.AUTH_PASS).
// Set the password once with: npx wrangler secret put AUTH_PASS

export default {
  async fetch(request, env) {
    if (!checkAuth(request, env)) {
      return new Response("Authentication required.", {
        status: 401,
        headers: { "WWW-Authenticate": 'Basic realm="dmzs-drive"' },
      });
    }

    const url = new URL(request.url);

    try {
      if (url.pathname === "/api/list" && request.method === "GET") {
        return await handleList(url, env);
      }
      if (url.pathname === "/api/object") {
        if (request.method === "PUT") return await handleUpload(request, url, env);
        if (request.method === "GET") return await handleDownload(url, env);
        if (request.method === "DELETE") return await handleDelete(url, env);
      }
      if (url.pathname === "/api/mkdir" && request.method === "POST") {
        return await handleMkdir(url, env);
      }
    } catch (err) {
      return new Response(`Error: ${err.message}`, { status: 500 });
    }

    // Anything else (including "/") serves the UI.
    return new Response(HTML, { headers: { "content-type": "text/html;charset=UTF-8" } });
  },
};

function checkAuth(request, env) {
  const header = request.headers.get("Authorization") || "";
  if (!header.startsWith("Basic ")) return false;
  const decoded = atob(header.slice(6));
  const sep = decoded.indexOf(":");
  const user = decoded.slice(0, sep);
  const pass = decoded.slice(sep + 1);
  return user === env.AUTH_USER && pass === env.AUTH_PASS && !!env.AUTH_PASS;
}

async function handleList(url, env) {
  const prefix = url.searchParams.get("prefix") || "";
  const listed = await env.DRIVE_BUCKET.list({ prefix, delimiter: "/" });

  const folders = (listed.delimitedPrefixes || []).sort();
  const files = listed.objects
    .filter((o) => o.key !== prefix) // hide the folder's own zero-byte marker, if any
    .map((o) => ({ key: o.key, size: o.size, uploaded: o.uploaded }))
    .sort((a, b) => a.key.localeCompare(b.key));

  return Response.json({ prefix, folders, files });
}

async function handleUpload(request, url, env) {
  const key = url.searchParams.get("key");
  if (!key) return new Response("Missing key", { status: 400 });

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

async function handleDelete(url, env) {
  const key = url.searchParams.get("key");
  if (!key) return new Response("Missing key", { status: 400 });
  await env.DRIVE_BUCKET.delete(key);
  return new Response("OK");
}

async function handleMkdir(url, env) {
  const key = url.searchParams.get("key");
  if (!key) return new Response("Missing key", { status: 400 });
  const folderKey = key.endsWith("/") ? key : key + "/";
  await env.DRIVE_BUCKET.put(folderKey, new Uint8Array());
  return new Response("OK");
}

// NOTE ON THIS TEMPLATE: HTML is built with String.raw so that backslashes meant
// for the CLIENT-side script (e.g. the regex /\/$/) survive untouched. Because of
// that, the client-side script below deliberately avoids backtick template literals
// and ${...} interpolation entirely (string concatenation + DOM APIs instead) —
// otherwise those would either get evaluated too early, in this Worker's own scope,
// or be escaped incorrectly by the time they reach the browser. Keep it that way if
// you edit this.
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
    --hover: #f3f4f6;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #14161a;
      --fg: #f1f1f1;
      --muted: #9aa0a6;
      --border: #2b2f36;
      --accent: #5b8cff;
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
  .toolbar { display: flex; gap: 8px; margin-bottom: 16px; }
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
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th { text-align: left; color: var(--muted); font-weight: 500; font-size: 12px; padding: 8px; border-bottom: 1px solid var(--border); }
  td { padding: 8px; border-bottom: 1px solid var(--border); }
  tr.row:hover { background: var(--hover); }
  .name { cursor: pointer; }
  .name:hover { color: var(--accent); }
  .size, .date { color: var(--muted); white-space: nowrap; }
  .actions { text-align: right; white-space: nowrap; }
  .actions button { padding: 3px 8px; font-size: 12px; margin-left: 4px; }
  #empty { color: var(--muted); text-align: center; padding: 40px 0; }
  #progress { font-size: 13px; color: var(--muted); margin-bottom: 12px; }
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
    <input id="fileInput" type="file" multiple style="display:none" />
  </div>
</header>
<main>
  <div id="dropzone">Drag files here, or click Upload</div>
  <div id="progress"></div>
  <table>
    <thead><tr><th>Name</th><th class="size">Size</th><th class="date">Modified</th><th></th></tr></thead>
    <tbody id="rows"></tbody>
  </table>
  <div id="empty" style="display:none">This folder is empty.</div>
</main>
<script>
var currentPrefix = "";

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

function renderBreadcrumb() {
  var parts = currentPrefix.split("/").filter(Boolean);
  var bc = document.getElementById("breadcrumb");
  bc.innerHTML = "";

  var root = document.createElement("span");
  root.textContent = "dmzs-drive";
  root.onclick = function () { load(""); };
  bc.appendChild(root);

  var acc = "";
  parts.forEach(function (p) {
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
    b.onclick = btn.onClick;
    actionsTd.appendChild(b);
  });
  tr.appendChild(actionsTd);

  return tr;
}

function load(prefix) {
  currentPrefix = prefix;
  renderBreadcrumb();
  return fetch("/api/list?prefix=" + encodeURIComponent(prefix))
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

      document.getElementById("empty").style.display =
        (data.folders.length === 0 && data.files.length === 0) ? "block" : "none";
    });
}

function download(key) {
  window.location = "/api/object?key=" + encodeURIComponent(key);
}

function removeFile(key) {
  if (!confirm("Delete " + key.split("/").pop() + "?")) return;
  fetch("/api/object?key=" + encodeURIComponent(key), { method: "DELETE" })
    .then(function () { load(currentPrefix); });
}

function removeFolder(prefix) {
  if (!confirm("Delete folder " + prefix + " and everything inside it? This cannot be undone.")) return;
  deleteFolderContents(prefix).then(function () { load(currentPrefix); });
}

// Recursively deletes everything under prefix, then the folder marker itself.
// Lists only the first 1000 entries per level (no cursor pagination) — plenty
// for a personal drive, but a folder with 1000+ direct items would need re-running.
function deleteFolderContents(prefix) {
  return fetch("/api/list?prefix=" + encodeURIComponent(prefix))
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

function uploadFiles(fileList) {
  var files = Array.prototype.slice.call(fileList);
  var progress = document.getElementById("progress");
  var i = 0;
  function next() {
    if (i >= files.length) {
      progress.textContent = "";
      load(currentPrefix);
      return;
    }
    var file = files[i];
    progress.textContent = "Uploading " + (i + 1) + "/" + files.length + ": " + file.name;
    var key = currentPrefix + file.name;
    fetch("/api/object?key=" + encodeURIComponent(key), {
      method: "PUT",
      headers: { "content-type": file.type || "application/octet-stream" },
      body: file,
    }).then(function () { i++; next(); });
  }
  next();
}

document.getElementById("uploadBtn").onclick = function () { document.getElementById("fileInput").click(); };
document.getElementById("fileInput").onchange = function (e) { uploadFiles(e.target.files); };

document.getElementById("newFolderBtn").onclick = function () {
  var name = prompt("Folder name:");
  if (!name) return;
  fetch("/api/mkdir?key=" + encodeURIComponent(currentPrefix + name + "/"), { method: "POST" })
    .then(function () { load(currentPrefix); });
};

var dropzone = document.getElementById("dropzone");
["dragenter", "dragover"].forEach(function (evt) {
  dropzone.addEventListener(evt, function (e) { e.preventDefault(); dropzone.classList.add("drag"); });
});
["dragleave", "drop"].forEach(function (evt) {
  dropzone.addEventListener(evt, function (e) { e.preventDefault(); dropzone.classList.remove("drag"); });
});
dropzone.addEventListener("drop", function (e) { uploadFiles(e.dataTransfer.files); });

load("");
</script>
</body>
</html>`;
