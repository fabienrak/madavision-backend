const express = require('express')
const router  = express.Router()

const { DEBUG, BASE, EMAIL_CONFIG } = require('../config')
const { ATBASE, headers, atGet, patchAirtableWithTypecast } = require('../lib/airtable')
const {
  requireRole,
  normalizeEmail,
  normalizeRole,
  normalizeAuthUser,
  authUsers,
  passwordPolicyError,
  hashPassword,
  patchAuthUser,
  findAuthUserByEmail,
  ensureAuthUser,
} = require('../lib/auth')
const { mailer, emailWrapper, escapeHtml, emailHtmlCommercialAlert, mailTransporter } = require('../lib/email')
const {
  fmtMoney,
  linkedRecordId,
  invoiceLinkedIds,
  invoiceFetchRecord,
  buildInvoiceData,
  generateInvoicePDF,
  invoiceSafeFilename,
  generateBadgesInvitationsPDF,
  resolveEditionAndSalon,
  fetchBilanPuissance,
  paymentCalendarFields,
  patchCommandeFields,
  paymentCalendarPayload,
  invoiceMoney,
  mapCommercialAccountOption,
  mapSocieteAccountOption,
  atRecordById,
  sendExposantValidationConfirmation,
  sendInvoicePdf,
} = require('../lib/pdf')
const { requireSonia } = require('../middleware/auth')

const SONIA_EMAILS = (process.env.SONIA_EMAILS || process.env.SONIA_EMAIL || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
const otpStoreSonia = {}  // { email: { code, expires } }

// POST /api/sonia/send-otp
router.post('/send-otp', async (req, res) => {
  try {
    const email = (req.body.email || '').trim().toLowerCase()
    if (!email) return res.status(400).json({ error: 'Email requis' })
    if (SONIA_EMAILS.length > 0 && !SONIA_EMAILS.includes(email))
      return res.status(403).json({ error: 'Accès non autorisé pour cet email.' })

    const code    = String(Math.floor(100000 + Math.random() * 900000))
    const expires = Date.now() + 10 * 60 * 1000  // 10 min
    otpStoreSonia[email] = { code, expires }

    if (mailTransporter) {
      await mailTransporter.sendMail({
        from:    `"${EMAIL_CONFIG.fromName}" <${EMAIL_CONFIG.fromAddress}>`,
        to:      email,
        subject: 'Code de connexion — Espace Administration',
        html: `
          <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto">
            <h2 style="color:#1B2A4A">Connexion à l'espace de validation</h2>
            <p>Votre code de connexion est :</p>
            <div style="font-size:36px;font-weight:700;letter-spacing:8px;color:#2260A7;padding:20px;background:#EEF2F8;border-radius:8px;text-align:center">${code}</div>
            <p style="color:#7A8891;font-size:13px;margin-top:16px">Ce code expire dans <strong>10 minutes</strong>. Ne le partagez pas.</p>
          </div>`,
      })
    } else {
      // Dev mode — log in console
      console.log(`[SONIA OTP] ${email} → ${code}`)
    }
    res.json({ success: true, dev: !mailTransporter ? code : undefined })
  } catch(e) {
    console.error('[sonia/send-otp]', e.message)
    res.status(500).json({ error: 'Erreur envoi OTP' })
  }
})

// POST /api/sonia/verify-otp
router.post('/verify-otp', (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase()
  // Accepte 'code' (React) ET 'otp' (legacy)
  const code  = (req.body.code || req.body.otp || '').trim()
  if (!email || !code) return res.status(400).json({ error: 'Email et code requis.' })
  const stored = otpStoreSonia[email]
  if (!stored)               return res.status(400).json({ error: 'Aucun code envoyé pour cet email.' })
  if (Date.now() > stored.expires) {
    delete otpStoreSonia[email]
    return res.status(400).json({ error: 'Code expiré. Demandez un nouveau code.' })
  }
  if (stored.code !== code)  return res.status(400).json({ error: 'Code incorrect.' })
  delete otpStoreSonia[email]
  const session = Buffer.from(JSON.stringify({ email, exp: Date.now() + 8*60*60*1000 })).toString('base64')
  res.json({ success: true, token: session, email })
})

// GET /api/sonia/debug — voir les champs bruts Airtable (dev uniquement)
router.get('/debug', requireSonia, async (req, res) => {
  try {
    const table = req.query.table || 'Commandes'
    const resp  = await fetch(`${ATBASE}/${encodeURIComponent(table)}?maxRecords=3`, { headers: headers() }).then(r => r.json())
    const sample = (resp.records || []).map(r => ({
      id:     r.id,
      fields: Object.keys(r.fields),
      sample: Object.fromEntries(
        Object.entries(r.fields).map(([k,v]) => [k, Array.isArray(v) ? `[array:${v.length}]` : String(v).slice(0,80)])
      )
    }))
    res.json({ table, totalRecords: resp.records?.length, sample, error: resp.error })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /api/sonia/dossier/:id — Récupère un dossier complet pour le commercial
router.get('/dossier/:id', requireSonia, async (req, res) => {
  try {
    const cmdId = req.params.id
    if (!cmdId) return res.status(400).json({ error: 'ID de commande requis' })

    // 1. Récupérer la COMMANDE
    const cmdResp = await fetch(`${ATBASE}/${encodeURIComponent('Commandes')}/${cmdId}`, { headers: headers() })
    if (!cmdResp.ok) return res.status(404).json({ error: 'Commande introuvable' })
    const cmd = await cmdResp.json()
    const cf = cmd.fields

    // 2. Récupérer la société liée
    const societeId = (cf['Societé'] || cf['Société'] || [])[0]
    if (!societeId) return res.status(404).json({ error: 'Société introuvable pour cette commande' })
    const socResp = await fetch(`${ATBASE}/${encodeURIComponent('Sociétés')}/${societeId}`, { headers: headers() })
    if (!socResp.ok) return res.status(404).json({ error: 'Société introuvable' })
    const soc = await socResp.json()
    const sf = soc.fields

    // 3. Récupérer l'édition liée
    const editionId = (cf['Édition'] || cf['Edition'] || cf['Societé'] || [])[0]
    let edition = null
    let evenement = null
    if (editionId) {
      const edRes = await fetch(`${ATBASE}/${encodeURIComponent('Salons')}/${editionId}`, { headers: headers() })
      if (edRes.ok) {
        const edData = await edRes.json()
        const ef = edData.fields || {}
        edition = { id: edData.id, nom: ef['Edition'] || ef['Édition'] || ef['Nom du salon'] }
        evenement = {
          id: edData.id,
          nom: ef['Nom du salon'] || ef['Nom'] || ef['Name'] || ef['ID Salon'] || edData.id,
          lieu: ef['Lieu'] || ef['Ville'] || '',
        }
      }
    }

    // 4. Récupérer les stands commandés
    const standIds = Array.isArray(cf['Stand ou service commandé']) ? cf['Stand ou service commandé'] : []
    const stands = []
    let fallbackEditionId = null
    let fallbackSalonId = null
    for (const sId of standIds) {
      const sRes = await fetch(`${ATBASE}/${encodeURIComponent('Stands')}/${sId}`, { headers: headers() })
      if (sRes.ok) {
        const sFields = (await sRes.json()).fields
        fallbackEditionId = fallbackEditionId || linkedRecordId(sFields['Édition'] || sFields['Edition'])
        fallbackSalonId = fallbackSalonId || linkedRecordId(sFields['Editions'] || sFields['Éditions'] || sFields['Salon'] || sFields['Salons'])
        stands.push({
          id: sId,
          label: sFields['ID Stand'] || sFields['Numéro stand'] || '—',
          surface: sFields['Dimension'] || '',
          prix: sFields['Prix'] || 0,
          type: sFields['Spécificités'] || 'Autres',
        })
      }
    }
    if ((!edition || !evenement) && (fallbackEditionId || fallbackSalonId)) {
      const resolved = await resolveEditionAndSalon(edition ? null : fallbackEditionId, evenement ? null : fallbackSalonId)
      if (!edition) edition = resolved.edition
      if (!evenement) evenement = resolved.evenement
    }

    // 5. Récupérer les activités optionnelles
    const activitesOptionnellesIds = Array.isArray(cf['Activités optionnelles']) ? cf['Activités optionnelles'] : []
    const optionalActivities = []
    for (const actId of activitesOptionnellesIds) {
      const actRes = await fetch(`${ATBASE}/${encodeURIComponent('Activités optionnelles')}/${actId}`, { headers: headers() })
      if (actRes.ok) {
        const actFields = (await actRes.json()).fields
        optionalActivities.push({
          id: actId,
          label: actFields['Nom activité'] || actFields['Nom'] || '—',
          type: actFields['Type activité'] || '',
          description: actFields['Description / thème'] || '',
          prix: actFields['Prix unitaire'] || 0,
          dateCreneau: actFields['Date et créneau'] || '',
        })
      }
    }

    // 6. Récupérer les suppléments (si champ existe)
    const supplements = []
    if (cf['Suppléments'] && cf['Suppléments'].length > 0) {
      // Si les suppléments sont des enregistrements liés, les récupérer
      // Pour l'instant, on suppose que c'est un champ texte ou un rollup
      supplements.push({ label: cf['Suppléments'], prix: 0 }) // Placeholder
    }

    // 6. Récupérer le bilan de puissance depuis Commandes.Puissance
    const bilan = await fetchBilanPuissance(cmdId, cf)

    // 7. Calcul du calendrier de paiement
    // Les dates sont calculées par Airtable via des formules, on les récupère directement
    const dateValidation = cf['Date validation'] || null
    const dateAcompte = cf['Date J+7'] || cf['Date acompte'] || null
    const dateSolde = cf['Date 20J'] || cf['Date solde'] || null

    // Commercial affecté
    const commercialId = (sf['Commerciaux'] || [])[0]
    let commercial = null
    if (commercialId) {
      commercial = (await atGet('Commerciaux', `RECORD_ID()="${commercialId}"`))[0]?.fields || null
    }

    // 6. Recalcul financier de sécurité (formules identiques à Airtable)
    // Les prix stands/activités sont déjà TTC (taxe incluse)
    // On extrait le HT à rebours pour calculer la taxe
    const totalHTStands = stands.reduce((sum, s) => sum + (Number(s.prix) || 0), 0)
    const totalHTActs = optionalActivities.reduce((sum, a) => sum + (Number(a.prix) || 0), 0)
    const montantTTC = totalHTStands + totalHTActs
    const rawTaxRate = sf['Régime fiscal'] || sf['Regime fiscal'] || '0.2'
    const taxRate = String(rawTaxRate).includes('20') ? 0.2
                  : String(rawTaxRate).includes('8') ? 0.08
                  : parseFloat(rawTaxRate) || 0
    const montantHT = taxRate > 0 ? Math.round(montantTTC / (1 + taxRate)) : montantTTC
    const montantTaxe = Math.round(montantHT * taxRate)
    const remisePromo = cf['Montant remise promo'] || 0
    const voucherAmount = cf['Montant voucher appliqué'] || 0
    const netAPayer = Math.max(0, montantTTC - remisePromo - voucherAmount)

    // 6b. Récupérer les paiements associés
    const paiements = []
    const pIds = cf['Paiements'] || []
    const parseMGA_local = v => parseFloat(String(v||0).replace(/[^0-9.,]/g,'').replace(',','.')) || 0
    for (const pid of pIds) {
      const pRes = await fetch(`${ATBASE}/${encodeURIComponent('Paiements')}/${pid}`, { headers: headers() })
      if (pRes.ok) {
        const pd = (await pRes.json()).fields || {}
        const pStatut = pd['Statut'] || 'En attente'
        paiements.push({
          id: pid,
          montant: parseMGA_local(pd['Montant payé'] || pd['Montant']),
          mode:    pd['Mode de paiement'] || pd['Mode paiement'] || '—',
          date:    pd['Date paiement'] || pd['Date'] || '',
          reference: pd['Référence'] || '',
          statut:  pStatut,
          valide:  pStatut !== 'Refusé' && (pd['Validé par M. Hery'] === true || pStatut === 'Validé'),
          notes:   pd['Notes'] || '',
        })
      }
    }

    res.json({
      commande: {
        id: cmd.id,
        numeroDossier: cf['Numero de dossier'] || cmd.id.slice(-8).toUpperCase(),
        dateCommande: cf['Date commande'],
        statutCommande: cf['Statut commande'],
        validation: cf['Validation'],
        montantTotal: netAPayer,
        montantHT: montantHT,
        montantTaxe: montantTaxe,
        pourcentageTaxe: cf['Pourcentage Taxe'] || '',
        tauxTva: cf['Pourcentage Taxe'] || sf['Régime fiscal'] || '',
        montantEncaisse: cf['Montant encaissé'] || 0,
        resteAPayer: Math.max(0, netAPayer - (cf['Montant encaissé'] || 0)), // Utilise le netAPayer calculé
        remisePromo: cf['Montant remise promo'] || 0,
        voucherAmount: cf['Montant voucher appliqué'] || 0,
        dateValidation: cf['Date validation'],
        dateAcompte,
        dateSolde,
        nbBadges: cf['Nombre badges'] || 0,
        nbInvitations: cf['Nombre invitations'] || 0,
        accesParkingVIP:     cf['Accès parking VIP'] || 0,
        notes:               cf['Notes'] || '',
        descriptionActivite: cf['Description activités'] || '',
      },
      societe: { ...sf, id: societeId, idEntreprise: sf['ID Entreprise'] || null },
      statutExposant: sf['Statut exposant (from Participations)'] || 'Exposant',
      edition: edition,
      evenement,
      stands: stands,
      optionalActivities: optionalActivities,
      supplements,
      paiements,
      bilan: bilan,
      commercial: commercial,
    })
  } catch (e) {
    console.error('[sonia/dossier/:id] error:', e.message)
    res.status(500).json({ error: DEBUG ? e.message : 'Erreur de chargement du dossier commercial' })
  }
})

router.get('/accounts', requireSonia, async (req, res) => {
  try {
    const [usersRaw, commerciauxRaw, societesRaw] = await Promise.all([
      authUsers({ refresh: true }),
      atGet('Commerciaux').catch(e => {
        console.warn('[sonia/accounts] Commerciaux:', e.message)
        return []
      }),
      atGet('Sociétés', 'maxRecords=500').catch(e => {
        console.warn('[sonia/accounts] Sociétés:', e.message)
        return []
      }),
    ])

    const users = usersRaw.map(record => {
      const user = normalizeAuthUser(record)
      return {
        id: user.id,
        email: user.email,
        role: user.role,
        linkedRecordId: user.linkedRecordId || '',
        active: user.active,
        hasPassword: !!user.passwordHash,
      }
    })

    res.json({
      users,
      commerciaux: commerciauxRaw.map(mapCommercialAccountOption),
      societes: societesRaw.map(mapSocieteAccountOption),
    })
  } catch (e) {
    console.error('[sonia/accounts]', e.message)
    res.status(500).json({ error: DEBUG ? e.message : 'Erreur de chargement des comptes' })
  }
})

router.post('/accounts', requireSonia, async (req, res) => {
  try {
    const role = normalizeRole(req.body?.role)
    const password = String(req.body?.password || '')
    const confirm = String(req.body?.confirmPassword || req.body?.passwordConfirm || '')
    const requestedRecordId = String(req.body?.linkedRecordId || req.body?.airtableRecordId || '').trim()
    let email = normalizeEmail(req.body?.email)
    let linkedRecordId = ''
    let label = ''

    if (!['admin_sonia', 'commercial', 'exposant'].includes(role)) {
      return res.status(400).json({ error: 'Rôle utilisateur invalide.' })
    }
    if (confirm && password !== confirm) {
      return res.status(400).json({ error: 'Les mots de passe ne correspondent pas.' })
    }
    const policyError = passwordPolicyError(password)
    if (policyError) return res.status(400).json({ error: policyError })

    if (role === 'commercial') {
      const record = await atRecordById('Commerciaux', requestedRecordId)
      if (!record) return res.status(400).json({ error: 'Commercial introuvable.' })
      const option = mapCommercialAccountOption(record)
      linkedRecordId = record.id
      email = email || normalizeEmail(option.email)
      label = option.nom
    } else if (role === 'exposant') {
      const record = await atRecordById('Sociétés', requestedRecordId)
      if (!record) return res.status(400).json({ error: 'Société introuvable.' })
      const option = mapSocieteAccountOption(record)
      linkedRecordId = record.id
      email = email || normalizeEmail(option.email)
      label = option.nom
    } else {
      label = 'Administration Madavision'
    }

    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'Email utilisateur invalide ou manquant.' })
    }

    const existing = await findAuthUserByEmail(email, role)
    if (existing && !existing.active) {
      return res.status(403).json({ error: 'Ce compte existe mais il est désactivé.' })
    }
    if (existing?.passwordHash) {
      return res.status(409).json({ error: 'Un compte avec cet email existe déjà pour ce rôle.' })
    }

    const user = await ensureAuthUser({ email, role, linkedRecordId, password })
    const frontendBase = (process.env.FRONTEND_URL || 'http://localhost:5173' || 'http://localhost:8080').replace(/\/$/, '')
    const spacePath = role === 'commercial' ? '/commercial' : role === 'exposant' ? '/exposant' : '/sonia'
    const accessUrl = `${frontendBase}${spacePath}`
    const roleText = role === 'commercial' ? 'Espace commercial' : role === 'exposant' ? 'Espace exposant' : 'Espace administration'
    const result = await mailer(
      email,
      'Votre compte Madavision est prêt',
      emailWrapper(`
        <h2 style="color:#1B2A4A;font-size:18px;margin:0 0 14px">Votre compte Madavision est prêt</h2>
        <p>Bonjour,</p>
        <p>Un accès <strong>${escapeHtml(roleText)}</strong>${label ? ` pour <strong>${escapeHtml(label)}</strong>` : ''} vient d'être créé par l'administration Madavision.</p>
        <div style="background:#EEF2F8;border-left:3px solid #2260A7;padding:14px 18px;border-radius:0 8px 8px 0;margin:18px 0">
          <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#2260A7;margin-bottom:8px">Informations de connexion</div>
          <div style="font-size:13px;color:#1B2A4A"><strong>Identifiant :</strong> ${escapeHtml(email)}</div>
          <div style="font-size:13px;color:#1B2A4A;margin-top:4px"><strong>Espace :</strong> ${escapeHtml(roleText)}</div>
        </div>
        <p>Vous pouvez maintenant vous connecter avec cet email et le mot de passe défini lors de la création du compte.</p>
        <div style="margin-top:22px">
          <a href="${frontendBase}/exposant" style="background:#1B2A4A;color:#fff;text-decoration:none;padding:10px 22px;border-radius:8px;display:inline-block;font-weight:600;font-size:13px">Accéder à mon espace</a>
        </div>
        <div style="font-size:11px;color:#9B9183;margin-top:10px;word-break:break-all">${accessUrl}</div>
      `)
    )

    res.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        linkedRecordId: user.linkedRecordId || linkedRecordId || '',
        active: user.active,
        hasPassword: !!user.passwordHash || !!password,
      },
      emailSent: result.sent,
      emailNote: result.error || null,
    })
  } catch (e) {
    console.error('[sonia/accounts:create]', e.message)
    res.status(500).json({ error: DEBUG ? e.message : 'Erreur de création du compte' })
  }
})

// PATCH /api/sonia/accounts/:id — modifier actif / réinitialiser mot de passe
router.patch('/accounts/:id', requireSonia, async (req, res) => {
  try {
    const { id } = req.params
    const updates = {}

    if (req.body.active !== undefined) updates.active = Boolean(req.body.active)
    if (req.body.password) {
      const pw  = String(req.body.password)
      const cpw = String(req.body.confirmPassword || '')
      if (pw !== cpw) return res.status(400).json({ error: 'Les mots de passe ne correspondent pas.' })
      const policyError = passwordPolicyError(pw)
      if (policyError) return res.status(400).json({ error: policyError })
      updates.passwordHash = hashPassword(pw)
    }
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'Aucune modification fournie.' })

    const records = await authUsers({ refresh: true })
    const record  = records.find(r => r.id === id)
    if (!record) return res.status(404).json({ error: 'Compte introuvable.' })

    const user = normalizeAuthUser(record)
    await patchAuthUser(user, updates)

    res.json({
      success:     true,
      id,
      active:      updates.active !== undefined ? updates.active : user.active,
      hasPassword: updates.passwordHash ? true : !!user.passwordHash,
    })
  } catch (e) {
    console.error('[sonia/accounts:update]', e.message)
    res.status(500).json({ error: DEBUG ? e.message : 'Erreur de mise à jour du compte' })
  }
})

// GET /api/sonia/dossiers — liste commandes classées par Validation
router.get('/dossiers', requireSonia, async (req, res) => {
  try {
    const filtre = req.query.statut || 'tous'

    let qs = `sort%5B0%5D%5Bfield%5D=${encodeURIComponent('Date commande')}&sort%5B0%5D%5Bdirection%5D=desc&maxRecords=200`
    if (filtre !== 'tous') {
      qs = `filterByFormula=${encodeURIComponent(`{Validation}="${filtre}"`)}&${qs}`
    }

    const [cmdsResp, commsResp, paiementsResp] = await Promise.all([
      fetch(`${ATBASE}/${encodeURIComponent('Commandes')}?${qs}`, { headers: headers() }).then(r => r.json()),
      fetch(`${ATBASE}/${encodeURIComponent('Commerciaux')}`,      { headers: headers() }).then(r => r.json()),
      fetch(`${ATBASE}/${encodeURIComponent('Paiements')}?maxRecords=500&sort%5B0%5D%5Bfield%5D=Date+paiement&sort%5B0%5D%5Bdirection%5D=desc`, { headers: headers() }).then(r => r.json()).catch(() => ({ records: [] })),
    ])

    if (cmdsResp.error) {
      return res.status(500).json({ error: `Airtable Commandes: ${cmdsResp.error.message}`, detail: cmdsResp.error })
    }

    const records = cmdsResp.records || []
    console.log(`[sonia/dossiers] ${records.length} commandes chargées`)

    // ── Commerciaux ──────────────────────────────────────────────────
    if (commsResp.error) console.error('[sonia/dossiers] Erreur table Commerciaux:', commsResp.error)

    const parseObjective = v => parseFloat(String(v || 0).replace(/[^0-9.,-]/g, '').replace(',', '.')) || 0
    const commerciaux = (commsResp.records || []).map(r => {
      const f = r.fields
      const nom = f['Nom'] || f['Nom complet'] || f['Prénom Nom'] ||
                  Object.values(f).find(v => typeof v === 'string' && v.length < 50) || r.id
      return {
        id:       r.id,
        nom,
        email:    f['Email'] || f['Email professionnel'] || f['Mail'] || '',
        telephone:f['Téléphone'] || f['Tel'] || '',
        objectifCA: parseObjective(f['Objectif CA']),
        objectifStands: parseObjective(f['Objectif stands']),
      }
    })
    console.log('[sonia/dossiers] Liste des commerciaux transformée:', commerciaux)

    // ── Map Paiements par commandeId ─────────────────────────────────
    const parseMGA2 = v => parseFloat(String(v || 0).replace(/[^0-9.,]/g, '').replace(',', '.')) || 0
    const paiementsMap = {}
    ;(paiementsResp.records || []).forEach(r => {
      const f    = r.fields
      const cIds = Array.isArray(f['Commande']) ? f['Commande'] : (f['Commande'] ? [f['Commande']] : [])
      cIds.forEach(cId => {
        if (!paiementsMap[cId]) paiementsMap[cId] = []
        const statut = f['Statut'] || 'En attente'
        paiementsMap[cId].push({
          id:      r.id,
          montant: parseMGA2(f['Montant payé'] || f['Montant']),
          mode:    f['Mode de paiement'] || f['Mode paiement'] || f['Mode'] || '—',
          date:    f['Date paiement'] || f['Date'] || '',
          reference: f['Référence'] || '',
          statut,
          notes:   f['Notes'] || '',
          valide:  statut !== 'Refusé' && (f['Validé par M. Hery'] === true || statut === 'Validé'),
        })
      })
    })

    // ── Collecter IDs uniques pour résolution en batch ───────────────
    const societeIds = new Set()
    const standIds   = new Set()
    const activityIds = new Set()
    const salonIds   = new Set()
    const editionIds = new Set()
    const activityMap = {}
    const editionMap = {}

    records.forEach(r => {
      const f = r.fields
      // Société liée (champ link → array de record IDs dans l'API)
      invoiceLinkedIds(f['Societé'] || f['Société']).forEach(id => societeIds.add(id))

      // Stands liés (champ link → array de record IDs)
      invoiceLinkedIds(f['Stand ou service commandé']).forEach(id => standIds.add(id))

      // Édition liée
      invoiceLinkedIds(f['Salons'] || f['Salon'] || f['Édition'] || f['Edition']).forEach(id => {
        editionIds.add(id)
        salonIds.add(id)
      })
      invoiceLinkedIds(f['Activités optionnelles']).forEach(id => activityIds.add(id))
    })

    // ── Fetch Sociétés en batch ───────────────────────────────────────
    const societeMap = {}
    if (societeIds.size > 0) {
      try {
        const ids  = [...societeIds]
        const fmla = ids.length === 1
          ? `RECORD_ID()="${ids[0]}"`
          : `OR(${ids.map(id => `RECORD_ID()="${id}"`).join(',')})`
        const sResp = await fetch(
          `${ATBASE}/${encodeURIComponent('Sociétés')}?filterByFormula=${encodeURIComponent(fmla)}`,
          { headers: headers() }
        ).then(r => r.json())
        ;(sResp.records || []).forEach(r => {
          const f = r.fields
          societeMap[r.id] = {
            id:        r.id,
            nom:       f['Raison sociale'] || f['Nom'] || f['Name'] || null,
            email:     f['Email'] || '',
            telephone: String(f['Téléphone'] || ''),
            commIds:   f['Commerciaux'] || [],
            regimeFiscal: f['Régime fiscal'] || f['Regime fiscal'] || '0.2',
          }
        })
        console.log(`[sonia/dossiers] ${Object.keys(societeMap).length} sociétés résolues`)
      } catch(e) { console.warn('[sonia] batch sociétés failed:', e.message) }
    }

    // ── Fetch Stands en batch (si IDs) ────────────────────────────────
    const standMap = {}
    // const salonIds = new Set()
    if (standIds.size > 0) {
      try {
        const ids  = [...standIds]
        const fmla = ids.length === 1
          ? `RECORD_ID()="${ids[0]}"`
          : `OR(${ids.map(id => `RECORD_ID()="${id}"`).join(',')})`
        const stResp = await fetch(
          `${ATBASE}/${encodeURIComponent('Stands')}?filterByFormula=${encodeURIComponent(fmla)}`,
          { headers: headers() }
        ).then(r => r.json())
        ;(stResp.records || []).forEach(r => {
          const f = r.fields || {}
          const editionId = linkedRecordId(f['Édition'] || f['Edition'])
          const salonId = linkedRecordId(f['Editions'] || f['Éditions'] || f['Salon'] || f['Salons'])
          if (salonId) salonIds.add(salonId)
          standMap[r.id] = {
            label: f['ID Stand'] || f['Spécificités'] || r.id,
            prix: parseFloat(String(f['Prix'] || f['Prix HT'] || f['Tarif'] || 0).replace(/[^0-9.,]/g, '').replace(',', '.')) || 0,
            salonId,
          }
        })
        console.log(`[sonia/dossiers] ${Object.keys(standMap).length} stands résolus`)
      } catch(e) { console.warn('[sonia] batch stands failed:', e.message) }
    }

    // ── Fetch Salons en batch (contient Salons + Editions unifiés) ─────
    const salonMap = {}
    if (salonIds.size > 0) {
      try {
        const ids = [...salonIds]
        const fmla = ids.length === 1 ? `RECORD_ID()="${ids[0]}"` : `OR(${ids.map(id => `RECORD_ID()="${id}"`).join(',')})`
        const sResp = await fetch(`${ATBASE}/${encodeURIComponent('Salons')}?filterByFormula=${encodeURIComponent(fmla)}`, { headers: headers() }).then(r => r.json())
        ;(sResp.records || []).forEach(r => {
          const f = r.fields
          salonMap[r.id] = { id: r.id, nom: f['Nom du salon'] || f['Nom'] || f['Name'] || r.id, lieu: f['Lieu'] || '' }
          editionMap[r.id] = {
            id: r.id,
            nom: f['Edition'] || f['Édition'] || f['Nom édition'] || f['Nom du salon'] || r.id,
            dateDebut: f['Date début'] || f['Date de début'] || '',
            dateFin:   f['Date fin'] || f['Date de fin'] || '',
          }
        })
      } catch(e) { console.warn('[sonia] batch salons failed:', e.message) }
    }

    // ── Fetch Activités optionnelles en batch ──────────────────────────
    if (activityIds.size > 0) {
      try {
        const ids = [...activityIds]
        const fmla = ids.length === 1 ? `RECORD_ID()="${ids[0]}"` : `OR(${ids.map(id => `RECORD_ID()="${id}"`).join(',')})`
        const actResp = await fetch(`${ATBASE}/${encodeURIComponent('Activités optionnelles')}?filterByFormula=${encodeURIComponent(fmla)}`, { headers: headers() }).then(r => r.json())
        ;(actResp.records || []).forEach(r => {
          const f = r.fields
          activityMap[r.id] = {
            prix: parseFloat(String(f['Prix unitaire'] || f['Prix'] || 0).replace(/[^0-9.,]/g, '').replace(',', '.')) || 0,
          }
        })
        console.log(`[sonia/dossiers] ${Object.keys(activityMap).length} activités résolues`)
      } catch(e) { console.warn('[sonia] batch activities failed:', e.message) }
    }

    // ── Mapping final commandes ──────────────────────────────────────
    const dossiers = records.map(r => {
      const f = r.fields
      const parseMGA = v => parseFloat(String(v||0).replace(/[^0-9.,]/g,'').replace(',','.')) || 0
      const getSingle = field => { const v=f[field]; return Array.isArray(v)?v[0]:(v||'') }

      // Société — utilise le batch résolu ou lookup texte en fallback
      const socLinkedIds = invoiceLinkedIds(f['Societé'] || f['Société'])
      const societeId    = socLinkedIds[0] || null
      const socResolved  = societeId ? societeMap[societeId] : null

      const societe = {
        id:        societeId,
        // nom : batch résolu (Raison sociale) > lookup texte dans Commandes > ID
        nom:       (socResolved?.nom && !String(socResolved.nom).startsWith('rec')) ? socResolved.nom : (getSingle('Nom (from Societé)') || '—'),
        email:     socResolved?.email     || getSingle('Email (from Societé)') || '',
        telephone: socResolved?.telephone || String(getSingle('Téléphone (à partir de Societé)') || ''),
        contact:   getSingle('Contact principal (à partir de Societé)'),
          regimeFiscal: socResolved?.regimeFiscal || getSingle('Régime fiscal (à partir de Societé)') || '0.2',
      }

      // Commercial actuel (on le résout via la société batchée pour être plus fiable que le lookup texte)
      const commercialId = socResolved?.commIds?.[0] || null
      const commercialNom = commercialId ? (commerciaux.find(c => c.id === commercialId)?.nom || null) : null

      console.log("COMMERCIAL = ", commercialNom)

      // Stands — batch résolu > texte CSV
      const stLinkedIds = invoiceLinkedIds(f['Stand ou service commandé'])
      let standsLabel
      if (stLinkedIds.length > 0) {
        // Ce sont des IDs → résoudre via batch
        standsLabel = stLinkedIds.map(id => standMap[id]?.label || id).join(', ')
      } else {
        // Ce sont déjà des noms (lookup texte)
        const rawStands = f['Stand ou service commandé'] || []
        standsLabel = Array.isArray(rawStands) ? rawStands.map(v => String(v || '')).join(', ') : String(rawStands || '—')
      }
      const standCount = stLinkedIds.length || String(f['Stand ou service commandé'] || '').split(',').map(s => s.trim()).filter(Boolean).length

      const participationId = Array.isArray(f['Participation']) ? f['Participation'][0] : null
      const edLinkedIds = invoiceLinkedIds(f['Salons'] || f['Salon'] || f['Édition'] || f['Edition'])
      const fallbackStand = stLinkedIds.map(id => standMap[id]).find(Boolean)
      const editionId = edLinkedIds[0] || fallbackStand?.salonId || null
      const edition = editionId ? editionMap[editionId] : null
      const salonId = editionId || fallbackStand?.salonId || null
      const evenement = salonId ? salonMap[salonId] : null

      // RECALCUL DYNAMIQUE (formules identiques à Airtable)
      // Les prix stands/activités sont déjà TTC (taxe incluse)
      // On extrait le HT à rebours pour calculer la taxe
      const totalHTStands = stLinkedIds.reduce((sum, id) => sum + (standMap[id]?.prix || 0), 0)
      const totalHTActs = invoiceLinkedIds(f['Activités optionnelles']).reduce((sum, id) => sum + (activityMap[id]?.prix || 0), 0)
      const montantTTC = totalHTStands + totalHTActs

      const tr = societe.regimeFiscal
      const taxRate = String(tr).includes('20') ? 0.2 : String(tr).includes('8') ? 0.08 : parseFloat(tr) || 0
      const montantHT = taxRate > 0 ? Math.round(montantTTC / (1 + taxRate)) : montantTTC
      const montantTaxe = Math.round(montantHT * taxRate)
      const remise = parseMGA(f['Montant remise promo'])
      const voucher = parseMGA(f['Montant voucher appliqué'])
      const netAPayer = Math.max(0, montantTTC - remise - voucher)

      const paiements     = paiementsMap[r.id] || []
      const montantEncaisse = paiements.filter(p => p.valide).reduce((s, p) => s + p.montant, 0) || parseMGA(f['Montant encaissé'])
      const resteAPayer = Math.max(0, netAPayer - montantEncaisse)

      return {
        id:              r.id,
        participationId,
        societeId,
        statut:          f['Validation']      || '—',
        statutCommande:  f['Statut commande'] || '—',
        dateCommande:    f['Date commande']   || '',
        dateInscription: f['Date commande']   || '',
        commercialId,
        commercial:      commercialNom        || null,
        editionId,
        edition,
        evenementId:     evenement?.id || null,
        evenement,
        societe,
        commandes: [{
          id:      r.id,
          stand:   standsLabel,
          standCount,
          montant: netAPayer,
          reste:   resteAPayer,
          statut:  f['Statut commande']        || '—',
        }],
        standCount,
        numDossier:      f['Numero de dossier'] || f['ID Commande'] || r.id.slice(-8).toUpperCase(),
        montantTotal: netAPayer,
        resteAPayer,
        montantEncaisse,
        paiements,
        codePromo:    f['Code promo']   || f['Code Promo']   || '',
        codeVoucher:  f['Code voucher'] || f['Code Voucher'] || f['Voucher'] || '',
        rawFields:    Object.keys(f),
      }
    })

    res.json({ dossiers, commerciaux, airtableBaseUrl: `https://airtable.com/${BASE}` })
  } catch(e) {
    console.error('[sonia/dossiers]', e.message)
    res.status(500).json({ error: e.message })
  }
})

// GET /api/sonia/paiements — validation administrative des paiements déclarés
router.get('/paiements', requireSonia, async (req, res) => {
  try {
    const parseMGA = v => parseFloat(String(v || 0).replace(/[^0-9.,-]/g, '').replace(',', '.')) || 0

    const [paiementRecords, commandeRecords, societeRecords, commerciauxRecords] = await Promise.all([
      atGet('Paiements', `maxRecords=500&sort%5B0%5D%5Bfield%5D=${encodeURIComponent('Date paiement')}&sort%5B0%5D%5Bdirection%5D=desc`),
      atGet('Commandes', 'maxRecords=500'),
      atGet('Sociétés', 'maxRecords=500'),
      atGet('Commerciaux', 'maxRecords=500').catch(() => []),
    ])

    const commerciaux = {}
    commerciauxRecords.forEach(record => {
      const f = record.fields || {}
      commerciaux[record.id] = {
        id: record.id,
        nom: f['Nom'] || f['Nom complet'] || f['Prénom Nom'] || record.id,
        email: f['Email'] || f['Email professionnel'] || f['Mail'] || '',
      }
    })

    const societes = {}
    societeRecords.forEach(record => {
      const f = record.fields || {}
      const commId = Array.isArray(f['Commerciaux']) ? f['Commerciaux'][0] : null
      societes[record.id] = {
        id: record.id,
        nom: f['Raison sociale'] || f['Nom'] || f['Name'] || record.id,
        email: f['Email'] || '',
        idEntreprise: f['ID Entreprise'] || '',
        commercialId: commId,
        commercial: commId ? commerciaux[commId] : null,
      }
    })

    const commandes = {}
    commandeRecords.forEach(record => {
      const f = record.fields || {}
      const societeId = linkedRecordId(f['Societé'] || f['Société'])
      commandes[record.id] = {
        id: record.id,
        numeroDossier: f['Numero de dossier'] || f['ID Commande'] || record.id.slice(-8).toUpperCase(),
        dateCommande: f['Date commande'] || '',
        statut: f['Validation'] || '',
        statutCommande: f['Statut commande'] || '',
        societeId,
        societe: societeId ? societes[societeId] : null,
      }
    })

    const paiements = paiementRecords.map(record => {
      const f = record.fields || {}
      const commandeId = linkedRecordId(f['Commande'])
      const commande = commandeId ? commandes[commandeId] : null
      const societe = commande?.societe || null
      const statut = f['Statut'] || 'En attente'
      return {
        id: record.id,
        commandeId,
        commande: commande ? {
          id: commande.id,
          numeroDossier: commande.numeroDossier,
          dateCommande: commande.dateCommande,
          statut: commande.statut,
          statutCommande: commande.statutCommande,
        } : null,
        societe: societe ? {
          id: societe.id,
          nom: societe.nom,
          email: societe.email,
          idEntreprise: societe.idEntreprise,
        } : null,
        commercial: societe?.commercial || null,
        montant: parseMGA(f['Montant payé'] || f['Montant']),
        mode: f['Mode de paiement'] || f['Mode paiement'] || f['Mode'] || '—',
        date: f['Date paiement'] || f['Date'] || record.createdTime || '',
        reference: f['Référence'] || '',
        statut,
        notes: f['Notes'] || '',
        valide: statut !== 'Refusé' && (f['Validé par M. Hery'] === true || statut === 'Validé'),
      }
    })

    res.json({ paiements })
  } catch (e) {
    console.error('[sonia/paiements]', e.message)
    res.status(500).json({ error: DEBUG ? e.message : 'Erreur de chargement des paiements' })
  }
})

// POST /api/sonia/paiements/:id/status — accepter ou refuser un paiement
router.post('/paiements/:id/status', requireSonia, async (req, res) => {
  try {
    const paiementId = req.params.id
    const requestedStatus = String(req.body?.status || '').trim()
    const raison = String(req.body?.raison || '').trim()
    const status = requestedStatus === 'Validé'
      ? 'Validé'
      : requestedStatus === 'Refusé'
        ? 'Refusé'
        : ''
    if (!status) return res.status(400).json({ error: 'Statut de paiement invalide.' })

    const currentRes = await fetch(`${ATBASE}/${encodeURIComponent('Paiements')}/${paiementId}`, { headers: headers() })
    if (!currentRes.ok) return res.status(404).json({ error: 'Paiement introuvable' })
    const current = await currentRes.json()
    const currentFields = current.fields || {}

    const noteParts = []
    if (currentFields['Notes']) noteParts.push(currentFields['Notes'])
    noteParts.push(`${status} par ${req.soniaEmail} le ${new Date().toISOString().slice(0, 10)}`)
    if (raison) noteParts.push(`Motif: ${raison}`)

    const fields = {
      'Statut': status,
      'Validé par M. Hery': status === 'Validé',
      'Date validation': new Date().toISOString().slice(0, 10),
      'Notes': noteParts.join(' — '),
    }

    let updated
    try {
      updated = await patchAirtableWithTypecast('Paiements', paiementId, fields)
    } catch (firstError) {
      console.warn('[sonia/paiements/status] full patch failed, retrying status only:', firstError.message)
      updated = await patchAirtableWithTypecast('Paiements', paiementId, {
        'Statut': status,
        'Notes': noteParts.join(' — '),
      })
    }

    const f = updated.fields || {}
    const finalStatus = f['Statut'] || status
    res.json({
      success: true,
      paiement: {
        id: updated.id,
        montant: invoiceMoney(f['Montant payé'] || f['Montant']),
        mode: f['Mode de paiement'] || f['Mode paiement'] || f['Mode'] || '—',
        date: f['Date paiement'] || f['Date'] || '',
        reference: f['Référence'] || '',
        statut: finalStatus,
        notes: f['Notes'] || '',
        valide: finalStatus !== 'Refusé' && (f['Validé par M. Hery'] === true || finalStatus === 'Validé'),
      },
    })
  } catch (e) {
    console.error('[sonia/paiements/status]', e.message)
    res.status(500).json({ error: DEBUG ? e.message : 'Erreur de mise à jour du paiement' })
  }
})



// POST /api/sonia/valider/:id — valider une commande (Commandes.Validation → Validé)
// NB: l'assignation commercial est une action SÉPARÉE via /api/sonia/assigner/:cmdId
router.post('/valider/:id', requireSonia, async (req, res) => {
  try {
    const id   = req.params.id
    const { commercialId, societeId } = req.body || {}

    const fields = {
      'Validation':      'Validé',
      'Date validation': new Date().toISOString(),
    }

    const r = await fetch(`${ATBASE}/${encodeURIComponent('Commandes')}/${id}`, {
      method: 'PATCH', headers: { ...headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields }),
    })
    const d = await r.json()
    if (!r.ok) return res.status(500).json({ error: `Commandes PATCH: ${d.error?.message || r.status}` })

    // ── NOUVEAU : Mise à jour de la Société (Assignation commercial) ──
    if (commercialId && societeId) {
      console.log(`[Sonia] Mise à jour Société ${societeId} -> Commercial ${commercialId}`)
      const sRes = await fetch(`${ATBASE}/${encodeURIComponent('Sociétés')}/${societeId}`, {
        method:  'PATCH',
        headers: { ...headers(), 'Content-Type': 'application/json' },
        body:    JSON.stringify({ fields: { 'Commerciaux': [commercialId] } }),
      })
      const sData = await sRes.json().catch(() => ({}))
      if (!sRes.ok) {
        console.error(`❌ [Sonia] Erreur Airtable Sociétés: ${sData.error?.message || sRes.status}`)
        // On ne bloque pas la réponse car la commande est déjà validée
      } else {
        console.log(`✓ [Sonia] Commercial assigné avec succès dans Airtable`)
      }
    }

    // Notification non-bloquante au commercial
    notifyCommercialStatus(id, 'Validé', commercialId, societeId, req.soniaEmail, null).catch(() => {})

    let exposantNotification = { emailSent: false, to: null, emailNote: null }
    try {
      exposantNotification = await sendExposantValidationConfirmation(id)
    } catch (emailErr) {
      exposantNotification = { emailSent: false, to: null, emailNote: emailErr.message }
      console.warn(`[Sonia] Email confirmation exposant non envoyé: ${emailErr.message}`)
    }

    console.log(`✓ [Sonia] Commande ${id} validée par ${req.soniaEmail}`)
    res.json({ success: true, ...exposantNotification })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/sonia/status/:id — Mise à jour générique du statut (Annulé, A valider)
router.post('/status/:id', requireSonia, async (req, res) => {
  try {
    const id = req.params.id
    const { status, commercialId, societeId } = req.body || {}
    if (!status) return res.status(400).json({ error: 'Statut requis' })

    await fetch(`${ATBASE}/${encodeURIComponent('Commandes')}/${id}`, {
      method: 'PATCH',
      headers: { ...headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { 'Validation': status } }),
    })

    if (commercialId && societeId) {
      await notifyCommercialStatus(id, status, commercialId, societeId, req.soniaEmail)
    }

    res.json({ success: true })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/sonia/dossier/:id/payment-calendar — dates de paiement modifiables par l'administration
router.post('/dossier/:id/payment-calendar', requireSonia, async (req, res) => {
  try {
    let fields
    try {
      fields = paymentCalendarFields(req.body)
    } catch (e) {
      return res.status(400).json({ error: e.message })
    }

    const cmdId = req.params.id
    const updated = await patchCommandeFields(cmdId, fields)
    res.json({ success: true, commande: paymentCalendarPayload(updated) })
  } catch(e) {
    console.error('[sonia/payment-calendar]', e.message)
    res.status(500).json({ error: DEBUG ? e.message : 'Erreur de mise à jour du calendrier de paiement' })
  }
})

// GET /api/sonia/dossier/:id/download-invoice — facture PDF pour l'administration
router.get('/dossier/:id/download-invoice', requireSonia, async (req, res) => {
  await sendInvoicePdf(req, res)
})

// PATCH /api/sonia/dossier/:id/access-config — mise à jour badges + invitations (admin)
router.patch('/dossier/:id/access-config', requireSonia, async (req, res) => {
  try {
    const cmdId = req.params.id
    const { nbBadges, nbInvitations } = req.body || {}
    if (nbBadges === undefined && nbInvitations === undefined) {
      return res.status(400).json({ error: 'Aucun champ à mettre à jour.' })
    }
    const fields = {}
    if (nbBadges !== undefined)      fields['Nombre badges']      = Math.max(0, Number(nbBadges) || 0)
    if (nbInvitations !== undefined) fields['Nombre invitations']  = Math.max(0, Number(nbInvitations) || 0)
    const atResp = await fetch(`${ATBASE}/${encodeURIComponent('Commandes')}/${cmdId}`, {
      method: 'PATCH', headers: headers(), body: JSON.stringify({ fields }),
    })
    if (!atResp.ok) {
      const atErr = await atResp.json().catch(() => ({}))
      return res.status(502).json({ error: `Airtable: ${atErr?.error?.message || 'champs introuvables — vérifiez que "Nombre badges" et "Nombre invitations" existent dans la table Commandes'}` })
    }
    res.json({ success: true, nbBadges: fields['Nombre badges'], nbInvitations: fields['Nombre invitations'] })
  } catch(e) {
    console.error('[sonia/access-config]', e.message)
    res.status(500).json({ error: DEBUG ? e.message : 'Erreur mise à jour accès' })
  }
})

// GET /api/sonia/dossier/:id/download-badges — génère le PDF badges + invitations (admin)
router.get('/dossier/:id/download-badges', requireSonia, async (req, res) => {
  try {
    const cmdId = req.params.id
    const cmdCheck = await invoiceFetchRecord('Commandes', cmdId)
    const cfCheck = cmdCheck?.fields || {}
    const nbBadges = Number(cfCheck['Nombre badges']) || 0
    const nbInvitations = Number(cfCheck['Nombre invitations']) || 0
    if (nbBadges === 0 && nbInvitations === 0) {
      return res.status(400).json({ error: 'Aucun badge ni invitation configuré pour ce dossier.' })
    }
    const result = await generateBadgesInvitationsPDF(cmdId, { nbBadges, nbInvitations })
    const filename = `badges-invitations-${cmdId.slice(-8)}.pdf`
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.send(result.buffer)
  } catch(e) {
    console.error('[sonia/download-badges]', e.message)
    res.status(400).json({ error: e.message })
  }
})

// POST /api/sonia/dossier/:id/email-invoice — envoyé par email au client exposant (admin)
router.post('/dossier/:id/email-invoice', requireSonia, async (req, res) => {
  try {
    const id = req.params.id
    const frontendBase = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '')

    const cmdResp = await fetch(`${ATBASE}/${encodeURIComponent('Commandes')}/${id}`, { headers: headers() })
    if (!cmdResp.ok) return res.status(404).json({ error: 'Commande introuvable' })
    const cmd = await cmdResp.json()
    const cf = cmd.fields || {}
    const societeId = linkedRecordId(cf['Societé'] || cf['Société'])
    const commId = linkedRecordId(cf['Commerciaux'] || cf['Commercial affecté'])
    const numDossier = cf['Numero de dossier'] || cf['ID Commande'] || id.slice(-8).toUpperCase()
    const dateCommande = cf['Date commande'] || '—'
    let commNom = '—'
    if (commId) {
      const commResp = await fetch(`${ATBASE}/${encodeURIComponent('Commerciaux')}/${commId}`, { headers: headers() })
      if (commResp.ok) {
        const commData = await commResp.json()
        commNom = commData.fields?.['Nom'] || commData.fields?.['Nom complet'] || '—'
      }
    }

    const [socData] = await Promise.all([
      societeId ? fetch(`${ATBASE}/${encodeURIComponent('Sociétés')}/${societeId}`, { headers: headers() }).then(r => r.json()).catch(() => ({ fields: {} })) : Promise.resolve({ fields: {} }),
    ])

    const socEmail = socData.fields?.['Email'] || ''
    const socNom = socData.fields?.['Raison sociale'] || socData.fields?.['Nom'] || 'votre société'

    if (!socEmail) {
      return res.status(400).json({ error: 'Aucune adresse email pour le client exposant' })
    }

    const invoiceData = await buildInvoiceData(id)
    const pdf = await generateInvoicePDF(invoiceData)
    const filename = `${invoiceSafeFilename(invoiceData.invoiceNumber)}.pdf`
    const totalTTC = Number(String(invoiceData.financial?.totalTTC || invoiceData.financial?.netAPayer || 0).replace(/[^0-9.,-]/g,'').replace(',','.')) || 0
    const encaisse = Number(String(invoiceData.financial?.montantEncaisse || 0).replace(/[^0-9.,-]/g,'').replace(',','.')) || 0
    const reste = Math.max(0, totalTTC - encaisse)

    const pIds = cf['Paiements'] || []
    const paiements = []
    for (const pid of pIds) {
      try {
        const pRes = await fetch(`${ATBASE}/${encodeURIComponent('Paiements')}/${pid}`, { headers: headers() })
        if (pRes.ok) {
          const pd = (await pRes.json()).fields || {}
          const m = Number(String(pd['Montant payé'] || pd['Montant'] || 0).replace(/[^0-9.,-]/g,'').replace(',','.')) || 0
          if (m > 0) paiements.push({ montant: m, date: pd['Date paiement'] || pd['Date'] || '', mode: pd['Mode de paiement'] || '—', valide: pd['Validé par M. Hery'] === true })
        }
      } catch(e) { /* non bloquant */ }
    }
    paiements.sort((a, b) => String(b.date).localeCompare(String(a.date)))
    const lastPay = paiements[0]

    const result = await mailer(
      socEmail,
      `Facture Madavision — ${socNom}`,
      emailWrapper(`
        <h2 style="color:#1B2A4A;font-size:18px;margin:0 0 14px">Votre facture Madavision</h2>
        <p>Bonjour ${escapeHtml(socNom)},</p>
        <p>Veuillez trouver ci-joint la facture pour votre participation à l evenement.</p>
        <div style="background:#EEF2F8;border-radius:10px;padding:18px;margin:18px 0">
          <div style="font-size:16px;font-weight:700;color:#1B2A4A">${totalTTC.toLocaleString('fr-FR')} Ar TTC</div>
          ${encaisse > 0 ? `<div style="font-size:13px;color:#16a34a;margin-top:6px">Déjà encaissé : ${encaisse.toLocaleString('fr-FR')} Ar</div>` : ''}
          ${reste > 0 ? `<div style="font-size:13px;color:#b45309;margin-top:4px">Reste à payer : ${reste.toLocaleString('fr-FR')} Ar</div>` : `<div style="font-size:13px;color:#16a34a;margin-top:4px">✓ Solde</div>`}
        </div>
        <div style="background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:14px;margin:14px 0;font-size:13px;color:#374151;line-height:1.7">
          <div><strong>Dossier :</strong> ${escapeHtml(numDossier)}</div>
          <div><strong>Date commande :</strong> ${escapeHtml(dateCommande)}</div>
          ${lastPay ? `<div><strong>Dernier paiement :</strong> ${escapeHtml(lastPay.date || '—')} — ${escapeHtml(lastPay.montant.toLocaleString('fr-FR'))} Ar (${escapeHtml(lastPay.mode)})${lastPay.valide ? ' ✓ Validé' : ''}</div>` : '<div><strong>Aucun paiement enregistré</strong></div>'}
        </div>
        <p style="font-size:13px;color:#5C5649">Commercial assigné : <strong>${escapeHtml(commNom)}</strong></p>
        <p style="font-size:12px;color:#9B9183;margin-top:16px">PDF en pièce jointe.</p>
      `),
      {
        attachments: [{
          filename,
          content: pdf,
          contentType: 'application/pdf',
        }],
      }
    )

    res.json({ success: true, emailSent: result.sent, to: socEmail, emailNote: result.error || null })
  } catch(e) {
    console.error('[sonia/email-invoice]', e.message)
    res.status(500).json({ error: e.message })
  }
})

// POST /api/sonia/cancel-request/:id — demande d'annulation envoyée à l'administration
router.post('/cancel-request/:id', requireSonia, async (req, res) => {
  try {
    const id = req.params.id
    const { raison } = req.body || {}
    if (!raison || !String(raison).trim()) {
      return res.status(400).json({ error: "Motif d'annulation requis" })
    }

    const cmdRes = await fetch(`${ATBASE}/${encodeURIComponent('Commandes')}/${id}`, { headers: headers() })
    if (!cmdRes.ok) return res.status(404).json({ error: 'Commande introuvable' })
    const cmd = await cmdRes.json()
    const cf = cmd.fields || {}

    const societeId = (cf['Societé'] || cf['Société'] || [])[0]
    let socData = null
    if (societeId) {
      const socRes = await fetch(`${ATBASE}/${encodeURIComponent('Sociétés')}/${societeId}`, { headers: headers() })
      if (socRes.ok) socData = await socRes.json()
    }
    const sf = socData?.fields || {}

    const commercialId = (sf['Commerciaux'] || [])[0]
    let commData = null
    if (commercialId) {
      const commRes = await fetch(`${ATBASE}/${encodeURIComponent('Commerciaux')}/${commercialId}`, { headers: headers() })
      if (commRes.ok) commData = await commRes.json()
    }
    const commFields = commData?.fields || {}

    const socNom = sf['Raison sociale'] || sf['Nom'] || 'Société non renseignée'
    const numDossier = cf['Numero de dossier'] || cf['ID Commande'] || id.slice(-8).toUpperCase()
    const commercialNom = commFields['Nom'] || commFields['Nom complet'] || req.soniaEmail
    const commercialEmail = commFields['Email'] || commFields['Email professionnel'] || commFields['Mail'] || req.soniaEmail

    const result = await mailer(
      EMAIL_CONFIG.fromAddress,
      `Demande d'annulation dossier — ${socNom}`,
      emailWrapper(`
        <h2 style="color:#1B2A4A;font-size:18px;margin:0 0 14px">Demande d'annulation de commande</h2>
        <p>Une demande d'annulation a été envoyée depuis l'espace commercial.</p>
        <div style="background:#F5F7FA;border-radius:10px;padding:18px;margin:18px 0">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:#7A8891;margin-bottom:4px">Société</div>
          <div style="font-size:16px;font-weight:700;color:#1B2A4A;margin-bottom:10px">${escapeHtml(socNom)}</div>
          <div style="font-size:12px;color:#5C5649"><strong>N° dossier :</strong> ${escapeHtml(numDossier)}</div>
          <div style="font-size:12px;color:#5C5649"><strong>Commande :</strong> ${escapeHtml(id)}</div>
          <div style="font-size:12px;color:#5C5649"><strong>Commercial :</strong> ${escapeHtml(commercialNom)} ${commercialEmail ? `(${escapeHtml(commercialEmail)})` : ''}</div>
        </div>
        <div style="background:#FFF0F0;border-left:3px solid #C0392B;padding:14px 18px;border-radius:0 8px 8px 0">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:#C0392B;margin-bottom:6px">Motif indiqué</div>
          <div style="font-size:13px;color:#1B2A4A;font-style:italic">${escapeHtml(raison)}</div>
        </div>
      `, '#7A1E2C', '#C0392B')
    )

    res.json({ success: true, emailSent: result.sent, emailNote: result.error || null })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/sonia/rejeter/:id — rejeter une commande
router.post('/rejeter/:id', requireSonia, async (req, res) => {
  try {
    const id     = req.params.id
    const { raison, commercialId, societeId } = req.body || {}

    console.log(`[Sonia] Rejet de la commande ${id}. Motif: ${raison}`)

    const r = await fetch(`${ATBASE}/${encodeURIComponent('Commandes')}/${id}`, {
      method: 'PATCH', headers: { ...headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: {
        'Validation':  'Rejeté',
        'Motif rejet': raison,
        'Date rejet':  new Date().toISOString().slice(0, 10),
      }}),
    })

    if (!r.ok) {
      const errData = await r.json().catch(() => ({}))
      return res.status(500).json({ error: `Erreur Airtable: ${errData.error?.message || r.status}` })
    }

    await notifyCommercialStatus(id, 'Rejeté', commercialId, societeId, req.soniaEmail, raison)

    res.json({ success: true })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

// Helper pour alerter le commercial lors d'un changement de statut du dossier
// Optimisé : Récupère les infos manquantes et inclut le motif du rejet/annulation
async function notifyCommercialStatus(cmdId, status, commercialId, societeId, soniaEmail, reason = null) {
  if (!mailTransporter) return
  try {
    let cid = commercialId
    let sid = societeId

    // Si IDs manquants (sécurité), on les récupère depuis Airtable
    if (!cid || !sid) {
      const cmdRaw = await fetch(`${ATBASE}/${encodeURIComponent('Commandes')}/${cmdId}`, { headers: headers() }).then(r => r.json())
      sid = sid || cmdRaw.fields?.['Societé']?.[0] || cmdRaw.fields?.['Société']?.[0]
      cid = cid || cmdRaw.fields?.['Commercial (from Societé)']?.[0] || cmdRaw.fields?.['Commercial (from Société)']?.[0]
    }
    if (!cid || !sid) return // Pas de commercial assigné, pas de notification

    const [commData, socData, cmdData] = await Promise.all([
      fetch(`${ATBASE}/${encodeURIComponent('Commerciaux')}/${cid}`, { headers: headers() }).then(r => r.json()),
      fetch(`${ATBASE}/${encodeURIComponent('Sociétés')}/${sid}`, { headers: headers() }).then(r => r.json()),
      fetch(`${ATBASE}/${encodeURIComponent('Commandes')}/${cmdId}`, { headers: headers() }).then(r => r.json())
    ])

    const commEmail = commData.fields?.['Email'] || commData.fields?.['Email professionnel'] || commData.fields?.['Mail'] || null
    if (!commEmail) return

    const socNom = socData.fields?.['Raison sociale'] || 'une société'
    const numDossier = cmdData.fields?.['Numero de dossier'] || cmdData.fields?.['ID Commande'] || cmdId.slice(-8).toUpperCase()
    const frontendBase = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '')

    const statusLabels = {
      'Validé':    { txt: 'VALIDÉ',    color: '#1E7F54' },
      'Rejeté':    { txt: 'REJETÉ',    color: '#C0392B' },
      'Annulé':    { txt: 'ANNULÉ',    color: '#7A8891' },
      'A valider': { txt: 'REMIS EN ATTENTE', color: '#C87B2F' }
    }
    const st = statusLabels[status] || { txt: status.toUpperCase(), color: '#1B2A4A' }

    // Section Motif (uniquement pour Rejeté ou Annulé)
    const reasonSection = (reason && (status === 'Rejeté' || status === 'Annulé'))
      ? `<div style="margin-top:12px;padding:12px;background:#FFF0F0;border-radius:6px;border:1px solid #FFDada;">
           <div style="font-size:10px;text-transform:uppercase;color:#C0392B;font-weight:bold;margin-bottom:4px">Motif indiqué :</div>
           <div style="font-size:13px;color:#1B2A4A;font-style:italic;">"${escapeHtml(reason)}"</div>
         </div>`
      : ''

    await mailer(
      commEmail,
      `Mise à jour dossier : ${socNom} — [${st.txt}]`,
      emailWrapper(`
        <h2 style="color:#1B2A4A;font-size:18px;margin:0 0 14px">Mise à jour du statut d'un dossier</h2>
        <p>Bonjour <strong>${escapeHtml(commData.fields?.['Nom'] || 'Commercial')}</strong>,</p>
        <p>Le statut du dossier suivant a été modifié par l'Administration :</p>
        <div style="background:#F5F7FA;border-radius:10px;padding:20px;margin:18px 0">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:#7A8891;margin-bottom:4px">Société</div>
          <div style="font-size:16px;font-weight:700;color:#1B2A4A;margin-bottom:12px">${escapeHtml(socNom)}</div>
          <div style="font-size:10px;text-transform:uppercase;color:#7A8891">N° Dossier : <span style="font-family:monospace;font-weight:700;color:#1B2A4A">${escapeHtml(numDossier)}</span></div>
          <div style="font-size:10px;text-transform:uppercase;color:#7A8891;margin-top:8px">Nouveau Statut : <span style="font-weight:700;color:${st.color}">${st.txt}</span></div>
          ${reasonSection}
        </div>
        <p style="font-size:13px;color:#5C5649">Connectez-vous à votre espace pour effectuer le suivi nécessaire.</p>
        <div style="margin-top:24px"><a href="${frontendBase}/commercial" style="background:#1B2A4A;color:#fff;text-decoration:none;padding:10px 22px;border-radius:8px;display:inline-block;font-weight:600;font-size:13px">→ Accéder à l'espace commercial</a></div>
      `)
    )
  } catch(e) { console.warn('[notifyCommercialStatus] Error:', e.message) }
}

// POST /api/sonia/assigner/:cmdId — assigner un commercial à la Société d'une commande
// → met à jour Sociétés.Commercial affecté (traite toutes les commandes de cette société)
router.post('/assigner/:cmdId', requireSonia, async (req, res) => {
  try {
    const { commercialId, societeId } = req.body
    if (!commercialId) return res.status(400).json({ error: 'commercialId requis' })

    // Résoudre l'ID Société : soit fourni dans le body, soit récupéré via la commande
    let socId = societeId
    if (!socId) {
      const cmdRes = await fetch(`${ATBASE}/${encodeURIComponent('Commandes')}/${req.params.cmdId}`, { headers: headers() }).then(r => r.json())
      const socIds = cmdRes.fields?.['Societé'] || cmdRes.fields?.['Société'] || []
      socId = Array.isArray(socIds) ? socIds[0] : null
    }

    if (!socId) {
      // Dernier fallback : chercher dans Participations
      const { participationId } = req.body
      if (participationId) {
        const pRes = await fetch(`${ATBASE}/${encodeURIComponent('Participations')}/${participationId}`, { headers: headers() }).then(r => r.json())
        const pSocIds = pRes.fields?.['Société'] || []
        socId = Array.isArray(pSocIds) ? pSocIds[0] : null
      }
    }

    if (!socId) return res.status(400).json({ error: 'Société introuvable pour cette commande. Vérifiez le champ Societé.' })

    // ── Assigner le commercial dans la table Sociétés ────────────────
    // Cela affecte TOUTES les commandes de cette société (via le lookup Commandes → Societé → Commercial)
    const patchRes = await fetch(`${ATBASE}/${encodeURIComponent('Sociétés')}/${socId}`, {
      method:  'PATCH',
      headers: { ...headers(), 'Content-Type': 'application/json' },
      body:    JSON.stringify({ fields: { 'Commerciaux': [commercialId] } }),
    })
    const patchData = await patchRes.json()
    if (!patchRes.ok) {
      console.error(`❌ [Sonia] Erreur assignation directe: ${patchData.error?.message}`)
      return res.status(500).json({ error: `Airtable Sociétés: ${patchData.error?.message || 'Erreur'}` })
    }

    console.log(`✓ [Sonia] Commercial ${commercialId} assigné à Société ${socId} par ${req.soniaEmail}`)

    // ── Email d'alerte au commercial ─────────────────────────────────
    const frontendBase = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '')
    let emailSent = false, emailNote = null
    try {
      const [commData, socData] = await Promise.all([
        fetch(`${ATBASE}/${encodeURIComponent('Commerciaux')}/${commercialId}`, { headers: headers() }).then(r => r.ok ? r.json() : { fields: {} }),
        fetch(`${ATBASE}/${encodeURIComponent('Sociétés')}/${socId}`, { headers: headers() }).then(r => r.json()),
      ])
      const commEmail = commData.fields?.['Email'] || commData.fields?.['Email professionnel'] || commData.fields?.['Mail'] || null
      if (!commEmail) {
        emailNote = 'Champ Email manquant dans Airtable (Commerciaux)'
        console.warn(`[assigner] Aucune adresse email pour le commercial ${commercialId}`)
      } else {
        const socNom = socData.fields?.['Raison sociale'] || socData.fields?.['Nom'] || 'une société'
        const result = await mailer(
          commEmail,
          `Nouveau dossier assigné — ${socNom}`,
          emailHtmlCommercialAlert({
            commNom:    commData.fields?.['Nom'] || commData.fields?.['Prénom Nom'] || commData.fields?.['Nom complet'] || commData.fields?.['Name'] || 'Commercial',
            socNom,
            socEmail:   socData.fields?.['Email'] || '',
            socTel:     socData.fields?.['Téléphone'] || '',
            assignedBy: req.soniaEmail,
            frontendBase,
          })
        )
        emailSent = result.sent
        emailNote = result.error || null
      }
    } catch (emailErr) {
      emailNote = emailErr.message
      console.warn(`[assigner] Erreur préparation email : ${emailErr.message}`)
    }

    res.json({ success: true, societeId: socId, emailSent, emailNote })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/sonia/resend-alert — renvoyer l'email d'alerte au commercial d'une société
router.post('/resend-alert', requireSonia, async (req, res) => {
  try {
    const { commercialId, societeId } = req.body
    if (!commercialId || !societeId) return res.status(400).json({ error: 'commercialId et societeId requis' })

    const [commData, socData] = await Promise.all([
      fetch(`${ATBASE}/${encodeURIComponent('Commerciaux')}/${commercialId}`, { headers: headers() }).then(r => r.json()),
      fetch(`${ATBASE}/${encodeURIComponent('Sociétés')}/${societeId}`, { headers: headers() }).then(r => r.json()),
    ])

    const commEmail = commData.fields?.['Email'] || commData.fields?.['Email professionnel'] || commData.fields?.['Mail'] || null
    if (!commEmail) return res.status(400).json({ error: 'Aucune adresse email pour ce commercial dans Airtable' })

    const frontendBase = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '')
    const socNom = socData.fields?.['Raison sociale'] || socData.fields?.['Nom'] || 'une société'

    const result = await mailer(
      commEmail,
      `Rappel dossier assigné — ${socNom}`,
      emailHtmlCommercialAlert({
        commNom:    commData.fields?.['Nom'] || commData.fields?.['Nom complet'] || 'Commercial',
        socNom,
        socEmail:   socData.fields?.['Email'] || '',
        socTel:     socData.fields?.['Téléphone'] || '',
        assignedBy: req.soniaEmail,
        frontendBase,
      })
    )

    if (!result.sent) return res.status(500).json({ error: result.error || 'Envoi SMTP échoué' })
    res.json({ success: true, emailSent: true, to: commEmail })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/sonia/notify-exposant/:id — notifier l'exposant qu'un commercial est assigné
router.post('/notify-exposant/:id', requireSonia, async (req, res) => {
  try {
    const { id } = req.params
    const frontendBase = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '')

    // Récupérer la commande et la société
    const cmdRes = await fetch(`${ATBASE}/${encodeURIComponent('Commandes')}/${id}`, { headers: headers() }).then(r => r.json())
    const cmdFields = cmdRes.fields || {}
    const socIds = cmdFields['Societé'] || cmdFields['Société'] || []
    const socId = Array.isArray(socIds) ? socIds[0] : null
    const commIds = cmdFields['Commerciaux'] || cmdFields['Commercial affecté'] || []
    const commId = Array.isArray(commIds) ? commIds[0] : null

    if (!socId) return res.status(400).json({ error: 'Société introuvable pour cette commande' })

    const [socData, commData] = await Promise.all([
      fetch(`${ATBASE}/${encodeURIComponent('Sociétés')}/${socId}`, { headers: headers() }).then(r => r.json()),
      commId ? fetch(`${ATBASE}/${encodeURIComponent('Commerciaux')}/${commId}`, { headers: headers() }).then(r => r.ok ? r.json() : { fields: {} }).catch(() => ({ fields: {} })) : Promise.resolve({ fields: {} }),
    ])

    const socEmail = socData.fields?.['Email'] || ''
    const socNom   = socData.fields?.['Raison sociale'] || socData.fields?.['Nom'] || 'votre société'
    const commNom  = commData.fields?.['Nom'] || commData.fields?.['Nom complet'] || commData.fields?.['Prénom Nom'] || commData.fields?.['Name'] || 'votre commercial'
    const commEmail = commData.fields?.['Email'] || commData.fields?.['Email professionnel'] || ''
    const commTel   = commData.fields?.['Téléphone'] || ''
    const numDossier = cmdFields['Numero de dossier'] || cmdFields['ID Commande'] || id.slice(-8).toUpperCase()

    if (!socEmail) return res.status(400).json({ error: 'Aucune adresse email pour le client exposant' })

    const result = await mailer(
      socEmail,
      `Commercial assigné à votre dossier — Madavision`,
      emailWrapper(`
        <h2 style="color:#1B2A4A;font-size:18px;margin:0 0 14px">Un commercial vous suit désormais</h2>
        <p>Bonjour,</p>
        <p>Nous vous informons qu'un commercial a été assigné à votre dossier d'inscription pour la FIM 2026.</p>
        <div style="background:#EEF2F8;border-left:3px solid #2260A7;padding:14px 18px;border-radius:0 8px 8px 0;margin:18px 0">
          <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#2260A7;margin-bottom:8px">Commercial assigné à votre dossier</div>
          <div style="font-size:16px;font-weight:700;color:#1B2A4A">${escapeHtml(commNom)}</div>
          ${commEmail ? `<div style="font-size:13px;color:#374151;margin-top:4px">📧 ${escapeHtml(commEmail)}</div>` : ''}
          ${commTel ? `<div style="font-size:13px;color:#374151;margin-top:2px">📞 ${escapeHtml(commTel)}</div>` : ''}
          <div style="font-size:12px;color:#5C5649;margin-top:6px">Dossier : <strong>${escapeHtml(numDossier)}</strong></div>
        </div>
        <p style="font-size:13px;color:#5C5649">
          Il/elle va prendre contact avec vous pour vous accompagner dans les étapes suivantes :<br/>
          • Confirmation de votre réservation de stand<br/>
          • Règlement de l'acompte (50%)<br/>
          • Suivi de votre dossier jusqu'à l'événement
        </p>
        <div style="margin-top:24px">
          <a href="${frontendBase}/exposant" style="background:#1B2A4A;color:#fff;text-decoration:none;padding:10px 22px;border-radius:8px;display:inline-block;font-weight:600;font-size:13px">Accéder à mon espace exposant</a>
        </div>
      `)
    )

    res.json({ success: true, emailSent: result.sent, to: socEmail })
  } catch(e) {
    console.error('[notify-exposant] error:', e.message)
    res.status(500).json({ error: e.message })
  }
})

module.exports = router
