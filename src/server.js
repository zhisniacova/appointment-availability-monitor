const { loadConfig } = require("./config");
const { createCryptoBox } = require("./crypto-box");
const { createEmailService } = require("./email-service");
const { IcbcChecker } = require("./icbc-checker");
const { LocationDiscovery } = require("./location-discovery");
const { createLogger } = require("./log");
const { NotificationService } = require("./notifications");
const { Scheduler } = require("./scheduler");
const { Storage } = require("./storage");
const { createWebServer } = require("./web-server");

async function main() {
  const logger = createLogger("server");
  let config;
  let storage;
  let checker;
  let scheduler;
  let webServer;

  try {
    config = loadConfig();
    storage = new Storage(config.databasePath);
    const cryptoBox = createCryptoBox(config.encryptionKey);
    const locationDiscovery = new LocationDiscovery({
      storage,
      config,
      logger: createLogger("locations"),
    });

    const emailService = createEmailService(config, createLogger("email"));
    const notificationService = new NotificationService({
      emailService,
      logger: createLogger("notifications"),
    });

    checker = new IcbcChecker({
      bookingUrl: config.bookingUrl,
      headless: config.headless,
      logger: createLogger("icbc"),
    });

    scheduler = new Scheduler({
      storage,
      cryptoBox,
      checker,
      notificationService,
      config,
      logger: createLogger("scheduler"),
    });

    webServer = createWebServer({
      storage,
      cryptoBox,
      emailService,
      locationDiscovery,
      config,
      logger: createLogger("web"),
    });

    await listen(webServer, config.port);
    logger.info("web server listening", {
      port: webServer.address().port,
      publicBaseUrl: config.publicBaseUrl,
      databasePath: config.databasePath,
    });

    if (config.startScheduler) {
      scheduler.start();
      logger.info("scheduler started", {
        checkIntervalMinutes: config.checkIntervalMinutes,
        maxConcurrentChecks: config.maxConcurrentChecks,
        minDelayBetweenChecksMs: config.minDelayBetweenChecksMs,
      });
    } else {
      logger.info("scheduler disabled by START_WORKER=false");
    }

    const shutdown = async signal => {
      logger.info("shutdown requested", { signal });
      await closeServer(webServer);
      if (scheduler) {
        await scheduler.stop();
      } else if (checker) {
        await checker.stop();
      }
      if (storage) {
        storage.close();
      }
      logger.info("shutdown complete");
      process.exit(0);
    };

    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  } catch (error) {
    logger.error("startup failed", { error: error.message });
    if (webServer) {
      await closeServer(webServer).catch(() => {});
    }
    if (scheduler) {
      await scheduler.stop().catch(() => {});
    } else if (checker) {
      await checker.stop().catch(() => {});
    }
    if (storage) {
      storage.close();
    }
    process.exitCode = 1;
  }
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    if (!server || !server.listening) {
      resolve();
      return;
    }

    server.close(error => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  main,
};
