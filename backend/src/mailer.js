const nodemailer = require("nodemailer");

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function createMailer(env = process.env) {
  // Brevo verifies a single sender address, so mail can reach anyone without
  // owning a domain — the one route that works on a host blocking SMTP.
  const brevoConfigured = Boolean(env.BREVO_API_KEY && env.EMAIL_FROM);
  const resendConfigured = Boolean(env.RESEND_API_KEY && env.EMAIL_FROM);
  const smtpConfigured = Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS);
  const configured = brevoConfigured || resendConfigured || smtpConfigured;
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
      })
    : null;

  return {
    configured,
    provider: brevoConfigured
      ? "brevo"
      : resendConfigured
        ? "resend"
        : smtpConfigured
          ? "smtp"
          : "disabled",
    async sendPasswordReset({ email, name, code }) {
      return this.sendVerification({
        email,
        name,
        code,
        subject: "Reset your CampusPulse password",
        purpose: "password reset code",
      });
    },
    async sendVerification({ email, name, code, subject, purpose }) {
      const label = purpose || "verification code";
      const heading = subject || "Verify your CampusPulse email";
      const text = `Hello ${name}, your CampusPulse ${label} is ${code}. It expires in 10 minutes.`;
      const html = `<p>Hello ${escapeHtml(name)},</p><p>Your CampusPulse ${escapeHtml(label)} is <strong>${code}</strong>.</p><p>It expires in 10 minutes.</p>`;
      if (brevoConfigured) {
        const match = String(env.EMAIL_FROM).match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
        const sender = match
          ? { name: match[1] || "CampusPulse", email: match[2] }
          : { name: "CampusPulse", email: String(env.EMAIL_FROM).trim() };
        const response = await fetch("https://api.brevo.com/v3/smtp/email", {
          method: "POST",
          headers: {
            "api-key": env.BREVO_API_KEY,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            sender,
            to: [{ email, name }],
            subject: heading,
            textContent: text,
            htmlContent: html,
          }),
        });
        if (!response.ok) {
          const body = await response.text();
          let detail = body;
          try {
            detail = JSON.parse(body).message || body;
          } catch {
            // Not JSON, so the raw body is the clearest description available.
          }
          const failure = new Error(`Email provider rejected the request: ${detail}`);
          failure.deliveryFailed = true;
          throw failure;
        }
        return { delivered: true };
      }

      if (resendConfigured) {
        const response = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.RESEND_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: env.EMAIL_FROM,
            to: [email],
            subject: heading,
            text,
            html,
          }),
        });
        if (!response.ok) {
          const body = await response.text();
          let detail = body;
          try {
            detail = JSON.parse(body).message || body;
          } catch {
            // Not JSON, so the raw body is the best description available.
          }
          const failure = new Error(`Email provider rejected the request: ${detail}`);
          // The caller turns this into an explanation rather than a bare 500.
          failure.deliveryFailed = true;
          throw failure;
        }
        return { delivered: true };
      }

      if (!transporter) {
        console.log(`[CampusPulse] ${label} for ${email}: ${code}`);
        return { delivered: false, previewCode: code };
      }

      try {
        await transporter.sendMail({
          from: env.SMTP_FROM || env.SMTP_USER,
          to: email,
          subject: heading,
          text,
          html,
        });
      } catch (error) {
        const reason = String(error?.code || error?.message || "");
        // A refused or timed-out connection means the host is blocking SMTP.
        if (/ETIMEDOUT|ECONNREFUSED|ESOCKET|ECONNECTION|Greeting never received/i.test(reason)) {
          const blocked = new Error(
            "The mail server could not be reached. Outbound SMTP is often blocked; use an HTTPS provider such as Resend instead.",
          );
          blocked.deliveryFailed = true;
          throw blocked;
        }
        const failure = new Error(`Email could not be sent: ${reason}`);
        failure.deliveryFailed = true;
        throw failure;
      }
      return { delivered: true };
    },
  };
}

module.exports = { createMailer };
