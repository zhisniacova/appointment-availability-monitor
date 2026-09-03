const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

function toBoolean(value) {
  return Boolean(value);
}

function mapUser(row) {
  return row || null;
}

function mapTracker(row) {
  if (!row) {
    return null;
  }

  return {
    ...row,
    active: toBoolean(row.active),
    existing_appointment_detected: row.existing_appointment_detected === null || row.existing_appointment_detected === undefined
      ? false
      : toBoolean(row.existing_appointment_detected),
    current_appointment: parseJson(row.current_appointment_json),
    earliest_available_appointment: parseJson(row.earliest_available_appointment_json),
    last_known_available: row.last_known_available === null ? null : toBoolean(row.last_known_available),
  };
}

function mapLocation(row) {
  if (!row) {
    return null;
  }

  return {
    ...row,
    enabled: row.enabled === undefined ? undefined : toBoolean(row.enabled),
    latitude: row.latitude === null ? null : Number(row.latitude),
    longitude: row.longitude === null ? null : Number(row.longitude),
    last_known_available: row.last_known_available === null ? null : toBoolean(row.last_known_available),
  };
}

class Storage {
  constructor(databasePath) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  migrate() {
    this.archiveLegacyTelegramSchema();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS trackers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL UNIQUE,
        encrypted_last_name TEXT NOT NULL,
        encrypted_dl_number TEXT NOT NULL,
        encrypted_keyword TEXT NOT NULL,
        selected_postal_code TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        existing_appointment_detected INTEGER NOT NULL DEFAULT 0,
        current_appointment_json TEXT,
        earliest_available_appointment_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_checked_at TEXT,
        last_successful_check_at TEXT,
        last_known_available INTEGER,
        last_availability_hash TEXT,
        last_notified_availability_hash TEXT,
        consecutive_error_count INTEGER NOT NULL DEFAULT 0,
        last_error_message TEXT,
        last_error_notified_at TEXT,
        next_eligible_check_at TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS locations (
        id TEXT PRIMARY KEY,
        locator_key TEXT UNIQUE,
        display_name TEXT NOT NULL,
        address TEXT,
        city TEXT,
        postal_code TEXT,
        latitude REAL,
        longitude REAL,
        primary_phone TEXT,
        secondary_phone TEXT,
        raw_json TEXT,
        booking_verification_status TEXT,
        booking_verification_notes TEXT,
        booking_search_text TEXT NOT NULL,
        booking_option_pattern TEXT NOT NULL,
        source TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tracker_locations (
        tracker_id INTEGER NOT NULL,
        location_id TEXT NOT NULL,
        locator_key TEXT,
        display_name TEXT NOT NULL,
        address TEXT,
        city TEXT,
        postal_code TEXT,
        latitude REAL,
        longitude REAL,
        booking_verification_status TEXT,
        booking_verification_notes TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_checked_at TEXT,
        last_successful_check_at TEXT,
        last_known_available INTEGER,
        last_availability_hash TEXT,
        last_notified_availability_hash TEXT,
        consecutive_error_count INTEGER NOT NULL DEFAULT 0,
        last_error_message TEXT,
        last_error_notified_at TEXT,
        PRIMARY KEY (tracker_id, location_id),
        FOREIGN KEY (tracker_id) REFERENCES trackers(id) ON DELETE CASCADE,
        FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS postal_location_searches (
        postal_code TEXT PRIMARY KEY,
        origin_latitude REAL,
        origin_longitude REAL,
        origin_label TEXT,
        monitorable_location_ids_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS auth_tokens (
        token_hash TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS tracker_drafts (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        encrypted_last_name TEXT NOT NULL,
        encrypted_dl_number TEXT NOT NULL,
        encrypted_keyword TEXT NOT NULL,
        selected_postal_code TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_trackers_active_due
        ON trackers (active, next_eligible_check_at);
      CREATE INDEX IF NOT EXISTS idx_tracker_locations_enabled
        ON tracker_locations (enabled, tracker_id);
      CREATE INDEX IF NOT EXISTS idx_auth_tokens_email
        ON auth_tokens (email);
      CREATE INDEX IF NOT EXISTS idx_sessions_user
        ON sessions (user_id);
      CREATE INDEX IF NOT EXISTS idx_tracker_drafts_user
        ON tracker_drafts (user_id);
    `);

    this.ensureColumn("locations", "primary_phone", "TEXT");
    this.ensureColumn("locations", "secondary_phone", "TEXT");
    this.ensureColumn("locations", "raw_json", "TEXT");
    this.ensureColumn("locations", "booking_verification_status", "TEXT");
    this.ensureColumn("locations", "booking_verification_notes", "TEXT");
    this.ensureColumn("trackers", "existing_appointment_detected", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("trackers", "current_appointment_json", "TEXT");
    this.ensureColumn("trackers", "earliest_available_appointment_json", "TEXT");
    this.ensureColumn("tracker_locations", "locator_key", "TEXT");
    this.ensureColumn("tracker_locations", "display_name", "TEXT");
    this.ensureColumn("tracker_locations", "address", "TEXT");
    this.ensureColumn("tracker_locations", "city", "TEXT");
    this.ensureColumn("tracker_locations", "postal_code", "TEXT");
    this.ensureColumn("tracker_locations", "latitude", "REAL");
    this.ensureColumn("tracker_locations", "longitude", "REAL");
    this.ensureColumn("tracker_locations", "booking_verification_status", "TEXT");
    this.ensureColumn("tracker_locations", "booking_verification_notes", "TEXT");
  }

  archiveLegacyTelegramSchema() {
    const columns = this.tableColumns("users");
    const hasLegacyUsers = columns.some(column => column.name === "telegram_chat_id") && !columns.some(column => column.name === "email");
    if (!hasLegacyUsers) {
      return;
    }

    const suffix = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
    this.db.exec(`ALTER TABLE users RENAME TO legacy_telegram_users_${suffix}`);
    if (this.tableColumns("user_locations").length > 0) {
      this.db.exec(`ALTER TABLE user_locations RENAME TO legacy_telegram_user_locations_${suffix}`);
    }
    if (this.tableColumns("setup_tokens").length > 0) {
      this.db.exec(`ALTER TABLE setup_tokens RENAME TO legacy_telegram_setup_tokens_${suffix}`);
    }
  }

  tableColumns(tableName) {
    return this.db.prepare(`PRAGMA table_info(${tableName})`).all();
  }

  ensureColumn(tableName, columnName, definition) {
    const columns = this.tableColumns(tableName);
    if (!columns.some(column => column.name === columnName)) {
      this.db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
    }
  }

  close() {
    this.db.close();
  }

  getUserById(id) {
    return mapUser(this.db.prepare("SELECT * FROM users WHERE id = ?").get(id));
  }

  getUserByEmail(email) {
    return mapUser(this.db.prepare("SELECT * FROM users WHERE email = ?").get(normalizeEmail(email)));
  }

  upsertUserByEmail(email) {
    const normalizedEmail = normalizeEmail(email);
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO users (email, created_at, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(email) DO UPDATE SET updated_at = excluded.updated_at
    `).run(normalizedEmail, now, now);
    return this.getUserByEmail(normalizedEmail);
  }

  createAuthToken({ tokenHash, email, expiresAt }) {
    this.db.prepare(`
      INSERT INTO auth_tokens (token_hash, email, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `).run(tokenHash, normalizeEmail(email), expiresAt.toISOString(), new Date().toISOString());
  }

  consumeAuthToken(tokenHash) {
    const row = this.db.prepare("SELECT * FROM auth_tokens WHERE token_hash = ?").get(tokenHash);
    if (!row || row.used_at) {
      return null;
    }

    if (new Date(row.expires_at).getTime() < Date.now()) {
      return null;
    }

    const result = this.db.prepare(`
      UPDATE auth_tokens
      SET used_at = ?
      WHERE token_hash = ? AND used_at IS NULL
    `).run(new Date().toISOString(), tokenHash);

    return result.changes > 0 ? row : null;
  }

  createSession({ tokenHash, userId, expiresAt }) {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO sessions (token_hash, user_id, expires_at, created_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(tokenHash, userId, expiresAt.toISOString(), now, now);
  }

  getSession(tokenHash) {
    const row = this.db.prepare(`
      SELECT sessions.*, users.email
      FROM sessions
      JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = ?
    `).get(tokenHash);

    if (!row || new Date(row.expires_at).getTime() < Date.now()) {
      return null;
    }

    this.db.prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?").run(new Date().toISOString(), tokenHash);
    return {
      session: row,
      user: {
        id: row.user_id,
        email: row.email,
      },
    };
  }

  deleteSession(tokenHash) {
    this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
  }

  createTrackerDraft({ id, userId, encryptedLastName, encryptedDlNumber, encryptedKeyword, selectedPostalCode, expiresAt }) {
    this.db.prepare("DELETE FROM tracker_drafts WHERE user_id = ?").run(userId);
    this.db.prepare(`
      INSERT INTO tracker_drafts (
        id,
        user_id,
        encrypted_last_name,
        encrypted_dl_number,
        encrypted_keyword,
        selected_postal_code,
        expires_at,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      userId,
      encryptedLastName,
      encryptedDlNumber,
      encryptedKeyword,
      selectedPostalCode,
      expiresAt.toISOString(),
      new Date().toISOString(),
    );
  }

  getTrackerDraft(id, userId) {
    const row = this.db.prepare("SELECT * FROM tracker_drafts WHERE id = ? AND user_id = ?").get(id, userId);
    if (!row || new Date(row.expires_at).getTime() < Date.now()) {
      return null;
    }

    return row;
  }

  deleteTrackerDraft(id, userId) {
    this.db.prepare("DELETE FROM tracker_drafts WHERE id = ? AND user_id = ?").run(id, userId);
  }

  upsertTracker({ userId, encryptedLastName, encryptedDlNumber, encryptedKeyword, selectedPostalCode, locationIds }) {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO trackers (
        user_id,
        encrypted_last_name,
        encrypted_dl_number,
        encrypted_keyword,
        selected_postal_code,
        active,
        created_at,
        updated_at,
        consecutive_error_count
      )
      VALUES (?, ?, ?, ?, ?, 1, ?, ?, 0)
      ON CONFLICT(user_id) DO UPDATE SET
        encrypted_last_name = excluded.encrypted_last_name,
        encrypted_dl_number = excluded.encrypted_dl_number,
        encrypted_keyword = excluded.encrypted_keyword,
        selected_postal_code = excluded.selected_postal_code,
        active = 1,
        updated_at = excluded.updated_at,
        consecutive_error_count = 0,
        last_error_message = NULL,
        last_error_notified_at = NULL,
        next_eligible_check_at = NULL
    `).run(
      userId,
      encryptedLastName,
      encryptedDlNumber,
      encryptedKeyword,
      selectedPostalCode || null,
      now,
      now,
    );

    const tracker = this.getTrackerByUserId(userId);
    this.replaceTrackerLocations(tracker.id, locationIds || []);
    return tracker;
  }

  getTrackerByUserId(userId) {
    return mapTracker(this.db.prepare(`
      SELECT trackers.*, users.email
      FROM trackers
      JOIN users ON users.id = trackers.user_id
      WHERE trackers.user_id = ?
    `).get(userId));
  }

  getFirstConfiguredTracker() {
    return mapTracker(this.db.prepare(`
      SELECT trackers.*, users.email
      FROM trackers
      JOIN users ON users.id = trackers.user_id
      WHERE trackers.encrypted_last_name IS NOT NULL
        AND trackers.encrypted_dl_number IS NOT NULL
        AND trackers.encrypted_keyword IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM tracker_locations
          WHERE tracker_locations.tracker_id = trackers.id
            AND tracker_locations.enabled = 1
        )
      ORDER BY trackers.updated_at DESC
      LIMIT 1
    `).get());
  }

  setTrackerActive(userId, active) {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE trackers
      SET active = ?, updated_at = ?, next_eligible_check_at = CASE WHEN ? = 1 THEN NULL ELSE next_eligible_check_at END
      WHERE user_id = ?
    `).run(active ? 1 : 0, now, active ? 1 : 0, userId);
  }

  deleteUserById(userId) {
    const user = this.getUserById(userId);
    if (!user) {
      return false;
    }

    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM auth_tokens WHERE email = ?").run(user.email);
      this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
      this.db.prepare("DELETE FROM tracker_drafts WHERE user_id = ?").run(userId);
      const result = this.db.prepare("DELETE FROM users WHERE id = ?").run(userId);
      this.db.exec("COMMIT");
      return result.changes > 0;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  upsertLocations(locations) {
    const now = new Date().toISOString();
    const statement = this.db.prepare(`
      INSERT INTO locations (
        id,
        locator_key,
        display_name,
        address,
        city,
        postal_code,
        latitude,
        longitude,
        primary_phone,
        secondary_phone,
        raw_json,
        booking_verification_status,
        booking_verification_notes,
        booking_search_text,
        booking_option_pattern,
        source,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        locator_key = excluded.locator_key,
        display_name = excluded.display_name,
        address = excluded.address,
        city = excluded.city,
        postal_code = excluded.postal_code,
        latitude = excluded.latitude,
        longitude = excluded.longitude,
        primary_phone = excluded.primary_phone,
        secondary_phone = excluded.secondary_phone,
        raw_json = excluded.raw_json,
        booking_verification_status = excluded.booking_verification_status,
        booking_verification_notes = excluded.booking_verification_notes,
        booking_search_text = excluded.booking_search_text,
        booking_option_pattern = excluded.booking_option_pattern,
        source = excluded.source,
        updated_at = excluded.updated_at
    `);

    this.db.exec("BEGIN");
    try {
      for (const location of locations) {
        statement.run(
          location.id,
          location.locatorKey,
          location.displayName,
          location.address || null,
          location.city || null,
          location.postalCode || null,
          location.latitude,
          location.longitude,
          location.primaryPhone || null,
          location.secondaryPhone || null,
          location.rawJson || null,
          location.bookingVerificationStatus || null,
          location.bookingVerificationNotes || null,
          location.bookingSearchText,
          location.bookingOptionPattern,
          location.source,
          now,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getLocationsByIds(locationIds) {
    if (!locationIds || locationIds.length === 0) {
      return [];
    }

    const statement = this.db.prepare("SELECT * FROM locations WHERE id = ?");
    return locationIds
      .map(locationId => mapLocation(statement.get(locationId)))
      .filter(Boolean);
  }

  getLocationSearchCache(postalCode, maxAgeMs) {
    const row = this.db.prepare("SELECT * FROM postal_location_searches WHERE postal_code = ?").get(postalCode);
    if (!row) {
      return null;
    }

    if (maxAgeMs && new Date(row.updated_at).getTime() < Date.now() - maxAgeMs) {
      return null;
    }

    let locationIds;
    try {
      locationIds = JSON.parse(row.monitorable_location_ids_json);
    } catch (error) {
      return null;
    }

    if (!Array.isArray(locationIds)) {
      return null;
    }

    return {
      postalCode: row.postal_code,
      origin: row.origin_latitude === null || row.origin_longitude === null
        ? null
        : {
            latitude: Number(row.origin_latitude),
            longitude: Number(row.origin_longitude),
            label: row.origin_label || null,
            source: "icbc-nearest-location-proxy",
          },
      locationIds,
      updatedAt: row.updated_at,
    };
  }

  upsertLocationSearchCache({ postalCode, origin, locationIds }) {
    this.db.prepare(`
      INSERT INTO postal_location_searches (
        postal_code,
        origin_latitude,
        origin_longitude,
        origin_label,
        monitorable_location_ids_json,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(postal_code) DO UPDATE SET
        origin_latitude = excluded.origin_latitude,
        origin_longitude = excluded.origin_longitude,
        origin_label = excluded.origin_label,
        monitorable_location_ids_json = excluded.monitorable_location_ids_json,
        updated_at = excluded.updated_at
    `).run(
      postalCode,
      origin && Number.isFinite(origin.latitude) ? origin.latitude : null,
      origin && Number.isFinite(origin.longitude) ? origin.longitude : null,
      origin && origin.label ? origin.label : null,
      JSON.stringify(locationIds || []),
      new Date().toISOString(),
    );
  }

  replaceTrackerLocations(trackerId, locationIds) {
    const uniqueIds = [...new Set(locationIds)];
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM tracker_locations WHERE tracker_id = ?").run(trackerId);
      const insert = this.db.prepare(`
        INSERT INTO tracker_locations (
          tracker_id,
          location_id,
          locator_key,
          display_name,
          address,
          city,
          postal_code,
          latitude,
          longitude,
          booking_verification_status,
          booking_verification_notes,
          enabled
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      `);
      for (const location of this.getLocationsByIds(uniqueIds)) {
        insert.run(
          trackerId,
          location.id,
          location.locator_key,
          location.display_name,
          location.address,
          location.city,
          location.postal_code,
          location.latitude,
          location.longitude,
          location.booking_verification_status,
          location.booking_verification_notes,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getTrackerLocations(trackerId) {
    return this.db.prepare(`
      SELECT
        locations.id,
        COALESCE(tracker_locations.locator_key, locations.locator_key) AS locator_key,
        COALESCE(tracker_locations.display_name, locations.display_name) AS display_name,
        COALESCE(tracker_locations.address, locations.address) AS address,
        COALESCE(tracker_locations.city, locations.city) AS city,
        COALESCE(tracker_locations.postal_code, locations.postal_code) AS postal_code,
        COALESCE(tracker_locations.latitude, locations.latitude) AS latitude,
        COALESCE(tracker_locations.longitude, locations.longitude) AS longitude,
        locations.primary_phone,
        locations.secondary_phone,
        locations.raw_json,
        COALESCE(tracker_locations.booking_verification_status, locations.booking_verification_status) AS booking_verification_status,
        COALESCE(tracker_locations.booking_verification_notes, locations.booking_verification_notes) AS booking_verification_notes,
        locations.booking_search_text,
        locations.booking_option_pattern,
        locations.source,
        locations.updated_at,
        tracker_locations.enabled,
        tracker_locations.last_checked_at,
        tracker_locations.last_successful_check_at,
        tracker_locations.last_known_available,
        tracker_locations.last_availability_hash,
        tracker_locations.last_notified_availability_hash,
        tracker_locations.consecutive_error_count,
        tracker_locations.last_error_message,
        tracker_locations.last_error_notified_at
      FROM tracker_locations
      JOIN locations ON locations.id = tracker_locations.location_id
      WHERE tracker_locations.tracker_id = ?
      ORDER BY locations.display_name ASC
    `).all(trackerId).map(mapLocation);
  }

  getActiveTrackersDue(now = new Date(), limit = 25) {
    return this.db.prepare(`
      SELECT DISTINCT trackers.*, users.email
      FROM trackers
      JOIN users ON users.id = trackers.user_id
      JOIN tracker_locations ON tracker_locations.tracker_id = trackers.id
      WHERE trackers.active = 1
        AND tracker_locations.enabled = 1
        AND (trackers.next_eligible_check_at IS NULL OR trackers.next_eligible_check_at <= ?)
      ORDER BY COALESCE(trackers.next_eligible_check_at, trackers.created_at) ASC
      LIMIT ?
    `).all(now.toISOString(), limit).map(mapTracker);
  }

  recordCheckStarted(trackerId, nextEligibleAt) {
    this.db.prepare(`
      UPDATE trackers
      SET last_checked_at = ?, next_eligible_check_at = ?
      WHERE id = ?
    `).run(new Date().toISOString(), nextEligibleAt.toISOString(), trackerId);
  }

  recordCheckSuccess(trackerId, {
    checkedAt,
    available,
    availabilityHash,
    nextEligibleAt,
    existingAppointmentDetected = false,
    currentAppointment = null,
    earliestAvailableAppointment = null,
  }) {
    this.db.prepare(`
      UPDATE trackers
      SET
        last_checked_at = ?,
        last_successful_check_at = ?,
        existing_appointment_detected = ?,
        current_appointment_json = ?,
        earliest_available_appointment_json = ?,
        last_known_available = ?,
        last_availability_hash = ?,
        consecutive_error_count = 0,
        last_error_message = NULL,
        last_error_notified_at = NULL,
        next_eligible_check_at = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      checkedAt.toISOString(),
      checkedAt.toISOString(),
      existingAppointmentDetected ? 1 : 0,
      currentAppointment ? JSON.stringify(currentAppointment) : null,
      earliestAvailableAppointment ? JSON.stringify(earliestAvailableAppointment) : null,
      available ? 1 : 0,
      availabilityHash || null,
      nextEligibleAt.toISOString(),
      new Date().toISOString(),
      trackerId,
    );
  }

  recordLocationCheckSuccess(trackerId, locationId, { checkedAt, available, availabilityHash }) {
    this.db.prepare(`
      UPDATE tracker_locations
      SET
        last_checked_at = ?,
        last_successful_check_at = ?,
        last_known_available = ?,
        last_availability_hash = ?,
        consecutive_error_count = 0,
        last_error_message = NULL,
        last_error_notified_at = NULL
      WHERE tracker_id = ? AND location_id = ?
    `).run(
      checkedAt.toISOString(),
      checkedAt.toISOString(),
      available ? 1 : 0,
      availabilityHash || null,
      trackerId,
      locationId,
    );
  }

  recordLocationNotificationSent(trackerId, locationId, availabilityHash) {
    this.db.prepare(`
      UPDATE tracker_locations
      SET last_notified_availability_hash = ?
      WHERE tracker_id = ? AND location_id = ?
    `).run(availabilityHash || null, trackerId, locationId);
  }

  recordCheckFailure(trackerId, { errorMessage, nextEligibleAt }) {
    this.db.prepare(`
      UPDATE trackers
      SET
        consecutive_error_count = consecutive_error_count + 1,
        last_error_message = ?,
        next_eligible_check_at = ?,
        updated_at = ?
      WHERE id = ?
    `).run(errorMessage, nextEligibleAt.toISOString(), new Date().toISOString(), trackerId);

    return mapTracker(this.db.prepare(`
      SELECT trackers.*, users.email
      FROM trackers
      JOIN users ON users.id = trackers.user_id
      WHERE trackers.id = ?
    `).get(trackerId));
  }

  recordLocationCheckFailure(trackerId, locationId, errorMessage) {
    this.db.prepare(`
      UPDATE tracker_locations
      SET
        consecutive_error_count = consecutive_error_count + 1,
        last_error_message = ?
      WHERE tracker_id = ? AND location_id = ?
    `).run(errorMessage, trackerId, locationId);

    return this.getTrackerLocations(trackerId).find(location => location.id === locationId) || null;
  }

  recordLocationErrorNotification(trackerId, locationId) {
    this.db.prepare(`
      UPDATE tracker_locations
      SET last_error_notified_at = ?
      WHERE tracker_id = ? AND location_id = ?
    `).run(new Date().toISOString(), trackerId, locationId);
  }

  recordErrorNotification(trackerId) {
    this.db.prepare(`
      UPDATE trackers
      SET last_error_notified_at = ?
      WHERE id = ?
    `).run(new Date().toISOString(), trackerId);
  }
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function parseJson(value) {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch (error) {
    return null;
  }
}

module.exports = {
  Storage,
  normalizeEmail,
};
