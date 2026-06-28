const express = require('express')
const router  = express.Router()

const { DEBUG, EMAIL_CONFIG } = require('../config')
const { ATBASE, headers, sleep, atFind, escapeFormula } = require('../lib/airtable')
const { mailer, emailWrapper, escapeHtml, mailTransporter } = require('../lib/email')

const otpStore     = new Map()  // email → { code, expiry }
const otpRateLimit = new Map()  // email → { count, resetAt }

function checkOtpRateLimit(email) {
  const now   = Date.now()
  const entry = otpRateLimit.get(email)
  if (!entry || now > entry.resetAt) {
    otpRateLimit.set(email, { count: 1, resetAt: now + 15 * 60 * 1000 })
    return true
  }
  if (entry.count >= 5) return false
  entry.count++
  return true
}

// Masque l'email pour affichage : jean.dupont@example.mg → j***t@example.mg
function maskEmail(email) {
  if (!email || !email.includes('@')) return '****'
  const [local, domain] = email.split('@')
  if (local.length <= 2) return `${local[0]}*@${domain}`
  return `${local[0]}${'*'.repeat(Math.min(local.length - 2, 4))}${local[local.length - 1]}@${domain}`
}

// OTP store pour la reconnexion par code entreprise (keyed par socId, jamais par email)
const otpStoreCompany = new Map()  // socId → { code, expiry, email }

// POST /api/send-otp — génère et envoie un code OTP par email
router.post('/send-otp', async (req, res) => {
  try {
    const { email } = req.body || {}
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'Email invalide' })
    }

    if (!checkOtpRateLimit(email.toLowerCase())) {
      return res.status(429).json({ error: 'Trop de tentatives. Attendez 15 minutes.' })
    }

    // Générer un code à 6 chiffres
    const code   = String(Math.floor(100000 + Math.random() * 900000))
    const expiry = Date.now() + 10 * 60 * 1000  // 10 minutes

    otpStore.set(email.toLowerCase(), { code, expiry })

    // Envoyer par email si Nodemailer configuré
    if (mailTransporter) {
      try {
        await mailTransporter.sendMail({
          from:    process.env.EMAIL_FROM || 'noreply@madavision.mg',
          to:      email,
          subject: `Votre code de confirmation : ${code}`,
          html: `
            <div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px;background:#F9F8F5;border-radius:12px">
              <div style="text-align:center;margin-bottom:24px">
                <div style="font-size:32px">✉️</div>
                <h2 style="color:#0A7070;margin:8px 0">Inscription Exposant</h2>
              </div>
              <p style="color:#333;font-size:14px">Votre code de confirmation :</p>
              <div style="background:#fff;border:2px solid #0A7070;border-radius:12px;padding:20px;text-align:center;margin:16px 0">
                <span style="font-size:36px;font-weight:700;letter-spacing:12px;color:#0A7070;font-family:monospace">${code}</span>
              </div>
              <p style="color:#888;font-size:12px">Ce code expire dans <strong>10 minutes</strong>. Ne le partagez avec personne.</p>
            </div>
          `,
        })
        console.log(`✓ OTP envoyé à ${email}`)
      } catch (emailErr) {
        console.warn(`⚠ Envoi OTP échoué : ${emailErr.message}`)
        // En mode debug, afficher le code dans les logs
        if (DEBUG) console.log(`[DEBUG] OTP pour ${email} : ${code}`)
      }
    } else {
      // Pas de mailTransporter configuré — afficher dans les logs (développement)
      console.log(`[OTP] Code pour ${email} : ${code}  (Nodemailer non configuré)`)
    }

    res.json({ sent: true, message: 'Code envoyé' })
  } catch (e) {
    console.error('[send-otp] error:', e.message)
    res.status(500).json({ error: 'Erreur lors de l\'envoi' })
  }
})

// POST /api/verify-otp — vérifie le code saisi
router.post('/verify-otp', async (req, res) => {
  try {
    const { email } = req.body || {}
    // Accepte 'code' (React) ET 'otp' (legacy HTML)
    const otp = req.body.code || req.body.otp || ''
    if (!email || !otp) return res.status(400).json({ error: 'Email et code requis' })

    const stored = otpStore.get(email.toLowerCase())
    if (!stored) {
      return res.status(400).json({ error: 'Code expiré ou non demandé — renvoyez un nouveau code' })
    }
    if (Date.now() > stored.expiry) {
      otpStore.delete(email.toLowerCase())
      return res.status(400).json({ error: 'Code expiré (10 min) — renvoyez un nouveau code' })
    }
    if (stored.code !== String(otp).trim()) {
      return res.status(400).json({ error: 'Code incorrect — vérifiez et réessayez' })
    }

    otpStore.delete(email.toLowerCase())
    // Émettre un session token (8h) — utilisé pour sécuriser les routes /espace-client
    const session = Buffer.from(JSON.stringify({ email: email.toLowerCase(), exp: Date.now() + 8 * 60 * 60 * 1000 })).toString('base64')
    res.json({ valid: true, email, session })
  } catch (e) {
    console.error('[verify-otp] error:', e.message)
    res.status(500).json({ error: 'Erreur de vérification' })
  }
})

// POST /api/company-code/check
// Vérifie si le code entreprise existe dans Airtable (champ "ID Entreprise" de Sociétés)
// Retourne l'email masqué et socId — l'email réel NE QUITTE JAMAIS le serveur
router.post('/company-code/check', async (req, res) => {
  try {
    const code = (req.body.codeEntreprise || '').trim().toUpperCase()
    if (!code) return res.status(400).json({ error: 'Code entreprise requis' })

    const safeCode = escapeFormula(code)
    const records  = await atFind('Sociétés',
      `{ID Entreprise}="${safeCode}"`)

    if (!records.length) {
      return res.json({ found: false })
    }

    const soc   = records[0]
    const email = soc.fields['Email'] || ''

    if (!email) {
      return res.json({
        found: true,
        noEmail: true,
        message: 'Aucun email enregistré pour cette société. Contactez l\'Administration Madavision.',
      })
    }

    res.json({
      found:       true,
      emailMasked: maskEmail(email),
      socId:       soc.id,
      nomSoc:      soc.fields['Raison sociale'] || '',
    })
  } catch (e) {
    console.error('[company-code/check]', e.message)
    res.status(500).json({ error: DEBUG ? e.message : 'Erreur de vérification' })
  }
})

// POST /api/company-code/forgot
// Recherche le code entreprise par email et l'envoie si trouvé
// Protection contre l'énumération : réponse identique si trouvé ou non
router.post('/company-code/forgot', async (req, res) => {
  try {
    const { email, companyName } = req.body || {}
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'Email invalide' })
    }
    if (!companyName || companyName.trim().length < 2) {
      return res.status(400).json({ error: 'Nom de société requis' })
    }

    const safeEmail = escapeFormula(email.toLowerCase().trim())
    const safeName  = escapeFormula(companyName.toLowerCase().trim())

    // Recherche croisée : Email ET (Raison sociale OU Nom de participation)
    const formula = `AND(LOWER({Email})="${safeEmail}", OR(LOWER({Raison sociale})="${safeName}", LOWER({Nom de participation})="${safeName}"))`
    const records = await atFind('Sociétés', formula)

    // Réponse générique pour la sécurité (évite de confirmer l'existence d'un email)
    const successMsg = { success: true, message: 'Si ces informations correspondent à un compte enregistré, vous recevrez votre code par email.' }

    if (records.length > 0) {
      const soc = records[0].fields
      const code = soc['ID Entreprise']
      const nomSoc = soc['Raison sociale'] || 'votre société'

      if (code && mailTransporter) {
        await mailer(
          email.toLowerCase().trim(),
          `Récupération de votre code entreprise — ${nomSoc}`,
          emailWrapper(`
            <h2 style="color:#1B2A4A;font-size:18px;margin:0 0 14px">Récupération de votre code entreprise</h2>
            <p style="font-size:13px">Bonjour,</p>
            <p style="font-size:13px">Vous avez demandé la récupération de votre code entreprise pour l'inscription aux événements Madavision.</p>
            <p style="font-size:13px">Sociétés : <b>${companyName}</b></p>
            <div style="background:#EEF2F8;border-left:3px solid #2260A7;padding:20px;border-radius:0 8px 8px 0;margin:18px 0;text-align:center">
              <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#2260A7;margin-bottom:8px">Votre code entreprise</div>
              <div style="font-family:monospace;font-size:24px;font-weight:700;color:#1B2A4A;letter-spacing:2px">${escapeHtml(code)}</div>
            </div>
            <p style="font-size:13px;color:#5C5649">Utilisez ce code dans la section "Déjà participé" du formulaire pour retrouver vos informations automatiquement.</p>
          `)
        )
      }
    }
    res.json(successMsg)
  } catch (e) {
    console.error('[company-code/forgot]', e.message)
    res.status(500).json({ error: 'Erreur lors de la récupération' })
  }
})

// POST /api/company-code/send-otp
// Envoie un OTP à l'email enregistré pour ce socId (l'email ne transite pas par le frontend)
router.post('/company-code/send-otp', async (req, res) => {
  try {
    const { socId } = req.body || {}
    if (!socId) return res.status(400).json({ error: 'socId requis' })

    // Récupérer l'email depuis Airtable
    const socResp = await fetch(`${ATBASE}/${encodeURIComponent('Sociétés')}/${socId}`, { headers: headers() })
    if (!socResp.ok) return res.status(404).json({ error: 'Société introuvable' })
    const soc   = await socResp.json()
    const email = soc.fields['Email'] || ''
    if (!email) return res.status(400).json({ error: 'Aucun email enregistré pour cette société' })

    // Générer OTP
    const code   = String(Math.floor(100000 + Math.random() * 900000))
    const expiry = Date.now() + 10 * 60 * 1000  // 10 min
    otpStoreCompany.set(socId, { code, expiry, email: email.toLowerCase() })

    // Envoyer par email
    if (mailTransporter) {
      try {
        await mailTransporter.sendMail({
          from:    `"${EMAIL_CONFIG.fromName}" <${EMAIL_CONFIG.fromAddress}>`,
          to:      email,
          subject: `Code de reconnexion — ${soc.fields['Raison sociale'] || ''}`,
          html: `
            <div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px;background:#F9F8F5;border-radius:12px">
              <h2 style="color:#0A7070">Reconnexion exposant</h2>
              <p>Votre code de confirmation :</p>
              <div style="background:#fff;border:2px solid #0A7070;border-radius:12px;padding:20px;text-align:center;margin:16px 0">
                <span style="font-size:36px;font-weight:700;letter-spacing:12px;color:#0A7070;font-family:monospace">${code}</span>
              </div>
              <p style="color:#888;font-size:12px">Ce code expire dans <strong>10 minutes</strong>.</p>
            </div>`,
        })
        console.log(`✓ OTP company envoyé à ${email} pour société ${socId}`)
      } catch (emailErr) {
        console.warn(`⚠ Envoi OTP company échoué : ${emailErr.message}`)
      }
    } else {
      console.log(`[OTP COMPANY] Code pour ${email} (${socId}) : ${code}`)
    }

    res.json({ sent: true, dev: !mailTransporter ? code : undefined })
  } catch (e) {
    console.error('[company-code/send-otp]', e.message)
    res.status(500).json({ error: DEBUG ? e.message : 'Erreur lors de l\'envoi' })
  }
})

// POST /api/company-code/verify-otp
// Vérifie l'OTP et retourne les données de pré-remplissage de la société
router.post('/company-code/verify-otp', async (req, res) => {
  try {
    const { socId, code } = req.body || {}
    if (!socId || !code) return res.status(400).json({ error: 'socId et code requis' })

    const stored = otpStoreCompany.get(socId)
    if (!stored)                     return res.status(400).json({ error: 'Code expiré — renvoyez un nouveau code' })
    if (Date.now() > stored.expiry)  { otpStoreCompany.delete(socId); return res.status(400).json({ error: 'Code expiré (10 min) — renvoyez un nouveau code' }) }
    if (stored.code !== String(code).trim()) return res.status(400).json({ error: 'Code incorrect' })

    otpStoreCompany.delete(socId)

    // Récupérer données société pour pré-remplissage
    const socResp = await fetch(`${ATBASE}/${encodeURIComponent('Sociétés')}/${socId}`, { headers: headers() })
    if (!socResp.ok) return res.status(404).json({ error: 'Société introuvable' })
    const soc = await socResp.json()
    const sf  = soc.fields || {}

    // Récupérer le commercial depuis la dernière participation
    const partIds = sf['Participations'] || []
    let commercialNom = '', commercialId = ''

    if (partIds.length > 0) {
      try {
        await sleep(150)
        const pResp = await fetch(
          `${ATBASE}/${encodeURIComponent('Participations')}/${partIds[partIds.length - 1]}`,
          { headers: headers() }
        )
        if (pResp.ok) {
          const pf     = (await pResp.json()).fields || {}
          const commId = (pf['Commercial affecté'] || [])[0]
          if (commId) {
            commercialId = commId
            await sleep(150)
            const cResp = await fetch(`${ATBASE}/${encodeURIComponent('Commerciaux')}/${commId}`, { headers: headers() })
            if (cResp.ok) {
              const cd = (await cResp.json()).fields || {}
              commercialNom = cd['Nom'] || cd['Prénom Nom'] || ''
            }
          }
        }
      } catch (e) { /* commercial non bloquant */ }
    }

    res.json({
      valid: true,
      email: stored.email,
      societe: {
        socAirtableId: soc.id,
        nomSoc:        sf['Raison sociale']       || '',
        typeEntite:    sf["Type d'entité"]         || 'Société',
        secteur:       sf["Secteur d'activité"]    || '',
        adresse:       sf['Adresse']              || '',
        nif:           sf['NIF']                  || '',
        stat:          sf['STAT']                 || '',
        nbMembres:     sf['Nombre de membres'] ? String(sf['Nombre de membres']) : '',
        regimeFiscal:  sf['Régime fiscal']         || '',
        contact:       sf['Contact principal']    || '',
        telephone:     sf['Téléphone']            || '',
        fonction:      sf['Fonction contact']     || '',
        commercialNom,
        commercialId,
        hasDossiers:   partIds.length > 0,
        nbDossiers:    partIds.length,
      },
    })
  } catch (e) {
    console.error('[company-code/verify-otp]', e.message)
    res.status(500).json({ error: DEBUG ? e.message : 'Erreur de vérification' })
  }
})

module.exports = router
