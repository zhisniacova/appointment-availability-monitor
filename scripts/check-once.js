#!/usr/bin/env node

const { loadConfig } = require("../src/config");
const {
  computeEarliestAvailable,
  slotsForDashboard,
} = require("../src/availability-summary");
const { createCryptoBox } = require("../src/crypto-box");
const { createEmailService } = require("../src/email-service");
const { IcbcChecker } = require("../src/icbc-checker");
const { createLogger, publicError } = require("../src/log");
const { NotificationService } = require("../src/notifications");
const { categorizeError } = require("../src/scheduler");
const { Storage } = require("../src/storage");

async function main() {
  const logger = createLogger("check-once");
  const config = loadConfig();
  const storage = new Storage(config.databasePath);
  const cryptoBox = createCryptoBox(config.encryptionKey);
  const checker = new IcbcChecker({
    bookingUrl: config.bookingUrl,
    headless: config.headless,
    logger: createLogger("icbc"),
  });
  const emailService = createEmailService(config, createLogger("email"));
  const notificationService = new NotificationService({
    emailService,
    logger: createLogger("notifications"),
  });

  try {
    const tracker = storage.getFirstConfiguredTracker();
    if (!tracker) {
      safePrint({
        event: "check-once",
        status: "no-configured-tracker",
      });
      process.exitCode = 1;
      return;
    }

    const locations = storage.getTrackerLocations(tracker.id).filter(location => location.enabled);
    safePrint({
      event: "check-once-started",
      trackerId: tracker.id,
      userId: tracker.user_id,
      locationCount: locations.length,
      workerEnabled: false,
    });

    const credentials = {
      lastName: cryptoBox.decrypt(tracker.encrypted_last_name),
      dlNumber: cryptoBox.decrypt(tracker.encrypted_dl_number),
      keyword: cryptoBox.decrypt(tracker.encrypted_keyword),
    };

    storage.recordCheckStarted(tracker.id, new Date());

    let successCount = 0;
    let anyAvailable = false;
    let lastCheckedAt = new Date();
    let lastAvailabilityHash = null;
    let lastError = null;
    let existingAppointmentDetected = false;
    let lastCurrentAppointment = null;
    const returnedAvailableSlots = [];

    for (const location of locations) {
      const stages = new Set();
      const officeReport = {
        event: "location-check",
        trackerId: tracker.id,
        locationId: location.id,
        locatorKey: location.locator_key,
        displayName: location.display_name,
        loginSucceeded: false,
        existingAppointmentDetected: false,
        currentAppointment: null,
        rescheduleFlowEntered: false,
        officeSelectable: false,
        available: null,
        totalAvailableSlots: 0,
        actionableSlots: 0,
      };

      try {
        const result = await checker.checkAvailability({
          ...credentials,
          location,
          onDiagnostic: stage => stages.add(stage),
        });

        officeReport.loginSucceeded = Boolean(result.loginSucceeded || stages.has("login-succeeded"));
        officeReport.existingAppointmentDetected = Boolean(result.existingAppointmentDetected);
        officeReport.currentAppointment = result.currentAppointment ? summarizeCurrentAppointment(result.currentAppointment) : null;
        officeReport.rescheduleFlowEntered = Boolean(result.rescheduleFlowEntered);
        officeReport.officeSelectable = Boolean(result.officeSelectable || stages.has("office-selected"));
        officeReport.available = result.available;
        officeReport.totalAvailableSlots = result.totalAvailableSlots;
        officeReport.actionableSlots = result.actionableSlots.length;
        officeReport.checkedAt = result.checkedAt.toISOString();
        safePrint(officeReport);

        storage.recordLocationCheckSuccess(tracker.id, location.id, {
          checkedAt: result.checkedAt,
          available: result.available,
          availabilityHash: result.availabilityHash,
        });

        if (result.available) {
          await notificationService.sendAvailabilityNotification(
            { id: tracker.user_id, email: tracker.email },
            result,
          );
          storage.recordLocationNotificationSent(tracker.id, location.id, result.availabilityHash);
          safePrint({
            event: "availability-notification-sent",
            trackerId: tracker.id,
            locationId: location.id,
            provider: config.emailProvider,
          });
        }

        successCount += 1;
        anyAvailable = anyAvailable || result.available;
        existingAppointmentDetected = existingAppointmentDetected || Boolean(result.existingAppointmentDetected);
        lastCurrentAppointment = result.currentAppointment || lastCurrentAppointment;
        returnedAvailableSlots.push(...slotsForDashboard(result));
        lastCheckedAt = result.checkedAt;
        lastAvailabilityHash = result.availabilityHash;
      } catch (error) {
        lastError = error;
        const errorMessage = categorizeError(error);
        storage.recordLocationCheckFailure(tracker.id, location.id, errorMessage);

        safePrint({
          ...officeReport,
          loginSucceeded: stages.has("login-succeeded"),
          existingAppointmentDetected: stages.has("existing-appointment-detected"),
          rescheduleFlowEntered: stages.has("reschedule-flow-entered"),
          officeSelectable: stages.has("office-selected"),
          failureCategory: errorMessage,
          failureStage: inferFailureStage(stages),
          failureDiagnostic: publicError(error),
        });
      }
    }

    if (successCount > 0) {
      const earliestAvailableAppointment = computeEarliestAvailable(returnedAvailableSlots);
      storage.recordCheckSuccess(tracker.id, {
        checkedAt: lastCheckedAt,
        available: anyAvailable,
        availabilityHash: lastAvailabilityHash,
        nextEligibleAt: new Date(),
        existingAppointmentDetected,
        currentAppointment: lastCurrentAppointment,
        earliestAvailableAppointment,
      });
      safePrint({
        event: "earliest-available-persisted",
        trackerId: tracker.id,
        earliestAvailableAppointment,
      });
    } else if (lastError) {
      storage.recordCheckFailure(tracker.id, {
        errorMessage: categorizeError(lastError),
        nextEligibleAt: new Date(),
      });
    }

    safePrint({
      event: "check-once-finished",
      trackerId: tracker.id,
      locationCount: locations.length,
      successCount,
      anyAvailable,
    });
  } finally {
    await checker.stop();
    storage.close();
  }
}

function inferFailureStage(stages) {
  if (!stages.has("booking-entry-opened")) {
    return "opening-booking-site";
  }

  if (!stages.has("login-form-ready")) {
    return "finding-login-form";
  }

  if (!stages.has("login-succeeded")) {
    return "logging-in";
  }

  if (stages.has("existing-appointment-detected") && !stages.has("reschedule-flow-entered")) {
    return "entering-reschedule-flow";
  }

  if (!stages.has("office-tab-opened")) {
    return "opening-office-search";
  }

  if (!stages.has("office-search-ready")) {
    return "finding-office-search";
  }

  if (!stages.has("office-selected")) {
    return "selecting-office";
  }

  return "checking-availability";
}

function safePrint(payload) {
  console.log(JSON.stringify(payload));
}

function summarizeCurrentAppointment(appointment) {
  return {
    date: appointment.date,
    startTime: appointment.startTime,
    endTime: appointment.endTime,
    exam: appointment.exam,
    office: appointment.office,
  };
}

main().catch(error => {
  safePrint({
    event: "check-once-crashed",
    failureCategory: categorizeError(error),
    failureDiagnostic: publicError(error),
  });
  process.exitCode = 1;
});
