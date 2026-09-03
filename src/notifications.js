function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function shouldNotifyAvailability(previousState, result) {
  if (!result.available) {
    return false;
  }

  if (!previousState.last_known_available) {
    return true;
  }

  return previousState.last_notified_availability_hash !== result.availabilityHash;
}

function formatAppointmentText(result) {
  if (!result.appointments || result.appointments.length === 0) {
    return "";
  }

  return [
    "",
    "Possible appointment details:",
    ...result.appointments.map(appointment => `- ${appointment.text}`),
  ].join("\n");
}

function formatAvailabilityEmail(result) {
  return [
    `ICBC appointment availability was found at ${result.office.name}.`,
    formatAppointmentText(result),
    "",
    `Book manually: ${result.bookingUrl}`,
    `Checked at: ${result.checkedAt.toLocaleString()}`,
    "",
    "Availability can disappear quickly.",
    "This service only monitors availability and never books, reschedules, cancels, or changes appointments.",
  ].join("\n");
}

function formatAvailabilityEmailHtml(result) {
    const appointmentRows =
      result.appointments && result.appointments.length > 0
        ? `
          <div style="margin:24px 0 0;">
            <div style="
              font-size:14px;
              font-weight:600;
              color:#64748b;
              margin-bottom:8px;
            ">
              Possible appointment details
            </div>

            ${result.appointments
              .map(
                appointment => `
                  <div style="
                    padding:12px 14px;
                    margin-top:8px;
                    border:1px solid #e2e8f0;
                    border-radius:10px;
                    background:#f8fafc;
                    font-size:15px;
                    color:#1f2937;
                    line-height:1.5;
                  ">
                    ${escapeHtml(appointment.text)}
                  </div>
                `
              )
              .join("")}
          </div>
        `
        : "";

    return `
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

          <div style="
            display:inline-block;
            padding:6px 10px;
            border-radius:999px;
            background:#dcfce7;
            color:#166534;
            font-size:13px;
            font-weight:700;
            margin-bottom:16px;
          ">
            APPOINTMENT FOUND
          </div>

          <h1 style="
            margin:0 0 14px;
            font-size:28px;
            line-height:1.2;
            color:#111827;
          ">
            A road test appointment may be available
          </h1>

          <p style="
            margin:0;
            font-size:16px;
            line-height:1.6;
            color:#475569;
          ">
            We detected availability at one of the locations you're monitoring.
          </p>

          <div style="
            margin-top:22px;
            padding:18px;
            border-radius:12px;
            background:#f8fafc;
            border:1px solid #e2e8f0;
          ">
            <div style="
              font-size:18px;
              font-weight:700;
              color:#111827;
            ">
              ${escapeHtml(result.office.name)}
            </div>

            ${
              result.office.address
                ? `
                  <div style="
                    margin-top:5px;
                    font-size:14px;
                    color:#64748b;
                  ">
                    ${escapeHtml(result.office.address)}
                  </div>
                `
                : ""
            }
          </div>

          ${appointmentRows}

          <div style="margin:28px 0 22px;">
            <a
              href="${escapeHtml(result.bookingUrl)}"
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
              Open ICBC booking
            </a>
          </div>

          <div style="
            padding:14px 16px;
            border-radius:10px;
            background:#fff7ed;
            border:1px solid #fed7aa;
            color:#9a3412;
            font-size:14px;
            line-height:1.5;
          ">
            Availability can disappear quickly. Open ICBC's booking site as soon as possible if you want this appointment.
          </div>

          <p style="
            margin:22px 0 0;
            font-size:13px;
            color:#94a3b8;
            line-height:1.5;
          ">
            Checked at ${escapeHtml(result.checkedAt.toLocaleString())}.
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
            Road Test Watch only monitors availability. It never books, reschedules, cancels, or changes appointments and is not affiliated with ICBC.
          </p>

        </div>
      </div>
    </body>
  </html>
    `.trim();
  }

function formatPersistentErrorEmail(target, threshold) {
  return [
    `Monitoring for your ICBC appointment has failed ${target.consecutive_error_count} times in a row.`,
    "",
    "Please sign in and update your tracker if your ICBC login details changed, or try again later if ICBC is unavailable.",
    "",
    `Error category: ${target.last_error_message || "unknown"}`,
    `You are only receiving this message after ${threshold} consecutive failed checks.`,
  ].join("\n");
}

function formatPersistentErrorEmailHtml(target, threshold) {
  return `
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
        max-width:600px;
        margin:0 auto;
        background:#ffffff;
        border:1px solid #e2e8f0;
        border-radius:16px;
        padding:32px;
      ">
        <div style="
          display:inline-block;
          padding:6px 10px;
          border-radius:999px;
          background:#fef3c7;
          color:#92400e;
          font-size:13px;
          font-weight:700;
          margin-bottom:16px;
        ">
          TRACKER NEEDS ATTENTION
        </div>

        <h1 style="
          margin:0 0 14px;
          font-size:26px;
          color:#111827;
        ">
          We’re having trouble checking ICBC
        </h1>

        <p style="
          margin:0;
          font-size:16px;
          line-height:1.6;
          color:#475569;
        ">
          Your tracker has failed
          <strong>${Number(target.consecutive_error_count)}</strong>
          checks in a row.
        </p>

        <p style="
          margin:18px 0 0;
          font-size:15px;
          line-height:1.6;
          color:#475569;
        ">
          If your ICBC login details changed, sign in to your tracker and update them.
          Otherwise, ICBC may simply be temporarily unavailable.
        </p>

        <div style="
          margin-top:22px;
          padding:14px 16px;
          border-radius:10px;
          background:#f8fafc;
          border:1px solid #e2e8f0;
          font-size:14px;
          color:#475569;
        ">
          Error category:
          <strong>${escapeHtml(target.last_error_message || "unknown")}</strong>
        </div>

        <p style="
          margin:20px 0 0;
          font-size:13px;
          line-height:1.5;
          color:#94a3b8;
        ">
          You only receive this email after ${Number(threshold)} consecutive failed checks.
        </p>
      </div>
    </div>
  </body>
</html>
  `.trim();
}

class NotificationService {
  constructor({ emailService, logger = console }) {
    this.emailService = emailService;
    this.logger = logger;
  }

  async sendAvailabilityNotification(user, result) {
    await this.emailService.send({
      to: user.email,
      subject: `Road test appointment found — ${result.office.name}`,
      text: formatAvailabilityEmail(result),
      html: formatAvailabilityEmailHtml(result),
    });
  }

  async sendPersistentErrorNotification(user, target, threshold) {
    await this.emailService.send({
      to: user.email,
      subject: "Your road test tracker needs attention",
      text: formatPersistentErrorEmail(target, threshold),
      html: formatPersistentErrorEmailHtml(target, threshold),
    });
  }
}

module.exports = {
  NotificationService,
  formatAvailabilityEmail,
  formatAvailabilityEmailHtml,
  formatPersistentErrorEmail,
  formatPersistentErrorEmailHtml,
  shouldNotifyAvailability,
};