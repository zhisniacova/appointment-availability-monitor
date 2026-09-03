class EmailService {
  constructor({ provider, devEmailTo = "", logger = console }) {
    this.provider = provider;
    this.devEmailTo = devEmailTo;
    this.logger = logger;
  }

  async send({ to, subject, text, html }) {
    const recipient = this.devEmailTo || to;
    await this.provider.send({
      to: recipient,
      subject,
      text,
      html,
    });
  }
}

class ConsoleEmailProvider {
  constructor({ logger = console } = {}) {
    this.logger = logger;
    this.mode = "console";
  }

  async send({ to, subject, text, html }) {
    this.logger.info("development email", {
      to,
      subject,
      text,
      html,
    });
  }
}

class ResendEmailProvider {
  constructor({ apiKey, fromEmail }) {
    this.apiKey = apiKey;
    this.fromEmail = fromEmail;
    this.mode = "resend";
  }

  async send({ to, subject, text, html }) {
    if (!this.apiKey) {
      throw new Error("RESEND_API_KEY is required when EMAIL_PROVIDER=resend");
    }

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: this.fromEmail,
        to,
        subject,
        text,
        html,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      throw new Error(
        `Resend email failed with HTTP ${response.status}${
          errorBody ? `: ${errorBody}` : ""
        }`
      );
    }
  }
}

function createEmailService(config, logger) {
  let provider;

  if (config.emailProvider === "resend") {
    provider = new ResendEmailProvider({
      apiKey: config.resendApiKey,
      fromEmail: config.emailFrom,
    });
  } else {
    provider = new ConsoleEmailProvider({ logger });
  }

  return new EmailService({
    provider,
    devEmailTo: config.devEmailTo,
    logger,
  });
}

module.exports = {
  ConsoleEmailProvider,
  EmailService,
  ResendEmailProvider,
  createEmailService,
};