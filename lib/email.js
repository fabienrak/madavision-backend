const nodemailer = require('nodemailer')
const { EMAIL_ENABLED, EMAIL_CONFIG } = require('../config')

// Transporter Nodemailer (créé une seule fois au démarrage)
let mailTransporter = null
if (EMAIL_ENABLED) {
  if (!EMAIL_CONFIG.host || !EMAIL_CONFIG.user || !EMAIL_CONFIG.pass) {
    console.warn('⚠ EMAIL_ENABLED=true mais SMTP_HOST/USER/PASS manquant — envoi désactivé')
  } else {
    mailTransporter = nodemailer.createTransport({
      host:   EMAIL_CONFIG.host,
      port:   EMAIL_CONFIG.port,
      secure: EMAIL_CONFIG.secure,
      auth:   { user: EMAIL_CONFIG.user, pass: EMAIL_CONFIG.pass },
      tls:    { rejectUnauthorized: false },
    })
    mailTransporter.verify((err) => {
      if (err) {
        console.warn('⚠ SMTP non joignable :', err.message)
        if (EMAIL_CONFIG.host.includes('gmail')) {
          console.warn('   → Gmail : utilisez un App Password (pas votre mot de passe normal)')
          console.warn('   → Créer ici : https://myaccount.google.com/apppasswords')
        }
      } else {
        console.log(`✓ SMTP prêt : ${EMAIL_CONFIG.host} (${EMAIL_CONFIG.user})`)
      }
    })
  }
}

function escapeHtml(s) {
  if (s == null) return ''
  return String(s).replace(/[&<>"']/g, c => (
    {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]
  ))
}

async function mailer(to, subject, html, opts = {}) {
  if (!mailTransporter) return { sent: false, error: 'smtp_disabled' }
  if (!to)             return { sent: false, error: 'no_recipient' }
  try {
    await mailTransporter.sendMail({
      from: `"${EMAIL_CONFIG.fromName}" <${EMAIL_CONFIG.fromAddress}>`,
      to, subject, html,
      ...(EMAIL_CONFIG.bcc       ? { bcc: EMAIL_CONFIG.bcc }               : {}),
      ...(opts.attachments       ? { attachments: opts.attachments }        : {}),
    })
    console.log(`✓ Email → ${to} | ${subject}`)
    return { sent: true }
  } catch (e) {
    console.warn(`⚠ Email échoué → ${to} | ${e.message}`)
    return { sent: false, error: e.message }
  }
}

function emailWrapper(bodyHtml, accentFrom = '#195b98', accentTo = '#0d0d0d') {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"/></head>
<body style="font-family:Arial,sans-serif;color:#1A1814;line-height:1.6;max-width:600px;margin:0 auto;padding:20px">
<html><head>
  <meta charset="UTF-8"/>
  <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;500;700&display=swap" rel="stylesheet">
</head>
<body style="font-family:'Poppins',Arial,sans-serif;color:#1A1814;line-height:1.6;max-width:600px;margin:0 auto;padding:20px">
  <div style="background:linear-gradient(135deg,${accentFrom} 0%,${accentTo} 100%);color:#fff;padding:25px 24px;border-radius:10px 10px 0 0">
    <div style="font-size:22px;font-weight:700;margin-bottom:4px">MADAVISION</div>
    <div style="font-size:13px;opacity:.9">2026</div>
  </div>
  <div style="background:#fff;border:1px solid #E8E3DA;border-top:none;padding:28px 24px;border-radius:0 0 10px 10px">
    ${bodyHtml}
  </div>
</body></html>`
}

function emailHtmlCommercialAlert({ commNom, socNom, socEmail, socTel, assignedBy, frontendBase }) {
  return emailWrapper(`
    <h2 style="color:#1B2A4A;font-size:18px;margin:0 0 14px">Un dossier vous a été assigné</h2>
    <p>Bonjour <strong>${escapeHtml(commNom)}</strong>,</p>
    <p>L'Administration Madavision vous a assigné le suivi du dossier de <strong>${escapeHtml(socNom)}</strong>.</p>
    <div style="background:#EEF2F8;border-left:3px solid #2260A7;padding:14px 18px;border-radius:0 8px 8px 0;margin:18px 0">
      <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#2260A7;margin-bottom:8px">Contact société</div>
      <div style="font-size:13px;color:#1B2A4A"><strong>Société :</strong> ${escapeHtml(socNom)}</div>
      ${socEmail ? `<div style="font-size:13px;color:#1B2A4A;margin-top:4px"><strong>Email :</strong> <a href="mailto:${escapeHtml(socEmail)}" style="color:#2260A7">${escapeHtml(socEmail)}</a></div>` : ''}
      ${socTel   ? `<div style="font-size:13px;color:#1B2A4A;margin-top:4px"><strong>Tél :</strong> ${escapeHtml(socTel)}</div>` : ''}
    </div>
    <h3 style="color:#1B2A4A;font-size:14px;margin:20px 0 8px">Prochaines actions</h3>
    <ol style="padding-left:20px;font-size:13px;color:#5C5649">
      <li>Prendre contact avec l'exposant pour confirmer la réservation</li>
      <li>Accompagner le règlement de l'acompte (50 %)</li>
      <li>Suivre la signature du contrat et le solde</li>
    </ol>
    <div style="margin-top:24px">
      <a href="${frontendBase}/commercial" style="background:#1B2A4A;color:#fff;text-decoration:none;padding:10px 22px;border-radius:8px;display:inline-block;font-weight:600;font-size:13px">→ Accéder à l'espace commercial</a>
    </div>
    <p style="margin-top:24px;font-size:13px;color:#9B9183">Assigné par ${escapeHtml(assignedBy)}</p>
  `)
}

module.exports = {
  mailTransporter,
  escapeHtml,
  mailer,
  emailWrapper,
  emailHtmlCommercialAlert,
}
