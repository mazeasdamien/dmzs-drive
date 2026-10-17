// Constants and helpers every part of the Worker uses.

export const TRASH = ".trash/";
export const CONFIG = ".config/"; // hidden technical area (share-link records live here)
export const SHARES = CONFIG + "shares/";
export const SESSIONS = CONFIG + "sessions/"; // one record per signed-in device
export const TOTP_LAST = CONFIG + "totp-last"; // last accepted code's time step
export const SESSION_COOKIE = "__Host-session";
export const SESSION_DAYS = 30;
export const TRASH_RETENTION_DAYS = 30;

export function isReserved(key) {
  return key.startsWith(TRASH) || key.startsWith(CONFIG);
}

// Stored files are served with this: whatever a file turns out to contain, it
// can't run script or load anything when opened directly.
export const FILE_CSP = "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'";
