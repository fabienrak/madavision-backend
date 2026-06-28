const express = require('express')
const path    = require('path')
const fs      = require('fs')
const router  = express.Router()

const { DEBUG, UPLOADS_DIR, EMAIL_CONFIG } = require('../config')
const { ATBASE, headers, sleep, atGet, atPost, atFind, escapeFormula } = require('../lib/airtable')
const {
  findAuthUserByEmail,
  ensureAuthUser,
  passwordPolicyError,
  startAuthSession,
  generateToken,
  isRestrictedStandSurface,
  MIN_RESTRICTED_STANDS,
  RESTRICTED_STAND_SURFACE_M2,
} = require('../lib/auth')
const { mailer, emailWrapper, escapeHtml, mailTransporter } = require('../lib/email')
const { generateInscriptionPDF, handleImageUpload, fmtMoney, linkedRecordId } = require('../lib/pdf')

// POST /api/check-duplicate — vérifier société existante
router.post('/check-duplicate', async (req, res) => {
  try {
    const { email, nomSociete } = req.body || {}
    if (!email || !nomSociete) {
      return res.status(400).json({ error: 'email et nomSociete requis' })
    }

    const safeEmail = escapeFormula(email).toLowerCase()
    const safeName  = escapeFormula(nomSociete)

    const found = await atFind('Sociétés',
      `AND(LOWER({Email})="${safeEmail}", {Raison sociale}="${safeName}")`)

    res.json({ duplicate: found.length > 0 })
  } catch (e) {
    console.error('[check-duplicate] error:', e.message)
    res.status(500).json({ error: DEBUG ? e.message : 'Erreur de vérification' })
  }
})

// GET /api/societes/search?q=... — recherche société par nom pour préremplissage
// Retourne id, nom, typeEntite, secteur, adresse, nif, stat, nbMembres,
// regimeFiscal, statutExposant (dernière participation), commercial, commercialId,
// hasDossier, nbDossiers
router.get('/societes/search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim()
    if (q.length < 2) return res.json({ societes: [] })

    const safeQ   = escapeFormula(q.toLowerCase())
    const records = await atFind('Sociétés',
      `FIND("${safeQ}", LOWER({Raison sociale})) > 0`)

    const result = []
    for (const r of records.slice(0, 6)) {
      const f       = r.fields
      const partIds = f['Participations'] || []

      let commercial     = null
      let commercialId   = null
      let statutExposant = null

      if (partIds.length > 0) {
        try {
          await sleep(150)
          const pResp = await fetch(
            `${ATBASE}/${encodeURIComponent('Participations')}/${partIds[partIds.length - 1]}`,
            { headers: headers() }
          )
          if (pResp.ok) {
            const pf = (await pResp.json()).fields || {}
            statutExposant = pf['Statut exposant'] || null
            const commId = (pf['Commercial affecte'] || pf['Commercial affecté'] || [])[0]
            if (commId) {
              commercialId = commId
              await sleep(150)
              const cResp = await fetch(
                `${ATBASE}/${encodeURIComponent('Commerciaux')}/${commId}`,
                { headers: headers() }
              )
              if (cResp.ok) {
                const cd = (await cResp.json()).fields || {}
                commercial = cd['Nom'] || cd['Prenom Nom'] || null
              }
            }
          }
        } catch (e) { /* commercial non bloquant */ }
      }

      // Normalize regimeFiscal: map any format → '0.2' | '0.08' | '0'
      const rawRegime = f['Regime fiscal'] || f['Régime fiscal'] || f['Régime Fiscal'] || ''
      const normalizeRegime = (v) => {
        const s = String(v).trim()
        if (['0.2','0.08','0'].includes(s)) return s
        if (s.includes('20') || s.toLowerCase().includes('tva')) return '0.2'
        if (s.includes('8') && !s.includes('20')) return '0.08'
        if (s.includes('3') || s.includes('exon') || s === '0') return '0'
        return s
      }
      result.push({
        id:             r.id,
        nom:            f['Raison sociale']       || '',
        typeEntite:     f["Type d'entite"]         || f["Type d'entité"] || 'Société',
        secteur:        f["Secteur d'activite"]    || f["Secteur d'activité"] || '',
        adresse:        f['Adresse']              || '',
        nif:            f['NIF']                  || '',
        stat:           f['STAT']                 || '',
        nbMembres:      f['Nombre de membres'] ? String(f['Nombre de membres']) : '',
        regimeFiscal:   normalizeRegime(rawRegime),
        taxe:           f['Taxe'] || f['Taux Taxe'] || f['Taux taxe'] || f['Taux TVA'] || null,
        statutExposant: statutExposant            || '',
        commercial,
        commercialId,
        hasDossier: partIds.length > 0,
        nbDossiers: partIds.length,
      })
    }

    res.json({ societes: result })
  } catch (e) {
    console.error('[societes/search]', e.message)
    res.status(500).json({ error: DEBUG ? e.message : 'Erreur de recherche' })
  }
})

// POST /api/voucher/check — vérifie un voucher, son propriétaire et sa transférabilité
router.post('/voucher/check', async (req, res) => {
  try {
    const { code, email, nomSociete, editionId } = req.body || {}
    if (!code) return res.status(400).json({ error: 'Code voucher requis' })

    const codeUpper = String(code).toUpperCase().trim()
    const safeCode  = escapeFormula(codeUpper)

    // Chercher le voucher par code
    const found = await atFind('Vouchers',
      `UPPER({Code voucher})="${safeCode}"`)

    if (found.length === 0) {
      return res.status(404).json({ valid: false, error: 'Code voucher introuvable' })
    }

    const v = found[0]
    const f = v.fields

    // Statut
    const statut = f['Statut'] || ''
    if (statut && !['Actif', 'Active', 'Valide'].includes(statut)) {
      return res.json({ valid: false, error: `Voucher non utilisable — statut : ${statut}` })
    }

    // Date validité — comparaison par date pure (insensible au fuseau)
    if (f['Date validité']) {
      const today  = new Date().toISOString().slice(0, 10)   // "2026-05-18"
      const expiry = String(f['Date validité']).slice(0, 10) // "2026-05-18"
      if (expiry < today) {
        return res.json({ valid: false, error: 'Voucher expiré' })
      }
    }

    // Solde
    const soldeRestant   = f['Solde restant']
    const montantInitial = f['Montant initial'] || 0
    const balance = (soldeRestant !== undefined && soldeRestant !== null && soldeRestant !== '')
      ? Number(soldeRestant)
      : Number(montantInitial)

    if (balance <= 0) {
      return res.json({ valid: false, error: 'Voucher épuisé (solde 0)' })
    }

    // ── Vérification stricte de la SOCIÉTÉ BÉNÉFICIAIRE ──
    const benefIds = f['Société bénéficiaire'] || []
    let societeBenefName = null
    let societeBenefEmail = null

    if (benefIds.length > 0) {
      try {
        const benefResp = await fetch(`${ATBASE}/${encodeURIComponent('Sociétés')}/${benefIds[0]}`, {
          headers: headers()
        })
        if (benefResp.ok) {
          const benefData = await benefResp.json()
          societeBenefName  = benefData.fields['Raison sociale'] || ''
          societeBenefEmail = (benefData.fields['Email'] || '').toLowerCase()
        }
      } catch (e) { /* silencieux */ }

      // Vérifier que c'est BIEN la société qui s'inscrit
      // Match si email ou nom de société correspond
      if (societeBenefName || societeBenefEmail) {
        const matchEmail = email && societeBenefEmail && email.toLowerCase().trim() === societeBenefEmail
        const matchName  = nomSociete && societeBenefName &&
                           nomSociete.trim().toLowerCase() === societeBenefName.trim().toLowerCase()
        if (!matchEmail && !matchName) {
          return res.json({
            valid: false,
            error: `Ce voucher est attribué à "${societeBenefName}". Il ne peut pas être utilisé par une autre société.`,
            blockedReason: 'societe',
            societeBenefName,
          })
        }
      }
    }

    // ── Vérification ÉDITION (transférabilité cross-éditions) ──
    const voucherEdition = (f['Édition'] || [])[0]   // édition d'origine si présente
    const transferable   = f['Transférable cross-éditions'] === true

    if (editionId && voucherEdition && !transferable && voucherEdition !== editionId) {
      return res.json({
        valid: false,
        error: 'Ce voucher est lié à une autre édition et n\'est pas transférable.',
        blockedReason: 'edition',
      })
    }

    // ── Commande d'origine (info pour traçabilité) ──
    const cmdOrigineIds = f['Commande d\'origine'] || []
    let cmdOrigineRef = null
    if (cmdOrigineIds.length > 0) {
      cmdOrigineRef = cmdOrigineIds[0]
    }

    res.json({
      valid:           true,
      voucherId:       v.id,
      code:            f['Code voucher'],
      nom:             f['Nom voucher'] || f['Code voucher'],
      balance,
      montantInitial,
      transferable,
      hasSocieteBenef: benefIds.length > 0,
      societeBenefName,
      cmdOrigineRef,
    })

  } catch (e) {
    console.error('[voucher/check] error:', e.message)
    res.status(500).json({ error: DEBUG ? e.message : 'Erreur de vérification' })
  }
})

// POST /api/inscription — soumission complète
router.post('/inscription', async (req, res) => {
  try {
    const raw = req.body || {}

    // ── Normalisation champs React (nomSoc, contact) vs legacy (nomSociete, prenom+nom) ──
    const data = {
      ...raw,
      logoUrl: raw.logoUrl || raw.logoSocieteUrl || raw.logoParticipation || raw.logo || '',
      originCommercialId: raw.originCommercialId || null,
      nomSociete: raw.nomSociete || raw.nomSoc || '',
      prenom: raw.prenom || (raw.contact ? (raw.contact.trim().split(/\s+/).length > 1 ? raw.contact.trim().split(/\s+/).slice(0,-1).join(' ') : raw.contact) : ''),
      nom:    raw.nom    || (raw.contact ? raw.contact.trim().split(/\s+/).slice(-1)[0] : ''),
    }

    // ── Validation des champs requis ──
    const required = {
      nomSociete: 'Nom de la société',
      email:      'Email',
      telephone:  'Téléphone',
      prenom:     'Prénom du contact',
      nom:        'Nom du contact'
    }
    for (const [key, label] of Object.entries(required)) {
      if (!data[key] || String(data[key]).trim() === '') {
        return res.status(400).json({ error: `Champ requis manquant : ${label}` })
      }
    }
    // Stands = soit data.stands (ancien format), soit data.emplacementIds (nouveau format checkboxes)
    const standsPayload = Array.isArray(data.emplacementIds) && data.emplacementIds.length > 0
      ? data.emplacementIds
      : Array.isArray(data.stands) && data.stands.length > 0
        ? data.stands.flatMap(s => Array.from({length: parseInt(s.qty)||1}, () => s.produitId || s.code))
        : []

    if (standsPayload.length === 0) {
      return res.status(400).json({ error: 'Au moins un stand doit être sélectionné' })
    }
    // Validation email basique
    if (!data.email.includes('@')) {
      return res.status(400).json({ error: 'Email invalide' })
    }

    const accountPassword = String(data.accountPassword || '')
    const accountPasswordConfirm = String(data.accountPasswordConfirm || data.passwordConfirm || '')
    const existingExposantAccount = await findAuthUserByEmail(data.email, 'exposant')
    if (existingExposantAccount && !existingExposantAccount.active) {
      return res.status(403).json({ error: 'Le compte exposant lié à cet email est désactivé. Contactez Madavision.' })
    }

    const exposantNeedsPassword = !existingExposantAccount || !existingExposantAccount.passwordHash
    if (exposantNeedsPassword) {
      if (!accountPassword) {
        return res.status(400).json({ error: 'Mot de passe du compte exposant requis.' })
      }
      if (accountPassword !== accountPasswordConfirm) {
        return res.status(400).json({ error: 'Les mots de passe du compte exposant ne correspondent pas.' })
      }
      const policyError = passwordPolicyError(accountPassword)
      if (policyError) return res.status(400).json({ error: policyError })
    }

    // ── 0a. VÉRIFICATION DU VOUCHER (si utilisé) ──
    let voucherCurrentBalance = null
    if (data.voucherId && data.voucherAmount > 0) {
      try {
        const resp = await fetch(`${ATBASE}/${encodeURIComponent('Vouchers')}/${data.voucherId}`, {
          headers: headers()
        })
        if (!resp.ok) {
          return res.status(400).json({ error: 'Voucher introuvable' })
        }
        const v = await resp.json()
        const vf = v.fields
        const soldeRestant   = vf['Solde restant']
        const montantInitial = vf['Montant initial'] || 0
        voucherCurrentBalance = (soldeRestant !== undefined && soldeRestant !== null && soldeRestant !== '')
          ? Number(soldeRestant)
          : Number(montantInitial)

        // Re-vérifier statut et solde
        const statut = vf['Statut'] || ''
        if (statut && !['Actif', 'Active', 'Valide'].includes(statut)) {
          return res.status(400).json({ error: `Voucher non utilisable (${statut})` })
        }
        if (data.voucherAmount > voucherCurrentBalance) {
          return res.status(400).json({
            error: `Solde voucher insuffisant : ${voucherCurrentBalance} Ar disponible, ${data.voucherAmount} Ar demandé`
          })
        }

        // Re-vérifier société bénéficiaire (anti-fraude)
        const benefIds = vf['Société bénéficiaire'] || []
        if (benefIds.length > 0) {
          try {
            const benefResp = await fetch(`${ATBASE}/${encodeURIComponent('Sociétés')}/${benefIds[0]}`, {
              headers: headers()
            })
            if (benefResp.ok) {
              const benef = await benefResp.json()
              const benefEmail = (benef.fields['Email'] || '').toLowerCase().trim()
              const benefName  = (benef.fields['Raison sociale'] || '').toLowerCase().trim()
              const userEmail  = (data.email || '').toLowerCase().trim()
              const userName   = (data.nomSociete || '').toLowerCase().trim()
              const matchEmail = userEmail && benefEmail && userEmail === benefEmail
              const matchName  = userName && benefName && userName === benefName
              if (!matchEmail && !matchName) {
                return res.status(403).json({
                  error: `Le voucher est attribué à "${benef.fields['Raison sociale']}". Inscription bloquée.`
                })
              }
            }
          } catch (e) { /* silencieux */ }
        }

        // Re-vérifier transférabilité cross-éditions
        const voucherEdition = (vf['Édition'] || [])[0]
        const transferable   = vf['Transférable cross-éditions'] === true
        if (data.editionId && voucherEdition && !transferable && voucherEdition !== data.editionId) {
          return res.status(403).json({
            error: 'Ce voucher est lié à une autre édition et n\'est pas transférable.'
          })
        }
      } catch (e) {
        return res.status(500).json({ error: 'Erreur de vérification du voucher' })
      }
    }

    // ── 0b. VÉRIFICATION ANTI-COLLISION DES EMPLACEMENTS ──
    // Re-vérifier que les emplacements sélectionnés sont TOUJOURS libres
    // (un autre exposant peut les avoir réservés entre temps)
    const emplacementIdsRequested = Array.isArray(data.emplacementIds) ? data.emplacementIds : []
    if (emplacementIdsRequested.length > 0) {
      const conflicts = []
      const standRecords = []
      for (const empId of emplacementIdsRequested) {
        try {
          const resp = await fetch(`${ATBASE}/${encodeURIComponent('Stands')}/${empId}`, {
            headers: headers()
          })
          if (!resp.ok) {
            conflicts.push({ id: empId, numero: '?', raison: 'introuvable' })
            continue
          }
          const rec = await resp.json()
          const statut = rec.fields['Statut'] || ''
          const numero = rec.fields['Numéro stand'] || rec.fields['ID Stand'] || empId
          standRecords.push({ id: empId, numero, fields: rec.fields || {} })
          if (statut && !['Libre', 'Disponible'].includes(statut)) {
            conflicts.push({ id: empId, numero, raison: statut })
          }
        } catch (e) {
          conflicts.push({ id: empId, numero: '?', raison: 'erreur' })
        }
      }

      if (conflicts.length > 0) {
        return res.status(409).json({
          error: 'Certains emplacements viennent d\'être réservés par un autre exposant',
          conflicts,
          message: `Conflit sur ${conflicts.length} emplacement(s) : ${conflicts.map(c => c.numero).join(', ')}. Veuillez rafraîchir et choisir d'autres emplacements.`,
        })
      }

      const restrictedStands = standRecords.filter(s => isRestrictedStandSurface(s.fields))
      if (restrictedStands.length > 0 && restrictedStands.length < MIN_RESTRICTED_STANDS) {
        return res.status(400).json({
          error: `Les stands de ${RESTRICTED_STAND_SURFACE_M2} m² doivent être réservés par ${MIN_RESTRICTED_STANDS} minimum.`,
          message: `Sélection actuelle : ${restrictedStands.map(s => s.numero).join(', ')}. Ajoutez au moins un autre stand de ${RESTRICTED_STAND_SURFACE_M2} m².`,
        })
      }
    }

    // ── NOUVEAU : Traitement du logo via Cloudinary ──
    data.logoUrl = await handleImageUpload(data.logoUrl)

    // ── 1. SOCIÉTÉ — utiliser l'ID connu (depuis recherche), chercher, ou créer ──
    let socId
    const validRegimes = ['0.2', '0.08', '0']
    const regimeFiscalValue = validRegimes.includes(String(data.regimeFiscal))
      ? String(data.regimeFiscal)
      : '0.2'

    if (data.socId) {
      // Société sélectionnée via la recherche → mise à jour des champs modifiés par l'exposant
      socId = data.socId
      const updateFields = {}
      if (data.typeEntite)    updateFields["Type d'entité"]      = data.typeEntite
      if (data.secteur)       updateFields["Secteur d'activité"] = data.secteur
      if (data.adresse)       updateFields['Adresse']            = data.adresse
      if (data.nif)           updateFields['NIF']                = data.nif
      if (data.stat)          updateFields['STAT']               = data.stat
      if (data.regimeFiscal)  updateFields['Régime fiscal']      = regimeFiscalValue
      if (data.telephone)     updateFields['Téléphone']          = data.telephone
      if (data.contact)       updateFields['Contact principal']  = data.contact
      if (data.fonction)      updateFields['Fonction contact']   = data.fonction
      if (data.logoUrl) {
        updateFields['Logo'] = [{ url: data.logoUrl }]
      }
      if (data.originCommercialId) {
        updateFields['Commerciaux'] = [data.originCommercialId]
      }
      if (data.nbMembres || data.nombreMembres) {
        const n = parseInt(data.nbMembres || data.nombreMembres)
        if (!isNaN(n)) updateFields['Nombre de membres'] = n
      }
      if (Object.keys(updateFields).length > 0) {
        await sleep(220)
        await fetch(`${ATBASE}/${encodeURIComponent('Sociétés')}/${socId}`, {
          method: 'PATCH',
          headers: headers(),
          body: JSON.stringify({ fields: updateFields }),
        })
      }
    } else {
      // Pas d'ID connu → chercher par email+nom ou créer
      const safeNom   = escapeFormula(data.nomSociete)
      const safeEmail = escapeFormula(data.email).toLowerCase()
      const existing  = await atFind('Sociétés',
        `AND(LOWER({Email})="${safeEmail}", {Raison sociale}="${safeNom}")`)

      if (existing.length > 0) {
        socId = existing[0].id
      } else {
        const socFields = {
          'Raison sociale':    data.nomSociete,
          "Type d'entité":     data.typeEntite || 'Société',
          'Statut client':     'Prospect',
          'Adresse':           data.adresse || '',
          'Téléphone':         data.telephone,
          'Email':             data.email,
          'Contact principal': `${data.prenom} ${data.nom}`.trim(),
          'Fonction contact':  data.fonction || '',
          'Régime fiscal':     regimeFiscalValue,
        }
        if (data.logoUrl) {
          socFields['Logo'] = [{ url: data.logoUrl }]
        }
        if (data.originCommercialId) {
          socFields['Commerciaux'] = [data.originCommercialId]
        }
        if (data.secteur)   socFields["Secteur d'activité"] = data.secteur
        if (data.nif)       socFields['NIF']  = data.nif
        if (data.stat)      socFields['STAT'] = data.stat
        if (data.nbMembres || data.nombreMembres) {
          const n = parseInt(data.nbMembres || data.nombreMembres)
          if (!isNaN(n)) socFields['Nombre de membres'] = n
        }

        const docNames = []
        const fn = data.fileNames || {}
        if (fn.logo)      docNames.push(`Logo: ${fn.logo}`)
        if (fn.brochure)  docNames.push(`Brochure: ${fn.brochure}`)
        if (fn.justif)    docNames.push(`Justificatif taxe: ${fn.justif}`)
        if (fn.taxjustif) docNames.push(`PJ régime fiscal: ${fn.taxjustif}`)
        if (docNames.length > 0) {
          socFields['Notes'] = `Documents à collecter (soumis via formulaire) :\n${docNames.join('\n')}`
        }

        const soc = await atPost('Sociétés', socFields)
        socId = soc.id
      }
    }

    let exposantAuthUser = null
    try {
      exposantAuthUser = await ensureAuthUser({
        email: data.email,
        role: 'exposant',
        linkedRecordId: socId,
        password: exposantNeedsPassword ? accountPassword : undefined,
      })
    } catch (e) {
      console.error('[inscription] création compte exposant:', e.message)
      return res.status(500).json({ error: DEBUG ? e.message : 'Erreur de création du compte exposant' })
    }

    // ── 2. PARTICIPATION ──
    // Générer un token unique pour l'accès dashboard exposant
    const accessToken = generateToken()

    // ── 3. COMMANDE ──
    const notes = []
    if (data.activiteGratuite) {
      notes.push(`Activité gratuite choisie : ${data.activiteGratuite}`)
    }
    if (data.sponsorPref === 'detail') {
      notes.push(`Facture avec détail demandée`)
    } else if (data.sponsorPref === 'global') {
      notes.push(`Facture globale demandée`)
    }

    if (data.modePaiement) {
      notes.push(`Mode de paiement : ${data.modePaiement}`)
      const pd = data.paiementDetails || {}
      if (data.modePaiement === 'Mobile Money' && pd.operateur) {
        notes.push(`Opérateur : ${pd.operateur}`)
        if (pd.reference) notes.push(`Référence : ${pd.reference}`)
        if (pd.montant)   notes.push(`Montant déclaré : ${fmtMoney(pd.montant)}`)
      } else if (data.modePaiement === 'Virement bancaire') {
        if (pd.banque)   notes.push(`Banque : ${pd.banque}`)
        if (pd.numOV)    notes.push(`Numéro OV : ${pd.numOV}`)
        if (pd.date)     notes.push(`Date virement : ${pd.date}`)
        if (pd.montant)  notes.push(`Montant déclaré : ${fmtMoney(pd.montant)}`)
      } else if (data.modePaiement === 'Chèque') {
        if (pd.numeroCheque) notes.push(`N° chèque : ${pd.numeroCheque}`)
        if (pd.titulaire)    notes.push(`Titulaire : ${pd.titulaire}`)
        if (pd.date)         notes.push(`Date chèque : ${pd.date}`)
        if (pd.montant)      notes.push(`Montant déclaré : ${fmtMoney(pd.montant)}`)
      } else if (data.modePaiement === 'À régler ultérieurement') {
        notes.push('⏳ Payer plus tard — acompte dû sous 7 jours')
      }
    }
    if (Array.isArray(data.emplacementIds) && data.emplacementIds.length > 0) {
      notes.push(`Emplacements sélectionnés : ${data.emplacementIds.length} stand(s)`)
    }
    // Remise multi-stands : calculée automatiquement par Airtable via formule
    // (champ "Remise multi-stands" dans la table Commandes)
    if (data.regimeFiscal) {
      const taxLabels = { '0.2': 'TVA 20 %', '0.08': 'Taxe 8 %', '0': 'Taxe 3ème taux (exonération)' }
      notes.push(`Régime fiscal : ${taxLabels[data.regimeFiscal] || data.regimeFiscal}`)
    }
    if (data.voucherId && data.voucherAmount > 0) {
      notes.push(`Voucher utilisé : ${data.voucherCode || data.voucherId} — ${data.voucherAmount.toLocaleString('fr-FR')} Ar`)
    }
    if (data.fileNames?.virement) {
      notes.push(`Preuve de virement : ${data.fileNames.virement}`)
    }
    notes.push(data.urgent
      ? `Conditions : Mode urgent (<30 jours) — acompte sous 20 jours`
      : `Conditions : Mode standard — contrat 7j puis acompte 20j`)

    let salonRecordId = String(data.salonId || data.editionId || '').trim()
    let salonLinkIds = salonRecordId.startsWith('rec') ? [salonRecordId] : []
    if (salonLinkIds.length === 0) {
      for (const standId of emplacementIdsRequested) {
        try {
          const standResp = await fetch(`${ATBASE}/${encodeURIComponent('Stands')}/${standId}`, { headers: headers() })
          if (!standResp.ok) continue
          const standData = await standResp.json()
          const standFields = standData.fields || {}
          const inferredSalonId = linkedRecordId(
            standFields['Edition'] ||
            standFields['Édition'] ||
            standFields['Editions'] ||
            standFields['Éditions'] ||
            standFields['Salon'] ||
            standFields['Salons']
          )
          if (inferredSalonId) {
            salonRecordId = inferredSalonId
            salonLinkIds = [inferredSalonId]
            break
          }
        } catch (e) {
          console.warn('[inscription] salon via stand:', e.message)
        }
      }
    }
    const inscriptionSalon = {
      label: data.salonLabel || data.eventLabel || '',
      edition: data.editionLabel || '',
      lieu: data.salonLieu || data.lieu || '',
      dateDebut: data.salonDateDebut || '',
      dateFin: data.salonDateFin || '',
    }
    if (salonLinkIds.length > 0) {
      try {
        const salonResp = await fetch(`${ATBASE}/${encodeURIComponent('Salons')}/${salonLinkIds[0]}`, { headers: headers() })
        if (salonResp.ok) {
          const salonData = await salonResp.json()
          const sfSalon = salonData.fields || {}
          inscriptionSalon.label = sfSalon['Nom du salon'] || sfSalon['Nom'] || sfSalon['Name'] || sfSalon['ID Salon'] || inscriptionSalon.label
          inscriptionSalon.edition = sfSalon['Edition'] || sfSalon['Édition'] || sfSalon['Nom édition'] || inscriptionSalon.edition
          inscriptionSalon.lieu = sfSalon['Lieu'] || sfSalon['Ville'] || inscriptionSalon.lieu
          inscriptionSalon.dateDebut = sfSalon['Date début'] || sfSalon['Date de début'] || inscriptionSalon.dateDebut
          inscriptionSalon.dateFin = sfSalon['Date fin'] || sfSalon['Date de fin'] || inscriptionSalon.dateFin
        }
      } catch (e) {
        console.warn('[inscription] résolution salon:', e.message)
      }
    }
    const inscriptionSalonLabel = [inscriptionSalon.label, inscriptionSalon.edition].filter(Boolean).join(' - ')

    const cmdFields = {
      'Societé':         [socId],
      'Statut commande': 'En attente validation',
      'Validation':      'A Valider',
      'Date commande':   new Date().toISOString().slice(0, 10),
      'Notes':           notes.join('\n'),
      'Activités optionnelles': data.activitesOptionnellesIds || [],
      "Token d'accès":   accessToken,
    }
    if (salonLinkIds.length > 0) {
      cmdFields['Salons'] = salonLinkIds
    }
    if (data.descriptionActivite) {
      cmdFields['Description activités'] = data.descriptionActivite
    }
    if (data.codePromoId) {
      cmdFields['Code promo appliqué'] = [data.codePromoId]
    }

    const cmd = await atPost('Commandes', cmdFields)

    // ── 4. LIGNES DE COMMANDE (+ liaison Emplacements) ──
    const emplacementIds = Array.isArray(data.emplacementIds) ? data.emplacementIds : []
    if (emplacementIds.length > 0) {
      try {
        await fetch(`${ATBASE}/${encodeURIComponent('Commandes')}/${cmd.id}`, {
          method: 'PATCH',
          headers: headers(),
          body: JSON.stringify({
            fields: { 'Stand ou service commandé': emplacementIds }
          }),
        })
      } catch(e) { console.warn('Lien stands → commande échoué:', e.message) }

      // Marquer les stands comme Réservés
      for (const empId of emplacementIds) {
        try {
          await sleep(220)
          await fetch(`${ATBASE}/${encodeURIComponent('Stands')}/${empId}`, {
            method: 'PATCH',
            headers: headers(),
            body: JSON.stringify({ fields: { 'Statut': 'Réservé' } }),
          })
        } catch(e) { console.warn(`Statut stand ${empId} échoué:`, e.message) }
      }
    }


    // ── Déduire le solde voucher + créer l'historique d'utilisation ──
    if (data.voucherId && data.voucherAmount > 0 && voucherCurrentBalance !== null) {
      const amountUsed = Number(data.voucherAmount)
      const newBalance = Math.max(0, voucherCurrentBalance - amountUsed)

      // ── 1. Créer un enregistrement dans Utilisations Voucher ──
      try {
        await sleep(220)
        const histFields = {
          'Voucher':         [data.voucherId],
          'Commande':        [cmd.id],
          'Montant utilisé': amountUsed,
          'Solde avant':     voucherCurrentBalance,
          'Solde après':     newBalance,
        }
        const histResp = await fetch(`${ATBASE}/${encodeURIComponent('Utilisations Voucher')}`, {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify({ fields: histFields }),
        })
        if (!histResp.ok) {
          const errBody = await histResp.json().catch(() => ({}))
          console.warn(`⚠ Création historique voucher échouée : ${errBody.error?.message || histResp.status}`)
          console.warn('   → Vérifier que la table "Utilisations Voucher" existe avec les champs : Voucher, Commande, Montant utilisé, Solde avant, Solde après')
        } else {
          console.log(`✓ Historique voucher créé pour ${data.voucherCode || data.voucherId} : ${amountUsed} Ar utilisés (${voucherCurrentBalance} → ${newBalance})`)
        }
      } catch (e) {
        console.warn(`⚠ Erreur création historique voucher : ${e.message}`)
      }

      // ── 2. Mettre à jour le Voucher (solde + statut + liaison commande) ──
      try {
        await sleep(220)
        const voucherFields = {
          'Solde restant': newBalance,
          'Commandes':     [cmd.id],
        }
        if (newBalance === 0) {
          voucherFields['Statut'] = 'Épuisé'
        }
        const vResp = await fetch(`${ATBASE}/${encodeURIComponent('Vouchers')}/${data.voucherId}`, {
          method: 'PATCH',
          headers: headers(),
          body: JSON.stringify({ fields: voucherFields }),
        })
        if (!vResp.ok) {
          const errBody = await vResp.json().catch(() => ({}))
          console.warn(`❌ Mise à jour voucher échouée : ${errBody.error?.message || vResp.status}`)
          // Retry sans Statut si l'option "Épuisé" n'existe pas
          if (newBalance === 0 && errBody.error?.message?.includes('Insufficient permissions')) {
            await sleep(220)
            delete voucherFields['Statut']
            await fetch(`${ATBASE}/${encodeURIComponent('Vouchers')}/${data.voucherId}`, {
              method: 'PATCH',
              headers: headers(),
              body: JSON.stringify({ fields: voucherFields }),
            })
          }
        } else {
          console.log(`✓ Voucher ${data.voucherCode || data.voucherId} : solde mis à jour ${voucherCurrentBalance} → ${newBalance} Ar`)
        }
      } catch (e) {
        console.warn(`❌ Erreur déduction voucher : ${e.message}`)
      }
    }

    // ── Récupérer les vrais totaux calculés par Airtable (Rollups + Formulas) ──
    // Note: les Rollups peuvent prendre quelques secondes à se calculer
    let totals = null
    try {
      // Petite attente pour laisser le temps aux Rollups de se calculer
      await sleep(500)
      const cmdResp = await fetch(`${ATBASE}/${encodeURIComponent('Commandes')}/${cmd.id}`, {
        headers: headers()
      })
      if (cmdResp.ok) {
        const cmdData = await cmdResp.json()
        const cf = cmdData.fields || {}
        totals = {
          totalHT:         cf['Montant HT']          || 0,  // ← Montant HT (pas Total HT)
          remisePromo:     cf['Montant remise promo'] || 0,  // ← Montant remise promo
          totalStands:     cf['Total stands']         || 0,
          pourcentageTaxe: cf['Pourcentage Taxe']     || 0,
          montantTaxe:     cf['Montant taxe']         || 0,
          ttc:             cf['Total TTC']            || 0,
          montantTTC:      cf['Montant TTC']          || 0,
          netAPayer:       cf['Net a payer']          || 0,  // ← sans accent
        }
      }
    } catch (e) {
      console.warn('Récupération totaux Airtable échouée (Rollups pas encore calculés ?) :', e.message)
    }

    // ── Résolution des noms d'activités pour le PDF ──
    let resolvedActivities = []
    if (data.activitesOptionnellesIds && data.activitesOptionnellesIds.length > 0) {
      try {
        const allAct = await atGet('Activités optionnelles')
        resolvedActivities = allAct
          .filter(a => data.activitesOptionnellesIds.includes(a.id))
          .map(a => ({
            label: a.fields['Nom activité'] || a.fields['Nom'] || 'Activité',
            prix:  a.fields['Prix unitaire'] || 0
          }))
      } catch (e) { console.warn('Resolution activities failed', e.message) }
    }

    // ── Générer et sauvegarder le PDF du dossier d'inscription ──
    let pdfBuffer = null
    try {
      pdfBuffer = await generateInscriptionPDF({
        numDossier:       cmd.id.slice(-8).toUpperCase(),
        salonLabel:       inscriptionSalonLabel,
        salonLieu:        inscriptionSalon.lieu,
        salonDateDebut:   inscriptionSalon.dateDebut,
        salonDateFin:     inscriptionSalon.dateFin,
        nomSociete:       data.nomSociete    || data.nomSoc       || '',
        nomParticipation: data.nomParticipation || '',
        typeEntite:       data.typeEntite    || '',
        statutExposant:   data.statutExposant || '',
        secteur:          data.secteur       || '',
        nif:              data.nif           || '',
        stat:             data.stat          || '',
        adresse:          data.adresse       || '',
        contact:          data.contact       || '',
        fonction:         data.fonction      || '',
        email:            data.email         || '',
        logoSocieteUrl:   data.logoUrl       || data.logoSocieteUrl || '',
        telephone:        data.telephone     || '',
        regimeFiscal:     data.regimeFiscal  || '',
        stands:           data.stands        || [],
        bilan:            data.bilan         || [],
        optionalActivities: resolvedActivities,
      })
      // Persister dans uploads/:token/dossier-inscription.pdf
      const pdfDir  = path.join(UPLOADS_DIR, accessToken)
      fs.mkdirSync(pdfDir, { recursive: true })
      fs.writeFileSync(path.join(pdfDir, 'dossier-inscription.pdf'), pdfBuffer)
      console.log(`✓ PDF dossier généré pour ${accessToken}`)
    } catch (pdfErr) {
      console.warn(`⚠ PDF dossier échoué : ${pdfErr.message}`)
    }

    // ── Email de confirmation à l'exposant (fire-and-forget) ──
    if (mailTransporter && data.email) {
      const frontendBase = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '')
      // const espaceUrl    = `${frontendBase}/exposant/${accessToken}`
      const espaceUrl    = `${frontendBase}/exposant`
      const numDossier   = cmd.id.slice(-8).toUpperCase()
      const nomSoc       = escapeHtml(data.nomSociete || data.nomSoc || 'votre société')
      const salonLabel   = escapeHtml(inscriptionSalonLabel || 'Madavision')

      const emailHtml = emailWrapper(`
        <h2 style="color:#195b98;font-size:18px;margin:0 0 14px">Confirmation d'inscription — ${numDossier}</h2>
        <p>Bonjour,</p>
        <p>Nous avons bien enregistré l'inscription de <strong>${nomSoc}</strong> à l'événement <strong>${salonLabel}</strong>.</p>

        <div style="background:#F5F7FA;border-left:4px solid #195b98;padding:16px 20px;border-radius:0 12px 12px 0;margin:20px 0">
          <div style="font-size:13px;color:#687e7e;margin-bottom:4px">Numéro de dossier</div>
          <div style="font-size:20px;font-weight:700;color:#195b98;font-family:monospace">${numDossier}</div>
        </div>

        <p style="font-size:14px;color:#0d0d0d">
          Vous trouverez ci-joint votre <strong>document d'inscription récapitulatif</strong> contenant le détail de votre réservation ainsi que nos <strong>coordonnées bancaires et Mobile Money</strong> pour le règlement de votre acompte.
        </p>

        <div style="background:#FEF3E8;border:1px solid #C87B2F;border-radius:12px;padding:18px;margin:24px 0">
          <div style="font-size:12px;font-weight:700;color:#C87B2F;margin-bottom:8px;text-transform:uppercase">🔑 Votre espace exposant</div>
          <p style="font-size:13px;margin:0 0 14px;color:#6d441f">Accédez à votre dossier, déclarez vos paiements et téléchargez vos factures :</p>
          <a href="${espaceUrl}" style="background:#195b98;color:#fff;text-decoration:none;padding:10px 20px;border-radius:8px;display:inline-block;font-weight:600;font-size:13px">Accéder à mon espace</a>
        </div>

        <h3 style="color:#195b98;font-size:14px;margin:22px 0 8px">Prochaines étapes</h3>
        <ol style="padding-left:20px;font-size:13px;color:#687e7e;line-height:1.6">
          <li>Validation de votre éligibilité par l'administration (24-48h).</li>
          <li>Paiement de l'acompte de 50% via les modes indiqués dans le PDF joint.</li>
          <li>Signature du contrat définitif.</li>
        </ol>

        <p style="margin-top:24px;font-size:13px;color:#0d0d0d">Cordialement,<br/><strong>L'Administration Madavision</strong></p>
      `)

      mailTransporter.sendMail({
        from:    `"${EMAIL_CONFIG.fromName}" <${EMAIL_CONFIG.fromAddress}>`,
        to:      data.email,
        subject: `Confirmation d'inscription — ${data.nomSociete || data.nomSoc}`,
        html: emailHtml,
        ...(EMAIL_CONFIG.bcc ? { bcc: EMAIL_CONFIG.bcc } : {}),
        ...(pdfBuffer ? { attachments: [{ filename: 'dossier-inscription.pdf', content: pdfBuffer, contentType: 'application/pdf' }] } : {}),
      }).then(() => console.log(`✓ Email confirmation envoyé à ${data.email}`))
        .catch(e => console.warn(`⚠ Email confirmation échoué : ${e.message}`))
    }

    const authUser = exposantNeedsPassword && exposantAuthUser
      ? await startAuthSession(res, exposantAuthUser).catch(() => null)
      : null

    res.json({
      success: true,
      societeId:       socId,
      participationId: cmd.id,
      commandeId:      cmd.id,
      numDossier:      cmd.id.slice(-8).toUpperCase(),
      accessToken,
      dashboardUrl:    `/exposant/${accessToken}`,
      totals,
      authUser,
    })

  } catch (e) {
    console.error('[inscription] error:', e.message)
    res.status(500).json({
      error: DEBUG ? e.message : 'Erreur lors de l\'enregistrement'
    })
  }
})

// GET /api/emplacements?editionId=... — liste avec statut à jour
// Permet au formulaire de rafraîchir la disponibilité avant soumission
router.get('/emplacements', async (req, res) => {
  try {
    const editionId = req.query.editionId
    const all = await atGet('Stands')

    const result = all
      .filter(r => {
        if (!r.fields['Numéro stand']) return false
        if (editionId) {
          const eds = r.fields['Édition'] || []
          if (!eds.includes(editionId)) return false
        }
        return true
      })
      .map(r => ({
        id:         r.id,
        numero:     r.fields['Numéro stand'] || '',
        zone:       r.fields['Zone / Village'] || '',
        specs:      r.fields['Spécificités'] || '',
        tarif:      r.fields['Tarif référence'] || 0,
        statut:     r.fields['Statut'] || 'Libre',
        editionIds: r.fields['Édition'] || [],
        // libre = disponible à la sélection
        libre:      !r.fields['Statut'] || ['Libre', 'Disponible'].includes(r.fields['Statut']),
      }))
      .sort((a, b) => a.numero.localeCompare(b.numero, undefined, { numeric: true, sensitivity: 'base' }))

    res.json({ emplacements: result, lastUpdate: new Date().toISOString() })
  } catch (e) {
    console.error('[emplacements] error:', e.message)
    res.status(500).json({ error: DEBUG ? e.message : 'Erreur de chargement' })
  }
})

module.exports = router
