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
  const resendConfigured = Boolean(env.RESEND_API_KEY && env.EMAIL_FROM);
  const smtpConfigured = Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS);
  const configured = resendConfigured || smtpConfigured;
  const transporter = smtpConfigured
    ? nodemailer.createTransport({
        host: env.SMTP_HOST,
        port: Number(env.SMTP_PORT || 587),
        secure: String(env.SMTP_SECURE || "").toLowerCase() === "true",
        auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
      })
    : null;

  return {
    configured,
    async sendVerification({ email, name, code }) {
      const text = `Hello ${name}, your CampusPulse verification code is ${code}. It expires in 10 minutes.`;
      const html = `<p>Hello ${escapeHtml(name)},</p><p>Your CampusPulse verification code is <strong>${code}</strong>.</p><p>It expires in 10 minutes.</p>`;
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
            subject: "Verify your CampusPulse email",
            text,
            html,
          }),
        });
        if (!response.ok) {
          const message = await response.text();
          throw new Error(`Email provider rejected the request: ${message}`);
        }
        return { delivered: true };
      }

      if (!transporter) {
        console.log(`[CampusPulse] Verification code for ${email}: ${code}`);
        return { delivered: false, previewCode: code };
      }

      await transporter.sendMail({
        from: env.SMTP_FROM || env.SMTP_USER,
        to: email,
        subject: "Verify your CampusPulse email",
        text,
        html,
      });
      return { delivered: true };
    },
  };
}

module.exports = { createMailer };
