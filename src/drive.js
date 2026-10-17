// The drive itself: listing, upload, download, rename, trash, search, usage.

import { CONFIG, FILE_CSP, TRASH, isReserved } from "./shared.js";

// ---------- Bucket index ----------
//
// Folder sizes, search and the storage figure all need every object in the
// bucket, and used to list the whole of it on each request: tens of R2 list
// calls per click on a big drive. They now share one listing, kept in the
// Cache API (free) under a "generation" that any change made through this
// Worker moves on, so the next request rebuilds it. Changes made behind the
// Worker's back (rclone) show within INDEX_TTL. .config/ is left out.
export const INDEX_TTL = 600;

export async function indexGeneration(origin) {
  const hit = await caches.default.match(origin + "/__internal/index-gen");
  return hit ? hit.text() : "0";
}

export async function bumpIndex(origin) {
  await caches.default.put(origin + "/__internal/index-gen", new Response(crypto.randomUUID(), {
    headers: { "cache-control": "max-age=2592000" },
  }));
}

export async function bucketIndex(env, origin) {
  const key = origin + "/__internal/index?g=" + (await indexGeneration(origin));
  const hit = await caches.default.match(key);
  if (hit) return hit.json();
  const all = [];
  let cursor;
  do {
    const page = await env.DRIVE_BUCKET.list({ cursor, include: ["customMetadata"] });
    for (const o of page.objects) {
      if (o.key.startsWith(CONFIG)) continue;
      all.push({ key: o.key, size: o.size, uploaded: modifiedOf(o) });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  await caches.default.put(key, new Response(JSON.stringify(all), {
    headers: { "content-type": "application/json", "cache-control": "max-age=" + INDEX_TTL },
  }));
  return all;
}

export async function handleList(url, env) {
  const prefix = url.searchParams.get("prefix") || "";
  // R2 returns at most 1000 entries a call: follow the cursor, or a big
  // folder is silently cut short (and so is anything that acts on it).
  const listed = { objects: [], delimitedPrefixes: [] };
  let pageCursor;
  do {
    const page = await env.DRIVE_BUCKET.list({ prefix, delimiter: "/", cursor: pageCursor, include: ["customMetadata"] });
    listed.objects.push(...page.objects);
    listed.delimitedPrefixes.push(...(page.delimitedPrefixes || []));
    pageCursor = page.truncated ? page.cursor : undefined;
  } while (pageCursor);

  const folderNames = listed.delimitedPrefixes.filter((p) => p !== TRASH && p !== CONFIG).sort();
  const files = listed.objects
    .filter((o) => o.key !== prefix) // hide the folder's own zero-byte marker, if any
    .map((o) => ({ key: o.key, size: o.size, uploaded: modifiedOf(o) }))
    .sort((a, b) => a.key.localeCompare(b.key));

  // R2 "folders" are just key prefixes with no metadata of their own, so
  // each subfolder's total size and most recent change are added up from the
  // bucket index. The folder tree asks with stats=0: it only needs names.
  const stats = {};
  if (folderNames.length && url.searchParams.get("stats") !== "0") {
    for (const o of await bucketIndex(env, url.origin)) {
      if (!o.key.startsWith(prefix)) continue;
      if (prefix === "" && isReserved(o.key)) continue;
      const rest = o.key.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash === -1) continue; // direct file of this level, not in a subfolder
      const folder = prefix + rest.slice(0, slash + 1);
      const s = stats[folder] || (stats[folder] = { size: 0, count: 0, modified: null });
      if (!o.key.endsWith("/")) { s.size += o.size; s.count++; }
      if (!s.modified || o.uploaded > s.modified) s.modified = o.uploaded;
    }
  }
  const folders = folderNames.map((p) => ({
    prefix: p,
    size: (stats[p] || {}).size || 0,
    count: (stats[p] || {}).count || 0,
    modified: (stats[p] || {}).modified || null,
  }));

  return Response.json({ prefix, folders, files });
}

export async function handleUpload(request, url, env) {
  const key = url.searchParams.get("key");
  if (!key) return new Response("Missing key", { status: 400 });
  if (isReserved(key)) return new Response("Reserved prefix", { status: 400 });

  const refused = await makeRoom(env, key, url);
  if (refused) return refused;

  await env.DRIVE_BUCKET.put(key, request.body, {
    httpMetadata: {
      contentType: request.headers.get("content-type") || "application/octet-stream",
    },
  });
  return new Response("OK");
}

// Never overwrite silently: the client asks first and sends replace=1, and
// the version being replaced goes to the trash like a delete would.
async function makeRoom(env, key, url) {
  if (!(await env.DRIVE_BUCKET.head(key))) return null;
  if (url.searchParams.get("replace") !== "1") return new Response("Target exists", { status: 409 });
  await moveToTrash(env, key);
  return null;
}

// Files too big for one request (a Worker takes bodies up to 100 MB) come in
// parts: create, then each part (the client sends 50 MB at a time), then
// complete. The overwrite rule is checked when the upload starts and applied
// when it completes, so an abandoned upload leaves the old file where it was.
export async function handleMultipart(request, url, env) {
  const key = url.searchParams.get("key");
  if (!key) return new Response("Missing key", { status: 400 });
  if (isReserved(key)) return new Response("Reserved prefix", { status: 400 });
  const step = url.pathname.slice("/api/upload/".length);

  if (step === "create" && request.method === "POST") {
    if ((await env.DRIVE_BUCKET.head(key)) && url.searchParams.get("replace") !== "1") {
      return new Response("Target exists", { status: 409 });
    }
    const upload = await env.DRIVE_BUCKET.createMultipartUpload(key, {
      httpMetadata: { contentType: request.headers.get("x-content-type") || "application/octet-stream" },
    });
    return Response.json({ uploadId: upload.uploadId });
  }

  const uploadId = url.searchParams.get("uploadId");
  if (!uploadId) return new Response("Missing uploadId", { status: 400 });
  const upload = env.DRIVE_BUCKET.resumeMultipartUpload(key, uploadId);

  if (step === "part" && request.method === "PUT") {
    const n = parseInt(url.searchParams.get("part") || "", 10);
    if (!(n >= 1 && n <= 10000)) return new Response("Bad part number", { status: 400 });
    const part = await upload.uploadPart(n, request.body);
    return Response.json({ partNumber: part.partNumber, etag: part.etag });
  }
  if (step === "complete" && request.method === "POST") {
    const { parts } = await request.json();
    if (!Array.isArray(parts) || !parts.length) return new Response("Missing parts", { status: 400 });
    const refused = await makeRoom(env, key, url);
    if (refused) return refused;
    await upload.complete(parts);
    return new Response("OK");
  }
  if (step === "abort" && request.method === "POST") {
    await upload.abort();
    return new Response("OK");
  }
  return new Response("Not found", { status: 404 });
}

export async function handleDownload(request, url, env) {
  const key = url.searchParams.get("key");
  if (!key) return new Response("Missing key", { status: 400 });

  // Range and If-None-Match are handed straight to R2: Safari won't play or
  // seek a video unless it can fetch it in pieces, and a file the browser
  // already holds comes back as a bodiless 304.
  const object = await env.DRIVE_BUCKET.get(key, { range: request.headers, onlyIf: request.headers });
  if (!object) return new Response("Not found", { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("accept-ranges", "bytes");
  if (!("body" in object)) return new Response(null, { status: 304, headers });
  let status = 200;
  if (object.range && request.headers.has("range")) {
    const r = object.range;
    const start = "suffix" in r ? object.size - r.suffix : r.offset || 0;
    const end = "suffix" in r ? object.size - 1 : start + (r.length ?? object.size - start) - 1;
    headers.set("content-range", `bytes ${start}-${end}/${object.size}`);
    status = 206;
  }
  const filename = key.split("/").pop();
  if (url.searchParams.get("view") === "1") {
    // Inline viewing (PDFs, images, text render natively in the browser).
    let ct = (headers.get("content-type") || "").toLowerCase();
    // Files stored without a useful type (e.g. uploaded without an extension)
    // get sniffed from their first bytes so PDFs and images still preview.
    if (!ct || ct === "application/octet-stream") {
      const head = await env.DRIVE_BUCKET.get(key, { range: { offset: 0, length: 16 } });
      if (head) {
        const sniffed = sniffType(new Uint8Array(await head.arrayBuffer()));
        if (sniffed) { ct = sniffed; headers.set("content-type", sniffed); }
      }
    }
    // Script-capable types are downgraded to plain text so an uploaded HTML/SVG
    // file can never run JavaScript inside the drive's origin.
    // (careful: Office mime types contain "openxmlformats" — don't match those)
    const scriptCapable = ct.includes("html") || ct.includes("svg") ||
      ct.startsWith("text/xml") || ct.startsWith("application/xml") || ct.includes("+xml");
    if (scriptCapable) {
      headers.set("content-type", "text/plain;charset=UTF-8");
    }
    headers.set("Content-Disposition", `inline; filename="${filename}"`);
    // Belt and braces for whatever the type check above misses. PDFs are left
    // out: a sandboxed response stops the browser's PDF viewer from loading.
    if (ct !== "application/pdf") headers.set("content-security-policy", FILE_CSP);
  } else {
    headers.set("Content-Disposition", `attachment; filename="${filename}"`);
    headers.set("content-security-policy", FILE_CSP);
  }
  return new Response(object.body, { status, headers });
}

export function sniffType(b) {
  const ascii = String.fromCharCode(...b.slice(0, 12));
  if (ascii.startsWith("%PDF")) return "application/pdf";
  if (b[0] === 0x89 && ascii.slice(1, 4) === "PNG") return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (ascii.startsWith("GIF8")) return "image/gif";
  if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") return "image/webp";
  return null;
}

export async function handleSoftDelete(url, env) {
  const key = url.searchParams.get("key");
  if (!key) return new Response("Missing key", { status: 400 });
  if (isReserved(key)) return new Response("Use /api/trash/*", { status: 400 });
  await moveToTrash(env, key);
  return new Response("OK");
}

// Rename and move share this: both are "move object to a new key".
export async function handleRename(url, env) {
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (!from || !to) return new Response("Missing from/to", { status: 400 });
  if (isReserved(from) || isReserved(to)) {
    return new Response("Reserved prefix", { status: 400 });
  }
  if (from === to) return new Response("OK");
  if (await env.DRIVE_BUCKET.head(to)) {
    return new Response("Target exists", { status: 409 }); // never overwrite silently
  }
  await moveObject(env, from, to);
  return new Response("OK");
}

export async function handleMkdir(url, env) {
  const key = url.searchParams.get("key");
  if (!key) return new Response("Missing key", { status: 400 });
  if (isReserved(key)) return new Response("Reserved prefix", { status: 400 });
  const folderKey = key.endsWith("/") ? key : key + "/";
  await env.DRIVE_BUCKET.put(folderKey, new Uint8Array());
  return new Response("OK");
}

// Raw keys under a prefix (folder markers included) — lets the client move a
// folder key-by-key with a progress bar.
export async function handleKeys(url, env) {
  const prefix = url.searchParams.get("prefix") || "";
  if (isReserved(prefix)) return new Response("Reserved prefix", { status: 400 });
  const keys = [];
  let cursor;
  do {
    const page = await env.DRIVE_BUCKET.list({ prefix, cursor });
    keys.push(...page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return Response.json({ keys });
}

// ---------- Search & usage ----------

export async function handleSearch(url, env) {
  const q = (url.searchParams.get("q") || "").toLowerCase();
  if (!q) return Response.json({ files: [] });
  const files = [];
  for (const o of await bucketIndex(env, url.origin)) {
    if (isReserved(o.key) || o.key.endsWith("/")) continue;
    if (o.key.toLowerCase().includes(q)) files.push(o);
    if (files.length >= 300) break;
  }
  files.sort((a, b) => a.key.localeCompare(b.key));
  return Response.json({ files: files.slice(0, 300) });
}

export async function handleUsage(url, env) {
  let driveBytes = 0, driveCount = 0, trashBytes = 0;
  for (const o of await bucketIndex(env, url.origin)) {
    if (o.key.startsWith(TRASH)) trashBytes += o.size;
    else if (!o.key.endsWith("/")) { driveBytes += o.size; driveCount++; }
  }
  return Response.json({ driveBytes, driveCount, trashBytes });
}

// ---------- Trash ----------

export async function handleTrashList(env) {
  const files = (await listAllTrash(env))
    .filter((o) => !o.key.endsWith("/")) // hide folder markers
    .map((o) => ({
      key: o.key,
      original: originalOf(o),
      size: o.size,
      deleted: o.uploaded, // moving into the trash resets the upload time
    }))
    .sort((a, b) => a.original.localeCompare(b.original));
  return Response.json({ files });
}

export async function handleTrashRestore(url, env) {
  const key = url.searchParams.get("key");
  if (!key || !key.startsWith(TRASH)) return new Response("Bad key", { status: 400 });
  const entry = await env.DRIVE_BUCKET.head(key);
  if (!entry) return new Response("Not found", { status: 404 });
  const dest = originalOf(entry);
  if (await env.DRIVE_BUCKET.head(dest)) {
    return new Response("Target exists", { status: 409 }); // never overwrite silently
  }
  await moveObject(env, key, dest, { original: null });
  return new Response("OK");
}

export async function handleTrashDelete(url, env) {
  const key = url.searchParams.get("key");
  if (!key || !key.startsWith(TRASH)) return new Response("Bad key", { status: 400 });
  await env.DRIVE_BUCKET.delete(key);
  return new Response("OK");
}

export async function handleTrashEmpty(env) {
  const keys = (await listAllTrash(env)).map((o) => o.key);
  for (let i = 0; i < keys.length; i += 1000) {
    await env.DRIVE_BUCKET.delete(keys.slice(i, i + 1000));
  }
  return new Response("OK");
}

export async function listAllTrash(env) {
  const out = [];
  let cursor;
  do {
    const page = await env.DRIVE_BUCKET.list({ prefix: TRASH, cursor, include: ["customMetadata"] });
    out.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out;
}

// R2 has no server-side copy in the binding API; stream the object across.
// FixedLengthStream keeps this working for objects of any size. R2 stamps the
// copy with the time of the move, so the file's own date travels along in
// its metadata (mtime), with whatever else it carried; `meta` adds to that,
// and a null value removes a field.
export async function moveObject(env, from, to, meta = {}) {
  const src = await env.DRIVE_BUCKET.get(from);
  if (!src) return;
  const customMetadata = { ...(src.customMetadata || {}), mtime: modifiedOf(src), ...meta };
  for (const k of Object.keys(customMetadata)) if (customMetadata[k] === null) delete customMetadata[k];
  const opts = { httpMetadata: src.httpMetadata, customMetadata };
  if (src.size === 0) {
    await env.DRIVE_BUCKET.put(to, new Uint8Array(), opts);
  } else {
    const { readable, writable } = new FixedLengthStream(src.size);
    await Promise.all([
      src.body.pipeTo(writable),
      env.DRIVE_BUCKET.put(to, readable, opts),
    ]);
  }
  await env.DRIVE_BUCKET.delete(from);
}

// When a file was last really changed: its upload, unless it has been moved
// since (see moveObject).
export function modifiedOf(o) {
  const m = o.customMetadata && o.customMetadata.mtime;
  return m || new Date(o.uploaded).toISOString();
}

// Trash entries normally sit at .trash/<original key>. Deleting a second file
// of the same name used to overwrite the first one's copy there; now the
// second gets a suffixed key, and every entry records where it came from.
// (Empty folder markers just replace each other: there's nothing to lose.)
export async function moveToTrash(env, key) {
  let to = TRASH + key;
  if (!key.endsWith("/") && (await env.DRIVE_BUCKET.head(to))) to += "~" + Date.now();
  await moveObject(env, key, to, { original: key });
}

export function originalOf(entry) {
  return (entry.customMetadata && entry.customMetadata.original) || entry.key.slice(TRASH.length);
}
