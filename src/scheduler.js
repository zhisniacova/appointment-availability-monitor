const {
  shouldNotifyAvailability,
} = require("./notifications");
const {
  computeEarliestAvailable,
  slotsForDashboard,
} = require("./availability-summary");
const { publicError } = require("./log");

class Scheduler {
  constructor({ storage, cryptoBox, checker, notificationService, config, logger }) {
    this.storage = storage;
    this.cryptoBox = cryptoBox;
    this.checker = checker;
    this.notificationService = notificationService;
    this.config = config;
    this.logger = logger;
    this.timer = null;
    this.stopped = false;
    this.tickRunning = false;
    this.inFlightTrackerIds = new Set();
    this.jobs = new Set();
    this.globalPauseUntil = null;
    this.globalFailureCount = 0;
  }

  start() {
    if (this.timer) {
      return;
    }

    this.stopped = false;
    this.timer = setInterval(() => {
      this.tick().catch(error => this.logger.error("scheduler tick failed", { error: error.message }));
    }, 10000);
    this.tick().catch(error => this.logger.error("scheduler initial tick failed", { error: error.message }));
  }

  async stop() {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    await Promise.allSettled([...this.jobs]);
    await this.checker.stop();
  }

  async tick() {
    if (this.stopped || this.tickRunning) {
      return;
    }

    if (this.globalPauseUntil && this.globalPauseUntil.getTime() > Date.now()) {
      return;
    }

    this.tickRunning = true;
    try {
      const capacity = this.config.maxConcurrentChecks - this.inFlightTrackerIds.size;
      if (capacity <= 0) {
        return;
      }

      const dueTrackers = this.storage
        .getActiveTrackersDue(new Date(), capacity)
        .filter(tracker => !this.inFlightTrackerIds.has(tracker.id));

      for (const tracker of dueTrackers) {
        if (this.stopped || this.inFlightTrackerIds.size >= this.config.maxConcurrentChecks) {
          break;
        }

        this.startTrackerJob(tracker);
        if (this.config.minDelayBetweenChecksMs > 0) {
          await sleep(this.config.minDelayBetweenChecksMs);
        }
      }
    } finally {
      this.tickRunning = false;
    }
  }

  startTrackerJob(tracker) {
    this.inFlightTrackerIds.add(tracker.id);
    this.storage.recordCheckStarted(tracker.id, this.nextEligibleTime(tracker, 0));

    const job = this.runTrackerCheck(tracker)
      .catch(error => this.logger.error("tracker check crashed", { trackerId: tracker.id, error: error.message }))
      .finally(() => {
        this.inFlightTrackerIds.delete(tracker.id);
        this.jobs.delete(job);
      });

    this.jobs.add(job);
  }

  async runTrackerCheck(tracker) {
    const user = { id: tracker.user_id, email: tracker.email };
    const locations = this.storage.getTrackerLocations(tracker.id).filter(location => location.enabled);
    if (locations.length === 0) {
      const updated = this.storage.recordCheckFailure(tracker.id, {
        errorMessage: "No ICBC locations selected",
        nextEligibleAt: this.nextEligibleTime(tracker, 1),
      });
      await this.maybeNotifyPersistentError(user, updated);
      return;
    }

    let anyAvailable = false;
    let lastAvailabilityHash = null;
    let lastCheckedAt = new Date();
    let successCount = 0;
    let lastError = null;
    let existingAppointmentDetected = false;
    let lastCurrentAppointment = null;
    const returnedAvailableSlots = [];

    const credentials = {
      lastName: this.cryptoBox.decrypt(tracker.encrypted_last_name),
      dlNumber: this.cryptoBox.decrypt(tracker.encrypted_dl_number),
      keyword: this.cryptoBox.decrypt(tracker.encrypted_keyword),
    };

    for (const location of locations) {
      try {
        const result = await this.checker.checkAvailability({
          ...credentials,
          location,
        });

        lastCheckedAt = result.checkedAt;
        anyAvailable = anyAvailable || result.available;
        lastAvailabilityHash = result.availabilityHash;
        existingAppointmentDetected = existingAppointmentDetected || Boolean(result.existingAppointmentDetected);
        lastCurrentAppointment = result.currentAppointment || lastCurrentAppointment;
        returnedAvailableSlots.push(...slotsForDashboard(result));

        const notify = shouldNotifyAvailability(location, result);
        this.storage.recordLocationCheckSuccess(tracker.id, location.id, {
          checkedAt: result.checkedAt,
          available: result.available,
          availabilityHash: result.availabilityHash,
        });

        if (notify) {
          await this.notificationService.sendAvailabilityNotification(user, result);
          this.storage.recordLocationNotificationSent(tracker.id, location.id, result.availabilityHash);
        }

        this.logger.info("location check completed", {
          trackerId: tracker.id,
          userId: user.id,
          locationId: location.id,
          available: result.available,
        });
        successCount += 1;
      } catch (error) {
        lastError = error;
        const errorMessage = categorizeError(error);
        const updatedLocation = this.storage.recordLocationCheckFailure(tracker.id, location.id, errorMessage);

        this.logger.warn("location check failed", {
          trackerId: tracker.id,
          userId: user.id,
          locationId: location.id,
          error: publicError(error),
        });

        if (updatedLocation && updatedLocation.consecutive_error_count >= this.config.persistentErrorThreshold && !updatedLocation.last_error_notified_at) {
          await this.notificationService.sendPersistentErrorNotification(user, updatedLocation, this.config.persistentErrorThreshold);
          this.storage.recordLocationErrorNotification(tracker.id, location.id);
        }
      }
    }

    if (successCount > 0) {
      const nextEligibleAt = this.nextEligibleTime(tracker, 0);
      this.storage.recordCheckSuccess(tracker.id, {
        checkedAt: lastCheckedAt,
        available: anyAvailable,
        availabilityHash: lastAvailabilityHash,
        nextEligibleAt,
        existingAppointmentDetected,
        currentAppointment: lastCurrentAppointment,
        earliestAvailableAppointment: computeEarliestAvailable(returnedAvailableSlots),
      });

      this.globalFailureCount = 0;
      this.globalPauseUntil = null;
      return;
    }

    if (lastError) {
      const errorMessage = categorizeError(lastError);
      const nextEligibleAt = this.nextEligibleTime(tracker, Number(tracker.consecutive_error_count || 0) + 1);
      const updated = this.storage.recordCheckFailure(tracker.id, {
        errorMessage,
        nextEligibleAt,
      });

      this.logger.warn("tracker check failed", {
        trackerId: tracker.id,
        userId: user.id,
        error: publicError(lastError),
        nextEligibleAt: nextEligibleAt.toISOString(),
      });

      this.trackGlobalFailure(lastError);
      await this.maybeNotifyPersistentError(user, updated);
    }
  }

  async maybeNotifyPersistentError(user, tracker) {
    if (!tracker || tracker.last_error_notified_at) {
      return;
    }

    if (tracker.consecutive_error_count < this.config.persistentErrorThreshold) {
      return;
    }

    await this.notificationService.sendPersistentErrorNotification(user, tracker, this.config.persistentErrorThreshold);
    this.storage.recordErrorNotification(tracker.id);
  }

  trackGlobalFailure(error) {
    if (!isLikelyGlobalFailure(error)) {
      return;
    }

    this.globalFailureCount += 1;
    if (this.globalFailureCount >= 5) {
      this.globalPauseUntil = new Date(Date.now() + Math.min(this.config.maxFailureBackoffMs, 15 * 60 * 1000));
      this.logger.warn("pausing checks after repeated likely ICBC-wide failures", {
        pauseUntil: this.globalPauseUntil.toISOString(),
      });
      this.globalFailureCount = 0;
    }
  }

  nextEligibleTime(user, failureCount) {
    const interval = this.config.checkIntervalMs;
    const backoffMultiplier = failureCount > 0 ? Math.min(2 ** Math.min(failureCount - 1, 6), 64) : 1;
    const delay = Math.min(interval * backoffMultiplier, this.config.maxFailureBackoffMs);
    const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(interval * 0.25)));
    return new Date(Date.now() + delay + jitter);
  }
}

function categorizeError(error) {
  const message = String(error && error.message ? error.message : error);
  if (/locator|timeout|search-location|mat-option|networkidle/i.test(message)) {
    return "ICBC page unavailable or changed";
  }

  if (/login|sign in|credential|auth|password|keyword/i.test(message)) {
    return "ICBC login failed";
  }

  return "Check failed";
}

function isLikelyGlobalFailure(error) {
  const message = String(error && error.message ? error.message : error);
  return /timeout|network|net::|search-location|mat-option|navigation/i.test(message);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  Scheduler,
  categorizeError,
};
