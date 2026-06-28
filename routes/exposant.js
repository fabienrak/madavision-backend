const express = require('express')
const path    = require('path')
const fs      = require('fs')
const router  = express.Router()

const { DEBUG, UPLOADS_DIR, EMAIL_CONFIG, EMAIL_ENABLED } = require('../config')
const { ATBASE, headers, sleep, atGet, atPost, atPatchRecord, atFind, escapeFormula, attachmentUrl, PLAN_MASSE_FIELDS } = require('../lib/airtable')
const {
  requireRole,
  generateToken,
  parseStandSurfaceM2,
  badgesFromStandSurface,
  isRestrictedStandSurface,
  MIN_RESTRICTED_STANDS,
  RESTRICTED_STAND_SURFACE_M2,
} = require('../lib/auth')
const { mailer, emailWrapper, escapeHtml, mailTransporter } = require('../lib/email')
const {
  generateInscriptionPDF,
  handleImageUpload,
  fmtMoney,
  fmtMoneyRaw,
  linkedRecordId,
  invoiceLinkedIds,
  buildExposantDocuments,
  findCommandeByAccessToken,
  fetchBilanPuissance,
  resolveEditionAndSalon,
  sendInvoicePdfByCommandId,
  buildProformaContractAttachment,
  generateBadgesInvitationsPDF,
} = require('../lib/pdf')
const { requireExposant } = require('../middleware/auth')

// GET /api/espace-client — tous les dossiers pour cet email (après OTP)
router.get('/espace-client', requireExposant, async (req, res) => {
  try {
    // Utiliser l'email du token de session (pas celui du query param) — plus sécurisé
    const email = req.exposantEmail

    const safeEmail = escapeFormula(email)
    const societes  = await atFind('Sociétés', `AND(LOWER({Email})="${safeEmail.toLowerCase()}", {Commandes} != "")`)
    if (!societes.length) return res.json({ dossiers: [], total: 0 })

    const dossiers = []
    for (const soc of societes) {
      const sf      = soc.fields
      const cmdIds  = sf['Commandes'] || []

      for (const cmdId of cmdIds) {
        try {
          await sleep(150)
          const cResp = await fetch(`${ATBASE}/${encodeURIComponent('Commandes')}/${cmdId}`, { headers: headers() })
          if (!cResp.ok) continue
          const cf = (await cResp.json()).fields || {}

          // ── Édition ── (table Salons, champ "Edition")
          const edId = (cf['Édition'] || cf['Edition'] || [])[0]
          let edition = { nom: '', id: edId }
          if (edId) {
            try {
              const er = await fetch(`${ATBASE}/${encodeURIComponent('Salons')}/${edId}`, { headers: headers() })
              if (er.ok) {
                const ef = (await er.json()).fields
                edition.nom = ef['Edition'] || ef['Édition'] || ef['Nom édition'] || ef['Nom du salon'] || ef['Nom'] || ''
              }
            } catch {}
          }

          const parseMGA = v => parseFloat(String(v||0).replace(/[^0-9.,]/g,'').replace(',','.')) || 0
          const mTotal   = parseMGA(cf['Total TTC'] || cf['Net a payer'])
          const mPaye    = parseMGA(cf['Montant encaissé'])
          const mReste   = parseMGA(cf['Reste à payer'])
          const stands   = Array.isArray(cf['Stand ou service commandé']) ? cf['Stand ou service commandé'].join(', ') : String(cf['Stand ou service commandé'] || '—')

          let accessToken = cf['Token d\'accès'] || null
          if (!accessToken) {
            accessToken = generateToken()
            await fetch(`${ATBASE}/${encodeURIComponent('Commandes')}/${cmdId}`, {
              method:  'PATCH',
              headers: headers(),
              body:    JSON.stringify({ fields: { 'Token d\'accès': accessToken } }),
            }).catch(e => console.warn('[espace-client] token write failed:', e.message))
          }

          dossiers.push({
            participationId:  cmdId,
            numeroDossier:    cf['Numero de dossier'] || cf['ID Commande'] || cmdId.slice(-6).toUpperCase(),
            edition:          edition.nom,
            dateInscription:  cf['Date commande'] || '',
            statutDossier:    cf['Statut commande'] || 'Inscrit',
            statutExposant:   'Exposant',
            validation:       cf['Validation'] || 'A Valider',
            accessToken,
            montantTotal:     mTotal,
            montantEncaisse:  mPaye,
            resteAPayer:      mReste,
            societe: {
              id:            soc.id,
              raisonSociale: sf['Raison sociale'] || sf['Nom'] || '—',
              email:         sf['Email'] || email,
              telephone:     sf['Téléphone'] || '',
            },
          })
        } catch (e) { console.warn('[espace-client] skip command:', e.message) }
      }
    }

    dossiers.sort((a, b) => new Date(b.dateInscription || 0) - new Date(a.dateInscription || 0))
    res.json({ dossiers, total: dossiers.length })
  } catch (e) {
    console.error('[espace-client]', e.message)
    res.status(500).json({ error: DEBUG ? e.message : 'Erreur serveur' })
  }
})

// GET /api/exposant/:token — récupère le dossier complet d'un exposant
router.get('/exposant/:token', async (req, res) => {
  try {
    const rawToken = req.params.token || ''
    const token = rawToken.toUpperCase().replace('TOKEN:', '').replace(/[^A-Z0-9]/g, '')
    if (!token || token.length < 5) {
      return res.status(400).json({ error: 'Token invalide' })
    }

    // 1. Chercher la COMMANDE par le token (champ dédié OU ancien format dans Notes)
    const safeToken = escapeFormula(token)
    const formula = `OR({Token d'accès}="${safeToken}", FIND("TOKEN:${safeToken}", {Notes}) > 0)`
    const records = await atFind('Commandes', formula)

    if (records.length === 0) {
      return res.status(404).json({ error: 'Dossier introuvable. Vérifiez votre lien d\'accès.' })
    }

    const cmd = records[0]
    const cf  = cmd.fields

    // 2. Récupérer la société liée
    const societeId = (cf['Societé'] || cf['Société'] || [])[0]
    if (!societeId) return res.status(404).json({ error: 'Société introuvable' })
    const socRecords = await atFind('Sociétés', `RECORD_ID()="${societeId}"`)
    const sf = socRecords[0]?.fields || {}

    // 3. Salon / Édition lié (via la commande ou via le stand)
    const firstLinkedId = value => Array.isArray(value) ? value[0] : value
    let salonOrEditionId = firstLinkedId(cf['Édition'] || cf['Edition'] || cf['Salons'] || cf['Salon'])
    const standIds = Array.isArray(cf['Stand ou service commandé']) ? cf['Stand ou service commandé'] : []
    if (!salonOrEditionId) {
      for (const sid of standIds) {
        try {
          const sRes = await fetch(`${ATBASE}/${encodeURIComponent('Stands')}/${sid}`, { headers: headers() })
          if (sRes.ok) {
            const sData = await sRes.json()
            const lid = firstLinkedId(
              sData.fields?.['Édition'] ||
              sData.fields?.['Edition'] ||
              sData.fields?.['Éditions'] ||
              sData.fields?.['Editions'] ||
              sData.fields?.['Salon'] ||
              sData.fields?.['Salons']
            )
            if (lid) { salonOrEditionId = lid; break }
          }
        } catch (e) {
          console.warn('[exposant] résolution salon via stand échouée:', e.message)
        }
      }
    }

    let edition = null
    if (salonOrEditionId) {
      const edRes = await fetch(`${ATBASE}/${encodeURIComponent('Salons')}/${salonOrEditionId}`, { headers: headers() })
      if (edRes.ok) {
        const edData = await edRes.json()
        const ef = edData.fields || {}
        edition = {
          id:        edData.id,
          nom:       ef['Edition'] || ef['Édition'] || ef['Nom édition'] || ef['Nom du salon'] || edData.id,
          evenement: ef['Événement'] || ef['Evenement'] || ef['Salon'] || ef['Nom du salon'] || '',
          dateDebut: ef['Date début'] || ef['Date de début'] || '',
          dateFin:   ef['Date fin'] || ef['Date de fin'] || '',
          lieu:      ef['Lieu'] || ef['Ville'] || '',
          salonId:   edData.id,
          salonIds:  [edData.id],
        }
      }
    }

    // 3b. Plan de masse du salon lié à l'édition
    let planMasseUrl = null
    if (edition?.salonId) {
      const salonRes = await fetch(`${ATBASE}/${encodeURIComponent('Salons')}/${edition.salonId}`, { headers: headers() })
      if (salonRes.ok) {
        const salonData = await salonRes.json()
        planMasseUrl = attachmentUrl(salonData.fields || {}, PLAN_MASSE_FIELDS)
      }
    }

    // 4. Commercial affecté (souvent lié à la société)
    const commercialId = (sf['Commerciaux'] || [])[0]
    let commercial = null
    if (commercialId) {
      const cRes  = await fetch(`${ATBASE}/${encodeURIComponent('Commerciaux')}/${commercialId}`, { headers: headers() })
      const cData = await cRes.json()
      if (cRes.ok) commercial = {
        nom:       cData.fields['Nom'],
        email:     cData.fields['Email'],
        telephone: cData.fields['Téléphone'],
      }
    }

    // 5. Stands commandés
    const rawStandIds = Array.isArray(cf['Stand ou service commandé']) ? cf['Stand ou service commandé'] : []
    const stands = []
    const standLabels = []
    for (const standId of rawStandIds) {
      if (!String(standId || '').startsWith('rec')) {
        const label = String(standId || '').trim()
        if (label) {
          standLabels.push(label)
          stands.push({ id: label, label })
        }
        continue
      }
      try {
        const sRes = await fetch(`${ATBASE}/${encodeURIComponent('Stands')}/${standId}`, { headers: headers() })
        if (!sRes.ok) {
          standLabels.push(standId)
          stands.push({ id: standId, label: standId })
          continue
        }
        const sData = await sRes.json()
        const sFields = sData.fields || {}
        const label = sFields['ID Stand'] || sFields['Numéro stand'] || sFields['Spécificités'] || standId
        standLabels.push(label)
        stands.push({
          id: standId,
          label,
          surface: sFields['Dimension'] || sFields['Surface'] || '',
          prix: sFields['Prix'] || sFields['Tarif référence'] || 0,
          type: sFields['Spécificités'] || sFields['Type'] || 'Autres',
        })
      } catch (e) {
        standLabels.push(standId)
        stands.push({ id: standId, label: standId })
      }
    }

    // 6. Normalisation de la commande pour le frontend
    const totalSurfaceM2 = stands.reduce((sum, s) => sum + parseStandSurfaceM2(s.surface), 0)
    const commandeData = {
      id:              cmd.id,
      idCommande:      cf['Numero de dossier'] || cf['ID Commande'] || cmd.id.slice(-8).toUpperCase(),
      dateCommande:    cf['Date commande'],
      statut:          cf['Statut commande'],
      statutValidation:cf['Validation'],
      totalHT:         cf['Montant HT'],
      ttc:             cf['Total TTC'],
      netAPayer:       cf['Net a payer'],
      montantEncaisse: cf['Montant encaissé'],
      resteAPayer:     cf['Reste à payer'],
      numeroDossier:   cf['Numero de dossier'] || cf['ID Commande'] || cmd.id.slice(-8).toUpperCase(),
      notes:                cf['Notes'] || '',
      descriptionActivite:  cf['Description activités'] || '',
      paiements:            cf['Paiements'] || [],
      documentsFinanciers:  cf['Documents financiers'] || [],
      stands:               standLabels.join(', '),
      standItems:           stands,
      nbBadges:             Number(cf['Nombre badges']) || 0,
      nbInvitations:   Number(cf['Nombre invitations']) || 0,
      surfaceTotaleM2: totalSurfaceM2,
      badgesEstimes:   badgesFromStandSurface(totalSurfaceM2),
    }

    // 7. Paiements
    const allPaiementIds = cf['Paiements'] || []
    const paiements = []
    for (const pid of allPaiementIds) {
      const pRes  = await fetch(`${ATBASE}/${encodeURIComponent('Paiements')}/${pid}`, { headers: headers() })
      const pData = await pRes.json()
      if (pRes.ok) {
        paiements.push({
          id: pData.id,
          montant:    pData.fields['Montant payé'],
          mode:       pData.fields['Mode de paiement'],
          date:       pData.fields['Date paiement'],
          reference:  pData.fields['Référence'],
          valide:     pData.fields['Validé par M. Hery'] || false,
          dateValid:  pData.fields['Date validation'],
        })
      }
    }

    // 8. Documents financiers
    const allDocsIds = cf['Documents financiers'] || []
    const documentsFinanciers = []
    for (const dId of allDocsIds) {
      const dRes  = await fetch(`${ATBASE}/${encodeURIComponent('Documents financiers')}/${dId}`, { headers: headers() })
      const dData = await dRes.json()
      if (dRes.ok) {
        documentsFinanciers.push({
          id: dData.id,
          reference:    dData.fields['Référence'],
          type:         dData.fields['Type document'],
          dateEmission: dData.fields['Date émission'],
          dateEcheance: dData.fields['Date échéance'],
          montantHT:    dData.fields['Montant HT'],
          ttc:          dData.fields['Total TTC'],
          statut:       dData.fields['Statut'],
          pdfUrls:      (dData.fields['PDF généré'] || []).map(att => ({ url: att.url, filename: att.filename })),
        })
      }
    }
    const documents = buildExposantDocuments({ token, cmd, documentsFinanciers })

    // 8b. Historique des vouchers utilisés par cette participation
    // (recherche les utilisations dans Utilisations Voucher liées aux commandes de cette participation)
    const utilisationsVoucher = []
    try {
        const filter = `{Commande}="${cmd.id}"`
        const utilRecords = await atGet('Utilisations Voucher', `filterByFormula=${encodeURIComponent(filter)}`).catch(() => [])
        utilRecords.forEach(u => {
          const cmdIds = u.fields['Commande'] || []
          const matchesCmd = cmdIds.includes(cmd.id)
          if (matchesCmd) {
            utilisationsVoucher.push({
              id:           u.id,
              montantUtilise: u.fields['Montant utilisé'] || 0,
              soldeAvant:   u.fields['Solde avant'] || 0,
              soldeApres:   u.fields['Solde après'] || 0,
              date:         u.fields['Date utilisation'] || u.createdTime,
              voucherIds:   u.fields['Voucher'] || [],
            })
          }
        })

        // Enrichir avec les infos des vouchers
        for (const util of utilisationsVoucher) {
          if (util.voucherIds.length > 0) {
            try {
              const vR = await fetch(`${ATBASE}/${encodeURIComponent('Vouchers')}/${util.voucherIds[0]}`, {
                headers: headers()
              })
              if (vR.ok) {
                const v = await vR.json()
                util.voucherCode = v.fields['Code voucher']
                util.voucherNom  = v.fields['Nom voucher']
                util.soldeRestantActuel = v.fields['Solde restant']
              }
            } catch (e) { /* skip */ }
          }
        }
    } catch (e) { console.warn('Voucher history failed:', e.message) }

    // 8c. Bilan de puissance depuis Commandes.Puissance
    const bilan = await fetchBilanPuissance(cmd.id, cf)

    // 8d. Activités optionnelles
    let optionalActivities = []
    if (cf['Activités optionnelles'] && cf['Activités optionnelles'].length > 0) {
      try {
        const allAct = await atGet('Activités optionnelles')
        optionalActivities = allAct
          .filter(a => cf['Activités optionnelles'].includes(a.id))
          .map(a => ({
            id: a.id,
            label: a.fields['Nom activité'] || a.fields['Nom'] || 'Activité',
            prix:  a.fields['Prix unitaire'] || 0
          }))
      } catch (e) { console.warn('Resolution activities failed', e.message) }
    }

    // 9. Réponse complète
    res.json({
      utilisationsVoucher,
      participation: {
        id:                cmd.id,
        numeroDossier:     commandeData.numeroDossier,
        statutDossier:     cf['Statut commande'],
        statutExposant:    'Exposant',
        dateInscription:   cf['Date commande'],
        montantTotal:      commandeData.netAPayer,
        montantEncaisse:   commandeData.montantEncaisse,
        resteAPayer:       commandeData.resteAPayer,
        validation:        cf['Validation'],
      },
      societe: {
        id:              societeId,
        raisonSociale:   sf['Raison sociale'],
        typeEntite:      sf["Type d'entité"],
        secteur:         sf["Secteur d'activité"],
        adresse:         sf['Adresse'],
        ville:           sf['Ville'],
        telephone:       sf['Téléphone'],
        email:           sf['Email'],
        contact:         sf['Contact principal'],
        fonction:        sf['Fonction contact'],
        nif:             sf['NIF'],
        stat:            sf['STAT'],
        regimeFiscal:    sf['Régime fiscal'],
      },
      edition,
      planMasseUrl,
      commercial,
      commandes: [commandeData],
      stands,
      paiements,
      documents,
      documentsFinanciers,
      optionalActivities,
      bilan,
    })

  } catch (e) {
    console.error('[exposant] error:', e.message)
    res.status(500).json({ error: DEBUG ? e.message : 'Erreur de chargement du dossier' })
  }
})

// POST /api/exposant/:token/bilan — ajouter un équipement
router.post('/exposant/:token/bilan', async (req, res) => {
  try {
    const { token } = req.params
    const cleanToken = (token || '').toUpperCase().replace('TOKEN:', '').replace(/[^A-Z0-9]/g, '')
    const data = req.body || {}
    const safeToken = escapeFormula(cleanToken)
    const formula = `OR({Token d'accès}="${safeToken}", FIND("TOKEN:${safeToken}", {Notes}) > 0)`
    const cmds = await atFind('Commandes', formula)
    if (!cmds.length) return res.status(404).json({ error: 'Commande introuvable' })

    const cmdId = cmds[0].id

    const fields = {
      'Materiel':          data.materiel,
      'Puissance':         Number(data.puissance) || 0,
      'Status':            data.status === 'Non Actif' ? 'Non Actif' : 'Actif',
      'Nombre':            Number(data.nombre) || 1,
      'Duree utilisation': Number(data.duree) || 0,
      'Commandes':         [cmdId]
    }

    const record = await atPost('Bilan de Puissance', fields)
    res.json({ success: true, id: record.id })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// PATCH /api/exposant/:token/bilan/:id — modifier un équipement
router.patch('/exposant/:token/bilan/:id', async (req, res) => {
  try {
    const { id } = req.params
    const data = req.body || {}

    const fields = {}
    if (data.materiel !== undefined)  fields['Materiel']          = data.materiel
    if (data.puissance !== undefined) fields['Puissance']         = Number(data.puissance)
    if (data.status !== undefined)    fields['Status']            = data.status
    if (data.nombre !== undefined)    fields['Nombre']            = Number(data.nombre)
    if (data.duree !== undefined)     fields['Duree utilisation'] = Number(data.duree)

    const r = await fetch(`${ATBASE}/${encodeURIComponent('Bilan de Puissance')}/${id}`, {
      method: 'PATCH',
      headers: headers(),
      body: JSON.stringify({ fields }),
    })
    if (!r.ok) throw new Error('Erreur lors de la mise à jour Airtable')

    res.json({ success: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// DELETE /api/exposant/:token/bilan/:id — supprimer un équipement
router.delete('/exposant/:token/bilan/:id', async (req, res) => {
  try {
    const { id } = req.params
    const r = await fetch(`${ATBASE}/${encodeURIComponent('Bilan de Puissance')}/${id}`, {
      method: 'DELETE',
      headers: headers(),
    })
    if (!r.ok) throw new Error('Erreur lors de la suppression Airtable')
    res.json({ success: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/exposant/:token/cancel — annuler la commande
router.post('/exposant/:token/cancel', async (req, res) => {
  try {
    const { token } = req.params
    const { raison } = req.body || {}
    if (!token) return res.status(400).json({ error: 'Token requis' })

    // Trouver la participation par token
    const rawToken = token || ''
    const cleanToken = rawToken.toUpperCase().replace('TOKEN:', '').replace(/[^A-Z0-9]/g, '')
    const safeToken = escapeFormula(cleanToken)
    const formula = `OR({Token d'accès}="${safeToken}", FIND("TOKEN:${safeToken}", {Notes}) > 0)`
    const cmds = await atFind('Commandes', formula)
    if (!cmds.length) return res.status(404).json({ error: 'Dossier introuvable' })

    const cmd = cmds[0]
    const cf  = cmd.fields

    const statut = cf['Statut commande'] || ''
    if (statut === 'Annulé') return res.status(400).json({ error: 'Dossier déjà annulé' })

    await fetch(`${ATBASE}/${encodeURIComponent('Commandes')}/${cmd.id}`, {
      method: 'PATCH',
      headers: headers(),
      body: JSON.stringify({ fields: { 'Statut commande': 'Annulé', 'Validation': 'Annulé' } }),
    })

    // Envoyer notification à Mme Sonia si mailer configuré
    if (mailTransporter) {
      try {
        const socNom = (await fetch(`${ATBASE}/${encodeURIComponent('Sociétés')}/${(cf['Societé']||cf['Société']||[])[0]}`, { headers: headers() }).then(r => r.json()))?.fields?.['Raison sociale'] || '—'
        await mailTransporter.sendMail({
          from: `"${EMAIL_CONFIG.fromName}" <${EMAIL_CONFIG.fromAddress}>`,
          to:   EMAIL_CONFIG.fromAddress,
          subject: `Annulation dossier — ${socNom}`,
          html: `<p>Le dossier de <strong>${socNom}</strong> a été annulé par l'exposant.</p><p>Raison : ${raison || 'Non précisée'}</p>`,
        })
      } catch(e) { console.warn('Email annulation échoué:', e.message) }
    }

    console.log(`✓ Dossier annulé — commande ${cmd.id}`)
    res.json({ success: true, message: 'Votre dossier a été annulé.' })
  } catch(e) {
    console.error('[cancel] error:', e.message)
    res.status(500).json({ error: DEBUG ? e.message : 'Erreur lors de l\'annulation' })
  }
})

async function notifyExposantDossierUpdate({ cmd, socId, socFields = {}, changes = [], standLabels = [], demandeModification = '' }) {
  if (!mailTransporter) return { sent: false, error: 'smtp_disabled' }

  try {
    let sf = socFields
    if (!sf || Object.keys(sf).length === 0) {
      const socRes = await fetch(`${ATBASE}/${encodeURIComponent('Sociétés')}/${socId}`, { headers: headers() })
      if (socRes.ok) sf = (await socRes.json()).fields || {}
    }

    const cf = cmd.fields || {}
    const socNom = sf['Raison sociale'] || sf['Nom'] || '—'
    const socEmail = sf['Email'] || ''
    const numDossier = cf['Numero de dossier'] || cf['ID Commande'] || cmd.id.slice(-8).toUpperCase()
    const frontendBase = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '')
    const changeList = changes.length ? changes : ['Modification du dossier exposant']
    const standSection = standLabels.length
      ? `<div style="font-size:13px;color:#1B2A4A;margin-top:8px"><strong>Stands sélectionnés :</strong> ${escapeHtml(standLabels.join(', '))}</div>`
      : ''
    const demandeSection = demandeModification
      ? `<div style="font-size:13px;color:#1B2A4A;margin-top:8px"><strong>Demande :</strong> ${escapeHtml(demandeModification)}</div>`
      : ''

    const adminHtml = emailWrapper(`
      <h2 style="color:#1B2A4A;font-size:18px;margin:0 0 14px">Dossier exposant modifié</h2>
      <p>L'exposant <strong>${escapeHtml(socNom)}</strong> a mis à jour son dossier depuis l'espace exposant.</p>
      <div style="background:#FFF7E8;border-left:4px solid #C87B2F;padding:16px 20px;border-radius:0 12px 12px 0;margin:20px 0">
        <div style="font-size:12px;font-weight:700;text-transform:uppercase;color:#C87B2F;margin-bottom:8px">Nouvelle validation requise</div>
        <div style="font-size:13px;color:#1B2A4A"><strong>Dossier :</strong> ${escapeHtml(numDossier)}</div>
        <div style="font-size:13px;color:#1B2A4A;margin-top:4px"><strong>Société :</strong> ${escapeHtml(socNom)}</div>
        ${socEmail ? `<div style="font-size:13px;color:#1B2A4A;margin-top:4px"><strong>Email :</strong> ${escapeHtml(socEmail)}</div>` : ''}
        <div style="font-size:13px;color:#1B2A4A;margin-top:8px"><strong>Modifications :</strong> ${changeList.map(escapeHtml).join(', ')}</div>
        ${standSection}
        ${demandeSection}
        <div style="font-size:13px;color:#b45309;margin-top:12px"><strong>Statut :</strong> En attente de validation / A Valider</div>
      </div>
      <div style="margin-top:24px">
        <a href="${frontendBase}/sonia" style="background:#1B2A4A;color:#fff;text-decoration:none;padding:10px 22px;border-radius:8px;display:inline-block;font-weight:600;font-size:13px">Accéder à l'administration</a>
      </div>
    `)

    const adminMail = await mailer(EMAIL_CONFIG.fromAddress, `Modification dossier exposant — ${socNom}`, adminHtml)

    const commercialIds = [
      ...(Array.isArray(sf['Commerciaux']) ? sf['Commerciaux'] : []),
      ...(Array.isArray(cf['Commerciaux']) ? cf['Commerciaux'] : []),
      ...(Array.isArray(cf['Commercial affecté']) ? cf['Commercial affecté'] : []),
    ].filter((id, index, arr) => id && arr.indexOf(id) === index)
    const commercialMails = []
    for (const commercialId of commercialIds) {
      try {
        const commRes = await fetch(`${ATBASE}/${encodeURIComponent('Commerciaux')}/${commercialId}`, { headers: headers() })
        if (!commRes.ok) continue
        const commFields = (await commRes.json()).fields || {}
        const commEmail = commFields['Email'] || commFields['Email professionnel'] || commFields['Mail']
        if (commEmail) commercialMails.push(commEmail)
      } catch (e) {
        console.warn('[notifyExposantDossierUpdate] commercial fetch:', e.message)
      }
    }

    await Promise.allSettled(commercialMails.map(email =>
      mailer(email, `[Suivi] Dossier modifié — ${socNom}`, adminHtml)
    ))

    if (socEmail) {
      const exposantHtml = emailWrapper(`
        <h2 style="color:#1B2A4A;font-size:18px;margin:0 0 14px">Modification de votre dossier enregistrée</h2>
        <p>Bonjour,</p>
        <p>Nous avons bien reçu la mise à jour de votre dossier <strong>${escapeHtml(numDossier)}</strong>.</p>
        <div style="background:#EEF2F8;border-left:4px solid #195b98;padding:16px 20px;border-radius:0 12px 12px 0;margin:20px 0">
          <div style="font-size:13px;color:#1B2A4A"><strong>Modifications :</strong> ${changeList.map(escapeHtml).join(', ')}</div>
          ${standSection}
          <div style="font-size:13px;color:#b45309;margin-top:12px"><strong>Statut :</strong> En attente de validation</div>
        </div>
        <p style="font-size:13px;color:#687e7e">L'administration Madavision va vérifier les changements avant validation finale.</p>
        <div style="margin-top:24px">
          <a href="${frontendBase}/exposant" style="background:#1B2A4A;color:#fff;text-decoration:none;padding:10px 22px;border-radius:8px;display:inline-block;font-weight:600;font-size:13px">Accéder à mon espace exposant</a>
        </div>
      `)
      await mailer(socEmail, 'Modification de votre dossier — Madavision', exposantHtml)
    }

    return { sent: Boolean(adminMail.sent), to: EMAIL_CONFIG.fromAddress }
  } catch (e) {
    console.warn('[notifyExposantDossierUpdate]', e.message)
    return { sent: false, error: e.message }
  }
}

// POST /api/exposant/:token/update — modifier les infos exposant
router.post('/exposant/:token/update', async (req, res) => {
  try {
    const { token } = req.params
    const data = req.body || {}
    if (!token) return res.status(400).json({ error: 'Token requis' })

    const rawToken = token || ''
    const cleanToken = rawToken.toUpperCase().replace('TOKEN:', '').replace(/[^A-Z0-9]/g, '')
    const safeToken = escapeFormula(cleanToken)
    const formula = `OR({Token d'accès}="${safeToken}", FIND("TOKEN:${safeToken}", {Notes}) > 0)`
    const cmds = await atFind('Commandes', formula)
    if (!cmds.length) return res.status(404).json({ error: 'Dossier introuvable' })

    const cmd = cmds[0]
    const cf  = cmd.fields
    const socId = (cf['Societé'] || cf['Société'] || [])[0]
    if (!socId) return res.status(404).json({ error: 'Société introuvable' })

    const hasField = key => Object.prototype.hasOwnProperty.call(data, key)
    const cleanText = value => String(value ?? '').trim()
    const normalizeRegimeFiscalInput = value => {
      const raw = cleanText(value).toLowerCase()
      if (!raw) return null
      if (raw === '0.2' || raw.includes('20')) return '0.2'
      if (raw === '0.08' || raw.includes('8')) return '0.08'
      if (raw === '0' || raw.includes('exon')) return '0'
      return undefined
    }
    const regimeFiscalValue = normalizeRegimeFiscalInput(data.regimeFiscal)
    if (hasField('raisonSociale') && !cleanText(data.raisonSociale)) {
      return res.status(400).json({ error: 'La raison sociale est obligatoire.' })
    }
    if (hasField('regimeFiscal') && regimeFiscalValue === undefined) {
      return res.status(400).json({ error: 'Régime fiscal invalide.' })
    }

    // Traitement du logo via Cloudinary si un nouveau logo est envoyé.
    data.logoUrl = await handleImageUpload(data.logoUrl || data.logoSocieteUrl || data.logoParticipation || data.logo)

    // Champs modifiables par l'exposant : société + interlocuteur.
    const socFields = {}
    if (hasField('raisonSociale')) socFields['Raison sociale'] = cleanText(data.raisonSociale)
    if (hasField('typeEntite'))    socFields["Type d'entité"] = cleanText(data.typeEntite)
    if (hasField('secteur'))       socFields["Secteur d'activité"] = cleanText(data.secteur)
    if (hasField('adresse'))       socFields['Adresse'] = cleanText(data.adresse)
    if (hasField('telephone'))     socFields['Téléphone'] = cleanText(data.telephone)
    if (hasField('nif'))           socFields['NIF'] = cleanText(data.nif)
    if (hasField('stat'))          socFields['STAT'] = cleanText(data.stat)
    if (hasField('regimeFiscal')) socFields['Régime fiscal'] = regimeFiscalValue
    if (hasField('contact'))       socFields['Contact principal'] = cleanText(data.contact)
    if (hasField('fonction'))      socFields['Fonction contact'] = cleanText(data.fonction)
    if (data.logoUrl) {
      socFields['Logo'] = [{ url: data.logoUrl }]
    }

    let requiresValidation = Object.keys(socFields).length > 0
    let standsToFree = []
    let standsToReserve = []
    let updatedSocFields = {}
    const notificationChanges = []
    const notificationStandLabels = []
    const demandeModificationText = hasField('demandeModification') ? cleanText(data.demandeModification) : ''

    if (Object.keys(socFields).length > 0) {
      const updatedSoc = await atPatchRecord('Sociétés', socId, socFields)
      updatedSocFields = updatedSoc.fields || {}
      notificationChanges.push('Informations société / interlocuteur')
    }

    const cmdFields = {}

    // Demandes de modification (stand, emplacement) → note dans la participation
    if (hasField('demandeModification') && demandeModificationText) {
      const noteActuelle = cf['Notes'] || ''
      const noteAjout = `\n[DEMANDE MODIFICATION ${new Date().toLocaleDateString('fr-FR')}] ${demandeModificationText}`
      cmdFields['Notes'] = (noteActuelle + noteAjout).trim()
      requiresValidation = true
      notificationChanges.push('Demande de modification')
    }

    // Modification des stands sélectionnés
    if (Array.isArray(data.standIds)) {
      const currentStandIds = (cf['Stand ou service commandé'] || []).map(id => String(id))
      const newStandIds = [...new Set(data.standIds.map(id => String(id || '').trim()).filter(Boolean))]
      const invalidStandIds = newStandIds.filter(id => !id.startsWith('rec'))
      if (invalidStandIds.length > 0) {
        return res.status(400).json({ error: 'Sélection de stands invalide.' })
      }
      if (newStandIds.length === 0) {
        return res.status(400).json({ error: 'Au moins un stand doit être sélectionné.' })
      }

      const standRecords = []
      for (const standId of newStandIds) {
        const standRes = await fetch(`${ATBASE}/${encodeURIComponent('Stands')}/${standId}`, { headers: headers() })
        if (!standRes.ok) return res.status(404).json({ error: `Stand introuvable : ${standId}` })
        const standRecord = await standRes.json()
        standRecords.push(standRecord)
        notificationStandLabels.push(standRecord.fields?.['ID Stand'] || standRecord.fields?.['Numéro stand'] || standRecord.id)
      }

      const toFree = currentStandIds.filter(id => !newStandIds.includes(id))
      const toReserve = newStandIds.filter(id => !currentStandIds.includes(id))
      const unavailable = standRecords
        .filter(record => toReserve.includes(record.id))
        .filter(record => {
          const statut = String(record.fields?.['Statut'] || '').trim()
          return statut && statut !== 'Disponible'
        })
        .map(record => record.fields?.['ID Stand'] || record.fields?.['Numéro stand'] || record.id)
      if (unavailable.length > 0) {
        return res.status(409).json({
          error: 'Certains stands ne sont plus disponibles.',
          message: `Stand(s) indisponible(s) : ${unavailable.join(', ')}`,
        })
      }

      const restrictedStands = standRecords.filter(record => isRestrictedStandSurface(record.fields || {}))
      if (restrictedStands.length === 1) {
        return res.status(400).json({
          error: `Les stands de ${RESTRICTED_STAND_SURFACE_M2} m² doivent être réservés par ${MIN_RESTRICTED_STANDS} minimum.`,
          message: `Sélection actuelle : ${restrictedStands.map(record => record.fields?.['ID Stand'] || record.fields?.['Numéro stand'] || record.id).join(', ')}. Ajoutez au moins un autre stand de ${RESTRICTED_STAND_SURFACE_M2} m².`,
        })
      }

      cmdFields['Stand ou service commandé'] = newStandIds
      standsToFree = toFree
      standsToReserve = toReserve
      requiresValidation = true
      notificationChanges.push('Stands')
    }

    if (requiresValidation) {
      cmdFields['Validation'] = 'A Valider'
      cmdFields['Statut commande'] = 'En attente validation'
    }

    if (Object.keys(cmdFields).length > 0) {
      await atPatchRecord('Commandes', cmd.id, cmdFields)
    }

    for (const id of standsToFree) {
      try {
        await atPatchRecord('Stands', id, { 'Statut': 'Disponible' })
      } catch(e) { console.warn(`[update] free stand ${id}:`, e.message) }
    }

    for (const id of standsToReserve) {
      try {
        await atPatchRecord('Stands', id, { 'Statut': 'Réservé' })
      } catch(e) { console.warn(`[update] reserve stand ${id}:`, e.message) }
    }

    const notification = requiresValidation
      ? await notifyExposantDossierUpdate({
          cmd,
          socId,
          socFields: updatedSocFields,
          changes: notificationChanges,
          standLabels: notificationStandLabels,
          demandeModification: demandeModificationText,
        })
      : { sent: false }

    res.json({ success: true, message: 'Informations mises à jour.', notification })
  } catch(e) {
    console.error('[update] error:', e.message)
    res.status(500).json({ error: DEBUG ? e.message : 'Erreur lors de la mise à jour' })
  }
})

// POST /api/exposant/:token/paiement
router.post('/exposant/:token/paiement', async (req, res) => {
  try {
    const token = (req.params.token || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
    const data  = req.body || {}

    const cleanToken = token.replace('TOKEN', '').replace(/[^A-Z0-9]/g, '')
    const safeToken = escapeFormula(cleanToken)
    const formula = `OR({Token d'accès}="${safeToken}", FIND("TOKEN:${safeToken}", {Notes}) > 0)`
    const cmds = await atFind('Commandes', formula)
    if (!cmds.length) return res.status(404).json({ error: 'Dossier introuvable' })

    const cmd   = cmds[0]
    const cf    = cmd.fields
    const cmdId = data.commandeId || cmd.id
    if (!cmdId) return res.status(400).json({ error: 'Aucune commande trouvée' })

    const montant = Number(data.montant)
    if (!montant || montant <= 0) return res.status(400).json({ error: 'Montant invalide' })
    if (!data.modePaiement)       return res.status(400).json({ error: 'Mode de paiement requis' })

    // Créer l'enregistrement Paiements
    const paiementFields = {
      'Commande':          [cmdId],
      'Montant payé':      montant,
      'Mode de paiement':  data.modePaiement,
      'Date paiement':     data.date || new Date().toISOString().slice(0, 10),
      'Statut':            'En attente',
    }
    const detailParts = []
    if (data.reference)  { paiementFields['Référence'] = data.reference;  detailParts.push(`Réf: ${data.reference}`) }
    if (data.banque)     detailParts.push(`Banque: ${data.banque}`)
    if (data.operateur)  { paiementFields['Operateur mobile'] = data.operateur; detailParts.push(`Opérateur: ${data.operateur}`) }
    if (data.numero)     detailParts.push(`N°: ${data.numero}`)
    if (data.nomSurCheque) { paiementFields['Nom sur chèque'] = data.nomSurCheque; detailParts.push(`Nom chèque: ${data.nomSurCheque}`) }
    if (detailParts.length) paiementFields['Notes'] = detailParts.join(' — ')

    const paiement = await atPost('Paiements', paiementFields)

    // ── 1. Récupérer infos société et commercial pour les notifications ──
    let socNom = '—';
    let socEmail = null;
    let commEmail = null;
    const socId = (cf['Societé'] || cf['Société'] || [])[0]

    if (socId) {
      try {
        const socRes = await fetch(`${ATBASE}/${encodeURIComponent('Sociétés')}/${socId}`, { headers: headers() })
        if (socRes.ok) {
          const sf = (await socRes.json()).fields || {}
          socNom = sf['Raison sociale'] || '—'
          socEmail = sf['Email'] || null

          const commIds = sf['Commerciaux'] || []
          if (commIds.length > 0) {
            const commRes = await fetch(`${ATBASE}/${encodeURIComponent('Commerciaux')}/${commIds[0]}`, { headers: headers() })
            if (commRes.ok) {
              const cf_comm = (await commRes.json()).fields || {}
              commEmail = cf_comm['Email'] || cf_comm['Email professionnel'] || cf_comm['Mail'] || null
            }
          }
        }
      } catch (e) { console.warn('[paiement] Fetch soc/comm failed:', e.message) }
    }

    // ── 2. Envoi des emails ──
    if (mailTransporter) {
      // A. Template pour l'Administration et le Commercial
      const adminHtml = emailWrapper(`
        <h2 style="color:#195b98;font-size:18px;margin:0 0 14px">Nouvelle déclaration de paiement</h2>
        <p>L'exposant <strong>${escapeHtml(socNom)}</strong> a déclaré un règlement :</p>
        <div style="background:#F5F7FA;border-left:4px solid #195b98;padding:16px 20px;border-radius:0 12px 12px 0;margin:20px 0">
          <div style="font-size:13px;color:#687e7e;margin-bottom:4px">Montant déclaré</div>
          <div style="font-size:20px;font-weight:700;color:#195b98;font-family:monospace">${fmtMoney(montant)}</div>
          <div style="margin-top:12px;font-size:13px;color:#0d0d0d;line-height:1.6">
            <strong>Mode :</strong> ${escapeHtml(data.modePaiement)}<br/>
            <strong>Référence :</strong> ${escapeHtml(data.reference || '—')}<br/>
            ${data.banque ? `<strong>Banque :</strong> ${escapeHtml(data.banque)}<br/>` : ''}
            ${data.operateur ? `<strong>Opérateur :</strong> ${escapeHtml(data.operateur)}` : ''}
          </div>
        </div>
        <p style="font-size:13px;color:#687e7e">Action : Vérifier et valider le paiement dans Airtable → table <strong>Paiements</strong>.</p>
      `)

      // Envoi à l'Admin
      mailer(EMAIL_CONFIG.fromAddress, `Déclaration paiement — ${socNom}`, adminHtml).catch(() => {})

      // Envoi au Commercial si assigné
      if (commEmail) {
        mailer(commEmail, `[Suivi] Paiement déclaré par ${socNom}`, adminHtml).catch(() => {})
      }

      // B. Template pour l'Exposant — Confirmation réception paiement
      const numDossier = cf['Numero de dossier'] || cf['ID Commande'] || cmd.id.slice(-8).toUpperCase()
      const exhibHtml = emailWrapper(`
        <h2 style="color:#195b98;font-size:18px;margin:0 0 14px">Confirmation réception paiement</h2>
        <p>Bonjour,</p>
        <p>Nous avons bien enregistré votre déclaration de paiement.</p>
        <div style="background:#E8F7EF;border-left:4px solid #1E7F54;padding:16px 20px;border-radius:0 12px 12px 0;margin:20px 0">
          <div style="font-size:20px;font-weight:700;color:#1E7F54;font-family:monospace">${fmtMoney(montant)}</div>
          <div style="margin-top:12px;font-size:13px;color:#0d0d0d;line-height:1.6">
            <strong>Dossier :</strong> ${escapeHtml(numDossier)}<br/>
            <strong>Mode :</strong> ${escapeHtml(data.modePaiement)}<br/>
            <strong>Date :</strong> ${escapeHtml(data.date || new Date().toISOString().slice(0,10))}<br/>
            ${data.reference ? `<strong>Référence :</strong> ${escapeHtml(data.reference)}<br/>` : ''}
            <strong>Statut :</strong> <span style="color:#b45309">En attente de validation</span>
          </div>
        </div>
        <p style="font-size:13px;color:#687e7e;line-height:1.5">
          Notre équipe administrative va procéder à la vérification de la transaction.<br/>
          Le statut de votre règlement sera mis à jour dans votre espace exposant sous <strong>24–48h ouvrables</strong>.
        </p>
        <p style="font-size:13px;color:#687e7e">Merci de votre confiance.</p>
        <p style="font-size:13px;margin-top:20px">Cordialement,<br/><strong>L'Administration Madavision</strong></p>
      `)

      const toEmail = data.emailExposant || socEmail
      if (toEmail) {
        mailer(toEmail, `Confirmation réception paiement — Madavision`, exhibHtml).catch(() => {})
      }
    }

    res.json({ success: true, paiementId: paiement.id, message: 'Paiement déclaré avec succès. Notre équipe validera sous 48h.' })
  } catch(e) {
    console.error('[paiement] error:', e.message)
    res.status(500).json({ error: DEBUG ? e.message : 'Erreur lors de la déclaration de paiement' })
  }
})

// POST /api/exposant/:token/upload-bc
router.post('/exposant/:token/upload-bc', async (req, res) => {
  try {
    const token = (req.params.token || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
    const { filename, data: fileData, commandeId: reqCmdId } = req.body || {}

    if (!fileData)   return res.status(400).json({ error: 'Fichier manquant' })
    if (!filename)   return res.status(400).json({ error: 'Nom de fichier requis' })

    const cleanToken = token.replace('TOKEN', '').replace(/[^A-Z0-9]/g, '')
    const safeToken = escapeFormula(cleanToken)
    const formula = `OR({Token d'accès}="${safeToken}", FIND("TOKEN:${safeToken}", {Notes}) > 0)`
    const cmds = await atFind('Commandes', formula)
    if (!cmds.length) return res.status(404).json({ error: 'Dossier introuvable' })

    const cmd    = cmds[0]
    const cf     = cmd.fields
    const cmdId  = reqCmdId || cmd.id

    // Sauvegarde du fichier sur disque
    const safeFilename  = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80)
    const uploadSubDir  = path.join(UPLOADS_DIR, token)
    if (!fs.existsSync(uploadSubDir)) fs.mkdirSync(uploadSubDir, { recursive: true })

    const fileBuffer = Buffer.from(fileData, 'base64')
    const destPath   = path.join(uploadSubDir, safeFilename)
    fs.writeFileSync(destPath, fileBuffer)

    // Mettre à jour les Notes de la Commande + statut "BC reçu"
    if (cmdId) {
      try {
        const cr = await fetch(`${ATBASE}/${encodeURIComponent('Commandes')}/${cmdId}`, { headers: headers() })
        if (cr.ok) {
          const existing = (await cr.json()).fields?.['Notes'] || ''
          const bcNote   = `\n[BC ${new Date().toLocaleDateString('fr-FR')}] ${safeFilename}`
          await fetch(`${ATBASE}/${encodeURIComponent('Commandes')}/${cmdId}`, {
            method: 'PATCH', headers: headers(),
            body: JSON.stringify({ fields: { 'Notes': existing + bcNote, 'Statut commande': 'BC reçu' } }),
          })
        }
      } catch (e) { console.warn('[upload-bc] commande update:', e.message) }
    }

    // Email admin
    if (mailTransporter) {
      let socNom = '—'
      const socId = (cf['Societé'] || cf['Société'] || [])[0]
      if (socId) {
        try {
          const s = await fetch(`${ATBASE}/${encodeURIComponent('Sociétés')}/${socId}`, { headers: headers() })
          if (s.ok) socNom = (await s.json()).fields?.['Raison sociale'] || '—'
        } catch {}
      }
      mailTransporter.sendMail({
        from:    `"${EMAIL_CONFIG.fromName}" <${EMAIL_CONFIG.fromAddress}>`,
        to:      EMAIL_CONFIG.fromAddress,
        subject: `BC reçu — ${socNom}`,
        html:    `<p>Un Bon de Commande a été déposé par <strong>${escapeHtml(socNom)}</strong> : <em>${escapeHtml(safeFilename)}</em></p>`,
      }).catch(() => {})
    }

    res.json({ success: true, filename: safeFilename, downloadUrl: `/api/exposant/${token}/download-bc/${safeFilename}` })
  } catch(e) {
    console.error('[upload-bc] error:', e.message)
    res.status(500).json({ error: DEBUG ? e.message : 'Erreur lors du dépôt du BC' })
  }
})

// GET /api/exposant/:token/download-bc/:filename — téléchargement BC
router.get('/exposant/:token/download-bc/:filename', (req, res) => {
  const token    = (req.params.token || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  const cleanToken = token.replace('TOKEN', '').replace(/[^A-Z0-9]/g, '')
  const filename = (req.params.filename || '').replace(/[^a-zA-Z0-9._-]/g, '_')
  const filePath = path.join(UPLOADS_DIR, cleanToken, filename)
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Fichier introuvable' })
  res.download(filePath, filename)
})

// GET /api/exposant/:token/download-dossier — téléchargement PDF dossier d'inscription
// Sert le PDF pré-généré si disponible, sinon le génère à la volée depuis Airtable
router.get('/exposant/:token/download-dossier', async (req, res) => {
  try {
    const token    = (req.params.token || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
    const filePath = path.join(UPLOADS_DIR, token, 'dossier-inscription.pdf')

    if (fs.existsSync(filePath)) return res.download(filePath, 'dossier-inscription.pdf')

    // Fichier absent → génération à la volée depuis Airtable
    const cleanToken = token.replace('TOKEN', '').replace(/[^A-Z0-9]/g, '')
    const safeToken = escapeFormula(cleanToken)
    const formula = `OR({Token d'accès}="${safeToken}", FIND("TOKEN:${safeToken}", {Notes}) > 0)`
    const cmds = await atFind('Commandes', formula)
    if (cmds.length === 0) return res.status(404).json({ error: 'Dossier introuvable. Vérifiez votre lien d\'accès.' })

    const cmd = cmds[0]
    const cf  = cmd.fields

    // Société + Salon en parallèle
    const societeId = (cf['Societé'] || cf['Société'] || [])[0]
    let salonId = linkedRecordId(cf['Salons'] || cf['Salon'] || cf['Édition'] || cf['Edition'])
    if (!salonId) {
      for (const standId of invoiceLinkedIds(cf['Stand ou service commandé'] || cf['Stand'])) {
        try {
          const standData = await fetch(`${ATBASE}/${encodeURIComponent('Stands')}/${standId}`, { headers: headers() }).then(r => r.ok ? r.json() : null)
          const standFields = standData?.fields || {}
          salonId = linkedRecordId(
            standFields['Edition'] ||
            standFields['Édition'] ||
            standFields['Editions'] ||
            standFields['Éditions'] ||
            standFields['Salon'] ||
            standFields['Salons']
          )
          if (salonId) break
        } catch (e) {
          console.warn('[download-dossier] résolution salon via stand:', e.message)
        }
      }
    }
    if (!societeId) return res.status(404).json({ error: 'Société introuvable.' })

    const [socData, edData] = await Promise.all([
      fetch(`${ATBASE}/${encodeURIComponent('Sociétés')}/${societeId}`, { headers: headers() }).then(r => r.json()),
      salonId ? fetch(`${ATBASE}/${encodeURIComponent('Salons')}/${salonId}`, { headers: headers() }).then(r => r.ok ? r.json() : null) : Promise.resolve(null),
    ])
    const sf = socData.fields || {}
    const ef = edData?.fields  || {}
    const salonLabel = [
      ef['Nom du salon'] || ef['Nom'] || ef['Name'] || ef['ID Salon'] || '',
      ef['Edition'] || ef['Édition'] || ef['Nom édition'] || '',
    ].filter(Boolean).join(' - ')

    // Stands depuis la première commande
    const commandeId = cmd.id
    let stands = []
    if (commandeId) {
      try {
        const cmdData  = await fetch(`${ATBASE}/${encodeURIComponent('Commandes')}/${commandeId}`, { headers: headers() }).then(r => r.json())
        const standIds = Array.isArray(cmdData.fields?.['Stand ou service commandé']) ? cmdData.fields['Stand ou service commandé'] : []
        for (const sId of standIds) {
          try {
            const sData = await fetch(`${ATBASE}/${encodeURIComponent('Stands')}/${sId}`, { headers: headers() }).then(r => r.json())
            const sFields = sData.fields || {}
            stands.push({
              label:   sFields['ID Stand'] || sFields['Numéro stand'] || '',
              surface: sFields['Surface']  || sFields['Superficie']   || '',
              prix:    sFields['Prix HT']  || sFields['Prix']         || sFields['Tarif'] || '',
            })
          } catch(e) { /* stand introuvable — on continue */ }
        }
      } catch(e) { /* commande inaccessible — stands vides */ }
    }

    const pdfBuffer = await generateInscriptionPDF({
      numDossier:       cf['Numero de dossier'] || cf['ID Commande'] || cmd.id.slice(-8).toUpperCase(),
      salonLabel,
      salonLieu:        ef['Lieu'] || ef['Ville'] || '',
      salonDateDebut:   ef['Date début'] || ef['Date de début'] || '',
      salonDateFin:     ef['Date fin'] || ef['Date de fin'] || '',
      nomSociete:       sf['Raison sociale']                  || '',
      nomParticipation: cf['Nom de participation (from Societé)'] || '',
      typeEntite:       sf["Type d'entité"]                   || '',
      statutExposant:   'Exposant',
      secteur:          sf["Secteur d'activité"]              || '',
      nif:              sf['NIF']                             || '',
      stat:             sf['STAT']                            || '',
      adresse:          sf['Adresse']                         || '',
      contact:          sf['Contact principal']               || '',
      fonction:         sf['Fonction contact']                || '',
      email:            sf['Email']                           || '',
      telephone:        sf['Téléphone']                       || '',
      regimeFiscal:     sf['Régime fiscal']                   || '',
      stands,
    })

    // Sauvegarder pour les prochains téléchargements
    try {
      fs.mkdirSync(path.join(UPLOADS_DIR, token), { recursive: true })
      fs.writeFileSync(filePath, pdfBuffer)
    } catch(e) { /* non-bloquant */ }

    res.set('Content-Type', 'application/pdf')
    res.set('Content-Disposition', 'attachment; filename="dossier-inscription.pdf"')
    res.send(pdfBuffer)
  } catch(e) {
    console.error('[download-dossier]', e.message)
    res.status(500).json({ error: 'Erreur lors de la génération du dossier.' })
  }
})

// GET /api/exposant/:token/download-invoice — facture PDF exposant
router.get('/exposant/:token/download-invoice', async (req, res) => {
  const cmd = req.exposantCommand || await findCommandeByAccessToken(req.params.token)
  if (!cmd) return res.status(404).json({ error: "Dossier introuvable. Vérifiez votre lien d'accès." })
  await sendInvoicePdfByCommandId(cmd.id, res)
})

// GET /api/exposant/:token/download-proforma-contract — facture proforma + contrat CGV exposant
router.get('/exposant/:token/download-proforma-contract', async (req, res) => {
  try {
    const cmd = req.exposantCommand || await findCommandeByAccessToken(req.params.token)
    if (!cmd) return res.status(404).json({ error: "Dossier introuvable. Vérifiez votre lien d'accès." })

    const { attachment } = await buildProformaContractAttachment(cmd.id)
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="${attachment.filename}"`)
    res.send(attachment.content)
  } catch (e) {
    console.error('[download-proforma-contract]', e.message)
    res.status(500).json({ error: DEBUG ? e.message : 'Erreur génération proforma' })
  }
})

// GET /api/exposant/:token/download-badges — badges + invitations exposant (dossier soldé requis)
router.get('/exposant/:token/download-badges', async (req, res) => {
  try {
    const cmd = await findCommandeByAccessToken(req.params.token)
    if (!cmd) return res.status(404).json({ error: 'Dossier introuvable. Vérifiez votre lien d\'accès.' })

    const cf = cmd.fields || {}
    const nbBadges     = Number(cf['Nombre badges']) || 0
    const nbInvitations = Number(cf['Nombre invitations']) || 0
    if (nbBadges === 0 && nbInvitations === 0) {
      return res.status(400).json({ error: 'Aucun badge ni invitation n\'a encore été configuré pour votre dossier.' })
    }

    const result = await generateBadgesInvitationsPDF(cmd.id, { nbBadges, nbInvitations })
    const numDossier = cf['Numero de dossier'] || cmd.id.slice(-8).toUpperCase()
    const filename = `badges-invitations-${numDossier}.pdf`
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.send(result.buffer)
  } catch(e) {
    console.error('[exposant/download-badges]', e.message)
    res.status(400).json({ error: e.message })
  }
})

// POST /api/send-dossier
router.post('/send-dossier', async (req, res) => {
  try {
    if (!EMAIL_ENABLED || !mailTransporter) {
      return res.status(503).json({ error: "L'envoi d'email n'est pas configuré sur le serveur" })
    }

    const {
      email, nomSociete, numDossier, htmlDossier, dashboardUrl,
      // Infos société (pour l'entête email)
      nif, stat, adresse, telephone: telSoc, siteWeb, emailSociete,
      logoSocieteUrl,         // URL publique logo société (depuis Airtable)
      // Données financières (formules identiques Airtable)
      totalStands    = 0,    // Total TTC stands (champ Cumul Airtable)
      totalActivites = 0,    // Prix activités optionnelles
      remisePromo    = 0,    // Montant remise code promo
      montantVoucher = 0,    // Montant utilisé voucher
      regimeFiscal   = '',   // '0.2' | '0.08' | '0' ou texte
      stands         = [],   // [{label, prix}] détail des stands
      activites      = [],   // [{label, prix}] détail des activités
    } = req.body || {}

    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Email invalide' })
    if (!nomSociete)                    return res.status(400).json({ error: 'Nom de société manquant' })

    // ─────────────────────────────────────────────────────────────────
    //  CALCUL FISCAL — identique aux formules Airtable
    //
    //  Les prix stands/activités sont déjà TTC (taxe incluse)
    //  La taxe s'extrait à rebours du TTC (pas ajout sur HT)
    //
    //  Montant TTC  = Total TTC stands + activités − remise promo
    //  Montant HT   = Montant TTC ÷ (1 + taux)
    //  Montant taxe = Montant HT × taux
    //  Net à payer  = Montant TTC − montant voucher
    // ─────────────────────────────────────────────────────────────────
    const stands_TTC    = Number(totalStands)    || 0
    const activ_TTC     = Number(totalActivites)  || 0
    const remise        = Number(remisePromo)     || 0
    const voucher       = Number(montantVoucher)  || 0

    const regStr = String(regimeFiscal)
    let taux = 0, tauxLabel = '', tauxPct = ''
    if      (regStr === '0.2'  || regStr.includes('20')) { taux = 0.20; tauxLabel = 'TVA 20 %';             tauxPct = '20 %' }
    else if (regStr === '0.08' || regStr.includes('8'))  { taux = 0.08; tauxLabel = 'Taxe 8 %';              tauxPct = '8 %'  }
    else if (regStr === '0'    || regStr.includes('3'))  { taux = 0.03; tauxLabel = "Taxe 3ème taux (0 %)"; tauxPct = '0 %'  }

    const montantTTC  = Math.max(0, stands_TTC + activ_TTC - remise)
    const montantHT   = taux > 0 ? Math.round(montantTTC / (1 + taux)) : montantTTC
    const montantTaxe = Math.round(montantHT * taux)
    const netAPayer   = Math.max(0, montantTTC - voucher)
    const acompte50   = Math.round(netAPayer * 0.5)

    // Séparateurs milliers avec POINTS (comme demandé)
    const fmtAr = n => Math.round(Number(n)||0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ' Ar'

    // Logo Madavision (URL depuis .env ou texte)
    const mvLogoUrl = process.env.MADAVISION_LOGO_URL || ''
    const logoMVHtml = mvLogoUrl
      ? `<img src="${mvLogoUrl}" alt="Madavision" style="height:50px;display:block;margin-bottom:8px"/>`
      : `<div style="font-size:24px;font-weight:900;color:#195b98;letter-spacing:-.02em;margin-bottom:8px">MADAVISION</div>`

    // Logo société (droit du header)
    const logoSocHtml = logoSocieteUrl
      ? `<img src="${escapeHtml(logoSocieteUrl)}" alt="${escapeHtml(nomSociete)}" style="height:50px;display:block;margin-left:auto;margin-bottom:6px;object-fit:contain"/>`
      : ''

    // Lignes stands
    const standsRows = stands.length > 0
      ? stands.map(s => `
        <tr>
          <td style="padding:6px 12px;font-size:12px;color:#687e7e;border-bottom:1px solid #eef2f8">${escapeHtml(s.label||'—')}</td>
          <td style="padding:6px 12px;text-align:right;font-family:monospace;font-size:12px;color:#0d0d0d;border-bottom:1px solid #eef2f8">${fmtAr(s.prix||0)}</td>
        </tr>`).join('')
      : stands_TTC > 0 ? `<tr><td style="padding:6px 12px;font-size:12px;color:#687e7e;border-bottom:1px solid #eef2f8">Stands réservés</td><td style="padding:6px 12px;text-align:right;font-family:monospace;font-size:12px;color:#0d0d0d;border-bottom:1px solid #eef2f8">${fmtAr(stands_TTC)}</td></tr>` : ''

    // Lignes activités
    const activRows = activites.length > 0
      ? activites.map(a => `
        <tr>
          <td style="padding:6px 12px;font-size:12px;color:#687e7e;border-bottom:1px solid #eef2f8">${escapeHtml(a.label||'Activité optionnelle')}</td>
          <td style="padding:6px 12px;text-align:right;font-family:monospace;font-size:12px;color:#0d0d0d;border-bottom:1px solid #eef2f8">${fmtAr(a.prix||0)}</td>
        </tr>`).join('')
      : activ_TTC > 0 ? `<tr><td style="padding:6px 12px;font-size:12px;color:#687e7e;border-bottom:1px solid #eef2f8">Activités optionnelles</td><td style="padding:6px 12px;text-align:right;font-family:monospace;font-size:12px;color:#0d0d0d;border-bottom:1px solid #eef2f8">${fmtAr(activ_TTC)}</td></tr>` : ''

    // ─── EMAIL HTML ───────────────────────────────────────────────────
    const emailHtml = `<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#f0f2f5;font-family:Arial,Helvetica,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px;background:#f0f2f5">
<tr><td>
<table width="600" align="center" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%">

<!-- ══ HEADER ══ -->
<tr><td style="background:#195b98;padding:24px 28px;border-radius:10px 10px 0 0">
  <table width="100%" cellpadding="0" cellspacing="0">
  <tr>
    <!-- Gauche: logo MV + infos -->
    <td style="vertical-align:top;width:58%">
      ${logoMVHtml}
      <div style="font-size:10px;font-weight:700;color:rgba(255,255,255,.8);text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px">Foire Internationale de Madagascar 2026</div>
      <table cellpadding="0" cellspacing="0" style="font-size:11px;color:rgba(255,255,255,.75);line-height:1.95">
        ${process.env.MADAVISION_NIF     ? `<tr><td style="white-space:nowrap;padding-right:6px;color:rgba(255,255,255,.6)">NIF</td><td>${escapeHtml(process.env.MADAVISION_NIF)}</td></tr>` : ''}
        ${process.env.MADAVISION_STAT    ? `<tr><td style="padding-right:6px;color:rgba(255,255,255,.6)">STAT</td><td>${escapeHtml(process.env.MADAVISION_STAT)}</td></tr>` : ''}
        ${process.env.MADAVISION_ADRESSE ? `<tr><td style="padding-right:6px;color:rgba(255,255,255,.6)">Adresse</td><td>${escapeHtml(process.env.MADAVISION_ADRESSE)}</td></tr>` : ''}
        <tr><td style="padding-right:6px;color:rgba(255,255,255,.6)">Tél.</td><td>${escapeHtml(process.env.MADAVISION_TEL||'+261 34 00 000 00')}</td></tr>
        <tr><td style="padding-right:6px;color:rgba(255,255,255,.6)">Email</td><td>${escapeHtml(process.env.MADAVISION_EMAIL||'info@madavision.mg')}</td></tr>
        <tr><td style="padding-right:6px;color:rgba(255,255,255,.6)">Site</td><td>${escapeHtml(process.env.MADAVISION_WEBSITE||'www.madavision.mg')}</td></tr>
      </table>
    </td>
    <!-- Droite: logo société + nom -->
    <td style="vertical-align:top;text-align:right;width:42%">
      ${logoSocHtml}
      <div style="font-size:15px;font-weight:700;color:#fff;margin-top:${logoSocHtml?'6':'0'}px">${escapeHtml(nomSociete)}</div>
      ${numDossier ? `<div style="font-size:10px;color:rgba(255,255,255,.6);font-family:monospace;margin-top:4px">${escapeHtml(numDossier)}</div>` : ''}
    </td>
  </tr>
  </table>
</td></tr>

<!-- ══ CORPS ══ -->
<tr><td style="background:#fff;padding:28px;border:1px solid #dde3ee;border-top:none">

  <h2 style="margin:0 0 4px;font-size:20px;color:#195b98;font-weight:700">Confirmation d'inscription</h2>
  <p style="margin:0 0 20px;font-size:12px;color:#687e7e">Foire Internationale de Madagascar 2026</p>

  <p style="font-size:14px;color:#0d0d0d;margin:0 0 10px">Bonjour,</p>
  <p style="font-size:14px;color:#0d0d0d;margin:0 0 20px">
    Nous avons bien reçu l'inscription de <strong>${escapeHtml(nomSociete)}</strong>
    à la <strong>Foire Internationale de Madagascar 2026</strong>.
  </p>

  <!-- Numéro dossier -->
  <div style="background:#eef2f8;border-left:4px solid #195b98;padding:14px 18px;border-radius:0 8px 8px 0;margin-bottom:24px">
    <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#687e7e;margin-bottom:5px">Numéro de dossier</div>
    <div style="font-family:monospace;font-size:16px;font-weight:700;color:#195b98">${escapeHtml(numDossier||'—')}</div>
  </div>

  ${montantTTC > 0 ? `
  <!-- ══ TABLEAU FINANCIER ══ -->
  <!-- Logique: prix stands/activités = TTC inclus → taxe extraite à rebours -->
  <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #dde3ee;border-radius:8px;overflow:hidden;margin-bottom:24px">
    <tr><td colspan="2" style="background:#195b98;padding:10px 12px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#fff">
      Récapitulatif financier
    </td></tr>

    <!-- Stands -->
    ${standsRows}
    <!-- Activités -->
    ${activRows}

    <!-- Remise promo -->
    ${remise > 0 ? `<tr><td style="padding:6px 12px;font-size:12px;color:#1e7f54;border-bottom:1px solid #eef2f8">Remise code promo</td><td style="padding:6px 12px;text-align:right;font-family:monospace;font-size:12px;color:#1e7f54;border-bottom:1px solid #eef2f8">− ${fmtAr(remise)}</td></tr>` : ''}

    <!-- Montant TTC (base fiscale) -->
    <tr style="background:#f5f7fa">
      <td style="padding:8px 12px;font-size:13px;font-weight:700;color:#0d0d0d;border-bottom:1px solid #dde3ee">Montant TTC</td>
      <td style="padding:8px 12px;text-align:right;font-family:monospace;font-size:13px;font-weight:700;color:#0d0d0d;border-bottom:1px solid #dde3ee">${fmtAr(montantTTC)}</td>
    </tr>

    <!-- Détail fiscal (sur une ligne subtile) -->
    ${taux > 0 ? `
    <tr>
      <td style="padding:4px 12px 4px 20px;font-size:11px;color:#687e7e;border-bottom:1px solid #eef2f8">dont HT (base)</td>
      <td style="padding:4px 12px;text-align:right;font-family:monospace;font-size:11px;color:#687e7e;border-bottom:1px solid #eef2f8">${fmtAr(montantHT)}</td>
    </tr>
    <tr>
      <td style="padding:4px 12px 8px 20px;font-size:11px;color:#687e7e;border-bottom:1px solid #dde3ee">dont ${tauxLabel}</td>
      <td style="padding:4px 12px 8px;text-align:right;font-family:monospace;font-size:11px;color:#687e7e;border-bottom:1px solid #dde3ee">${fmtAr(montantTaxe)}</td>
    </tr>` : ''}

    <!-- Voucher -->
    ${voucher > 0 ? `<tr><td style="padding:6px 12px;font-size:12px;color:#c87b2f;border-bottom:1px solid #eef2f8">Voucher utilisé</td><td style="padding:6px 12px;text-align:right;font-family:monospace;font-size:12px;color:#c87b2f;border-bottom:1px solid #eef2f8">− ${fmtAr(voucher)}</td></tr>` : ''}

    <!-- NET À PAYER -->
    <tr style="background:#195b98">
      <td style="padding:13px 12px;font-size:14px;font-weight:700;color:#fff">NET À PAYER</td>
      <td style="padding:13px 12px;text-align:right;font-family:monospace;font-size:17px;font-weight:700;color:#fff">${fmtAr(netAPayer)}</td>
    </tr>
  </table>

  <!-- Calendrier paiements -->
  <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px">
  <tr>
    <td width="49%" style="background:#fff8ec;border:1px solid #f5c97a;border-radius:8px;padding:14px;text-align:center;vertical-align:top">
      <div style="font-size:10px;font-weight:700;text-transform:uppercase;color:#687e7e;letter-spacing:.06em;margin-bottom:5px">Acompte 50 % — J+7</div>
      <div style="font-family:monospace;font-size:20px;font-weight:700;color:#c87b2f">${fmtAr(acompte50)}</div>
      <div style="font-size:10px;color:#687e7e;margin-top:4px">après validation du dossier</div>
    </td>
    <td width="2%"></td>
    <td width="49%" style="background:#f5f7fa;border:1px solid #dde3ee;border-radius:8px;padding:14px;text-align:center;vertical-align:top">
      <div style="font-size:10px;font-weight:700;text-transform:uppercase;color:#687e7e;letter-spacing:.06em;margin-bottom:5px">Solde 50 % — J+20</div>
      <div style="font-family:monospace;font-size:20px;font-weight:700;color:#687e7e">${fmtAr(acompte50)}</div>
      <div style="font-size:10px;color:#687e7e;margin-top:4px">après réception de l'acompte</div>
    </td>
  </tr>
  </table>
  ` : ''}

  <p style="font-size:13px;color:#0d0d0d;margin:0 0 16px">
    Vous trouverez en pièce jointe votre <strong>dossier d'inscription complet</strong>.
  </p>

  ${dashboardUrl ? `
  <div style="background:#eef2f8;border:1px solid #b8cbe8;border-radius:8px;padding:16px 18px;margin-bottom:20px">
    <div style="font-size:13px;font-weight:700;color:#195b98;margin-bottom:8px">🔑 Votre espace exposant</div>
    <div style="font-size:12px;color:#687e7e;margin-bottom:12px">Suivez votre dossier et vos paiements en temps réel :</div>
    <a href="${escapeHtml(dashboardUrl)}" style="background:#195b98;color:#fff;text-decoration:none;padding:10px 22px;border-radius:6px;display:inline-block;font-weight:700;font-size:13px">Accéder à mon espace →</a>
  </div>` : ''}

  <!-- Prochaines étapes -->
  <div style="background:#f5f7fa;border-radius:8px;padding:16px 20px;margin-bottom:20px">
    <div style="font-size:11px;font-weight:700;color:#195b98;text-transform:uppercase;letter-spacing:.07em;margin-bottom:10px">Prochaines étapes</div>
    <ol style="margin:0;padding-left:18px;font-size:12px;color:#0d0d0d;line-height:2.1">
      <li>Validation du dossier par l'administration Madavision</li>
      <li>Règlement de l'<strong>acompte 50 %</strong> sous <strong>7 jours</strong> après validation</li>
      <li>Signature du contrat et confirmation du stand</li>
      <li>Règlement du <strong>solde 50 %</strong> sous 20 jours après l'acompte</li>
      <li>Remise des badges et invitations après solde complet</li>
    </ol>
  </div>

  <!-- Avertissement -->
  <div style="border-left:4px solid #c0392b;background:#fdecea;padding:12px 16px;border-radius:0 6px 6px 0;margin-bottom:20px">
    <div style="font-size:12px;color:#c0392b;font-weight:700;margin-bottom:3px">⚠ Politique d'annulation</div>
    <div style="font-size:11px;color:#0d0d0d;line-height:1.6">
      L'acompte versé est <strong>intégralement conservé</strong> par Madavision en cas d'annulation.
      Sans acompte sous 7 jours : annulation automatique.
    </div>
  </div>

  <p style="font-size:13px;color:#0d0d0d;margin:0 0 6px">
    Pour toute question : <a href="mailto:${escapeHtml(process.env.MADAVISION_EMAIL||'info@madavision.mg')}" style="color:#195b98">${escapeHtml(process.env.MADAVISION_EMAIL||'info@madavision.mg')}</a>
  </p>
  <p style="font-size:13px;color:#0d0d0d;margin:0">Cordialement,<br><strong style="color:#195b98">L'équipe Madavision</strong></p>

</td></tr>

<!-- ══ FOOTER ══ -->
<tr><td style="background:#195b98;padding:14px 28px;border-radius:0 0 10px 10px;text-align:center">
  <div style="font-size:11px;color:rgba(255,255,255,.7)">Madavision — Foire Internationale de Madagascar 2026</div>
  <div style="font-size:10px;color:rgba(255,255,255,.45);margin-top:3px">Cet email a été envoyé automatiquement — vous pouvez y répondre directement.</div>
</td></tr>

</table>
</td></tr></table>
</body></html>`

    const safeName   = String(nomSociete).replace(/[^a-zA-Z0-9-_]/g,'_').slice(0,40)
    const filename   = `Dossier_${(numDossier||'export').replace(/[^a-zA-Z0-9-_]/g,'_')}_${safeName}.html`
    const mailOptions = {
      from:        `"${EMAIL_CONFIG.fromName}" <${EMAIL_CONFIG.fromAddress}>`,
      to:          email,
      subject:     `[FIM 2026] Confirmation d'inscription — ${nomSociete}`,
      html:        emailHtml,
      attachments: htmlDossier ? [{ filename, content: htmlDossier, contentType: 'text/html; charset=utf-8' }] : [],
    }
    if (EMAIL_CONFIG.bcc) mailOptions.bcc = EMAIL_CONFIG.bcc

    const info = await mailTransporter.sendMail(mailOptions)
    console.log(`✓ [send-dossier] Email → ${email} | msgId: ${info.messageId}`)
    res.json({ success: true, messageId: info.messageId, message: `Email envoyé à ${email}` })

  } catch(e) {
    console.error('[send-dossier]', e.message)
    res.status(500).json({ error: DEBUG ? e.message : "Impossible d'envoyer l'email." })
  }
})

module.exports = router
