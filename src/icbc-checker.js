const { chromium } = require("playwright");

class IcbcChecker {
  constructor({ bookingUrl, headless = true, logger }) {
    this.bookingUrl = bookingUrl;
    this.headless = headless;
    this.logger = logger;
    this.browser = null;
  }

  async start() {
    if (!this.browser) {
      this.browser = await chromium.launch({ headless: this.headless });
    }
  }

  async stop() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  async checkAvailability(userConfig) {
    const office = userConfig.location;
    const diagnostic = typeof userConfig.onDiagnostic === "function" ? userConfig.onDiagnostic : () => {};
    if (!office) {
      throw new Error("Unsupported ICBC office selected");
    }

    await this.start();
    const context = await this.browser.newContext();
    const page = await context.newPage();
    const checkedAt = new Date();
    const captured = createResponseCapture(page);

    try {
      diagnostic("browser-context-created", { officeId: office.id });
      this.logger.info("opening ICBC booking page", { officeId: office.id });
      await page.goto(this.bookingUrl, { waitUntil: "networkidle" });
      await page.getByRole("button", { name: /next/i }).click();
      diagnostic("booking-entry-opened", { officeId: office.id });

      this.logger.info("logging in to ICBC", { officeId: office.id });
      await page.locator('input[formcontrolname="drvrLastName"]').waitFor({ timeout: 15000 });
      diagnostic("login-form-ready", { officeId: office.id });

      await page.locator('input[formcontrolname="drvrLastName"]').click();
      await page.locator('input[formcontrolname="drvrLastName"]').fill(userConfig.lastName);

      await page.locator('input[formcontrolname="licenceNumber"]').click();
      await page.locator('input[formcontrolname="licenceNumber"]').fill(userConfig.dlNumber);

      await page.locator('input[formcontrolname="keyword"]').click();
      await page.locator('input[formcontrolname="keyword"]').fill(userConfig.keyword);

      const checkbox = page.locator('mat-checkbox[formcontrolname="cb"]');
      const isChecked = await checkbox.locator('input[type="checkbox"]').isChecked();
      if (!isChecked) {
        await checkbox.click();
      }

      await page.getByRole("button", { name: /log in|sign in|next/i }).click();

      this.logger.info("waiting for ICBC post-login state", { officeId: office.id });
      const postLoginState = await waitForPostLoginState(page, captured);
      diagnostic("login-succeeded", { officeId: office.id, state: postLoginState.state });

      let existingAppointmentDetected = postLoginState.state === "existing-appointment";
      let currentAppointment = captured.getCurrentAppointment();
      let rescheduleFlowEntered = false;

      if (existingAppointmentDetected) {
        currentAppointment = currentAppointment || await waitForCurrentAppointment(captured, 3000);
        currentAppointment = currentAppointment || await readCurrentAppointmentFromPage(page).catch(() => null);
        diagnostic("existing-appointment-detected", { officeId: office.id });
        await enterRescheduleFlow(page);
        rescheduleFlowEntered = true;
        diagnostic("reschedule-flow-entered", { officeId: office.id });
      }

      await selectOffice(page, office, diagnostic, this.logger);
      await page.waitForTimeout(4000);

      const structuredSlots = captured.getAvailableSlots();
      const pageText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
      const noSlots = await page.locator(".warning-message-wrapper").count() > 0;
      const appointments = buildAppointmentList({
        slots: structuredSlots,
        noSlots,
        pageText,
        existingAppointmentDetected,
      });
      const actionableSlots = getActionableSlots({
        slots: structuredSlots,
        currentAppointment,
        existingAppointmentDetected,
        fallbackAppointments: appointments,
        noSlots,
      });
      const notificationAppointments = existingAppointmentDetected ? actionableSlots : appointments;
      const available = actionableSlots.length > 0;
      const availabilityHash = buildAvailabilityHash({
        officeId: office.id,
        available,
        actionableSlots,
        appointments: notificationAppointments,
      });

      return {
        success: true,
        loginSucceeded: true,
        existingAppointmentDetected,
        currentAppointment,
        rescheduleFlowEntered,
        officeSelectable: true,
        totalAvailableSlots: structuredSlots.length,
        availableSlots: structuredSlots,
        actionableSlots,
        available,
        appointments: notificationAppointments,
        office: {
          id: office.id,
          name: office.display_name,
          address: office.address,
          city: office.city,
        },
        checkedAt,
        availabilityHash,
        bookingUrl: "https://onlinebusiness.icbc.com/webdeas-ui/booking",
      };
    } finally {
      captured.stop();
      await context.close();
    }
  }
}

function createResponseCapture(page) {
  let currentAppointment = null;
  const availableSlots = [];
  const seenSlots = new Set();

  const handler = async response => {
    const url = response.url();
    if (!isRelevantJsonResponse(response, url)) {
      return;
    }

    try {
      const payload = await response.json();
      const activeAppointment = findActiveAppointment(payload);
      if (activeAppointment) {
        currentAppointment = activeAppointment;
      }

      if (/getAvailableAppointments/i.test(url)) {
        for (const slot of extractAvailableAppointmentSlots(payload)) {
          const key = `${slot.date}|${slot.startTime}|${slot.endTime || ""}|${slot.posId || ""}`;
          if (!seenSlots.has(key)) {
            seenSlots.add(key);
            availableSlots.push(slot);
          }
        }
      }
    } catch (error) {
      // Ignore unreadable or non-JSON responses; the UI path remains authoritative.
    }
  };

  page.on("response", handler);

  return {
    getCurrentAppointment: () => currentAppointment,
    getAvailableSlots: () => [...availableSlots],
    stop: () => page.off("response", handler),
  };
}

function isRelevantJsonResponse(response, url) {
  const headers = response.headers();
  const contentType = headers["content-type"] || "";
  return contentType.includes("application/json") ||
    /driver|appointment|getAvailableAppointments|webAappointments/i.test(url);
}

async function waitForPostLoginState(page, captured) {
  const searchLocator = page.locator("#search-location");
  const rescheduleLocator = page.getByRole("button", { name: /reschedule appointment/i });
  const upcomingText = page.getByText(/upcoming appointments|your upcoming appointments/i).first();
  const deadline = Date.now() + 30000;

  while (Date.now() < deadline) {
    const searchVisible = await searchLocator.isVisible().catch(() => false);
    const rescheduleVisible = await rescheduleLocator.isVisible().catch(() => false);
    const upcomingVisible = await upcomingText.isVisible().catch(() => false);
    const state = classifyPostLoginState({
      searchVisible,
      existingAppointmentVisible: rescheduleVisible || upcomingVisible,
      activeAppointment: captured.getCurrentAppointment(),
    });

    if (state) {
      return { state };
    }

    await page.waitForTimeout(250);
  }

  throw new Error("Timed out waiting for ICBC booking search or existing appointment page");
}

function classifyPostLoginState({ searchVisible, existingAppointmentVisible, activeAppointment }) {
  if (searchVisible) {
    return "booking-search";
  }

  if (existingAppointmentVisible || activeAppointment) {
    return "existing-appointment";
  }

  return null;
}

async function enterRescheduleFlow(page) {
  const reschedule = page.getByRole("button", { name: /reschedule appointment/i }).first()
    .or(page.getByRole("link", { name: /reschedule appointment/i }).first())
    .or(page.getByText(/reschedule appointment/i).first());
  await reschedule.click();
  const yesButton = page.getByRole("button", { name: /yes/i }).first();
  await yesButton.waitFor({ timeout: 15000 });
  await yesButton.click();
  await page.locator("#search-location").waitFor({ timeout: 30000 });
}

async function selectOffice(page, office, diagnostic, logger) {
  logger.info("selecting ICBC office search", { officeId: office.id });
  await page.getByRole("tab", { name: /by office/i }).click();
  diagnostic("office-tab-opened", { officeId: office.id });
  await page.waitForTimeout(1000);

  const officeInput = page.locator('mat-tab-body.mat-tab-body-active input[type="text"]').first();
  await officeInput.waitFor({ timeout: 10000 });
  diagnostic("office-search-ready", { officeId: office.id });

  for (const searchText of buildOfficeSearchTerms(office)) {
    await officeInput.click();
    await officeInput.fill("");
    await officeInput.pressSequentially(searchText, { delay: 80 });

    for (const suggestionPattern of buildOfficeSuggestionPatterns(office)) {
      const suggestion = page.locator("mat-option").filter({ hasText: suggestionPattern }).first();
      const visible = await suggestion.isVisible({ timeout: 5000 }).catch(() => false);
      if (visible) {
        await suggestion.click();
        diagnostic("office-selected", { officeId: office.id });
        logger.info("waiting for ICBC availability results", { officeId: office.id });
        return;
      }
    }
  }

  throw new Error(`ICBC office option was not selectable for ${office.id}`);
}

function buildOfficeSearchTerms(office) {
  const terms = [
    office.booking_search_text,
    office.display_name,
    office.city && office.display_name ? `${office.city} ${office.display_name}` : "",
    parentheticalText(office.display_name),
  ].filter(Boolean);

  return [...new Set(terms.map(term => term.replace(/\s+/g, " ").trim()).filter(Boolean))];
}

function buildOfficeSuggestionPatterns(office) {
  const patterns = [new RegExp(office.booking_option_pattern, "i")];
  const parenthetical = parentheticalText(office.display_name);
  if (parenthetical) {
    patterns.push(new RegExp(escapeRegExp(parenthetical), "i"));
  }

  if (office.display_name) {
    const words = office.display_name
      .replace(/\([^)]*\)/g, " ")
      .split(/\s+/)
      .map(word => word.replace(/[^A-Za-z0-9]/g, ""))
      .filter(word => word.length >= 4 && !/driver|licensing|centre|center|road|tests|only/i.test(word));
    if (words.length > 0) {
      patterns.push(new RegExp(words.map(escapeRegExp).join(".*"), "i"));
    }
  }

  return patterns;
}

function parentheticalText(value) {
  const match = String(value || "").match(/\(([^)]+)\)/);
  return match ? match[1] : "";
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findActiveAppointment(payload) {
  for (const value of walkValues(payload)) {
    if (!value || typeof value !== "object") {
      continue;
    }

    if (looksLikeActiveAppointment(value)) {
      return normalizeCurrentAppointment(value);
    }

    const appointments = findAppointmentArray(value);
    if (!appointments) {
      continue;
    }

    const active = appointments.find(looksLikeActiveAppointment);
    if (active) {
      return normalizeCurrentAppointment(active);
    }
  }

  return null;
}

function findAppointmentArray(value) {
  if (Array.isArray(value)) {
    return value.some(item => item && typeof item === "object" && "bookedIndicator" in item) ? value : null;
  }

  for (const [key, item] of Object.entries(value)) {
    if (key.toLowerCase() === "webaappointments" && Array.isArray(item)) {
      return item;
    }
  }

  return null;
}

function looksLikeActiveAppointment(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof value.bookedIndicator === "string" &&
    value.bookedIndicator.toUpperCase() === "ACTIVE" &&
    value.appointmentDt &&
    value.startTm,
  );
}

function normalizeCurrentAppointment(appointment) {
  if (!appointment || typeof appointment !== "object") {
    return null;
  }

  const normalized = {
    date: appointment.appointmentDt && appointment.appointmentDt.date ? String(appointment.appointmentDt.date) : null,
    startTime: appointment.startTm ? String(appointment.startTm) : null,
    endTime: appointment.endTm ? String(appointment.endTm) : null,
    exam: appointment.dlExam ? {
      code: appointment.dlExam.code || null,
      description: appointment.dlExam.description || null,
    } : null,
    office: {
      name: appointment.posName || null,
      agency: appointment.posGeo && appointment.posGeo.agency ? appointment.posGeo.agency : null,
      address: appointment.posGeo && appointment.posGeo.address ? appointment.posGeo.address : null,
      posId: appointment.posGeo && appointment.posGeo.posId != null ? appointment.posGeo.posId : appointment.posId ?? null,
    },
  };

  return normalized.date && normalized.startTime ? normalized : null;
}

function extractAvailableAppointmentSlots(payload) {
  const slots = [];
  const seen = new Set();

  for (const value of walkValues(payload)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }

    const normalized = normalizeAvailableSlot(value);
    if (!normalized) {
      continue;
    }

    const key = `${normalized.date}|${normalized.startTime}|${normalized.endTime || ""}|${normalized.posId || ""}`;
    if (!seen.has(key)) {
      seen.add(key);
      slots.push(normalized);
    }
  }

  return slots.sort(compareSlots);
}

function normalizeAvailableSlot(slot) {
  if (!slot || typeof slot !== "object" || !slot.appointmentDt || !slot.startTm) {
    return null;
  }

  if (!slot.appointmentDt.date) {
    return null;
  }

  return {
    date: slot.appointmentDt.date ? String(slot.appointmentDt.date) : null,
    dayOfWeek: slot.appointmentDt.dayOfWeek ? String(slot.appointmentDt.dayOfWeek) : null,
    startTime: String(slot.startTm),
    endTime: slot.endTm ? String(slot.endTm) : null,
    examCode: slot.dlExam && slot.dlExam.code ? String(slot.dlExam.code) : null,
    posId: slot.posId ? String(slot.posId) : null,
  };
}

async function waitForCurrentAppointment(captured, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const currentAppointment = captured.getCurrentAppointment();
    if (currentAppointment) {
      return currentAppointment;
    }

    await new Promise(resolve => setTimeout(resolve, 100));
  }

  return null;
}

function buildAppointmentList({ slots, noSlots, pageText, existingAppointmentDetected }) {
  if (slots.length > 0) {
    return slots.map(slot => ({
      ...slot,
      text: formatSlot(slot),
    }));
  }

  if (existingAppointmentDetected || noSlots) {
    return [];
  }

  return extractAppointmentHints(pageText);
}

function getActionableSlots({ slots, currentAppointment, existingAppointmentDetected, fallbackAppointments, noSlots }) {
  if (existingAppointmentDetected) {
    if (!currentAppointment) {
      return [];
    }

    return slots
      .filter(slot => isSlotEarlierThanCurrent(slot, currentAppointment))
      .map(slot => ({ ...slot, text: formatSlot(slot) }));
  }

  if (slots.length > 0) {
    return slots.map(slot => ({ ...slot, text: formatSlot(slot) }));
  }

  return noSlots ? [] : fallbackAppointments;
}

function isSlotEarlierThanCurrent(slot, currentAppointment) {
  const slotDate = toDateTime(slot.date, slot.startTime);
  const currentDate = toDateTime(currentAppointment.date, currentAppointment.startTime);
  return Boolean(slotDate && currentDate && slotDate.getTime() < currentDate.getTime());
}

function toDateTime(date, time) {
  if (!date || !time) {
    return null;
  }

  const normalizedTime = normalizeTime(time);
  const parsed = new Date(`${date}T${normalizedTime}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizeTime(time) {
  const value = String(time);
  if (/^\d{2}:\d{2}:\d{2}$/.test(value)) {
    return value;
  }

  if (/^\d{2}:\d{2}$/.test(value)) {
    return `${value}:00`;
  }

  if (/^\d{4}$/.test(value)) {
    return `${value.slice(0, 2)}:${value.slice(2)}:00`;
  }

  return value;
}

function formatSlot(slot) {
  return [slot.dayOfWeek, slot.date, slot.startTime, slot.endTime ? `to ${slot.endTime}` : ""]
    .filter(Boolean)
    .join(" ");
}

function extractAppointmentHints(pageText) {
  const lines = pageText
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  const hints = lines.filter(line => {
    return /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|\d{1,2}\/\d{1,2}|\d{4}-\d{2}-\d{2}|\d{1,2}:\d{2})\b/i.test(line);
  });

  return hints.slice(0, 8).map(text => ({ text }));
}

async function readCurrentAppointmentFromPage(page) {
  const text = await page.locator("body").innerText({ timeout: 5000 });
  const parsed = parseCurrentAppointmentText(text);
  if (!parsed) {
    return null;
  }

  return {
    date: parsed.date,
    startTime: parsed.startTime,
    endTime: null,
    exam: null,
    office: {
      name: null,
      agency: null,
      address: null,
      posId: null,
    },
  };
}

function parseCurrentAppointmentText(text) {
  const date = parseAppointmentDate(text);
  const startTime = parseAppointmentTime(text);
  return date && startTime ? { date, startTime } : null;
}

function parseAppointmentDate(text) {
  const isoMatch = text.match(/\b\d{4}-\d{2}-\d{2}\b/);
  if (isoMatch) {
    return isoMatch[0];
  }

  const monthMatch = text.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan\.?|Feb\.?|Mar\.?|Apr\.?|Jun\.?|Jul\.?|Aug\.?|Sept?\.?|Oct\.?|Nov\.?|Dec\.?)\s+(\d{1,2}),\s+(\d{4})\b/i);
  if (!monthMatch) {
    return null;
  }

  const months = {
    jan: 1,
    january: 1,
    feb: 2,
    february: 2,
    mar: 3,
    march: 3,
    apr: 4,
    april: 4,
    may: 5,
    jun: 6,
    june: 6,
    jul: 7,
    july: 7,
    aug: 8,
    august: 8,
    sep: 9,
    sept: 9,
    september: 9,
    oct: 10,
    october: 10,
    nov: 11,
    november: 11,
    dec: 12,
    december: 12,
  };
  const monthKey = monthMatch[1].replace(/\./g, "").toLowerCase();
  const month = months[monthKey];
  const day = Number(monthMatch[2]);
  const year = Number(monthMatch[3]);
  if (!month || !day || !year) {
    return null;
  }

  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseAppointmentTime(text) {
  const timeMatch = text.match(/\b(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?|am|pm)?\b/i);
  if (!timeMatch) {
    return null;
  }

  let hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const second = Number(timeMatch[3] || 0);
  const meridiem = timeMatch[4] ? timeMatch[4].replace(/\./g, "").toLowerCase() : null;

  if (meridiem === "pm" && hour < 12) {
    hour += 12;
  } else if (meridiem === "am" && hour === 12) {
    hour = 0;
  }

  if (hour > 23 || minute > 59 || second > 59) {
    return null;
  }

  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
}

function buildAvailabilityHash({ officeId, available, actionableSlots, appointments }) {
  if (!available) {
    return `${officeId}:none`;
  }

  const details = actionableSlots && actionableSlots.length > 0
    ? actionableSlots.map(slot => `${slot.date}|${slot.startTime}|${slot.endTime || ""}`).join("|")
    : appointments.map(appointment => appointment.text).join("|");

  return `${officeId}:available:${details}`;
}

function compareSlots(a, b) {
  const first = toDateTime(a.date, a.startTime);
  const second = toDateTime(b.date, b.startTime);
  return (first ? first.getTime() : 0) - (second ? second.getTime() : 0);
}

function* walkValues(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) {
    return;
  }

  seen.add(value);
  yield value;

  if (Array.isArray(value)) {
    for (const item of value) {
      yield* walkValues(item, seen);
    }
    return;
  }

  for (const item of Object.values(value)) {
    yield* walkValues(item, seen);
  }
}

module.exports = {
  IcbcChecker,
  buildAvailabilityHash,
  classifyPostLoginState,
  extractAppointmentHints,
  extractAvailableAppointmentSlots,
  findActiveAppointment,
  formatSlot,
  isSlotEarlierThanCurrent,
  normalizeAvailableSlot,
  normalizeCurrentAppointment,
  parseCurrentAppointmentText,
};
