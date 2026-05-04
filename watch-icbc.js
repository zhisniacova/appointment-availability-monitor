require("dotenv").config();
const { chromium } = require("playwright");
const TelegramBot = require("node-telegram-bot-api");

const CHECK_EVERY_MINUTES = Number(process.env.CHECK_EVERY_MINUTES || 5);
const OFFICE_NAME = "Burnaby driver licensing";
const BOOKING_URL = "https://onlinebusiness.icbc.com/webdeas-ui/home";

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);

function log(msg) {
  console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

async function notify(message) {
  await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, message);
}

async function checkOnce() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    // ── Step 1: Home page → click Next ────────────────────────────────────────
    log("Opening ICBC booking page…");
    await page.goto(BOOKING_URL, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: /next/i }).click();

    // ── Step 2: Fill login form ───────────────────────────────────────────────
    log("Logging in…");
    await page.locator('input[formcontrolname="drvrLastName"]').waitFor({ timeout: 15000 });

    // Click each field first so Angular activates the form control
    await page.locator('input[formcontrolname="drvrLastName"]').click();
    await page.locator('input[formcontrolname="drvrLastName"]').fill(process.env.ICBC_LAST_NAME);

    await page.locator('input[formcontrolname="licenceNumber"]').click();
    await page.locator('input[formcontrolname="licenceNumber"]').fill(process.env.ICBC_DL_NUMBER);

    await page.locator('input[formcontrolname="keyword"]').click();
    await page.locator('input[formcontrolname="keyword"]').fill(process.env.ICBC_KEYWORD);

    // Tick the Terms & Conditions checkbox
    const checkbox = page.locator('mat-checkbox[formcontrolname="cb"]');
    const isChecked = await checkbox.locator('input[type="checkbox"]').isChecked();
    if (!isChecked) {
      await checkbox.click();
    }

    await page.getByRole("button", { name: /log in|sign in|next/i }).click();

    // ── Step 3: Wait for the booking page ────────────────────────────────────
    // Wait for the search tab group — it only exists on the booking page
    log("Waiting for booking page…");
    await page.locator("#search-location").waitFor({ timeout: 30000 });

    // ── Step 4: Click the "By office" tab ────────────────────────────────────
    log("Selecting 'By office' tab…");
    await page.getByRole("tab", { name: /by office/i }).click();
    await page.waitForTimeout(1000); // let tab content render

    // ── Step 5: Type office name and pick from autocomplete ───────────────────
    log(`Typing "${OFFICE_NAME}"…`);
    const officeInput = page.locator('mat-tab-body.mat-tab-body-active input[type="text"]').first();
    await officeInput.waitFor({ timeout: 10000 });
    await officeInput.click();
    // Type character by character so Angular's autocomplete reacts
    await officeInput.pressSequentially(OFFICE_NAME, { delay: 80 });

    // Wait for the dropdown option and click it
    const suggestion = page.locator("mat-option").filter({ hasText: /Burnaby driver licensing/i }).first();
    await suggestion.waitFor({ timeout: 10000 });
    await suggestion.click();

    // ── Step 6: Wait for results ──────────────────────────────────────────────
    log("Waiting for availability results…");
    await page.waitForTimeout(4000);

    // ── Step 7: Check availability ────────────────────────────────────────────
    const noSlots = await page.locator(".warning-message-wrapper").count() > 0;

    if (noSlots) {
      log("No appointments available.");
    } else {
      log("APPOINTMENTS FOUND — sending notification!");
      await notify(
        `🚗 ICBC road test slots available at ${OFFICE_NAME}!\n\nBook now → https://onlinebusiness.icbc.com/webdeas-ui/booking`
      );
    }
  } catch (err) {
    log(`Error during check: ${err.message}`);
    await page.screenshot({ path: "debug-last-run.png" }).catch(() => {});
    throw err;
  } finally {
    await browser.close();
  }
}

async function loop() {
  log(`Starting ICBC watcher — checking every ${CHECK_EVERY_MINUTES} min`);
  while (true) {
    try {
      await checkOnce();
    } catch (err) {
      log(`Check failed: ${err.message}`);
    }
    log(`Sleeping ${CHECK_EVERY_MINUTES} min…`);
    await new Promise(resolve => setTimeout(resolve, CHECK_EVERY_MINUTES * 60 * 1000));
  }
}

loop();
