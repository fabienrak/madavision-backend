const express = require('express')
const router  = express.Router()

const { DEBUG, EMAIL_CONFIG } = require('../config')
const { ATBASE, headers, atGet, atPost, atFind } = require('../lib/airtable')
const { requireRole, findCommercialByEmail } = require('../lib/auth')
const { mailer, emailWrapper, escapeHtml, mailTransporter } = require('../lib/email')
const {
  fmtMoney,
  linkedRecordId,
  invoiceLinkedIds,
  invoiceFetchRecord,
  buildInvoiceData,
  generateInvoicePDF,
  invoiceSafeFilename,
  generateBadgesInvitationsPDF,
  getCommercialSocietes,
  resolveEditionAndSalon,
  fetchBilanPuissance,
  paymentCalendarFields,
  patchCommandeFields,
  paymentCalendarPayload,
  invoiceMoney,
} = require('../lib/pdf')
const { requireCommercial } = require('../middleware/auth')

const otpStoreCommercial = {}  // { email: { code, expires, commercialId } }

// POST /api/commercial/send-otp — OTP commercial basé sur la table Commerciaux
router.post('/send-otp', async (req, res) => {
  try {
    const email = (req.body.email || '').trim().toLowerCase()
    if (!email) return res.status(400).json({ error: 'Email requis' })

    const commercial = await findCommercialByEmail(email)
    if (!commercial) return res.status(403).json({ error: 'Aucun commercial actif trouvé pour cet email.' })

    const code = String(Math.floor(100000 + Math.random() * 900000))
    const expires = Date.now() + 10 * 60 * 1000
    otpStoreCommercial[email] = { code, expires, commercialId: commercial.id }

    if (mailTransporter) {
      await mailTransporter.sendMail({
        from: `"${EMAIL_CONFIG.fromName}" <${EMAIL_CONFIG.fromAddress}>`,
        to: email,
        subject: 'Code de connexion — Espace Commercial',
        html: `
          <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto">
            <h2 style="color:#1B2A4A">Connexion à l'espace commercial</h2>
            <p>Votre code de connexion est :</p>
            <div style="font-size:36px;font-weight:700;letter-spacing:8px;color:#2260A7;padding:20px;background:#EEF2F8;border-radius:8px;text-align:center">${code}</div>
            <p style="color:#7A8891;font-size:13px;margin-top:16px">Ce code expire dans <strong>10 minutes</strong>. Ne le partagez pas.</p>
          </div>`,
      })
    } else {
      console.log(`[COMMERCIAL OTP] ${email} → ${code}`)
    }

    res.json({ success: true, dev: !mailTransporter ? code : undefined })
  } catch(e) {
    console.error('[commercial/send-otp]', e.message)
    res.status(500).json({ error: 'Erreur envoi OTP commercial' })
  }
})

// POST /api/commercial/verify-otp
router.post('/verify-otp', (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase()
  const code = (req.body.code || req.body.otp || '').trim()
  if (!email || !code) return res.status(400).json({ error: 'Email et code requis.' })

  const stored = otpStoreCommercial[email]
  if (!stored) return res.status(400).json({ error: 'Aucun code envoyé pour cet email.' })
  if (Date.now() > stored.expires) {
    delete otpStoreCommercial[email]
    return res.status(400).json({ error: 'Code expiré. Demandez un nouveau code.' })
  }
  if (stored.code !== code) return res.status(400).json({ error: 'Code incorrect.' })

  delete otpStoreCommercial[email]
  const session = Buffer.from(JSON.stringify({
    role: 'commercial',
    email,
    commercialId: stored.commercialId,
    exp: Date.now() + 8 * 60 * 60 * 1000,
  })).toString('base64')
  res.json({ success: true, token: session, email })
})

// GET /api/commercial/dossiers — dossiers limités au commercial connecté
router.get('/dossiers', requireCommercial, async (req, res) => {
  try {
    const filtre = req.query.statut || 'tous'
    const commercial = await findCommercialByEmail(req.commercialEmail)
    const societeMap = await getCommercialSocietes(req.commercialId)
    const allowedSocieteIds = new Set(Object.keys(societeMap))

    if (allowedSocieteIds.size === 0) {
      return res.json({ dossiers: [], commerciaux: commercial ? [commercial] : [], currentCommercial: commercial })
    }

    const [records, paiementsResp] = await Promise.all([
      atGet('Commandes', `sort%5B0%5D%5Bfield%5D=${encodeURIComponent('Date commande')}&sort%5B0%5D%5Bdirection%5D=desc&maxRecords=200`),
      fetch(`${ATBASE}/${encodeURIComponent('Paiements')}?maxRecords=500&sort%5B0%5D%5Bfield%5D=Date+paiement&sort%5B0%5D%5Bdirection%5D=desc`, { headers: headers() }).then(r => r.json()).catch(() => ({ records: [] })),
    ])

    const filteredRecords = records.filter(r => {
      const f = r.fields || {}
      const societeId = linkedRecordId(f['Societé'] || f['Société'])
      if (!allowedSocieteIds.has(societeId)) return false
      if (filtre !== 'tous' && (f['Validation'] || '—') !== filtre) return false
      return true
    })

    const parseMGA = v => parseFloat(String(v || 0).replace(/[^0-9.,]/g, '').replace(',', '.')) || 0
    const paiementsMap = {}
    ;(paiementsResp.records || []).forEach(r => {
      const f = r.fields || {}
      const cIds = Array.isArray(f['Commande']) ? f['Commande'] : (f['Commande'] ? [f['Commande']] : [])
      cIds.forEach(cId => {
        if (!paiementsMap[cId]) paiementsMap[cId] = []
        paiementsMap[cId].push({
          id: r.id,
          montant: parseMGA(f['Montant'] || f['Montant payé']),
          mode: f['Mode paiement'] || f['Mode'] || f['Mode de paiement'] || '—',
          date: f['Date'] || f['Date paiement'] || '',
          statut: f['Statut'] || 'En attente',
          notes: f['Notes'] || '',
          valide: (f['Statut'] || '') === 'Validé' || f['Validé par M. Hery'] === true,
        })
      })
    })

    const standIds = new Set()
    const activityIds = new Set()
    const salonIds = new Set()
    const editionIds = new Set()
    const activityMap = {}
    const editionMap = {}

    filteredRecords.forEach(r => {
      const f = r.fields || {}
      invoiceLinkedIds(f['Stand ou service commandé']).forEach(id => standIds.add(id))
      invoiceLinkedIds(f['Activités optionnelles']).forEach(id => activityIds.add(id))
      invoiceLinkedIds(f['Salons'] || f['Salon'] || f['Édition'] || f['Edition']).forEach(id => {
        editionIds.add(id)
        salonIds.add(id)
      })
    })

    const standMap = {}
    if (standIds.size > 0) {
      const ids = [...standIds]
      const fmla = ids.length === 1 ? `RECORD_ID()="${ids[0]}"` : `OR(${ids.map(id => `RECORD_ID()="${id}"`).join(',')})`
      const stResp = await fetch(`${ATBASE}/${encodeURIComponent('Stands')}?filterByFormula=${encodeURIComponent(fmla)}`, { headers: headers() }).then(r => r.json()).catch(() => ({ records: [] }))
      ;(stResp.records || []).forEach(r => {
        const f = r.fields || {}
        const editionId = linkedRecordId(f['Edition'] || f['Edition'])
        const salonId = linkedRecordId(f['Editions'] || f['Éditions'] || f['Salon'] || f['Salons'])
        if (editionId) editionIds.add(editionId)
        if (salonId) salonIds.add(salonId)
        standMap[r.id] = {
          label: f['ID Stand'] || f['Numéro stand'] || f['Spécificités'] || r.id,
          editionId,
          salonId,
        }
      })
    }

    // ── Fetch Activités en batch ─────────────────────────────────────
    if (activityIds.size > 0) {
      try {
        const ids = [...activityIds]
        const fmla = ids.length === 1 ? `RECORD_ID()="${ids[0]}"` : `OR(${ids.map(id => `RECORD_ID()="${id}"`).join(',')})`
        const actResp = await fetch(`${ATBASE}/${encodeURIComponent('Activités optionnelles')}?filterByFormula=${encodeURIComponent(fmla)}`, { headers: headers() }).then(r => r.json())
        ;(actResp.records || []).forEach(r => {
          const f = r.fields
          activityMap[r.id] = {
            prix: parseFloat(String(f['Prix unitaire'] || 0).replace(/[^0-9.,]/g, '').replace(',', '.')) || 0
          }
        })
      } catch(e) { console.warn('[commercial] batch activities failed:', e.message) }
    }

    // const editionMap = {}
    if (editionIds.size > 0) {
      const ids = [...editionIds]
      const fmla = ids.length === 1 ? `RECORD_ID()="${ids[0]}"` : `OR(${ids.map(id => `RECORD_ID()="${id}"`).join(',')})`
      const edResp = await fetch(`${ATBASE}/${encodeURIComponent('Éditions')}?filterByFormula=${encodeURIComponent(fmla)}`, { headers: headers() }).then(r => r.json()).catch(() => ({ records: [] }))
      ;(edResp.records || []).forEach(r => {
        const f = r.fields || {}
        const salonId = linkedRecordId(f['Salon'] || f['Salons'] || f['Salon lié'] || f['ID Salon'])
        if (salonId) salonIds.add(salonId)
        editionMap[r.id] = {
          id: r.id,
          nom: f['Nom édition'] || (f['Année'] ? `Édition ${f['Année']}` : r.id),
          annee: f['Année'] || '',
          lieu: f['Lieu'] || '',
          dateDebut: f['Date début'] || '',
          dateFin: f['Date fin'] || '',
          salonId,
        }
      })
    }

    // ── Fetch Activités en batch ─────────────────────────────────────
    // const activityMap = {}
    if (activityIds.size > 0) {
      try {
        const ids = [...activityIds]
        const fmla = ids.length === 1 ? `RECORD_ID()="${ids[0]}"` : `OR(${ids.map(id => `RECORD_ID()="${id}"`).join(',')})`
        const actResp = await fetch(`${ATBASE}/${encodeURIComponent('Activités optionnelles')}?filterByFormula=${encodeURIComponent(fmla)}`, { headers: headers() }).then(r => r.json())
        ;(actResp.records || []).forEach(r => {
          const f = r.fields
          activityMap[r.id] = {
            prix: parseFloat(String(f['Prix unitaire'] || 0).replace(/[^0-9.,]/g, '').replace(',', '.')) || 0
          }
        })
      } catch(e) { console.warn('[sonia] batch activities failed:', e.message) }
    }

    const salonMap = {}
    if (salonIds.size > 0) {
      const ids = [...salonIds]
      const fmla = ids.length === 1 ? `RECORD_ID()="${ids[0]}"` : `OR(${ids.map(id => `RECORD_ID()="${id}"`).join(',')})`
      const salonsResp = await fetch(`${ATBASE}/${encodeURIComponent('Salons')}?filterByFormula=${encodeURIComponent(fmla)}`, { headers: headers() }).then(r => r.json()).catch(() => ({ records: [] }))
      ;(salonsResp.records || []).forEach(r => {
        const f = r.fields || {}
        salonMap[r.id] = {
          id: r.id,
          nom: f['Nom du salon'] || f['Nom'] || f['Name'] || f['ID Salon'] || r.id,
          lieu: f['Lieu'] || f['Ville'] || '',
        }
      })
    }

    const dossiers = filteredRecords.map(r => {
      const f = r.fields || {}
      const societeId = linkedRecordId(f['Societé'] || f['Société'])
      const societe = societeMap[societeId]
      const stLinkedIds = f['Stand ou service commandé'] || f['Stand'] || []
      const fallbackStand = Array.isArray(stLinkedIds)
        ? stLinkedIds.map(id => standMap[id]).find(Boolean)
        : null
      const standsLabel = (Array.isArray(stLinkedIds) && stLinkedIds.length > 0 && String(stLinkedIds[0]).startsWith('rec'))
        ? stLinkedIds.map(id => standMap[id]?.label || id).join(', ')
        : (Array.isArray(stLinkedIds) ? stLinkedIds.join(', ') : String(stLinkedIds || '—'))
      const paiements = paiementsMap[r.id] || []
      const montantTotal = parseMGA(f['Total TTC'] || f['Net a payer'])
      const resteAPayer = parseMGA(f['Reste à payer'])
      const montantEncaisse = paiements.filter(p => p.valide).reduce((s, p) => s + p.montant, 0) || parseMGA(f['Montant encaissé'])
      const commandEditionId = linkedRecordId(f['Edition'] || f['Edition'])
      const editionId = commandEditionId || fallbackStand?.editionId || null
      const edition = editionId ? editionMap[editionId] : null
      const salonId = edition?.salonId || fallbackStand?.salonId || null
      const evenement = salonId ? salonMap[salonId] : null

      return {
        id: r.id,
        participationId: Array.isArray(f['Participation']) ? f['Participation'][0] : null,
        societeId,
        statut: f['Validation'] || '—',
        statutCommande: f['Statut commande'] || '—',
        dateCommande: f['Date commande'] || '',
        dateInscription: f['Date commande'] || '',
        commercialId: req.commercialId,
        commercial: commercial?.nom || null,
        editionId,
        edition,
        evenementId: evenement?.id || null,
        evenement,
        societe,
        commandes: [{ id: r.id, stand: standsLabel, montant: montantTotal, reste: resteAPayer, statut: f['Statut commande'] || '—' }],
        numDossier: f['Numero de dossier'] || f['ID Commande'] || r.id.slice(-8).toUpperCase(),
        montantTotal: montantTotal,
        resteAPayer,
        montantEncaisse,
        paiements,
        codePromo: f['Code promo'] || f['Code Promo'] || '',
        codeVoucher: f['Code voucher'] || f['Code Voucher'] || f['Voucher'] || '',
      }
    })

    res.json({ dossiers, commerciaux: commercial ? [commercial] : [], currentCommercial: commercial })
  } catch(e) {
    console.error('[commercial/dossiers]', e.message)
    res.status(500).json({ error: DEBUG ? e.message : 'Erreur de chargement des dossiers commerciaux' })
  }
})

// GET /api/commercial/dossier/:id — détail limité aux dossiers assignés
router.get('/dossier/:id', requireCommercial, async (req, res) => {
  try {
    const cmdId = req.params.id
    const cmdResp = await fetch(`${ATBASE}/${encodeURIComponent('Commandes')}/${cmdId}`, { headers: headers() })
    if (!cmdResp.ok) return res.status(404).json({ error: 'Commande introuvable' })
    const cmd = await cmdResp.json()
    const cf = cmd.fields || {}

    const societeId = linkedRecordId(cf['Societé'] || cf['Société'])
    const societeMap = await getCommercialSocietes(req.commercialId)
    if (!societeId || !societeMap[societeId]) {
      return res.status(403).json({ error: "Ce dossier n'est pas assigné à ce commercial." })
    }

    const socResp = await fetch(`${ATBASE}/${encodeURIComponent('Sociétés')}/${societeId}`, { headers: headers() })
    if (!socResp.ok) return res.status(404).json({ error: 'Société introuvable' })
    const soc = await socResp.json()
    const sf = soc.fields || {}

    const editionId = linkedRecordId(cf['Édition'] || cf['Edition'])
    let edition = null
    let evenement = null
    if (editionId) {
      const edRes = await fetch(`${ATBASE}/${encodeURIComponent('Éditions')}/${editionId}`, { headers: headers() })
      if (edRes.ok) {
        const edData = await edRes.json()
        const ef = edData.fields || {}
        const salonId = linkedRecordId(ef['Salon'] || ef['Salons'] || ef['Salon lié'] || ef['ID Salon'])
        edition = { id: edData.id, ...ef }
        if (salonId) {
          const salonRes = await fetch(`${ATBASE}/${encodeURIComponent('Salons')}/${salonId}`, { headers: headers() })
          if (salonRes.ok) {
            const salonData = await salonRes.json()
            const sfSalon = salonData.fields || {}
            evenement = {
              id: salonData.id,
              nom: sfSalon['Nom du salon'] || sfSalon['Nom'] || sfSalon['Name'] || sfSalon['ID Salon'] || salonData.id,
              lieu: sfSalon['Lieu'] || sfSalon['Ville'] || '',
            }
          }
        }
      }
    }

    const stands = []
    let fallbackEditionId = null
    let fallbackSalonId = null
    for (const standId of (cf['Stand ou service commandé'] || [])) {
      const standRes = await fetch(`${ATBASE}/${encodeURIComponent('Stands')}/${standId}`, { headers: headers() })
      if (!standRes.ok) continue
      const standFields = (await standRes.json()).fields || {}
      fallbackEditionId = fallbackEditionId || linkedRecordId(standFields['Édition'] || standFields['Edition'])
      fallbackSalonId = fallbackSalonId || linkedRecordId(standFields['Editions'] || standFields['Éditions'] || standFields['Salon'] || standFields['Salons'])
      stands.push({
        id: standId,
        label: standFields['ID Stand'] || standFields['Numéro stand'] || '—',
        surface: standFields['Dimension'] || '',
        prix: standFields['Prix'] || 0,
        type: standFields['Spécificités'] || 'Autres',
      })
    }
    if ((!edition || !evenement) && (fallbackEditionId || fallbackSalonId)) {
      const resolved = await resolveEditionAndSalon(edition ? null : fallbackEditionId, evenement ? null : fallbackSalonId)
      if (!edition) edition = resolved.edition
      if (!evenement) evenement = resolved.evenement
    }

    const optionalActivities = []
    for (const actId of (cf['Activités optionnelles'] || [])) {
      const actRes = await fetch(`${ATBASE}/${encodeURIComponent('Activités optionnelles')}/${actId}`, { headers: headers() })
      if (!actRes.ok) continue
      const actFields = (await actRes.json()).fields || {}
      optionalActivities.push({
        id: actId,
        label: actFields['Nom activité'] || actFields['Nom'] || '—',
        type: actFields['Type activité'] || '',
        description: actFields['Description / thème'] || '',
        prix: actFields['Prix unitaire'] || 0,
        dateCreneau: actFields['Date et créneau'] || '',
      })
    }

    const supplements = []
    const rawSupplements = cf['Suppléments'] || cf['Supplements'] || []
    if (Array.isArray(rawSupplements)) {
      rawSupplements.forEach(item => supplements.push({ label: item, prix: 0 }))
    } else if (rawSupplements) {
      supplements.push({ label: rawSupplements, prix: 0 })
    }

    const bilan = await fetchBilanPuissance(cmdId, cf)
    const paiements = []
    const paiementIds = Array.isArray(cf['Paiements']) ? cf['Paiements'] : []
    for (const paiementId of paiementIds) {
      try {
        const pRes = await fetch(`${ATBASE}/${encodeURIComponent('Paiements')}/${paiementId}`, { headers: headers() })
        if (!pRes.ok) continue
        const pFields = (await pRes.json()).fields || {}
        paiements.push({
          id: paiementId,
          montant: invoiceMoney(pFields['Montant payé'] || pFields['Montant']),
          mode: pFields['Mode de paiement'] || pFields['Mode paiement'] || pFields['Mode'] || '—',
          date: pFields['Date paiement'] || pFields['Date'] || '',
          reference: pFields['Référence'] || '',
          statut: pFields['Statut'] || 'En attente',
          notes: pFields['Notes'] || '',
          valide: pFields['Validé par M. Hery'] === true || (pFields['Statut'] || '') === 'Validé',
        })
      } catch (e) {
        console.warn('[commercial/dossier/:id] paiement fetch failed:', e.message)
      }
    }

    // RECALCUL SÉCURITÉ DETAIL (formules identiques à Airtable)
    // Les prix stands/activités sont déjà TTC (taxe incluse)
    // On extrait le HT à rebours pour calculer la taxe
    const totalHTStands = stands.reduce((sum, s) => sum + (Number(s.prix) || 0), 0)
    const totalHTActs = optionalActivities.reduce((sum, a) => sum + (Number(a.prix) || 0), 0)
    const montantTTC = totalHTStands + totalHTActs
    const tr = sf['Régime fiscal'] || sf['Regime fiscal'] || '0.2'
    const taxRate = String(tr).includes('20') ? 0.2 : String(tr).includes('8') ? 0.08 : parseFloat(tr) || 0
    const montantHT = taxRate > 0 ? Math.round(montantTTC / (1 + taxRate)) : montantTTC
    const montantTaxe = Math.round(montantHT * taxRate)
    const remise = cf['Montant remise promo'] || 0
    const voucher = cf['Montant voucher appliqué'] || 0
    const netAPayer = Math.max(0, montantTTC - remise - voucher)

    const commercial = await findCommercialByEmail(req.commercialEmail)
    res.json({
      commande: {
        id: cmd.id,
        numeroDossier: cf['Numero de dossier'] || cf['ID Commande'] || cmd.id.slice(-8).toUpperCase(),
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
        dateAcompte: cf['Date J+7'] || cf['Date acompte'],
        dateSolde: cf['Date 20J'] || cf['Date solde'],
        nbBadges: cf['Nombre badges'] || 0,
        nbInvitations: cf['Nombre invitations'] || 0,
        accesParkingVIP:     cf['Accès parking VIP'] || 0,
        notes:               cf['Notes'] || '',
        descriptionActivite: cf['Description activités'] || '',
      },
      societe: { ...sf, id: societeId, idEntreprise: sf['ID Entreprise'] || null },
      statutExposant: sf['Statut exposant (from Participations)'] || 'Exposant',
      edition,
      evenement,
      stands,
      optionalActivities,
      supplements,
      bilan,
      paiements,
      commercial,
    })
  } catch(e) {
    console.error('[commercial/dossier/:id]', e.message)
    res.status(500).json({ error: DEBUG ? e.message : 'Erreur de chargement du dossier commercial' })
  }
})

// POST /api/commercial/dossier/:id/paiement — déclaration de paiement par un commercial assigné
router.post('/dossier/:id/paiement', requireCommercial, async (req, res) => {
  try {
    const cmdId = req.params.id
    const data = req.body || {}

    const cmdResp = await fetch(`${ATBASE}/${encodeURIComponent('Commandes')}/${cmdId}`, { headers: headers() })
    if (!cmdResp.ok) return res.status(404).json({ error: 'Commande introuvable' })
    const cmd = await cmdResp.json()
    const cf = cmd.fields || {}

    const societeId = linkedRecordId(cf['Societé'] || cf['Société'])
    const societeMap = await getCommercialSocietes(req.commercialId)
    const societe = societeId ? societeMap[societeId] : null
    if (!societeId || !societe) {
      return res.status(403).json({ error: "Ce dossier n'est pas assigné à ce commercial." })
    }

    const montant = Number(data.montant)
    if (!montant || montant <= 0) return res.status(400).json({ error: 'Montant invalide' })
    if (!data.modePaiement) return res.status(400).json({ error: 'Mode de paiement requis' })

    const paiementFields = {
      'Commande': [cmdId],
      'Montant payé': montant,
      'Mode de paiement': data.modePaiement,
      'Date paiement': data.date || new Date().toISOString().slice(0, 10),
      'Statut': 'En attente',
    }

    const detailParts = []
    if (data.reference) {
      paiementFields['Référence'] = data.reference
      detailParts.push(`Réf: ${data.reference}`)
    }
    if (data.banque) detailParts.push(`Banque: ${data.banque}`)
    if (data.operateur) {
      paiementFields['Operateur mobile'] = data.operateur
      detailParts.push(`Opérateur: ${data.operateur}`)
    }
    if (data.numero) detailParts.push(`N°: ${data.numero}`)
    if (data.nomSurCheque) {
      paiementFields['Nom sur chèque'] = data.nomSurCheque
      detailParts.push(`Nom chèque: ${data.nomSurCheque}`)
    }
    detailParts.push(`Déclaré par commercial: ${req.commercialEmail}`)
    paiementFields['Notes'] = detailParts.join(' — ')

    const paiement = await atPost('Paiements', paiementFields)

    const commercial = await findCommercialByEmail(req.commercialEmail)
    const socNom = societe.nom || societe.raw?.['Raison sociale'] || '—'
    const socEmail = data.emailExposant || societe.email || societe.raw?.['Email'] || ''
    const numDossier = cf['Numero de dossier'] || cf['ID Commande'] || cmdId.slice(-8).toUpperCase()
    const paymentDate = data.date || new Date().toISOString().slice(0, 10)
    let emailSent = false

    if (mailTransporter) {
      const adminHtml = emailWrapper(`
        <h2 style="color:#195b98;font-size:18px;margin:0 0 14px">Nouvelle déclaration de paiement</h2>
        <p>Le commercial <strong>${escapeHtml(commercial?.nom || req.commercialEmail)}</strong> a déclaré un règlement pour <strong>${escapeHtml(socNom)}</strong>.</p>
        <div style="background:#F5F7FA;border-left:4px solid #195b98;padding:16px 20px;border-radius:0 12px 12px 0;margin:20px 0">
          <div style="font-size:13px;color:#687e7e;margin-bottom:4px">Montant déclaré</div>
          <div style="font-size:20px;font-weight:700;color:#195b98;font-family:monospace">${fmtMoney(montant)}</div>
          <div style="margin-top:12px;font-size:13px;color:#0d0d0d;line-height:1.6">
            <strong>Dossier :</strong> ${escapeHtml(numDossier)}<br/>
            <strong>Mode :</strong> ${escapeHtml(data.modePaiement)}<br/>
            <strong>Référence :</strong> ${escapeHtml(data.reference || '—')}<br/>
            ${data.banque ? `<strong>Banque :</strong> ${escapeHtml(data.banque)}<br/>` : ''}
            ${data.operateur ? `<strong>Opérateur :</strong> ${escapeHtml(data.operateur)}<br/>` : ''}
            <strong>Déclaré par :</strong> ${escapeHtml(req.commercialEmail)}
          </div>
        </div>
        <p style="font-size:13px;color:#687e7e">Action : Vérifier et valider le paiement dans Airtable → table <strong>Paiements</strong>.</p>
      `)

      const exhibHtml = emailWrapper(`
        <h2 style="color:#195b98;font-size:18px;margin:0 0 14px">Confirmation réception paiement</h2>
        <p>Bonjour,</p>
        <p>Nous avons bien enregistré une déclaration de paiement pour votre dossier.</p>
        <div style="background:#E8F7EF;border-left:4px solid #1E7F54;padding:16px 20px;border-radius:0 12px 12px 0;margin:20px 0">
          <div style="font-size:20px;font-weight:700;color:#1E7F54;font-family:monospace">${fmtMoney(montant)}</div>
          <div style="margin-top:12px;font-size:13px;color:#0d0d0d;line-height:1.6">
            <strong>Dossier :</strong> ${escapeHtml(numDossier)}<br/>
            <strong>Mode :</strong> ${escapeHtml(data.modePaiement)}<br/>
            <strong>Date :</strong> ${escapeHtml(paymentDate)}<br/>
            ${data.reference ? `<strong>Référence :</strong> ${escapeHtml(data.reference)}<br/>` : ''}
            <strong>Statut :</strong> <span style="color:#b45309">En attente de validation</span>
          </div>
        </div>
        <p style="font-size:13px;color:#687e7e;line-height:1.5">
          Notre équipe administrative va procéder à la vérification de la transaction.<br/>
          Le statut du règlement sera mis à jour dans votre espace exposant sous <strong>24–48h ouvrables</strong>.
        </p>
        <p style="font-size:13px;color:#687e7e">Merci de votre confiance.</p>
        <p style="font-size:13px;margin-top:20px">Cordialement,<br/><strong>L'Administration Madavision</strong></p>
      `)

      const adminMail = await mailer(EMAIL_CONFIG.fromAddress, `Déclaration paiement — ${socNom}`, adminHtml)
      if (commercial?.email || req.commercialEmail) {
        mailer(commercial?.email || req.commercialEmail, `[Suivi] Paiement déclaré — ${socNom}`, adminHtml).catch(() => {})
      }
      const exhibMail = socEmail
        ? await mailer(socEmail, 'Confirmation réception paiement — Madavision', exhibHtml)
        : { sent: false, error: 'no_recipient' }
      emailSent = Boolean(adminMail.sent || exhibMail.sent)
    }

    res.json({
      success: true,
      paiementId: paiement.id,
      emailSent,
      message: 'Paiement déclaré avec succès. Notre équipe validera sous 48h.',
    })
  } catch (e) {
    console.error('[commercial/paiement] error:', e.message)
    res.status(500).json({ error: DEBUG ? e.message : 'Erreur lors de la déclaration de paiement' })
  }
})

// POST /api/commercial/dossier/:id/payment-calendar — dates de paiement du dossier assigné
router.post('/dossier/:id/payment-calendar', requireCommercial, async (req, res) => {
  try {
    let fields
    try {
      fields = paymentCalendarFields(req.body, { includeValidation: false })
    } catch (e) {
      return res.status(400).json({ error: e.message })
    }

    const cmdId = req.params.id
    const cmdResp = await fetch(`${ATBASE}/${encodeURIComponent('Commandes')}/${cmdId}`, { headers: headers() })
    if (!cmdResp.ok) return res.status(404).json({ error: 'Commande introuvable' })
    const cmd = await cmdResp.json()
    const cf = cmd.fields || {}
    const societeId = linkedRecordId(cf['Societé'] || cf['Société'])
    const societeMap = await getCommercialSocietes(req.commercialId)
    if (!societeId || !societeMap[societeId]) {
      return res.status(403).json({ error: "Ce dossier n'est pas assigné à ce commercial." })
    }

    const updated = await patchCommandeFields(cmdId, fields)
    res.json({ success: true, commande: paymentCalendarPayload(updated) })
  } catch(e) {
    console.error('[commercial/payment-calendar]', e.message)
    res.status(500).json({ error: DEBUG ? e.message : 'Erreur de mise à jour du calendrier de paiement' })
  }
})

// GET /api/commercial/dossier/:id/download-invoice — facture PDF limitée au commercial assigné
router.get('/dossier/:id/download-invoice', requireCommercial, async (req, res) => {
  const { sendInvoicePdf } = require('../lib/pdf')
  await sendInvoicePdf(req, res, { commercialId: req.commercialId })
})

// PATCH /api/commercial/dossier/:id/access-config — mise à jour badges + invitations (commercial)
router.patch('/dossier/:id/access-config', requireCommercial, async (req, res) => {
  try {
    const cmdId = req.params.id
    const { nbBadges, nbInvitations } = req.body || {}
    if (nbBadges === undefined && nbInvitations === undefined) {
      return res.status(400).json({ error: 'Aucun champ à mettre à jour.' })
    }
    // Vérifier que le dossier est bien assigné au commercial connecté
    const cmdResp = await fetch(`${ATBASE}/${encodeURIComponent('Commandes')}/${cmdId}`, { headers: headers() })
    if (!cmdResp.ok) return res.status(404).json({ error: 'Commande introuvable' })
    const cf = (await cmdResp.json()).fields || {}
    const societeId = linkedRecordId(cf['Societé'] || cf['Société'])
    const societeMap = await getCommercialSocietes(req.commercialId)
    if (!societeId || !societeMap[societeId]) {
      return res.status(403).json({ error: 'Ce dossier n\'est pas assigné à ce commercial.' })
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
    console.error('[commercial/access-config]', e.message)
    res.status(500).json({ error: DEBUG ? e.message : 'Erreur mise à jour accès' })
  }
})

// GET /api/commercial/dossier/:id/download-badges — génère PDF badges + invitations (commercial)
router.get('/dossier/:id/download-badges', requireCommercial, async (req, res) => {
  try {
    const cmdId = req.params.id
    const cmdCheck = await invoiceFetchRecord('Commandes', cmdId)
    const cfCheck = cmdCheck?.fields || {}
    const nbBadges = Number(cfCheck['Nombre badges']) || 0
    const nbInvitations = Number(cfCheck['Nombre invitations']) || 0
    if (nbBadges === 0 && nbInvitations === 0) {
      return res.status(400).json({ error: 'Aucun badge ni invitation configuré pour ce dossier.' })
    }
    const result = await generateBadgesInvitationsPDF(cmdId, { commercialId: req.commercialId, nbBadges, nbInvitations })
    const filename = `badges-invitations-${cmdId.slice(-8)}.pdf`
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.send(result.buffer)
  } catch(e) {
    console.error('[commercial/download-badges]', e.message)
    res.status(400).json({ error: e.message })
  }
})

// POST /api/commercial/dossier/:id/email-invoice — envoyé par email au client exposant
router.post('/dossier/:id/email-invoice', requireCommercial, async (req, res) => {
  try {
    const id = req.params.id
    const frontendBase = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '')

    // Vérifier que le dossier appartient au commercial
    const cmdResp = await fetch(`${ATBASE}/${encodeURIComponent('Commandes')}/${id}`, { headers: headers() })
    if (!cmdResp.ok) return res.status(404).json({ error: 'Commande introuvable' })
    const cmd = await cmdResp.json()
    const cf = cmd.fields || {}
    const societeId = linkedRecordId(cf['Societé'] || cf['Société'])
    const societeMap = await getCommercialSocietes(req.commercialId)
    if (!societeId || !societeMap[societeId]) {
      return res.status(403).json({ error: 'Ce dossier n\'est pas assigné à ce commercial.' })
    }

    const [socData, commData] = await Promise.all([
      fetch(`${ATBASE}/${encodeURIComponent('Sociétés')}/${societeId}`, { headers: headers() }).then(r => r.json()),
      fetch(`${ATBASE}/${encodeURIComponent('Commerciaux')}/${req.commercialId}`, { headers: headers() }).then(r => r.json()),
    ])

    const socEmail = socData.fields?.['Email'] || ''
    const socNom = socData.fields?.['Raison sociale'] || socData.fields?.['Nom'] || 'votre société'
    const commNom = commData.fields?.['Nom'] || commData.fields?.['Nom complet'] || 'votre commercial'
    const numDossier = cf['Numero de dossier'] || cf['ID Commande'] || id.slice(-8).toUpperCase()
    const dateCommande = cf['Date commande'] || '—'

    // Dernier paiement enregistré sur la commande
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

    if (!socEmail) {
      return res.status(400).json({ error: 'Aucune adresse email pour le client' })
    }

    // Générer le PDF
    const invoiceData = await buildInvoiceData(id, { commercialId: req.commercialId })
    const pdf = await generateInvoicePDF(invoiceData)
    const filename = `${invoiceSafeFilename(invoiceData.invoiceNumber)}.pdf`
    const totalTTC = Number(String(invoiceData.financial?.totalTTC || invoiceData.financial?.netAPayer || 0).replace(/[^0-9.,-]/g,'').replace(',','.')) || 0
    const encaisse = Number(String(invoiceData.financial?.montantEncaisse || 0).replace(/[^0-9.,-]/g,'').replace(',','.')) || 0
    const reste = Math.max(0, totalTTC - encaisse)

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
    console.error('[commercial/email-invoice]', e.message)
    res.status(500).json({ error: e.message })
  }
})

// POST /api/commercial/cancel-request/:id — demande d'annulation commerciale
router.post('/cancel-request/:id', requireCommercial, async (req, res) => {
  try {
    const id = req.params.id
    const { raison } = req.body || {}
    if (!raison || !String(raison).trim()) {
      return res.status(400).json({ error: "Motif d'annulation requis" })
    }

    const cmdResp = await fetch(`${ATBASE}/${encodeURIComponent('Commandes')}/${id}`, { headers: headers() })
    if (!cmdResp.ok) return res.status(404).json({ error: 'Commande introuvable' })
    const cmd = await cmdResp.json()
    const cf = cmd.fields || {}
    const societeId = linkedRecordId(cf['Societé'] || cf['Société'])
    const societeMap = await getCommercialSocietes(req.commercialId)
    if (!societeId || !societeMap[societeId]) {
      return res.status(403).json({ error: "Ce dossier n'est pas assigné à ce commercial." })
    }

    const societe = societeMap[societeId]
    const commercial = await findCommercialByEmail(req.commercialEmail)
    const numDossier = cf['Numero de dossier'] || cf['ID Commande'] || id.slice(-8).toUpperCase()

    const result = await mailer(
      EMAIL_CONFIG.fromAddress,
      `Demande d'annulation dossier — ${societe.nom}`,
      emailWrapper(`
        <h2 style="color:#1B2A4A;font-size:18px;margin:0 0 14px">Demande d'annulation de commande</h2>
        <p>Une demande d'annulation a été envoyée depuis l'espace commercial.</p>
        <div style="background:#F5F7FA;border-radius:10px;padding:18px;margin:18px 0">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:#7A8891;margin-bottom:4px">Société</div>
          <div style="font-size:16px;font-weight:700;color:#1B2A4A;margin-bottom:10px">${escapeHtml(societe.nom)}</div>
          <div style="font-size:12px;color:#5C5649"><strong>N° dossier :</strong> ${escapeHtml(numDossier)}</div>
          <div style="font-size:12px;color:#5C5649"><strong>Commande :</strong> ${escapeHtml(id)}</div>
          <div style="font-size:12px;color:#5C5649"><strong>Commercial :</strong> ${escapeHtml(commercial?.nom || req.commercialEmail)} (${escapeHtml(req.commercialEmail)})</div>
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

module.exports = router
