const crypto = require("node:crypto");
const path = require("node:path");

function parseInteger(name, defaultValue, { min = 0 } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return defaultValue;
  }

  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${name} must be an integer greater than or equal to ${min}`);
  }

  return value;
}

function parseBoolean(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return defaultValue;
  }

  if (["true", "1", "yes", "on"].includes(raw.toLowerCase())) {
    return true;
  }

  if (["false", "0", "no", "off"].includes(raw.toLowerCase())) {
    return false;
  }

  throw new Error(`${name} must be true or false`);
}

function parsePublicBaseUrl() {
  const value = process.env.PUBLIC_BASE_URL || "http://localhost:3000";

  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error("unsupported protocol");
    }

    return url.toString().replace(/\/$/, "");
  } catch (error) {
    throw new Error("PUBLIC_BASE_URL must be a valid http(s) URL");
  }
}

function parseEncryptionKey() {
  const value = process.env.ENCRYPTION_KEY;
  if (!value) {
    throw new Error("ENCRYPTION_KEY is required. Generate one with: node -e \"console.log(require('node:crypto').randomBytes(32).toString('base64'))\"");
  }

  const base64 = Buffer.from(value, "base64");
  if (base64.length === 32) {
    return base64;
  }

  const hex = Buffer.from(value, "hex");
  if (hex.length === 32) {
    return hex;
  }

  throw new Error("ENCRYPTION_KEY must decode to exactly 32 bytes using base64 or hex");
}

function loadConfig() {
  require("dotenv").config();

  const port = parseInteger("PORT", 3000, { min: 0 });
  const checkIntervalMinutes = parseInteger("CHECK_INTERVAL_MINUTES", 15, { min: 1 });
  const maxConcurrentChecks = parseInteger("MAX_CONCURRENT_CHECKS", 2, { min: 1 });
  const minDelayBetweenChecksMs = parseInteger("MIN_DELAY_BETWEEN_CHECKS_MS", 30000, { min: 0 });
  const magicLinkTtlMinutes = parseInteger("MAGIC_LINK_TTL_MINUTES", 15, { min: 1 });
  const sessionTtlDays = parseInteger("SESSION_TTL_DAYS", 30, { min: 1 });
  const authRateLimitPerHour = parseInteger("AUTH_RATE_LIMIT_PER_HOUR", 5, { min: 1 });
  const setupRateLimitPerHour = parseInteger("SETUP_RATE_LIMIT_PER_HOUR", 20, { min: 1 });
  const persistentErrorThreshold = parseInteger("PERSISTENT_ERROR_THRESHOLD", 3, { min: 1 });
  const maxFailureBackoffMinutes = parseInteger("MAX_FAILURE_BACKOFF_MINUTES", 120, { min: 1 });
  const initialLocationResultLimit = parseInteger("INITIAL_LOCATION_RESULT_LIMIT", 8, { min: 1 });
  const expandedLocationResultLimit = parseInteger("EXPANDED_LOCATION_RESULT_LIMIT", 20, { min: 1 });
  const locatorCacheTtlHours = parseInteger("LOCATOR_CACHE_TTL_HOURS", 24, { min: 1 });

  const emailProvider = (process.env.EMAIL_PROVIDER || "console").toLowerCase();
  if (!["console", "resend"].includes(emailProvider)) {
    throw new Error("EMAIL_PROVIDER must be console or resend");
  }

  const emailFrom = process.env.EMAIL_FROM || "ICBC Monitor <notifications@example.com>";
  if (emailProvider === "resend" && !process.env.RESEND_API_KEY) {
    throw new Error("RESEND_API_KEY is required when EMAIL_PROVIDER=resend");
  }

  return {
    port,
    publicBaseUrl: parsePublicBaseUrl(),
    databasePath: process.env.DATABASE_PATH || path.join(process.cwd(), "data", "icbc-monitor.sqlite"),
    encryptionKey: parseEncryptionKey(),
    checkIntervalMs: checkIntervalMinutes * 60 * 1000,
    checkIntervalMinutes,
    maxConcurrentChecks,
    minDelayBetweenChecksMs,
    magicLinkTtlMs: magicLinkTtlMinutes * 60 * 1000,
    sessionTtlMs: sessionTtlDays * 24 * 60 * 60 * 1000,
    authRateLimitPerHour,
    setupRateLimitPerHour,
    persistentErrorThreshold,
    maxFailureBackoffMs: maxFailureBackoffMinutes * 60 * 1000,
    initialLocationResultLimit,
    expandedLocationResultLimit,
    locatorCacheTtlMs: locatorCacheTtlHours * 60 * 60 * 1000,
    bookingUrl: process.env.ICBC_BOOKING_URL || "https://onlinebusiness.icbc.com/webdeas-ui/home",
    emailProvider,
    emailFrom,
    resendApiKey: process.env.RESEND_API_KEY || "",
    devEmailTo: process.env.DEV_EMAIL_TO || "",
    cookieSecure: parseBoolean("COOKIE_SECURE", process.env.PUBLIC_BASE_URL ? process.env.PUBLIC_BASE_URL.startsWith("https://") : false),
    headless: parseBoolean("PLAYWRIGHT_HEADLESS", true),
    startScheduler: parseBoolean("START_WORKER", true),
  };
}

function generateSetupToken() {
  return crypto.randomBytes(32).toString("base64url");
}

module.exports = {
  loadConfig,
  generateSetupToken,
};
