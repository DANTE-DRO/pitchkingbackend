const nodemailer = require("nodemailer");

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER) {
    console.warn("[email] SMTP not configured — emails will be logged instead of sent.");
    return null;
  }
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 465),
    secure: String(process.env.SMTP_SECURE || "true") === "true",
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return transporter;
}

async function sendEmail({ to, subject, html }) {
  const t = getTransporter();
  const fromName = process.env.SMTP_FROM_NAME || "PitchKing";
  if (!t) {
    console.log(`\n[email:not-sent] To: ${to}\nSubject: ${subject}\n${html}\n`);
    return { sent: false, reason: "smtp_not_configured" };
  }
  try {
    await t.sendMail({
      from: `"${fromName}" <${process.env.SMTP_USER}>`,
      to,
      subject,
      html,
    });
    return { sent: true };
  } catch (err) {
    console.error(`[email] Failed to send to ${to}: ${err.message}`);
    return { sent: false, reason: err.message };
  }
}

module.exports = { sendEmail };
