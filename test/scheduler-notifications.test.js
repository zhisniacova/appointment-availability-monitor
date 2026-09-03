const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createCryptoBox } = require("../src/crypto-box");
const { shouldNotifyAvailability } = require("../src/notifications");
const { Scheduler } = require("../src/scheduler");
const { Storage } = require("../src/storage");

function tempStorage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "icbc-monitor-test-"));
  return new Storage(path.join(dir, "test.sqlite"));
}

test("availability notification is suppressed after the same available state was already notified", () => {
  const user = {
    last_known_available: true,
    last_notified_availability_hash: "burnaby:available:first",
  };
  const result = {
    available: true,
    availabilityHash: "burnaby:available:first",
  };

  assert.equal(shouldNotifyAvailability(user, result), false);
  assert.equal(shouldNotifyAvailability({ ...user, last_known_available: false }, result), true);
  assert.equal(shouldNotifyAvailability(user, { ...result, availabilityHash: "burnaby:available:changed" }), true);
});

test("scheduler stop waits for jobs and closes the checker", async () => {
  const storage = tempStorage();
  const box = createCryptoBox(crypto.randomBytes(32));
  const sent = [];
  const checker = {
    stopped: false,
    async checkAvailability() {
      return {
        success: true,
        available: false,
        appointments: [],
        office: { id: "burnaby-driver-licensing", name: "Burnaby driver licensing" },
        checkedAt: new Date(),
        availabilityHash: "burnaby:none",
        bookingUrl: "https://onlinebusiness.icbc.com/webdeas-ui/booking",
      };
    },
    async stop() {
      this.stopped = true;
    },
  };

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
      bookingSearchText: "Burnaby driver licensing",
      bookingOptionPattern: "Burnaby driver licensing",
      source: "test",
    },
  ]);

  const user = storage.upsertUserByEmail("tester@example.com");
  storage.upsertTracker({
    userId: user.id,
    encryptedLastName: box.encrypt("Tester"),
    encryptedDlNumber: box.encrypt("1234567"),
    encryptedKeyword: box.encrypt("keyword"),
    selectedPostalCode: "V5H 2N2",
    locationIds: ["icbc-FpEniQaRrcvuGf8e7OjD1"],
  });

  const scheduler = new Scheduler({
    storage,
    cryptoBox: box,
    checker,
    notificationService: {
      sendAvailabilityNotification: async (recipient, result) => sent.push({ email: recipient.email, result }),
      sendPersistentErrorNotification: async (recipient, target) => sent.push({ email: recipient.email, target }),
    },
    config: {
      maxConcurrentChecks: 1,
      minDelayBetweenChecksMs: 0,
      checkIntervalMs: 1000,
      maxFailureBackoffMs: 5000,
      persistentErrorThreshold: 3,
    },
    logger: { warn() {}, info() {}, error() {} },
  });

  try {
    scheduler.start();
    await scheduler.stop();
    assert.equal(checker.stopped, true);
    assert.deepEqual(sent, []);
  } finally {
    storage.close();
  }
});

test("scheduler emails availability once per unchanged available state and again after reappearance", async () => {
  const storage = tempStorage();
  const box = createCryptoBox(crypto.randomBytes(32));
  const sent = [];
  let available = true;
  const checker = {
    async checkAvailability() {
      return {
        success: true,
        available,
        appointments: available ? [{ text: "Jan 2, 10:00 AM" }] : [],
        office: { id: "burnaby-driver-licensing", name: "Burnaby driver licensing" },
        checkedAt: new Date(),
        availabilityHash: available ? "burnaby:jan-2-10am" : "burnaby:none",
        bookingUrl: "https://onlinebusiness.icbc.com/webdeas-ui/booking",
      };
    },
    async stop() {},
  };

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
      bookingSearchText: "Burnaby driver licensing",
      bookingOptionPattern: "Burnaby driver licensing",
      source: "test",
    },
  ]);

  const user = storage.upsertUserByEmail("notify@example.com");
  storage.upsertTracker({
    userId: user.id,
    encryptedLastName: box.encrypt("Tester"),
    encryptedDlNumber: box.encrypt("1234567"),
    encryptedKeyword: box.encrypt("keyword"),
    selectedPostalCode: "V5H 2N2",
    locationIds: ["icbc-FpEniQaRrcvuGf8e7OjD1"],
  });

  const scheduler = new Scheduler({
    storage,
    cryptoBox: box,
    checker,
    notificationService: {
      sendAvailabilityNotification: async (recipient, result) => sent.push({ email: recipient.email, hash: result.availabilityHash }),
      sendPersistentErrorNotification: async () => {},
    },
    config: {
      maxConcurrentChecks: 1,
      minDelayBetweenChecksMs: 0,
      checkIntervalMs: 1000,
      maxFailureBackoffMs: 5000,
      persistentErrorThreshold: 3,
    },
    logger: { warn() {}, info() {}, error() {} },
  });

  try {
    await scheduler.runTrackerCheck(storage.getTrackerByUserId(user.id));
    await scheduler.runTrackerCheck(storage.getTrackerByUserId(user.id));
    available = false;
    await scheduler.runTrackerCheck(storage.getTrackerByUserId(user.id));
    available = true;
    await scheduler.runTrackerCheck(storage.getTrackerByUserId(user.id));

    assert.deepEqual(sent, [
      { email: "notify@example.com", hash: "burnaby:jan-2-10am" },
      { email: "notify@example.com", hash: "burnaby:jan-2-10am" },
    ]);
  } finally {
    storage.close();
  }
});

test("scheduler only emails earlier actionable slots when a current appointment exists", async () => {
  const storage = tempStorage();
  const box = createCryptoBox(crypto.randomBytes(32));
  const sent = [];
  const currentAppointment = {
    date: "2026-10-15",
    startTime: "11:00:00",
    endTime: "11:45:00",
    office: { name: "Point Grey", address: "4126 MacDonald Street", posId: "123" },
  };
  const sequence = [
    {
      available: false,
      totalAvailableSlots: 1,
      availableSlots: [{ date: "2026-10-16", startTime: "09:00:00" }],
      actionableSlots: [],
      availabilityHash: "burnaby:none",
    },
    {
      available: true,
      totalAvailableSlots: 1,
      availableSlots: [{ date: "2026-10-10", startTime: "09:00:00", endTime: "09:45:00" }],
      actionableSlots: [{ date: "2026-10-10", startTime: "09:00:00", endTime: "09:45:00", text: "2026-10-10 09:00:00" }],
      availabilityHash: "burnaby:available:2026-10-10|09:00:00|09:45:00",
    },
    {
      available: true,
      totalAvailableSlots: 1,
      availableSlots: [{ date: "2026-10-10", startTime: "09:00:00", endTime: "09:45:00" }],
      actionableSlots: [{ date: "2026-10-10", startTime: "09:00:00", endTime: "09:45:00", text: "2026-10-10 09:00:00" }],
      availabilityHash: "burnaby:available:2026-10-10|09:00:00|09:45:00",
    },
    {
      available: false,
      totalAvailableSlots: 1,
      availableSlots: [{ date: "2026-10-16", startTime: "09:00:00" }],
      actionableSlots: [],
      availabilityHash: "burnaby:none",
    },
  ];
  const checker = {
    async checkAvailability() {
      const next = sequence.shift();
      return {
        success: true,
        loginSucceeded: true,
        existingAppointmentDetected: true,
        currentAppointment,
        rescheduleFlowEntered: true,
        officeSelectable: true,
        appointments: next.actionableSlots,
        office: { id: "burnaby-driver-licensing", name: "Burnaby driver licensing" },
        checkedAt: new Date(),
        bookingUrl: "https://onlinebusiness.icbc.com/webdeas-ui/booking",
        ...next,
      };
    },
    async stop() {},
  };

  const user = seedSingleLocationTracker(storage, box, "earlier@example.com");
  const scheduler = makeScheduler({ storage, box, checker, sent });

  try {
    await scheduler.runTrackerCheck(storage.getTrackerByUserId(user.id));
    await scheduler.runTrackerCheck(storage.getTrackerByUserId(user.id));
    await scheduler.runTrackerCheck(storage.getTrackerByUserId(user.id));
    await scheduler.runTrackerCheck(storage.getTrackerByUserId(user.id));

    assert.deepEqual(sent, [
      { email: "earlier@example.com", hash: "burnaby:available:2026-10-10|09:00:00|09:45:00" },
    ]);

    const tracker = storage.getTrackerByUserId(user.id);
    assert.equal(tracker.existing_appointment_detected, true);
    assert.equal(tracker.current_appointment.date, "2026-10-15");
    assert.equal(tracker.last_known_available, false);
    assert.deepEqual(tracker.earliest_available_appointment, {
      date: "2026-10-16",
      startTime: "09:00:00",
      officeName: "Burnaby driver licensing",
    });
  } finally {
    storage.close();
  }
});

test("scheduler persists earliest later slot for dashboard without sending notification", async () => {
  const storage = tempStorage();
  const box = createCryptoBox(crypto.randomBytes(32));
  const sent = [];
  const checker = {
    async checkAvailability() {
      return {
        success: true,
        loginSucceeded: true,
        existingAppointmentDetected: true,
        currentAppointment: {
          date: "2026-10-19",
          startTime: "09:50",
          endTime: "10:30",
          office: { name: "POINT GREY DRIVER LICENSING", posId: 9 },
        },
        rescheduleFlowEntered: true,
        officeSelectable: true,
        available: false,
        totalAvailableSlots: 48,
        availableSlots: [
          { date: "2026-11-18", startTime: "09:55", endTime: "10:35" },
          { date: "2026-11-18", startTime: "11:10", endTime: "11:50" },
          { date: "2026-11-19", startTime: "08:20", endTime: "09:00" },
        ],
        actionableSlots: [],
        appointments: [],
        office: {
          id: "icbc-6rPPNEzEnVv1dEyQnqCsAA",
          name: "Vancouver Driver Licensing (Point Grey)",
        },
        checkedAt: new Date(),
        availabilityHash: "icbc-6rPPNEzEnVv1dEyQnqCsAA:none",
        bookingUrl: "https://onlinebusiness.icbc.com/webdeas-ui/booking",
      };
    },
    async stop() {},
  };

  const user = seedSingleLocationTracker(storage, box, "later-dashboard@example.com");
  const scheduler = makeScheduler({ storage, box, checker, sent });

  try {
    await scheduler.runTrackerCheck(storage.getTrackerByUserId(user.id));

    const tracker = storage.getTrackerByUserId(user.id);
    assert.equal(tracker.last_known_available, false);
    assert.deepEqual(sent, []);
    assert.deepEqual(tracker.earliest_available_appointment, {
      date: "2026-11-18",
      startTime: "09:55",
      officeName: "Vancouver Driver Licensing (Point Grey)",
    });
  } finally {
    storage.close();
  }
});

function seedSingleLocationTracker(storage, box, email) {
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
      bookingSearchText: "Burnaby driver licensing",
      bookingOptionPattern: "Burnaby driver licensing",
      source: "test",
    },
  ]);

  const user = storage.upsertUserByEmail(email);
  storage.upsertTracker({
    userId: user.id,
    encryptedLastName: box.encrypt("Tester"),
    encryptedDlNumber: box.encrypt("1234567"),
    encryptedKeyword: box.encrypt("keyword"),
    selectedPostalCode: "V5H 2N2",
    locationIds: ["icbc-FpEniQaRrcvuGf8e7OjD1"],
  });
  return user;
}

function makeScheduler({ storage, box, checker, sent }) {
  return new Scheduler({
    storage,
    cryptoBox: box,
    checker,
    notificationService: {
      sendAvailabilityNotification: async (recipient, result) => sent.push({ email: recipient.email, hash: result.availabilityHash }),
      sendPersistentErrorNotification: async () => {},
    },
    config: {
      maxConcurrentChecks: 1,
      minDelayBetweenChecksMs: 0,
      checkIntervalMs: 1000,
      maxFailureBackoffMs: 5000,
      persistentErrorThreshold: 3,
    },
    logger: { warn() {}, info() {}, error() {} },
  });
}
