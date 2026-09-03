const crypto = require("node:crypto");
const {
  CSRF_COOKIE,
  SESSION_COOKIE,
  createCsrfToken,
  createMagicLink,
  createSession,
  destroySession,
  getCurrentUser,
  isValidEmail,
  normalizeEmail,
  parseCookies,
  serializeCookie,
  validateCsrf,
  verifyMagicLink,
} = require("./auth");
const { isMonitorableLocationId } = require("./locations");
const { normalizePostalCode } = require("./postal-code");
const { InMemoryRateLimiter, clientIp } = require("./rate-limit");

const MAX_BODY_BYTES = 25_000;
const DRAFT_TTL_MS = 30 * 60 * 1000;

function createWebServer({ storage, cryptoBox, emailService, locationDiscovery, config, logger }) {
  const authLimiter = new InMemoryRateLimiter({
    limit: config.authRateLimitPerHour,
    windowMs: 60 * 60 * 1000,
  });
  const setupLimiter = new InMemoryRateLimiter({
    limit: config.setupRateLimitPerHour,
    windowMs: 60 * 60 * 1000,
  });

  return httpHandler(async (request, response) => {
    addSecurityHeaders(response);

    const url = new URL(request.url, "http://localhost");
    const user = getCurrentUser(storage, request);

    if (request.method === "GET" && url.pathname === "/health") {
      return send(response, 200, "ok", "text/plain; charset=utf-8");
    }

    if (request.method === "GET" && url.pathname === "/") {
      return user ? redirect(response, "/dashboard") : renderSignIn(response, config);
    }

    if (request.method === "GET" && url.pathname === "/signin") {
      return renderSignIn(response, config);
    }

    if (request.method === "POST" && url.pathname === "/auth/request") {
      return handleMagicLinkRequest({ request, response, storage, emailService, config, logger, authLimiter });
    }

    if (request.method === "GET" && url.pathname === "/auth/verify") {
      return handleMagicLinkVerify({ response, url, storage, config });
    }

    if (request.method === "POST" && url.pathname === "/logout") {
      return handleLogout({ request, response, storage, config });
    }

    if (!user) {
      return redirect(response, "/signin");
    }

    if (request.method === "GET" && url.pathname === "/dashboard") {
      return renderDashboard(response, { storage, user, config });
    }

    if (request.method === "GET" && url.pathname === "/tracker/edit") {
      return renderTrackerEdit(response, { storage, user, config });
    }

    if (request.method === "POST" && url.pathname === "/tracker/search") {
      return handleTrackerSearch({ request, response, storage, cryptoBox, locationDiscovery, user, config, logger, setupLimiter });
    }

    if (request.method === "POST" && url.pathname === "/tracker/expand") {
      return handleTrackerExpand({ request, response, storage, locationDiscovery, user, config, logger, setupLimiter });
    }

    if (request.method === "POST" && url.pathname === "/tracker/save") {
      return handleTrackerSave({ request, response, storage, user });
    }

    if (request.method === "POST" && url.pathname === "/tracker/pause") {
      return handleTrackerActiveChange({ request, response, storage, user, active: false });
    }

    if (request.method === "POST" && url.pathname === "/tracker/resume") {
      return handleTrackerActiveChange({ request, response, storage, user, active: true });
    }

    if (request.method === "POST" && url.pathname === "/account/delete") {
      return handleAccountDelete({ request, response, storage, user, config });
    }

    return send(response, 404, renderPage("Not found", "<p>The page you requested was not found.</p>", { user }), "text/html; charset=utf-8");
  }, logger);
}

function httpHandler(handler, logger) {
  const http = require("node:http");
  return http.createServer(async (request, response) => {
    try {
      await handler(request, response);
    } catch (error) {
      logger.error("web request failed", { error: error.message });
      send(response, 500, renderPage("Something went wrong", "<p>Please try again.</p>"), "text/html; charset=utf-8");
    }
  });
}

async function handleMagicLinkRequest({ request, response, storage, emailService, config, logger, authLimiter }) {
  const form = await readForm(request);
  if (!validateCsrf(request, form)) {
    return send(response, 403, renderPage("Session expired", "<p>Refresh the sign-in page and try again.</p>"), "text/html; charset=utf-8");
  }

  const email = normalizeEmail(form.get("email"));
  const rateKey = `auth:${clientIp(request)}:${email}`;
  if (!authLimiter.check(rateKey)) {
    return send(response, 429, renderPage("Too many attempts", "<p>Please wait before requesting another sign-in link.</p>"), "text/html; charset=utf-8");
  }

  if (!isValidEmail(email)) {
    return renderSignIn(response, config, "Enter a valid email address.");
  }

  const magicLink = createMagicLink({ storage, config, email });
  await emailService.send({
    to: email,
    subject: "Your Road Test Watch sign-in link",
    text: [
      "Sign in to Road Test Watch:",
      magicLink.url,
      "",
      `This link expires at ${magicLink.expiresAt.toLocaleString()}.`,
      "If you did not request this sign-in link, you can ignore this email.",
    ].join("\n"),
    html: `
  <!doctype html>
  <html>
    <body style="
      margin:0;
      padding:0;
      background:#f1f5f9;
      font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;
      color:#1f2937;
    ">
      <div style="padding:32px 16px;">
        <div style="
          max-width:560px;
          margin:0 auto;
          background:#ffffff;
          border:1px solid #e2e8f0;
          border-radius:16px;
          padding:32px;
        ">
          <div style="
            font-size:14px;
            font-weight:700;
            color:#0f766e;
            margin-bottom:14px;
          ">
            ROAD TEST WATCH
          </div>

          <h1 style="
            margin:0 0 14px;
            font-size:28px;
            line-height:1.2;
            color:#111827;
          ">
            Sign in to your tracker
          </h1>

          <p style="
            margin:0;
            font-size:16px;
            line-height:1.6;
            color:#475569;
          ">
            Use the button below to securely sign in and manage your road test monitoring.
          </p>

          <div style="margin:28px 0;">
            <a
              href="${escapeHtml(magicLink.url)}"
              style="
                display:inline-block;
                background:#0f766e;
                color:#ffffff;
                text-decoration:none;
                font-weight:700;
                padding:14px 20px;
                border-radius:10px;
                font-size:16px;
              "
            >
              Sign in to Road Test Watch
            </a>
          </div>

          <p style="
            margin:0;
            font-size:14px;
            line-height:1.5;
            color:#64748b;
          ">
            This link expires at ${escapeHtml(magicLink.expiresAt.toLocaleString())}.
          </p>

          <p style="
            margin:18px 0 0;
            font-size:14px;
            line-height:1.5;
            color:#64748b;
          ">
            If you didn’t request this sign-in link, you can safely ignore this email.
          </p>

          <hr style="
            border:none;
            border-top:1px solid #e2e8f0;
            margin:28px 0 18px;
          ">

          <p style="
            margin:0;
            font-size:12px;
            line-height:1.5;
            color:#94a3b8;
          ">
            Road Test Watch is an independent monitoring tool and is not affiliated with ICBC.
          </p>
        </div>
      </div>
    </body>
  </html>
    `.trim(),
  });

  logger.info("magic link requested", { email, provider: config.emailProvider });
  const devLink = config.emailProvider === "console"
    ? `<p class="dev-link"><a href="${escapeHtml(magicLink.url)}">Open development sign-in link</a></p>`
    : "";
  return send(
    response,
    200,
    renderPage("Check your email", `<p>We sent a sign-in link to ${escapeHtml(email)}.</p>${devLink}`),
    "text/html; charset=utf-8",
  );
}

function handleMagicLinkVerify({ response, url, storage, config }) {
  const token = url.searchParams.get("token") || "";
  const verification = verifyMagicLink({ storage, token });
  if (!verification.ok) {
    return send(response, 400, renderPage("Link unavailable", "<p>This sign-in link is invalid, expired, or already used.</p><p><a href=\"/signin\">Request a new link</a></p>"), "text/html; charset=utf-8");
  }

  const session = createSession({ storage, config, user: verification.user });
  response.setHeader("Set-Cookie", serializeCookie(SESSION_COOKIE, session.token, {
    expires: session.expiresAt,
    secure: config.cookieSecure,
  }));
  return redirect(response, "/dashboard");
}

function handleLogout({ request, response, storage, config }) {
  destroySession(storage, request);
  response.setHeader("Set-Cookie", serializeCookie(SESSION_COOKIE, "", {
    expires: new Date(0),
    maxAge: 0,
    secure: config.cookieSecure,
  }));
  return redirect(response, "/signin");
}

async function handleTrackerSearch({ request, response, storage, cryptoBox, locationDiscovery, user, config, logger, setupLimiter }) {
  const form = await readForm(request);
  if (!validateCsrf(request, form)) {
    return send(response, 403, renderPage("Session expired", "<p>Refresh the tracker form and try again.</p>", { user }), "text/html; charset=utf-8");
  }

  if (!setupLimiter.check(`setup:${clientIp(request)}:${user.id}`)) {
    return send(response, 429, renderPage("Too many attempts", "<p>Please wait before changing tracker settings again.</p>", { user }), "text/html; charset=utf-8");
  }

  const validation = validateTrackerDetails(form);
  if (!validation.ok) {
    return renderTrackerEdit(response, { storage, user, config, error: validation.message, values: formValues(form) });
  }

  let result;
  try {
    result = await locationDiscovery.findNearby(validation.values.postalCode, null);
  } catch (error) {
    logger.warn("location search failed", { userId: user.id, error: error.message });
    return renderTrackerEdit(response, {
      storage,
      user,
      config,
      error: "Location search is temporarily unavailable. Please try again later.",
      values: formValues(form),
    });
  }

  if (!result.ok) {
    return renderTrackerEdit(response, { storage, user, config, error: "Enter a valid Canadian postal code.", values: formValues(form) });
  }

  const draftId = crypto.randomBytes(24).toString("base64url");
  storage.createTrackerDraft({
    id: draftId,
    userId: user.id,
    encryptedLastName: cryptoBox.encrypt(validation.values.lastName),
    encryptedDlNumber: cryptoBox.encrypt(validation.values.dlNumber),
    encryptedKeyword: cryptoBox.encrypt(validation.values.keyword),
    selectedPostalCode: validation.values.postalCode,
    expiresAt: new Date(Date.now() + DRAFT_TTL_MS),
  });

  return renderLocationSelection(response, { user, config, draftId, searchResult: result });
}

async function handleTrackerExpand({ request, response, storage, locationDiscovery, user, config, logger, setupLimiter }) {
  const form = await readForm(request);
  if (!validateCsrf(request, form)) {
    return send(response, 403, renderPage("Session expired", "<p>Refresh the tracker form and try again.</p>", { user }), "text/html; charset=utf-8");
  }

  if (!setupLimiter.check(`setup:${clientIp(request)}:${user.id}`)) {
    return send(response, 429, renderPage("Too many attempts", "<p>Please wait before changing tracker settings again.</p>", { user }), "text/html; charset=utf-8");
  }

  const draftId = String(form.get("draftId") || "");
  const draft = storage.getTrackerDraft(draftId, user.id);
  if (!draft) {
    return redirect(response, "/tracker/edit");
  }

  try {
    const result = await locationDiscovery.findNearby(draft.selected_postal_code, config.expandedLocationResultLimit);
    return renderLocationSelection(response, { user, config, draftId, searchResult: result });
  } catch (error) {
    logger.warn("expanded location search failed", { userId: user.id, error: error.message });
    return redirect(response, "/tracker/edit");
  }
}

async function handleTrackerSave({ request, response, storage, user }) {
  const form = await readForm(request);
  if (!validateCsrf(request, form)) {
    return send(response, 403, renderPage("Session expired", "<p>Refresh the tracker form and try again.</p>", { user }), "text/html; charset=utf-8");
  }

  const draftId = String(form.get("draftId") || "");
  const draft = storage.getTrackerDraft(draftId, user.id);
  if (!draft) {
    return redirect(response, "/tracker/edit");
  }

  const locationIds = [...new Set(form.getAll("locationIds").map(value => normalizeInput(value, 120)))];
  if (locationIds.length === 0 || !locationIds.every(isMonitorableLocationId) || storage.getLocationsByIds(locationIds).length !== locationIds.length) {
    return send(response, 400, renderPage("Choose a location", "<p>Select at least one supported ICBC road-test location.</p>", { user }), "text/html; charset=utf-8");
  }

  storage.upsertTracker({
    userId: user.id,
    encryptedLastName: draft.encrypted_last_name,
    encryptedDlNumber: draft.encrypted_dl_number,
    encryptedKeyword: draft.encrypted_keyword,
    selectedPostalCode: draft.selected_postal_code,
    locationIds,
  });
  storage.deleteTrackerDraft(draftId, user.id);
  return redirect(response, "/dashboard");
}

async function handleTrackerActiveChange({ request, response, storage, user, active }) {
  const form = await readForm(request);
  if (!validateCsrf(request, form)) {
    return send(response, 403, renderPage("Session expired", "<p>Refresh the dashboard and try again.</p>", { user }), "text/html; charset=utf-8");
  }

  storage.setTrackerActive(user.id, active);
  return redirect(response, "/dashboard");
}

async function handleAccountDelete({ request, response, storage, user, config }) {
  const form = await readForm(request);
  if (!validateCsrf(request, form)) {
    return send(response, 403, renderPage("Session expired", "<p>Refresh the dashboard and try again.</p>", { user }), "text/html; charset=utf-8");
  }

  if (form.get("confirm") !== "delete") {
    return send(response, 400, renderPage("Confirmation required", "<p>Type delete to permanently remove your tracker and account.</p>", { user }), "text/html; charset=utf-8");
  }

  storage.deleteUserById(user.id);
  response.setHeader("Set-Cookie", serializeCookie(SESSION_COOKIE, "", {
    expires: new Date(0),
    maxAge: 0,
    secure: config.cookieSecure,
  }));
  return send(response, 200, renderPage("Deleted", "<p>Your account, tracker, and stored ICBC credentials were deleted.</p><p><a href=\"/signin\">Return to sign in</a></p>"), "text/html; charset=utf-8");
}

function renderSignIn(response, config, error = "") {
  return renderWithCsrf(response, config, csrf => renderPage("Sign In", `
    ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
    <p>Enter your email and we will send you a one-time sign-in link.</p>
    <form method="post" action="/auth/request" autocomplete="on">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <label>
        Email
        <input name="email" type="email" required autocomplete="email" inputmode="email">
      </label>
      <button type="submit">Send sign-in link</button>
    </form>
  `));
}

function renderDashboard(response, { storage, user, config }) {
  const tracker = storage.getTrackerByUserId(user.id);
  if (!tracker) {
    return renderWithCsrf(response, config, csrf => renderPage("Dashboard", `
      <p class="muted">${escapeHtml(user.email)}</p>
      <p>No tracker is configured yet.</p>
      <p><a class="button-link" href="/tracker/edit">Create tracker</a></p>
      ${logoutForm(csrf)}
    `, { user }));
  }

  const locations = storage.getTrackerLocations(tracker.id);
  const currentAppointmentPanel = tracker.existing_appointment_detected && tracker.current_appointment
    ? renderCurrentAppointmentPanel(tracker.current_appointment)
    : "";
  const locationRows = locations.map(location => `
    <li>
      <strong>${escapeHtml(location.display_name)}</strong>
      <small>${escapeHtml([location.address, location.city, location.postal_code].filter(Boolean).join(", "))}</small>
      <small>Earlier availability: ${escapeHtml(formatEarlierAvailability(location.last_known_available))}</small>
    </li>
  `).join("");

  return renderWithCsrf(response, config, csrf => renderPage("Dashboard", `
    <p class="muted">${escapeHtml(user.email)}</p>
    <div class="status ${tracker.active ? "active" : "paused"}">${tracker.active ? "ACTIVE" : "PAUSED"}</div>
    <dl>
      <div><dt>Postal code area</dt><dd>${escapeHtml(tracker.selected_postal_code || "not saved")}</dd></div>
      <div><dt>Last successful check</dt><dd>${escapeHtml(formatDate(tracker.last_successful_check_at))}</dd></div>
      <div><dt>Earliest available right now</dt><dd>${renderEarliestAvailable(tracker.earliest_available_appointment)}</dd></div>
      <div><dt>Earlier actionable appointment</dt><dd>${escapeHtml(formatActionableAvailability(tracker))}</dd></div>
      <div><dt>Next eligible check</dt><dd>${escapeHtml(formatDate(tracker.next_eligible_check_at))}</dd></div>
    </dl>
    ${currentAppointmentPanel}
    <h2>Selected offices</h2>
    <ul class="locations">${locationRows || "<li>No locations selected.</li>"}</ul>
    <div class="actions">
      <a class="button-link" href="/tracker/edit">Edit tracker</a>
      ${tracker.active ? postButton("/tracker/pause", "Pause monitoring", csrf, "secondary") : postButton("/tracker/resume", "Resume monitoring", csrf)}
    </div>
    <details>
      <summary>Delete tracker/account</summary>
      <form method="post" action="/account/delete">
        <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
        <label>
          Type delete
          <input name="confirm" autocomplete="off">
        </label>
        <button class="danger" type="submit">Delete permanently</button>
      </form>
    </details>
    ${logoutForm(csrf)}
  `, { user }));
}

function renderCurrentAppointmentPanel(appointment) {
  const office = appointment.office || {};
  const officeName = formatOfficeName(office.name || office.agency);
  return `
    <section class="notice">
      <h2>Looking for an earlier appointment</h2>
      <p>Current appointment:<br><strong>${escapeHtml(formatAppointmentDateTime(appointment))}</strong>${officeName ? `<small>${escapeHtml(officeName)}</small>` : ""}</p>
      <p>We'll notify you only if we find an appointment earlier than your current booking.</p>
    </section>
  `;
}

function renderTrackerEdit(response, { storage, user, config, error = "", values = {} }) {
  const tracker = storage.getTrackerByUserId(user.id);
  const postalCode = values.postalCode || (tracker && tracker.selected_postal_code) || "";
  return renderWithCsrf(response, config, csrf => renderPage("Tracker Settings", `
    ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
    <p>Enter your ICBC details and postal code, then choose road-test offices to monitor.</p>
    <form method="post" action="/tracker/search" autocomplete="off">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <label>
        Last name
        <input name="lastName" required maxlength="80" autocomplete="family-name">
      </label>
      <label>
        Driver's licence number
        <input name="dlNumber" required maxlength="40" inputmode="text" autocomplete="off">
      </label>
      <label>
        ICBC keyword/password
        <input name="keyword" required maxlength="120" type="password" autocomplete="current-password">
      </label>
      <label>
        Postal code
        <input name="postalCode" required maxlength="7" inputmode="text" autocomplete="postal-code" placeholder="V5H 2N2" value="${escapeHtml(postalCode)}">
      </label>
      <button type="submit">Find nearby locations</button>
    </form>
    <p><a href="/dashboard">Back to dashboard</a></p>
  `, { user }));
}

function renderLocationSelection(response, { user, config, draftId, searchResult }) {
  const locationInputs = searchResult.locations
    .map(location => renderLocationCheckbox(location))
    .join("");

  return renderWithCsrf(response, config, csrf => renderPage("Choose Locations", `
    <p>Showing ICBC locator results near ${escapeHtml(searchResult.postalCode)}, filtered to locations this monitor can attempt to search in the road-test booking flow. Select one or more offices.</p>
    ${searchResult.expanded ? "<p>Showing more nearby results from ICBC's nearest-first locator response.</p>" : ""}
    <form method="post" action="/tracker/save" autocomplete="off">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <input type="hidden" name="draftId" value="${escapeHtml(draftId)}">
      <fieldset>
        <legend>Locations to monitor</legend>
        ${locationInputs || "<p>No monitorable locations found. Search another postal code.</p>"}
      </fieldset>
      <button type="submit">Start monitoring</button>
    </form>
    <div class="actions">
      ${searchResult.hasMore ? expandForm(csrf, draftId) : ""}
      <a class="button-link secondary" href="/tracker/edit">Search another postal code</a>
    </div>
  `, { user }));
}

function validateTrackerDetails(form) {
  const lastName = normalizeInput(form.get("lastName"), 80);
  const dlNumber = normalizeInput(form.get("dlNumber"), 40);
  const keyword = normalizeInput(form.get("keyword"), 120);
  const postalCode = normalizePostalCode(form.get("postalCode"));

  if (!lastName || !/^[\p{L}\p{M}' -]{1,80}$/u.test(lastName)) {
    return { ok: false, message: "Last name is required and can only include letters, spaces, apostrophes, and hyphens." };
  }

  if (!dlNumber || !/^[A-Za-z0-9 -]{4,40}$/.test(dlNumber)) {
    return { ok: false, message: "Driver's licence number is required and has an unexpected format." };
  }

  if (!keyword || keyword.length < 2) {
    return { ok: false, message: "ICBC keyword/password is required." };
  }

  if (!postalCode) {
    return { ok: false, message: "A valid Canadian postal code is required." };
  }

  return {
    ok: true,
    values: { lastName, dlNumber, keyword, postalCode },
  };
}

function formValues(form) {
  return {
    postalCode: normalizeInput(form.get("postalCode"), 8),
  };
}

function renderLocationCheckbox(location) {
  const order = Number.isInteger(location.locatorOrder) ? `Nearby result ${location.locatorOrder + 1}` : "Nearby result from ICBC locator";
  const address = [location.address, location.city, location.postal_code].filter(Boolean).join(", ");
  return `
    <label class="choice">
      <input type="checkbox" name="locationIds" value="${escapeHtml(location.id)}">
      <span>
        <strong>${escapeHtml(location.display_name)}</strong>
        <small>${escapeHtml(order)}${address ? ` - ${escapeHtml(address)}` : ""}</small>
      </span>
    </label>
  `;
}

function renderWithCsrf(response, config, renderer) {
  const csrf = createCsrfToken();
  response.setHeader("Set-Cookie", serializeCookie(CSRF_COOKIE, csrf, {
    secure: config.cookieSecure,
    sameSite: "Lax",
  }));
  return send(response, 200, renderer(csrf), "text/html; charset=utf-8");
}

function postButton(action, label, csrf, className = "") {
  return `
    <form method="post" action="${escapeHtml(action)}">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <button class="${escapeHtml(className)}" type="submit">${escapeHtml(label)}</button>
    </form>
  `;
}

function expandForm(csrf, draftId) {
  return `
    <form method="post" action="/tracker/expand">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <input type="hidden" name="draftId" value="${escapeHtml(draftId)}">
      <button class="secondary" type="submit">Show more nearby locations</button>
    </form>
  `;
}

function logoutForm(csrf) {
  return `
    <form class="logout" method="post" action="/logout">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <button class="link-button" type="submit">Sign out</button>
    </form>
  `;
}

function renderPage(title, body, { user = null } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} - ICBC Monitor</title>
  <style>
    :root {
      color-scheme: light;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #1f2933;
      background: #eef2f6;
    }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
    }
    main {
      width: min(100%, 760px);
      background: #ffffff;
      border: 1px solid #d8dee8;
      border-radius: 8px;
      padding: 28px;
      box-shadow: 0 18px 50px rgba(31, 41, 51, 0.12);
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 18px;
    }
    h1 {
      margin: 0;
      font-size: clamp(1.7rem, 6vw, 2.1rem);
      line-height: 1.15;
    }
    h2 {
      margin: 28px 0 10px;
      font-size: 1.1rem;
    }
    p {
      line-height: 1.55;
    }
    form {
      display: grid;
      gap: 16px;
      margin-top: 18px;
    }
    label {
      display: grid;
      gap: 7px;
      font-weight: 650;
    }
    fieldset {
      display: grid;
      gap: 10px;
      border: 1px solid #d8dee8;
      border-radius: 6px;
      padding: 14px;
    }
    legend {
      font-weight: 700;
      padding: 0 6px;
    }
    input {
      width: 100%;
      box-sizing: border-box;
      border: 1px solid #b8c2cc;
      border-radius: 6px;
      padding: 12px;
      font: inherit;
      background: #ffffff;
    }
    button,
    .button-link {
      display: inline-flex;
      justify-content: center;
      align-items: center;
      min-height: 44px;
      box-sizing: border-box;
      border: 0;
      border-radius: 6px;
      padding: 12px 16px;
      font: inherit;
      font-weight: 700;
      color: #ffffff;
      background: #146c60;
      text-decoration: none;
      cursor: pointer;
    }
    button:hover,
    .button-link:hover {
      background: #0d5b51;
    }
    .secondary {
      background: #52606d;
    }
    .danger {
      background: #a32727;
    }
    .link-button {
      min-height: auto;
      padding: 0;
      color: #0d5b51;
      background: transparent;
      text-decoration: underline;
    }
    .link-button:hover {
      background: transparent;
    }
    .choice {
      grid-template-columns: auto 1fr;
      align-items: start;
      font-weight: 500;
      border: 1px solid #d8dee8;
      border-radius: 6px;
      padding: 11px;
      background: #f8fafc;
    }
    .choice input {
      width: auto;
      margin-top: 3px;
    }
    small,
    .muted {
      display: block;
      margin-top: 3px;
      color: #52606d;
      line-height: 1.35;
    }
    a {
      color: #0d5b51;
      font-weight: 700;
    }
    .status {
      display: inline-flex;
      border-radius: 999px;
      padding: 6px 10px;
      font-size: 0.8rem;
      font-weight: 800;
      letter-spacing: 0;
      color: #ffffff;
    }
    .status.active {
      background: #13795b;
    }
    .status.paused {
      background: #7b5d12;
    }
    dl {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
      gap: 12px;
      margin: 22px 0;
    }
    dl div,
    .locations li {
      border: 1px solid #d8dee8;
      border-radius: 6px;
      padding: 12px;
      background: #f8fafc;
    }
    dt {
      color: #52606d;
      font-size: 0.85rem;
    }
    dd {
      margin: 4px 0 0;
      font-weight: 700;
    }
    .locations {
      display: grid;
      gap: 10px;
      padding: 0;
      list-style: none;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
      margin-top: 18px;
    }
    .actions form {
      margin: 0;
    }
    details {
      margin-top: 24px;
      border-top: 1px solid #d8dee8;
      padding-top: 18px;
    }
    .logout {
      margin-top: 24px;
    }
    .error {
      border: 1px solid #e0a6a6;
      border-radius: 6px;
      padding: 12px;
      background: #fff5f5;
      color: #8a1f1f;
    }
    .notice {
      border: 1px solid #b8d8d2;
      border-radius: 6px;
      padding: 14px;
      background: #f0fdfa;
      margin: 18px 0;
    }
    .notice h2 {
      margin-top: 0;
    }
    .dev-link {
      border: 1px solid #b8c2cc;
      border-radius: 6px;
      padding: 12px;
      background: #f8fafc;
    }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>${escapeHtml(title)}</h1>
      ${user ? `<span class="muted">${escapeHtml(user.email)}</span>` : ""}
    </header>
    ${body}
  </main>
</body>
</html>`;
}

function formatDate(value) {
  if (!value) {
    return "not yet";
  }

  return new Date(value).toLocaleString();
}

function formatAvailability(value) {
  if (value === null || value === undefined) {
    return "unknown";
  }

  return value ? "available" : "not available";
}

function formatActionableAvailability(tracker) {
  if (tracker.last_known_available === null || tracker.last_known_available === undefined) {
    return "unknown";
  }

  if (tracker.existing_appointment_detected) {
    return tracker.last_known_available ? "earlier appointment found" : "no earlier appointment found";
  }

  return tracker.last_known_available ? "appointment found" : "no appointment found";
}

function formatEarlierAvailability(value) {
  if (value === null || value === undefined) {
    return "unknown";
  }

  return value ? "found" : "none found";
}

function formatEarliestAvailable(appointment) {
  if (!appointment) {
    return "No appointments currently found.";
  }

  return [formatAppointmentDateTime(appointment), appointment.officeName]
    .filter(Boolean)
    .join(" ");
}

function renderEarliestAvailable(appointment) {
  if (!appointment) {
    return escapeHtml(formatEarliestAvailable(appointment));
  }

  return [
    `<strong>${escapeHtml(formatAppointmentDateTime(appointment))}</strong>`,
    appointment.officeName ? `<small>${escapeHtml(appointment.officeName)}</small>` : "",
  ].filter(Boolean).join("");
}

function formatAppointmentSummary(appointment) {
  return [appointment.date, appointment.startTime, appointment.endTime ? `to ${appointment.endTime}` : ""]
    .filter(Boolean)
    .join(" ");
}

function formatAppointmentDateTime(appointment) {
  if (!appointment || !appointment.date || !appointment.startTime) {
    return "not available";
  }

  const parsed = parseLocalAppointmentDateTime(appointment.date, appointment.startTime);
  if (!parsed) {
    return formatAppointmentSummary(appointment);
  }

  const date = new Intl.DateTimeFormat("en-CA", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(parsed);
  const time = new Intl.DateTimeFormat("en-CA", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(parsed)
    .replace(/\ba\.m\./i, "AM")
    .replace(/\bp\.m\./i, "PM");

  return `${date} · ${time}`;
}

function parseLocalAppointmentDateTime(date, time) {
  const dateMatch = String(date).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const timeMatch = String(time).match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!dateMatch || !timeMatch) {
    return null;
  }

  const parsed = new Date(
    Number(dateMatch[1]),
    Number(dateMatch[2]) - 1,
    Number(dateMatch[3]),
    Number(timeMatch[1]),
    Number(timeMatch[2]),
    Number(timeMatch[3] || 0),
  );

  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatOfficeName(value) {
  const name = String(value || "").trim();
  if (!name) {
    return "";
  }

  if (name === name.toUpperCase()) {
    return name.toLowerCase().replace(/\b[a-z]/g, letter => letter.toUpperCase());
  }

  return name;
}

function normalizeInput(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

function addSecurityHeaders(response) {
  response.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Cache-Control", "no-store");
}

function send(response, statusCode, body, contentType) {
  response.writeHead(statusCode, { "Content-Type": contentType });
  response.end(body);
}

function redirect(response, location) {
  response.writeHead(303, { Location: location });
  response.end();
}

async function readForm(request) {
  return new URLSearchParams(await readRequestBody(request));
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";

    request.setEncoding("utf8");
    request.on("data", chunk => {
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        request.destroy();
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

module.exports = {
  createWebServer,
  escapeHtml,
  formatAppointmentDateTime,
  formatEarliestAvailable,
  validateTrackerDetails,
};
