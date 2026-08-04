const nodemailer = require("nodemailer");

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// Providers cap how fast they accept mail. Resend's free plan allows two
// requests a second, and a class signing up together sails past that: the
// rejected requests were reported as sent, so those students never received a
// code. Sends are paced and retried instead.
const PROVIDER_MIN_INTERVAL_MS = {
  resend: 600,
  brevo: 150,
  smtp: 250,
};

// A wrong API key or an unverified sender domain will fail the same way however
// many times it is retried, so those surface immediately.
const PERMANENT_STATUSES = new Set([400, 401, 403, 404, 405, 413, 422]);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryAfterMs(response) {
  const header = response?.headers?.get?.("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

function describe(body) {
  try {
    const parsed = JSON.parse(body);
    return parsed.message || parsed.error || body;
  } catch {
    // Not JSON, so the raw body is the clearest description available.
    return body;
  }
}

function deliveryFailure(message) {
  const failure = new Error(message);
  // The caller turns this into an explanation rather than a bare 500.
  failure.deliveryFailed = true;
  return failure;
}

/**
 * Runs sends one at a time, no faster than the provider accepts them.
 *
 * Requests queue rather than racing, so a burst of sign-ups is spread out
 * instead of being partly rejected.
 */
function createSendQueue(minIntervalMs) {
  let chain = Promise.resolve();
  let lastStartedAt = 0;
  return function enqueue(task) {
    const result = chain.then(async () => {
      const since = Date.now() - lastStartedAt;
      if (since < minIntervalMs) await delay(minIntervalMs - since);
      lastStartedAt = Date.now();
      return task();
    });
    chain = result.then(
      () => {},
      () => {},
    );
    return result;
  };
}

function createMailer(env = process.env) {
  // Brevo verifies a single sender address, so mail can reach anyone without
  // owning a domain — the one route that works on a host blocking SMTP.
  const brevoConfigured = Boolean(env.BREVO_API_KEY && env.EMAIL_FROM);
  const resendConfigured = Boolean(env.RESEND_API_KEY && env.EMAIL_FROM);
  const smtpConfigured = Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS);
  const configured = brevoConfigured || resendConfigured || smtpConfigured;
  const provider = brevoConfigured
    ? "brevo"
    : resendConfigured
      ? "resend"
      : smtpConfigured
        ? "smtp"
        : "disabled";
  // Some hosts block outbound SMTP entirely, and a blocked connection would
  // otherwise hang the request that is waiting on it.
  const smtpTimeoutMs = Number(env.SMTP_TIMEOUT_MS || 12000);
  const transporter = smtpConfigured
    ? nodemailer.createTransport({
        host: env.SMTP_HOST,
        port: Number(env.SMTP_PORT || 587),
        secure: String(env.SMTP_SECURE || "").toLowerCase() === "true",
        auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
        connectionTimeout: smtpTimeoutMs,
        greetingTimeout: smtpTimeoutMs,
        socketTimeout: smtpTimeoutMs,
        // One connection reused for a queued burst beats a fresh handshake per
        // message, which is what tips a provider into throttling.
        pool: true,
        maxConnections: 1,
        maxMessages: 50,
      })
    : null;

  const minIntervalMs = Number(
    env.EMAIL_MIN_INTERVAL_MS || PROVIDER_MIN_INTERVAL_MS[provider] || 0,
  );
  const maxAttempts = Math.max(1, Number(env.EMAIL_MAX_ATTEMPTS || 4));
  const enqueue = createSendQueue(minIntervalMs);

  // Surfaced through /api/health so a missing code can be diagnosed without
  // shell access to the server.
  const stats = {
    queued: 0,
    delivered: 0,
    failed: 0,
    retried: 0,
    lastError: null,
    lastErrorAt: null,
    lastDeliveredAt: null,
  };

  async function postJson(url, headers, body) {
    let lastDetail = "";
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(20000),
        });
      } catch (error) {
        lastDetail = String(error?.message || error);
        if (attempt === maxAttempts) break;
        stats.retried += 1;
        await delay(500 * 2 ** (attempt - 1));
        continue;
      }

      if (response.ok) return;

      lastDetail = describe(await response.text());
      if (PERMANENT_STATUSES.has(response.status) || attempt === maxAttempts) break;
      // 429 and 5xx are worth another try; the provider tells us how long to
      // wait when it can.
      stats.retried += 1;
      await delay(retryAfterMs(response) ?? 500 * 2 ** (attempt - 1));
    }
    throw deliveryFailure(`Email provider rejected the request: ${lastDetail}`);
  }

  async function deliver({ email, name, code, subject, purpose }) {
    const label = purpose || "verification code";
    const heading = subject || "Verify your CampusPulse email";
    const text = `Hello ${name}, your CampusPulse ${label} is ${code}. It expires in 10 minutes.`;
    const html = `<p>Hello ${escapeHtml(name)},</p><p>Your CampusPulse ${escapeHtml(label)} is <strong>${code}</strong>.</p><p>It expires in 10 minutes.</p>`;

    if (brevoConfigured) {
      const match = String(env.EMAIL_FROM).match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
      const sender = match
        ? { name: match[1] || "CampusPulse", email: match[2] }
        : { name: "CampusPulse", email: String(env.EMAIL_FROM).trim() };
      await postJson(
        "https://api.brevo.com/v3/smtp/email",
        {
          "api-key": env.BREVO_API_KEY,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        {
          sender,
          to: [{ email, name }],
          subject: heading,
          textContent: text,
          htmlContent: html,
        },
      );
      return { delivered: true };
    }

    if (resendConfigured) {
      await postJson(
        "https://api.resend.com/emails",
        {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        { from: env.EMAIL_FROM, to: [email], subject: heading, text, html },
      );
      return { delivered: true };
    }

    if (!transporter) {
      console.log(`[CampusPulse] ${label} for ${email}: ${code}`);
      return { delivered: false, previewCode: code };
    }

    let lastReason = "";
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await transporter.sendMail({
          from: env.SMTP_FROM || env.SMTP_USER,
          to: email,
          subject: heading,
          text,
          html,
        });
        return { delivered: true };
      } catch (error) {
        lastReason = String(error?.code || error?.message || "");
        // A refused or timed-out connection means the host is blocking SMTP,
        // and no number of retries will change that.
        if (/ECONNREFUSED|ESOCKET|ECONNECTION|Greeting never received/i.test(lastReason)) {
          throw deliveryFailure(
            "The mail server could not be reached. Outbound SMTP is often blocked; use an HTTPS provider such as Brevo or Resend instead.",
          );
        }
        // A 4xx SMTP reply is a permanent rejection of this message.
        if (/^5\d\d/.test(String(error?.responseCode || ""))) break;
        if (attempt === maxAttempts) break;
        stats.retried += 1;
        await delay(500 * 2 ** (attempt - 1));
      }
    }
    throw deliveryFailure(`Email could not be sent: ${lastReason}`);
  }

  return {
    configured,
    provider,
    stats,
    async sendPasswordReset({ email, name, code }) {
      return this.sendVerification({
        email,
        name,
        code,
        subject: "Reset your CampusPulse password",
        purpose: "password reset code",
      });
    },
    async sendVerification(message) {
      stats.queued += 1;
      try {
        const outcome = await enqueue(() => deliver(message));
        if (outcome.delivered) {
          stats.delivered += 1;
          stats.lastDeliveredAt = new Date().toISOString();
        }
        return outcome;
      } catch (error) {
        stats.failed += 1;
        stats.lastError = String(error?.message || error).slice(0, 300);
        stats.lastErrorAt = new Date().toISOString();
        // Named explicitly so an administrator can see exactly who missed a
        // code rather than inferring it from a complaint.
        console.error(
          `[CampusPulse] verification email to ${message?.email} failed: ${stats.lastError}`,
        );
        throw error;
      }
    },
  };
}

module.exports = { createMailer };
