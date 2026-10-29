// OAuth for the MCP endpoint: claude.ai's custom connectors won't take a
// fixed bearer token, they want OAuth 2.1 with dynamic client registration
// and PKCE. Just that much is implemented here:
//
//   GET  /.well-known/oauth-protected-resource      -> where to get a token
//   GET  /.well-known/oauth-authorization-server    -> the endpoints below
//   POST /oauth/register     {redirect_uris}        -> {client_id}  (public clients only)
//   GET  /oauth/authorize    (needs the drive session; signed out = login page)
//   POST /oauth/authorize    "Allow" button          -> redirect with ?code=&state=
//   POST /oauth/token        authorization_code (PKCE S256) | refresh_token
//
// The person approving is whoever holds a drive session, i.e. someone who
// got past the password and the TOTP code. Clients, codes and tokens are R2
// records under .config/oauth/, tokens stored by their SHA-256 only; the
// daily cron drops the expired ones (customMetadata.exp, like sessions).

import { CONFIG } from "./shared.js";

export const OAUTH = CONFIG + "oauth/";
const CODE_TTL = 300;
const ACCESS_TTL = 3600;
const REFRESH_TTL = 30 * 86400;

// Where an approval may send the code: Claude's own callbacks, and loopback
// for desktop clients. Anything else would hand a code to a stranger.
export function allowedRedirect(uri) {
  let u;
  try { u = new URL(uri); } catch { return false; }
  if (u.protocol === "https:" && ["claude.ai", "claude.com"].includes(u.hostname)) return true;
  return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
}

export function oauthMetadata(origin) {
  return {
    issuer: origin,
    authorization_endpoint: origin + "/oauth/authorize",
    token_endpoint: origin + "/oauth/token",
    registration_endpoint: origin + "/oauth/register",
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["drive"],
  };
}

export function resourceMetadata(origin) {
  return { resource: origin + "/mcp", authorization_servers: [origin], scopes_supported: ["drive"] };
}

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type, mcp-protocol-version" };

export function corsPreflight() {
  return new Response(null, { status: 204, headers: { ...CORS, "access-control-allow-methods": "GET, POST, OPTIONS" } });
}

export function jsonCors(body, status = 200) {
  return Response.json(body, { status, headers: { ...CORS, "cache-control": "no-store" } });
}

export async function handleRegister(request, env) {
  let body;
  try { body = await request.json(); } catch { body = null; }
  const uris = body && Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
  if (!uris.length || !uris.every((u) => typeof u === "string" && allowedRedirect(u))) {
    return jsonCors({ error: "invalid_redirect_uri" }, 400);
  }
  const client = {
    client_id: crypto.randomUUID(),
    client_name: typeof body.client_name === "string" ? body.client_name.slice(0, 100) : "MCP client",
    redirect_uris: uris,
  };
  await env.DRIVE_BUCKET.put(OAUTH + "clients/" + client.client_id, JSON.stringify(client));
  return jsonCors({
    ...client,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  }, 201);
}

async function readJson(env, key) {
  const o = await env.DRIVE_BUCKET.get(key);
  return o ? o.json() : null;
}

// The query of an authorize request, checked against the registered client.
async function authorizeParams(env, p) {
  const q = {
    client_id: p.get("client_id") || "",
    redirect_uri: p.get("redirect_uri") || "",
    state: p.get("state") || "",
    code_challenge: p.get("code_challenge") || "",
    code_challenge_method: p.get("code_challenge_method") || "",
    response_type: p.get("response_type") || "",
  };
  if (!/^[0-9a-f-]{36}$/.test(q.client_id)) return { error: "Unknown client." };
  const client = await readJson(env, OAUTH + "clients/" + q.client_id);
  if (!client) return { error: "Unknown client." };
  if (!client.redirect_uris.includes(q.redirect_uri)) return { error: "This redirect address wasn't registered." };
  if (q.response_type !== "code" || q.code_challenge_method !== "S256" || !q.code_challenge) {
    return { error: "Only the code flow with PKCE (S256) is supported." };
  }
  return { q, client };
}

export async function handleAuthorizePage(url, env) {
  const { error, q, client } = await authorizeParams(env, url.searchParams);
  if (error) return consentPage(`<p>${esc(error)}</p>`, 400);
  const hidden = Object.entries(q).map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}">`).join("");
  return consentPage(`
    <h1>Allow access to your documents?</h1>
    <p><b>${esc(client.client_name)}</b> wants to search the documents in Ressources/.</p>
    <p class="muted">It will be sent to ${esc(new URL(q.redirect_uri).host)}.</p>
    <form method="post" action="/oauth/authorize">${hidden}<button>Allow</button></form>`);
}

export async function handleAuthorizeApprove(request, env) {
  const form = await request.formData();
  const { error, q } = await authorizeParams(env, form);
  if (error) return consentPage(`<p>${esc(error)}</p>`, 400);
  const code = randomToken();
  const exp = Math.floor(Date.now() / 1000) + CODE_TTL;
  await env.DRIVE_BUCKET.put(OAUTH + "codes/" + (await sha256(code)), JSON.stringify({
    client_id: q.client_id, redirect_uri: q.redirect_uri, code_challenge: q.code_challenge, exp,
  }), { customMetadata: { exp: String(exp) } });
  const to = new URL(q.redirect_uri);
  to.searchParams.set("code", code);
  if (q.state) to.searchParams.set("state", q.state);
  return new Response(null, { status: 302, headers: { location: to.toString() } });
}

export async function handleToken(request, env) {
  const p = await request.formData().catch(() => null);
  if (!p) return jsonCors({ error: "invalid_request" }, 400);
  const now = Math.floor(Date.now() / 1000);
  const grant = p.get("grant_type");
  const clientId = p.get("client_id") || "";

  if (grant === "authorization_code") {
    const key = OAUTH + "codes/" + (await sha256(p.get("code") || ""));
    const rec = await readJson(env, key);
    if (rec) await env.DRIVE_BUCKET.delete(key); // single use, even when the rest fails
    if (!rec || rec.exp < now || rec.client_id !== clientId || rec.redirect_uri !== p.get("redirect_uri")) {
      return jsonCors({ error: "invalid_grant" }, 400);
    }
    if ((await pkceChallenge(p.get("code_verifier") || "")) !== rec.code_challenge) {
      return jsonCors({ error: "invalid_grant", error_description: "PKCE check failed" }, 400);
    }
    return issueTokens(env, clientId);
  }

  if (grant === "refresh_token") {
    const key = OAUTH + "refresh/" + (await sha256(p.get("refresh_token") || ""));
    const rec = await readJson(env, key);
    if (rec) await env.DRIVE_BUCKET.delete(key); // rotated on every use
    if (!rec || rec.exp < now || rec.client_id !== clientId) return jsonCors({ error: "invalid_grant" }, 400);
    return issueTokens(env, clientId);
  }

  return jsonCors({ error: "unsupported_grant_type" }, 400);
}

async function issueTokens(env, clientId) {
  const now = Math.floor(Date.now() / 1000);
  const access = randomToken(), refresh = randomToken();
  const aExp = now + ACCESS_TTL, rExp = now + REFRESH_TTL;
  await env.DRIVE_BUCKET.put(OAUTH + "access/" + (await sha256(access)), JSON.stringify({ client_id: clientId, exp: aExp }),
    { customMetadata: { exp: String(aExp) } });
  await env.DRIVE_BUCKET.put(OAUTH + "refresh/" + (await sha256(refresh)), JSON.stringify({ client_id: clientId, exp: rExp }),
    { customMetadata: { exp: String(rExp) } });
  return jsonCors({ access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL, refresh_token: refresh, scope: "drive" });
}

export async function isValidAccessToken(env, token) {
  if (!token) return false;
  const rec = await readJson(env, OAUTH + "access/" + (await sha256(token)));
  return !!rec && rec.exp >= Math.floor(Date.now() / 1000);
}

function randomToken() {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

async function sha256(s) {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));
}

const pkceChallenge = sha256;

function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function consentPage(body, status = 200) {
  return new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize access</title><style>
body{font-family:system-ui,sans-serif;background:#16161a;color:#e8e8ea;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}
main{max-width:420px}h1{font-size:20px}.muted{color:#9a9aa2;font-size:14px}
button{background:#5b8cff;color:#fff;border:0;border-radius:6px;padding:10px 18px;font-size:15px;cursor:pointer}
</style></head><body><main>${body}</main></body></html>`, {
    status,
    headers: {
      "content-type": "text/html;charset=UTF-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    },
  });
}
