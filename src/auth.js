const crypto = require("node:crypto");
const { normalizeEmail } = require("./storage");

const SESSION_COOKIE = "icbc_session";
const CSRF_COOKIE = "icbc_csrf";

function createToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function isValidEmail(email) {
  const normalized = normalizeEmail(email);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) && normalized.length <= 254;
}

function createMagicLink({ storage, config, email }) {
  const token = createToken();
  const expiresAt = new Date(Date.now() + config.magicLinkTtlMs);
  storage.createAuthToken({
    tokenHash: hashToken(token),
    email: normalizeEmail(email),
    expiresAt,
  });

  const url = new URL("/auth/verify", config.publicBaseUrl);
  url.searchParams.set("token", token);
  return { token, url: url.toString(), expiresAt };
}

function verifyMagicLink({ storage, token }) {
  const record = storage.consumeAuthToken(hashToken(token));
  if (!record) {
    return { ok: false };
  }

  const user = storage.upsertUserByEmail(record.email);
  return { ok: true, user };
}

function createSession({ storage, config, user }) {
  const token = createToken();
  const expiresAt = new Date(Date.now() + config.sessionTtlMs);
  storage.createSession({
    tokenHash: hashToken(token),
    userId: user.id,
    expiresAt,
  });
  return { token, expiresAt };
}

function getCurrentUser(storage, request) {
  const token = parseCookies(request.headers.cookie || "")[SESSION_COOKIE];
  if (!token) {
    return null;
  }

  const session = storage.getSession(hashToken(token));
  return session ? session.user : null;
}

function destroySession(storage, request) {
  const token = parseCookies(request.headers.cookie || "")[SESSION_COOKIE];
  if (token) {
    storage.deleteSession(hashToken(token));
  }
}

function createCsrfToken() {
  return createToken();
}

function validateCsrf(request, form) {
  const cookies = parseCookies(request.headers.cookie || "");
  const cookieToken = cookies[CSRF_COOKIE] || "";
  const formToken = form.get("csrf") || "";
  const cookieBuffer = Buffer.from(cookieToken);
  const formBuffer = Buffer.from(formToken);
  return Boolean(cookieToken && formToken && cookieBuffer.length === formBuffer.length && crypto.timingSafeEqual(cookieBuffer, formBuffer));
}

function parseCookies(cookieHeader) {
  const cookies = {};
  for (const part of String(cookieHeader || "").split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (!rawName) {
      continue;
    }

    cookies[rawName] = decodeURIComponent(rawValue.join("=") || "");
  }
  return cookies;
}

function serializeCookie(name, value, { expires = null, maxAge = null, httpOnly = true, secure = false, sameSite = "Lax", path = "/" } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, `SameSite=${sameSite}`];
  if (httpOnly) {
    parts.push("HttpOnly");
  }
  if (secure) {
    parts.push("Secure");
  }
  if (expires) {
    parts.push(`Expires=${expires.toUTCString()}`);
  }
  if (maxAge !== null) {
    parts.push(`Max-Age=${maxAge}`);
  }
  return parts.join("; ");
}

module.exports = {
  CSRF_COOKIE,
  SESSION_COOKIE,
  createCsrfToken,
  createMagicLink,
  createSession,
  destroySession,
  getCurrentUser,
  hashToken,
  isValidEmail,
  normalizeEmail,
  parseCookies,
  serializeCookie,
  validateCsrf,
  verifyMagicLink,
};
