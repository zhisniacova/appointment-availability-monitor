const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createCryptoBox } = require("../src/crypto-box");
const {
  createMagicLink,
  createSession,
  getCurrentUser,
  hashToken,
  isValidEmail,
  serializeCookie,
  validateCsrf,
  verifyMagicLink,
} = require("../src/auth");
const { normalizePostalCode } = require("../src/postal-code");
const { Storage } = require("../src/storage");
const { validateTrackerDetails } = require("../src/web-server");

function tempStorage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "icbc-monitor-test-"));
  return new Storage(path.join(dir, "test.sqlite"));
}

function config(overrides = {}) {
  return {
    publicBaseUrl: "http://localhost:3000",
    magicLinkTtlMs: 15 * 60 * 1000,
    sessionTtlMs: 30 * 24 * 60 * 60 * 1000,
    ...overrides,
  };
}

test("encrypts and decrypts sensitive values without storing plaintext", () => {
  const key = crypto.randomBytes(32);
  const box = createCryptoBox(key);

  const encrypted = box.encrypt("sensitive keyword");

  assert.notEqual(encrypted, "sensitive keyword");
  assert.match(encrypted, /^v1:/);
  assert.equal(box.decrypt(encrypted), "sensitive keyword");

  const encryptedAgain = box.encrypt("sensitive keyword");
  assert.notEqual(encryptedAgain, encrypted);
  assert.notEqual(encryptedAgain.split(":")[1], encrypted.split(":")[1]);
});

test("magic links are hashed, expire, single-use, and create email users", () => {
  const storage = tempStorage();
  try {
    const link = createMagicLink({
      storage,
      config: config(),
      email: "Tester@Example.com",
    });
    const tokenRow = storage.db.prepare("SELECT * FROM auth_tokens WHERE email = ?").get("tester@example.com");

    assert.equal(tokenRow.token_hash, hashToken(link.token));
    assert.notEqual(tokenRow.token_hash, link.token);

    const first = verifyMagicLink({ storage, token: link.token });
    const second = verifyMagicLink({ storage, token: link.token });

    assert.equal(first.ok, true);
    assert.equal(first.user.email, "tester@example.com");
    assert.deepEqual(second, { ok: false });

    const expired = createMagicLink({
      storage,
      config: config({ magicLinkTtlMs: -1 }),
      email: "expired@example.com",
    });
    assert.deepEqual(verifyMagicLink({ storage, token: expired.token }), { ok: false });
  } finally {
    storage.close();
  }
});

test("sessions expire and resolve the current user from an HttpOnly SameSite cookie", () => {
  const storage = tempStorage();
  try {
    const user = storage.upsertUserByEmail("person@example.com");
    const session = createSession({ storage, config: config(), user });
    const cookie = serializeCookie("icbc_session", session.token, { secure: true });
    const request = { headers: { cookie } };

    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.match(cookie, /Secure/);
    assert.equal(getCurrentUser(storage, request).email, "person@example.com");
    storage.deleteSession(hashToken(session.token));
    assert.equal(getCurrentUser(storage, request), null);

    const expiredSession = createSession({ storage, config: config({ sessionTtlMs: -1 }), user });
    assert.equal(getCurrentUser(storage, { headers: { cookie: serializeCookie("icbc_session", expiredSession.token) } }), null);
  } finally {
    storage.close();
  }
});

test("tracker details validate expected credential and postal-code shapes", () => {
  const valid = new URLSearchParams({
    lastName: "Morgan-Smith",
    dlNumber: "1234567",
    keyword: "keyword",
    postalCode: "v5h2n2",
  });

  assert.equal(validateTrackerDetails(valid).ok, true);
  assert.equal(validateTrackerDetails(new URLSearchParams({ ...Object.fromEntries(valid), lastName: "<script>" })).ok, false);
  assert.equal(validateTrackerDetails(new URLSearchParams({ ...Object.fromEntries(valid), postalCode: "D1A 1A1" })).ok, false);
});

test("normalizes Canadian postal codes and email addresses", () => {
  assert.equal(normalizePostalCode("v5h2n2"), "V5H 2N2");
  assert.equal(normalizePostalCode("V5H 2N2"), "V5H 2N2");
  assert.equal(normalizePostalCode("D1A 1A1"), null);
  assert.equal(isValidEmail("person@example.com"), true);
  assert.equal(isValidEmail("not-an-email"), false);
});

test("csrf validation requires matching cookie and form tokens", () => {
  const form = new URLSearchParams({ csrf: "same-token" });
  const request = { headers: { cookie: "icbc_csrf=same-token" } };
  const badRequest = { headers: { cookie: "icbc_csrf=different" } };

  assert.equal(validateCsrf(request, form), true);
  assert.equal(validateCsrf(badRequest, form), false);
});

test("deleting an account removes personally linked records and keeps shared location cache", () => {
  const storage = tempStorage();
  const box = createCryptoBox(crypto.randomBytes(32));
  try {
    const user = storage.upsertUserByEmail("delete-me@example.com");
    const authLink = createMagicLink({ storage, config: config(), email: user.email });
    createSession({ storage, config: config(), user });
    storage.upsertLocations([
      {
        id: "icbc-FpEniQaRrcvuGf8e7OjD1",
        locatorKey: "FpEniQaRrcvuGf8e7OjD1",
        displayName: "Burnaby Driver Licensing",
        address: "4820 Kingsway",
        city: "Burnaby",
        postalCode: null,
        latitude: 49.2266,
        longitude: -122.9993,
        bookingVerificationStatus: "manual-unverified",
        bookingVerificationNotes: "test",
        bookingSearchText: "Burnaby driver licensing",
        bookingOptionPattern: "Burnaby driver licensing",
        source: "test",
      },
    ]);
    const tracker = storage.upsertTracker({
      userId: user.id,
      encryptedLastName: box.encrypt("Tester"),
      encryptedDlNumber: box.encrypt("1234567"),
      encryptedKeyword: box.encrypt("keyword"),
      selectedPostalCode: "V5H 2N2",
      locationIds: ["icbc-FpEniQaRrcvuGf8e7OjD1"],
    });
    storage.createTrackerDraft({
      id: "draft-1",
      userId: user.id,
      encryptedLastName: box.encrypt("Draft"),
      encryptedDlNumber: box.encrypt("7654321"),
      encryptedKeyword: box.encrypt("draft-keyword"),
      selectedPostalCode: "V5H 2N2",
      expiresAt: new Date(Date.now() + 1000),
    });

    assert.equal(storage.deleteUserById(user.id), true);
    assert.equal(storage.db.prepare("SELECT COUNT(*) AS count FROM users WHERE id = ?").get(user.id).count, 0);
    assert.equal(storage.db.prepare("SELECT COUNT(*) AS count FROM trackers WHERE id = ?").get(tracker.id).count, 0);
    assert.equal(storage.db.prepare("SELECT COUNT(*) AS count FROM tracker_locations WHERE tracker_id = ?").get(tracker.id).count, 0);
    assert.equal(storage.db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?").get(user.id).count, 0);
    assert.equal(storage.db.prepare("SELECT COUNT(*) AS count FROM tracker_drafts WHERE user_id = ?").get(user.id).count, 0);
    assert.equal(storage.db.prepare("SELECT COUNT(*) AS count FROM auth_tokens WHERE token_hash = ?").get(hashToken(authLink.token)).count, 0);
    assert.equal(storage.db.prepare("SELECT COUNT(*) AS count FROM locations WHERE id = ?").get("icbc-FpEniQaRrcvuGf8e7OjD1").count, 1);
  } finally {
    storage.close();
  }
});
