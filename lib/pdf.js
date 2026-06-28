const PDFDocument = require('pdfkit')
const fs   = require('fs')
const path = require('path')
const QRCode = require('qrcode')

const { DEBUG } = require('../config')
const { ATBASE, headers, atGet, atFind, escapeFormula } = require('./airtable')

const FONT_DIR = path.join(__dirname, '..', 'assets', 'fonts')

function fmtMoney(value) {
  const n = Math.round(Number(value || 0))
  return n.toLocaleString('fr-FR', { maximumFractionDigits: 0 }).replace(/\s/g, '.') + ' Ar'
}

function fmtMoneyRaw(value) {
  const n = Math.round(Number(value || 0))
  return n.toLocaleString('fr-FR', { maximumFractionDigits: 0 }).replace(/\s/g, '.')
}

/**
 * Enregistre la famille Poppins dans un document PDFKit
 */
function registerFonts(doc) {
  try {
    doc.registerFont('Poppins-Light',   path.join(FONT_DIR, 'Poppins-Light.ttf'))
    doc.registerFont('Poppins-Regular', path.join(FONT_DIR, 'Poppins-Regular.ttf'))
    doc.registerFont('Poppins-Medium',  path.join(FONT_DIR, 'Poppins-Medium.ttf'))
    doc.registerFont('Poppins-Bold',    path.join(FONT_DIR, 'Poppins-Bold.ttf'))
  } catch (e) {
    console.warn('⚠ Impossible de charger Poppins pour le PDF, repli sur Helvetica:', e.message)
  }
}

/**
 * Télécharge une image depuis une URL pour PDFKit
 */
async function fetchImageBuffer(url) {
  if (!url) return null
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    return Buffer.from(await res.arrayBuffer())
  } catch (e) {
    console.warn(`[PDF] Erreur téléchargement logo : ${url}`, e.message)
    return null
  }
}

/**
 * Télécharge une image vers Cloudinary si nécessaire et retourne l'URL sécurisée
 */
async function handleImageUpload(input, folder = 'logos') {
  if (!input) return null
  // Si c'est déjà une URL HTTP, on ne fait rien
  if (String(input).startsWith('http')) return input
  const { cloudinary } = require('../config')
  try {
    const res = await cloudinary.uploader.upload(input, {
      folder: `madavision/${folder}`,
    })
    return res.secure_url
  } catch (e) {
    console.error('[Cloudinary] Erreur upload :', e.message)
    return null
  }
}

// ── Génération PDF du dossier d'inscription ──────────────────
async function generateInscriptionPDF(data) {
  const logoExposantBuffer = await fetchImageBuffer(data.logoSocieteUrl)

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, compress: true })
    const bufs = []
    doc.on('data', b => bufs.push(b))
    doc.on('end',  () => resolve(Buffer.concat(bufs)))
    doc.on('error', reject)

    registerFonts(doc)

    const BLEU  = '#195b98'
    const GRIS  = '#687e7e'
    const NOIR  = '#0d0d0d'
    const LGRIS = '#E8E3DA'
    const W     = 495

    // --- HEADER ---
    doc.rect(50, 50, W, 110).fill(BLEU)

    const logoMadPath = '/Users/mac/Desktop/my_project/MADAVISION/madavision-react/assets/logo/madavision-logo.png'
    if (fs.existsSync(logoMadPath)) {
      doc.image(logoMadPath, 65, 60, { width: 55 })
    }

    doc.fillColor('#fff').font('Poppins-Bold').fontSize(13)
      .text('MADAVISION', 130, 60)
    doc.font('Poppins-Regular').fontSize(7.5).fillColor('#E6F4F4')
      .text('NIF : 3000001053 • STAT : 92391 11 1993 0 00002', 130, 75)
      .text('Enceinte Gare Soarano, Analakely, Antananarivo', 130, 85)
      .text('Tel : +261 20 22 235 44 • Email : contact@madavision.mg', 130, 95)
      .text('www.madavision.mg', 130, 105)

    // Logo exposant ou Nom à droite
    const nomSocPdf = data.nomSociete || data.nomSoc || ''
    if (nomSocPdf) {
      doc.fillColor('#fff').font('Poppins-Bold').fontSize(11)
        .text(nomSocPdf.toUpperCase(), 380, 60, { width: 155, align: 'right' })
      doc.fillColor('#E6F4F4').font('Poppins-Regular').fontSize(7)
        .text('SOCIÉTÉ EXPOSANTE', 380, 75, { width: 155, align: 'right' })

      if (logoExposantBuffer) {
        doc.image(logoExposantBuffer, 495, 85, { width: 40 })
      }
    }

    let y = 175

    // --- Numéro de dossier ---
    doc.rect(50, y, W, 40).fillAndStroke('#E6F4F4', BLEU)
    doc.fillColor(BLEU).font('Poppins-Bold').fontSize(10).text('NUMÉRO DE DOSSIER', 65, y + 8)
    doc.font('Poppins-Bold').fontSize(16).text(data.numDossier || '—', 65, y + 22)
    doc.fillColor(NOIR)
    y += 58

    function section(title) {
      doc.rect(50, y, W, 24).fill('#F5F3EF')
      doc.fillColor(BLEU).font('Poppins-Bold').fontSize(9)
        .text(title.toUpperCase(), 65, y + 8)
      doc.fillColor(NOIR)
      y += 32
    }

    function row(label, value, indent = 65) {
      if (!value) return
      if (y > 760) { doc.addPage(); y = 60 }
      doc.font('Poppins-Regular').fontSize(9).fillColor(GRIS).text(label, indent, y, { width: 160 })
      doc.font('Poppins-Bold').fontSize(9).fillColor(NOIR).text(String(value), indent + 165, y, { width: W - 165 - 15, align: 'right' })
      y += 16
    }

    function separator() {
      doc.moveTo(50, y).lineTo(545, y).strokeColor(LGRIS).lineWidth(0.5).stroke()
      y += 10
    }

    // ── Salon ──
    section('Salon')
    row('Salon', data.salonLabel)
    row('Lieu', data.salonLieu)
    if (data.salonDateDebut || data.salonDateFin) {
      const d1 = data.salonDateDebut ? new Date(data.salonDateDebut).toLocaleDateString('fr-FR', { day:'2-digit', month:'long', year:'numeric' }) : ''
      const d2 = data.salonDateFin   ? new Date(data.salonDateFin).toLocaleDateString('fr-FR',   { day:'2-digit', month:'long', year:'numeric' }) : ''
      row('Dates', [d1, d2].filter(Boolean).join(' — '))
    }
    separator()

    // ── Société ──
    section('Société / Exposant')
    row('Raison sociale', data.nomSociete || data.nomSoc)
    row("Nom de participation", data.nomParticipation)
    row('Type d\'entité', data.typeEntite)
    row('Statut exposant', data.statutExposant)
    row('Secteur', data.secteur)
    row('NIF', data.nif)
    row('STAT', data.stat)
    row('Adresse', data.adresse)
    separator()

    // ── Contact ──
    section('Contact principal')
    row('Nom', data.contact)
    row('Fonction', data.fonction)
    row('Email', data.email)
    row('Téléphone', data.telephone)
    separator()

    // ── Stands ──
    section('Stands réservés')
    const stands = Array.isArray(data.stands) ? data.stands : []
    if (stands.length === 0) {
      doc.font('Poppins-Regular').fontSize(9).fillColor(GRIS).text('—', 65, y); y += 16
    } else {
      stands.forEach(s => {
        const label = s.label || s.produitId || '—'
        const surf  = s.surface ? `  ${String(s.surface).replace(/\s*m²?/i,'')} m²` : ''
        const prix  = s.prix ? `${fmtMoneyRaw(s.prix)} Ar` : ''
        doc.font('Poppins-Bold').fontSize(9).fillColor(NOIR).text(label + surf, 65, y, { width: W - 180 })
        if (prix) doc.font('Poppins-Regular').fontSize(9).fillColor(BLEU).text(prix, 400, y, { width: 145, align: 'right' })
        y += 16
        if (y > 760) { doc.addPage(); y = 60 }
      })
    }
    separator()

    // ── Activités optionnelles ──
    const optActs = Array.isArray(data.optionalActivities) ? data.optionalActivities : []
    if (optActs.length > 0) {
      section('Activités & Services optionnels')
      optActs.forEach(act => {
        const label = act.label || '—'
        const prix  = act.prix ? `${fmtMoneyRaw(act.prix)} Ar` : ''
        doc.font('Poppins-Bold').fontSize(9).fillColor(NOIR).text(label, 65, y, { width: W - 180 })
        if (prix) doc.font('Poppins-Regular').fontSize(9).fillColor(BLEU).text(prix, 400, y, { width: 145, align: 'right' })
        y += 16
        if (y > 760) { doc.addPage(); y = 60 }
      })
      separator()
    }

    // ── Suppléments & Services ──
    const supplements = Array.isArray(data.supplements) ? data.supplements : []
    if (supplements.length > 0) {
      section('Suppléments & Services')
      supplements.forEach(item => {
        const label = item.label || '—'
        const prix = item.prix ? `${fmtMoneyRaw(item.prix)} Ar` : ''
        doc.font('Poppins-Bold').fontSize(9).fillColor(NOIR).text(label, 65, y, { width: W - 180 })
        if (prix) doc.font('Poppins-Regular').fontSize(9).fillColor(BLEU).text(prix, 400, y, { width: 145, align: 'right' })
        y += 16
        if (y > 760) { doc.addPage(); y = 60 }
      })
      separator()
    }

    // ── Badges, Invitations, Parking VIP ──
    section('Badges & Accès')
    row('Badges exposant', data.nbBadges || '—')
    row('Invitations', data.nbInvitations || '—')
    row('Accès parking VIP', data.accesParkingVIP || '—')
    separator()

    // ── Régime fiscal ──
    if (data.regimeFiscal) {
      const rl = { '0.2':'TVA 20 %', '0.08':'Taxe 8 %', '0':'Taxe 3ème taux (3 %)' }
      section('Régime fiscal')
      row('Régime choisi', rl[data.regimeFiscal] || data.regimeFiscal)
      separator()
    }

    // ── Pied de page ──
    const today = new Date().toLocaleDateString('fr-FR', { day:'2-digit', month:'long', year:'numeric' })
    y += 10

    // --- Calcul dynamique des totaux ---
    const totalHTStands = stands.reduce((sum, s) => sum + (Number(s.prix) || 0), 0)
    const totalHTActs = (data.optionalActivities || []).reduce((sum, a) => sum + (Number(a.prix) || 0), 0)
    const totalHTSupps = (data.supplements || []).reduce((sum, s) => sum + (Number(s.prix) || 0), 0)
    const totalHT = totalHTStands + totalHTActs + totalHTSupps

    const taxRate = parseFloat(data.regimeFiscal) || 0
    const montantTTC = totalHT
    const montantHT  = taxRate > 0 ? Math.round(montantTTC / (1 + taxRate)) : montantTTC
    const montantTaxe = Math.round(montantHT * taxRate)

    const taxLabels = { '0.2': 'TVA 20%', '0.08': 'Taxe 8%', '0': 'Exonéré (0%)' }
    const currentTaxLabel = taxLabels[data.regimeFiscal] || (taxRate > 0 ? `${taxRate * 100}%` : '—')

    if (y > 600) { doc.addPage(); y = 60 } // Évite de couper le tableau financier

    section('Récapitulatif financier')
    // row('Total TTC (Stands + Activités)', fmtMoney(totalHT))
    row('Total HT (Stands + Activités)', fmtMoney(montantHT))
    row('Régime fiscal appliqué', currentTaxLabel)
    row('Montant de la taxe', fmtMoney(montantTaxe))

    y += 8
    doc.rect(50, y, W, 30).fill(BLEU)
    doc.fillColor('#fff').font('Poppins-Bold').fontSize(12)
       .text('MONTANT TOTAL TTC', 65, y + 9)
    doc.text(fmtMoney(montantTTC), 400, y + 10, { width: 135, align: 'right' })
    y += 50

    // --- MODALITÉS DE RÈGLEMENT ---
    if (y > 620) { doc.addPage(); y = 60 }
    doc.rect(50, y, W, 20).fill('#F5F3EF')
    doc.fillColor(BLEU).font('Poppins-Bold').fontSize(9).text('MODALITÉS DE RÈGLEMENT', 65, y + 6)
    y += 30

    // RIB
    doc.fillColor(NOIR).font('Poppins-Bold').fontSize(8).text('VIREMENT BANCAIRE OU CHÈQUE', 65, y)
    doc.font('Poppins-Regular').fontSize(8).fillColor(GRIS)
      .text('Banque : Bred Madagasikara', 65, y + 12)
      .text('Compte : 00008/00006 02001009138 17', 65, y + 24)
      .text('Ordre : Madavision', 65, y + 36)

    // Mobile Money
    doc.fillColor(NOIR).font('Poppins-Bold').fontSize(8).text('MOBILE MONEY', 300, y)
    doc.font('Poppins-Regular').fontSize(8).fillColor(GRIS)
      .text('MVOLA : 038 17 250 11', 300, y + 12)
      .text('AIRTEL MONEY : 033 17 250 11', 300, y + 24)
      .text('ORANGE MONEY : 032 17 250 11', 300, y + 36)
    y += 60

    if (data.totalsCalc || true) {
      separator()

      section('Calendrier de paiement')
      row('Date validation', data.dateValidation || '—')
      row('Acompte 50% dû le', data.dateAcompte || '—')
      row('Solde 50% dû le', data.dateSolde || '—')
      doc.font('Poppins-Regular').fontSize(9).fillColor(GRIS).text('Note: Les dates sont indicatives et peuvent être ajustées.', 65, y)
      y += 20
      separator()
    }


    doc.rect(50, y, W, 1).fill(BLEU)
    y += 10
    doc.font('Poppins-Regular').fontSize(8).fillColor(GRIS)
      .text(`Dossier généré le ${today} — Madavision`, 50, y, { width: W, align: 'center' })

    doc.end()
  })
}

// ── Shared helpers ────────────────────────────────────────────

async function findCommandeByAccessToken(rawToken) {
  const token = String(rawToken || '').toUpperCase().replace('TOKEN:', '').replace(/[^A-Z0-9]/g, '')
  if (!token || token.length < 5) return null
  const safeToken = escapeFormula(token)
  const formula = `OR({Token d'accès}="${safeToken}", FIND("TOKEN:${safeToken}", {Notes}) > 0)`
  const records = await atFind('Commandes', formula)
  return records[0] || null
}

function buildExposantDocuments({ token, cmd, documentsFinanciers = [] }) {
  const cf = cmd?.fields || {}
  const cleanToken = String(token || '').toUpperCase().replace('TOKEN:', '').replace(/[^A-Z0-9]/g, '')
  const dossierNumber = cf['Numero de dossier'] || cf['ID Commande'] || cmd?.id?.slice(-8).toUpperCase() || ''
  const statusText = [
    cf['Validation'],
    cf['Statut commande'],
    cf['Statut'],
  ].filter(Boolean).join(' ')
  const normalizedStatus = statusText
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
  const isCancelledOrRejected = /annul|rejet/.test(normalizedStatus)
  const isValidated = /\b(valide|confirme|confirmer|paye|solde|bc recu)\b/.test(normalizedStatus)
  const documents = []

  documents.push({
    id: 'dossier-inscription',
    type: 'Dossier',
    title: "Dossier d'inscription",
    filename: 'dossier-inscription.pdf',
    reference: dossierNumber,
    date: cf['Date commande'] || '',
    status: 'Disponible',
    description: "Dossier d'inscription complet généré depuis les informations du dossier.",
    downloadUrl: `/exposant/${cleanToken}/download-dossier`,
  })

  if (!isCancelledOrRejected && isValidated) {
    documents.push({
      id: 'proforma-contrat',
      type: 'Proforma',
      title: 'Facture proforma + contrat CGV',
      filename: `${invoiceSafeFilename(`proforma-contrat-${dossierNumber || cmd.id}`)}.pdf`,
      reference: dossierNumber,
      date: cf['Date validation'] || cf['Date commande'] || '',
      status: 'Disponible',
      description: 'Facture proforma et engagement CGV dans un seul fichier PDF.',
      downloadUrl: `/exposant/${cleanToken}/download-proforma-contract`,
    })

    documents.push({
      id: 'facture-finale',
      type: 'Facture',
      title: 'Facture PDF',
      filename: `${invoiceSafeFilename(`FACT-${dossierNumber || cmd.id}`)}.pdf`,
      reference: dossierNumber,
      date: cf['Date validation'] || cf['Date commande'] || '',
      amount: cf['Net a payer'] || cf['Total TTC'] || 0,
      status: 'Disponible',
      description: 'Facture générée à partir des montants, remises, vouchers et taxes du dossier.',
      downloadUrl: `/exposant/${cleanToken}/download-invoice`,
    })
  }

  documentsFinanciers.forEach((doc, index) => {
    const files = Array.isArray(doc.pdfUrls) ? doc.pdfUrls : []
    if (files.length === 0) {
      documents.push({
        id: `finance-${doc.id || index}`,
        type: doc.type || 'Document financier',
        title: doc.type || 'Document financier',
        filename: doc.reference || 'document-financier.pdf',
        reference: doc.reference || '',
        date: doc.dateEmission || '',
        amount: doc.ttc || doc.montantHT || 0,
        status: doc.statut || 'PDF non disponible',
        description: 'Document financier enregistré dans Airtable.',
        disabled: true,
      })
      return
    }

    files.forEach((file, fileIndex) => {
      documents.push({
        id: `finance-${doc.id || index}-${fileIndex}`,
        type: doc.type || 'Document financier',
        title: doc.type || 'Document financier',
        filename: file.filename || doc.reference || 'document-financier.pdf',
        reference: doc.reference || '',
        date: doc.dateEmission || '',
        amount: doc.ttc || doc.montantHT || 0,
        status: doc.statut || 'Disponible',
        description: 'Document financier enregistré dans Airtable.',
        externalUrl: file.url,
      })
    })
  })

  const notes = String(cf['Notes'] || '')
  const bcMatches = [...notes.matchAll(/\[BC ([^\]]+)\] ([^\n]+)/g)]
  bcMatches.forEach((match, index) => {
    const filename = String(match[2] || '').trim()
    if (!filename) return
    documents.push({
      id: `bc-${index}`,
      type: 'BC',
      title: 'Bon de Commande déposé',
      filename,
      reference: dossierNumber,
      date: match[1] || '',
      status: 'Déposé',
      description: "Bon de Commande transmis à l'administration Madavision.",
      downloadUrl: `/exposant/${cleanToken}/download-bc/${encodeURIComponent(filename)}`,
    })
  })

  return documents
}

function linkedRecordId(value) {
  const values = Array.isArray(value) ? value : (value ? [value] : [])
  for (const item of values) {
    const id = typeof item === 'string'
      ? item
      : (item?.id || item?.recordId || item?.airtableId || '')
    const cleanId = String(id || '').trim()
    if (cleanId.startsWith('rec')) return cleanId
  }
  return null
}

async function atRecordById(table, id) {
  const cleanId = String(id || '').trim()
  if (!cleanId.startsWith('rec')) return null
  const records = await atFind(table, `RECORD_ID()="${escapeFormula(cleanId)}"`)
  return records[0] || null
}

function mapCommercialAccountOption(record) {
  const f = record.fields || {}
  const nom = f['Nom'] || f['Nom complet'] || f['Prénom Nom'] || record.id
  return {
    id: record.id,
    nom,
    email: f['Email'] || f['Email professionnel'] || f['Mail'] || '',
    telephone: f['Téléphone'] || f['Tel'] || '',
  }
}

function mapSocieteAccountOption(record) {
  const f = record.fields || {}
  return {
    id: record.id,
    nom: f['Raison sociale'] || f['Nom'] || f['Name'] || record.id,
    email: f['Email'] || '',
    idEntreprise: f['ID Entreprise'] || '',
    telephone: f['Téléphone'] || '',
  }
}

function normalizeDateOnly(value, label) {
  const clean = String(value || '').trim()
  if (!clean) return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(clean)) {
    throw new Error(`${label} doit être au format YYYY-MM-DD`)
  }
  const parsed = new Date(`${clean}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${label} invalide`)
  }
  return clean
}

function paymentCalendarFields(body = {}, { includeValidation = true } = {}) {
  const mapping = [
    ...(includeValidation ? [['dateValidation', 'Date validation', 'Date validation']] : []),
    ['dateAcompte', 'Date J+7', 'Acompte 50 %'],
    ['dateSolde', 'Date 20J', 'Solde 50 %'],
  ]
  const fields = {}
  mapping.forEach(([key, fieldName, label]) => {
    if (!Object.prototype.hasOwnProperty.call(body, key)) return
    fields[fieldName] = normalizeDateOnly(body[key], label)
  })
  if (Object.keys(fields).length === 0) {
    throw new Error('Aucune date à mettre à jour')
  }
  return fields
}

async function patchCommandeFields(cmdId, fields) {
  const resp = await fetch(`${ATBASE}/${encodeURIComponent('Commandes')}/${cmdId}`, {
    method: 'PATCH',
    headers: headers(),
    body: JSON.stringify({ fields }),
  })
  const data = await resp.json()
  if (!resp.ok) {
    const msg = data?.error?.message || `HTTP ${resp.status}`
    throw new Error(`Mise à jour commande impossible : ${msg}`)
  }
  return data
}

function paymentCalendarPayload(record) {
  const f = record.fields || {}
  return {
    id: record.id,
    dateValidation: f['Date validation'] || null,
    dateAcompte: f['Date J+7'] || f['Date acompte'] || null,
    dateSolde: f['Date 20J'] || f['Date solde'] || null,
  }
}

function getCommercialSocietes_sync() {
  // placeholder — actual implementation below
}

async function getCommercialSocietes(commercialId) {
  const records = await atGet('Sociétés')
  const map = {}
  records.forEach(r => {
    const f = r.fields || {}
    const commIds = Array.isArray(f['Commerciaux']) ? f['Commerciaux'] : []
    if (!commIds.includes(commercialId)) return
    map[r.id] = {
      id: r.id,
      nom: f['Raison sociale'] || f['Nom'] || f['Name'] || r.id,
      email: f['Email'] || '',
      telephone: String(f['Téléphone'] || ''),
      contact: f['Contact principal'] || '',
      commIds,
      raw: f,
    }
  })
  return map
}

// ── Invoice helpers ────────────────────────────────────────────

function invoiceMoney(value) {
  if (typeof value === 'number') return value
  if (Array.isArray(value)) return invoiceMoney(value[0])
  return parseFloat(String(value || 0).replace(/[^0-9.,-]/g, '').replace(',', '.')) || 0
}

function invoiceText(...values) {
  for (const value of values) {
    if (Array.isArray(value)) {
      const nested = invoiceText(...value)
      if (nested) return nested
    } else if (value !== null && value !== undefined) {
      const text = String(value).trim()
      if (text && !text.startsWith('rec')) return text
    }
  }
  return ''
}

function invoiceLinkedIds(value) {
  const values = Array.isArray(value) ? value : (value ? [value] : [])
  return values
    .map(v => typeof v === 'string' ? v : (v?.id || v?.recordId || v?.airtableId || ''))
    .map(v => String(v || '').trim())
    .filter(v => v.startsWith('rec'))
}

function invoicePickMoney(fields, names, fallback = 0) {
  for (const name of names) {
    if (fields[name] !== undefined && fields[name] !== null && fields[name] !== '') {
      return invoiceMoney(fields[name])
    }
  }
  return fallback
}

function invoiceTaxLabel(value, regimeFiscal = '') {
  const raw = invoiceText(value, regimeFiscal)
  if (raw.includes('20')) return '20 %'
  if (raw.includes('8')) return '8 %'
  if (raw.includes('3')) return '3 %'
  const numeric = invoiceMoney(raw)
  if (numeric > 0 && numeric <= 1) return `${Math.round(numeric * 100)} %`
  if (numeric > 1) return `${numeric.toLocaleString('fr-FR')} %`
  return raw || '—'
}

function invoiceFormatMoney(value) {
  return `${fmtMoneyRaw(value)} Ar`
}

function invoiceFormatMoneyBare(value) {
  return fmtMoneyRaw(value)
}

function invoiceFormatDate(value) {
  const text = invoiceText(value)
  if (!text) return '—'
  const date = new Date(text)
  if (Number.isNaN(date.getTime())) return text
  return date.toLocaleDateString('fr-FR')
}

function invoiceNumberToFrench(value) {
  const n = Math.max(0, Math.round(Number(value || 0)))
  const units = ['ZERO', 'UN', 'DEUX', 'TROIS', 'QUATRE', 'CINQ', 'SIX', 'SEPT', 'HUIT', 'NEUF', 'DIX', 'ONZE', 'DOUZE', 'TREIZE', 'QUATORZE', 'QUINZE', 'SEIZE']
  const tens = ['', '', 'VINGT', 'TRENTE', 'QUARANTE', 'CINQUANTE', 'SOIXANTE']

  function underHundred(num) {
    if (num < 17) return units[num]
    if (num < 20) return `DIX ${units[num - 10]}`
    if (num < 70) {
      const t = Math.floor(num / 10)
      const u = num % 10
      if (u === 0) return tens[t]
      if (u === 1) return `${tens[t]} ET UN`
      return `${tens[t]} ${units[u]}`
    }
    if (num < 80) {
      if (num === 71) return 'SOIXANTE ET ONZE'
      return `SOIXANTE ${underHundred(num - 60)}`
    }
    if (num === 80) return 'QUATRE VINGTS'
    return `QUATRE VINGT ${underHundred(num - 80)}`
  }

  function underThousand(num) {
    if (num < 100) return underHundred(num)
    const h = Math.floor(num / 100)
    const r = num % 100
    const hundred = h === 1 ? 'CENT' : `${units[h]} CENT`
    if (!r) return h > 1 ? `${hundred}S` : hundred
    return `${hundred} ${underHundred(r)}`
  }

  function group(num, divisor, singular, plural) {
    const q = Math.floor(num / divisor)
    const r = num % divisor
    const label = q > 1 ? plural : singular
    const prefix = q === 1 && singular === 'MILLE' ? singular : `${invoiceNumberToFrench(q)} ${label}`
    return r ? `${prefix} ${invoiceNumberToFrench(r)}` : prefix
  }

  if (n < 1000) return underThousand(n)
  if (n < 1000000) return group(n, 1000, 'MILLE', 'MILLE')
  if (n < 1000000000) return group(n, 1000000, 'MILLION', 'MILLIONS')
  return group(n, 1000000000, 'MILLIARD', 'MILLIARDS')
}

function invoiceAmountInWords(value) {
  return `${invoiceNumberToFrench(value)} ARIARY`
}

function invoiceSafeFilename(value) {
  return String(value || 'facture')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90) || 'facture'
}

function invoiceMadavisionLogoPath() {
  return [
    path.join(__dirname, '..', '..', 'logo_madavision.png'),
    path.join(__dirname, '..', '..', 'madavision-react', 'assets', 'logo', 'madavision-logo.png'),
    path.join(__dirname, '..', 'assets', 'logo_madavision.png'),
  ].find(p => fs.existsSync(p)) || null
}

function invoiceHeaderImagePath() {
  const headerPath = path.join(__dirname, '..', 'assets', 'entete.png')
  return fs.existsSync(headerPath) ? headerPath : null
}

async function invoiceFetchRecord(table, id) {
  if (!id) return null
  const resp = await fetch(`${ATBASE}/${encodeURIComponent(table)}/${id}`, { headers: headers() })
  if (!resp.ok) return null
  return resp.json()
}

async function resolveEditionAndSalon(editionId, directSalonId = null) {
  // Puisque Édition == Salon, on fetch directement dans Salons
  const idToFetch = editionId || directSalonId
  const salonData = await invoiceFetchRecord('Salons', idToFetch)
  const f = salonData?.fields || {}

  return {
    edition: { id: idToFetch, nom: f['Edition'] || f['Édition'] || f['Nom édition'] || '' },
    evenement: { id: idToFetch, nom: f['Nom du salon'] || f['Nom'] || f['Name'] || f['ID Salon'] || '', lieu: f['Lieu'] }
  }
}

async function fetchFirstRecordFromTables(tableNames, id) {
  for (const table of tableNames) {
    const record = await invoiceFetchRecord(table, id)
    if (record) return record
  }
  return null
}

function mapBilanPuissanceRecord(record) {
  const f = record.fields || {}
  const rawStatus = f['Status'] ?? f['Statut']
  let status = 'Actif'
  if (rawStatus === 'Non Actif' || rawStatus === 'Inactif' || rawStatus === false) status = 'Non Actif'
  else if (rawStatus === 'Actif' || rawStatus === true || rawStatus === 'Active') status = 'Actif'

  return {
    id: record.id,
    materiel: f['Materiel'] || f['Matériel'] || f['Appareil'] || f['Équipement'] || '',
    puissance: invoiceMoney(f['Puissance']),
    status,
    nombre: f['Nombre'] || f['Quantité'] || 1,
    duree: f['Duree utilisation'] || f['Durée utilisation'] || 0,
  }
}

async function fetchBilanPuissance(cmdId, commandeFields = {}) {
  const tableNames = ['Bilan de puissance', 'Bilan de Puissance']
  const linkedIds = invoiceLinkedIds(
    commandeFields['Puissance'] ||
    commandeFields['Bilan de puissance'] ||
    commandeFields['Bilan de Puissance']
  )

  if (linkedIds.length > 0) {
    const records = []
    for (const id of linkedIds) {
      const record = await fetchFirstRecordFromTables(tableNames, id)
      if (record) records.push(record)
    }
    return records.map(mapBilanPuissanceRecord)
  }

  const formulas = [
    `{Commandes} = "${cmdId}"`,
    `{Commande} = "${cmdId}"`,
    `FIND("${cmdId}", ARRAYJOIN({Commandes}))`,
    `FIND("${cmdId}", ARRAYJOIN({Commande}))`,
  ]

  for (const table of tableNames) {
    for (const formula of formulas) {
      try {
        const records = await atGet(table, `filterByFormula=${encodeURIComponent(formula)}`)
        if (records.length > 0) return records.map(mapBilanPuissanceRecord)
      } catch {
        // Champ absent ou table alternative: on essaie la variante suivante.
      }
    }
  }

  return []
}

async function invoiceResolveLinkedLabel(table, ids, fieldNames) {
  const id = invoiceLinkedIds(ids)[0]
  if (!id) return ''
  const record = await invoiceFetchRecord(table, id)
  const fields = record?.fields || {}
  return invoiceText(...fieldNames.map(name => fields[name]))
}

async function buildInvoiceData(cmdId, { commercialId } = {}) {
  const cmd = await invoiceFetchRecord('Commandes', cmdId)
  if (!cmd) {
    const err = new Error('Commande introuvable')
    err.statusCode = 404
    throw err
  }
  const cf = cmd.fields || {}

  const societeId = invoiceLinkedIds(cf['Societé'] || cf['Société'])[0]
  const societeRecord = await invoiceFetchRecord('Sociétés', societeId)
  const sf = societeRecord?.fields || {}

  // Calcul des échéances à partir de la date de commande (J+5 et J+20)
  const dateCmdStr = cf['Date commande'] || new Date().toISOString().slice(0, 10)
  const addDays = (baseDate, days) => {
    const d = new Date(baseDate)
    if (isNaN(d.getTime())) return baseDate
    d.setDate(d.getDate() + days)
    return d.toISOString().slice(0, 10)
  }

  if (commercialId) {
    const commIds = invoiceLinkedIds(sf['Commerciaux'])
    if (!commIds.includes(commercialId)) {
      const err = new Error("Ce dossier n'est pas assigné à ce commercial.")
      err.statusCode = 403
      throw err
    }
  }

  let editionId = invoiceLinkedIds(cf['Édition'] || cf['Edition'] || cf['Salons'] || cf['Salon'])[0]
  let salonRecord = await invoiceFetchRecord('Salons', editionId)
  let salonFields = salonRecord?.fields || {}
  let ef = salonFields

  const lines = []
  let fallbackEditionId = null
  let fallbackSalonId = null
  for (const standId of invoiceLinkedIds(cf['Stand ou service commandé'] || cf['Stand'])) {
    const standRecord = await invoiceFetchRecord('Stands', standId)
    const f = standRecord?.fields || {}
    fallbackEditionId = fallbackEditionId || linkedRecordId(f['Édition'] || f['Edition'])
    fallbackSalonId = fallbackSalonId || linkedRecordId(f['Editions'] || f['Éditions'] || f['Salon'] || f['Salons'])
    const amount = invoicePickMoney(f, ['Prix', 'Tarif référence', 'Montant', 'Prix TTC'], 0)
    lines.push({
      label: invoiceText(f['ID Stand'], f['Numéro stand'], standId),
      description: [invoiceText(f['Spécificités'], f['Type']), invoiceText(f['Dimension'])].filter(Boolean).join(' - '),
      qty: 1,
      amount,
    })
  }
  if (!salonRecord && (fallbackEditionId || fallbackSalonId)) {
    const targetId = fallbackEditionId || fallbackSalonId
    salonRecord = await invoiceFetchRecord('Salons', targetId)
    if (salonRecord) {
      salonFields = salonRecord.fields || {}
      ef = salonFields
    }
  }

  for (const activityId of invoiceLinkedIds(cf['Activités optionnelles'])) {
    const activityRecord = await invoiceFetchRecord('Activités optionnelles', activityId)
    const f = activityRecord?.fields || {}
    const amount = invoicePickMoney(f, ['Prix unitaire', 'Prix', 'Montant'], 0)
    lines.push({
      label: invoiceText(f['Nom activité'], f['Nom'], activityId),
      description: invoiceText(f['Type activité'], f['Date et créneau'], f['Description / thème']),
      qty: 1,
      amount,
    })
  }

  const rawSupplements = cf['Suppléments'] || cf['Supplements'] || []
  const supplementLabels = Array.isArray(rawSupplements) ? rawSupplements : (rawSupplements ? [rawSupplements] : [])
  supplementLabels.forEach(label => {
    const clean = invoiceText(label)
    if (clean) lines.push({ label: clean, description: 'Supplément', qty: 1, amount: 0 })
  })

  const remisePromo = invoicePickMoney(cf, ['Montant remise promo', 'Remise promo', 'Remise accordée'], 0)
  const voucherAmount = invoicePickMoney(cf, ['Montant voucher appliqué', 'Voucher appliqué', 'Montant voucher'], 0)
  const rawTax = sf['Régime fiscal'] || sf['Regime fiscal'] || '0.2'
  const taxRate = String(rawTax).includes('20') ? 0.2 : String(rawTax).includes('8') ? 0.08 : parseFloat(rawTax) || 0

  // CALCUL DE SÉCURITÉ : Les montants ligne sont déjà TTC (taxe incluse)
  // On extrait le HT à rebours, identique aux formules Airtable
  const montantTTC = lines.reduce((sum, item) => sum + invoiceMoney(item.amount) * (Number(item.qty) || 1), 0)
  const montantHT  = taxRate > 0 ? Math.round(montantTTC / (1 + taxRate)) : montantTTC
  const montantTaxe = Math.round(montantHT * taxRate)
  const totalTTC = montantTTC
  const netAPayer = Math.max(0, totalTTC - remisePromo - voucherAmount)
  const montantEncaisse = invoicePickMoney(cf, ['Montant encaissé', 'Montant soldé', 'Montant deja payer', 'Montant déjà payé'], 0)
  const resteAPayer = invoicePickMoney(cf, ['Reste à payer'], Math.max(0, totalTTC - montantEncaisse))

  const promoCode = invoiceText(
    cf['Code promo'],
    cf['Code Promo'],
    await invoiceResolveLinkedLabel('Codes promo', cf['Code promo appliqué'], ['Code', 'Nom', 'Motif']),
  )
  const voucherCode = invoiceText(cf['Code voucher'], cf['Code Voucher'], cf['Voucher'])
  const regimeFiscal = invoiceText(sf['Régime fiscal'], sf['Regime fiscal'])

  return {
    invoiceNumber: `FACT-${invoiceText(cf['Numero de dossier'], cf['ID Commande'], cmd.id.slice(-8).toUpperCase())}`,
    dossierNumber: invoiceText(cf['Numero de dossier'], cf['ID Commande'], cmd.id.slice(-8).toUpperCase()),
    date: new Date().toISOString().slice(0, 10),
    commandeId: cmd.id,
    societe: {
      nom: invoiceText(sf['Raison sociale'], sf['Nom'], sf['Name'], 'Société non renseignée'),
      idEntreprise: invoiceText(sf['ID Entreprise']),
      nif: invoiceText(sf['NIF']),
      stat: invoiceText(sf['STAT']),
      adresse: invoiceText(sf['Adresse']),
      email: invoiceText(sf['Email']),
      telephone: invoiceText(sf['Téléphone']),
      logoUrl: sf['Logo']?.[0]?.url || '',
    },
    evenement: {
      nom: invoiceText(salonFields['Nom du salon'], salonFields['Nom'], salonFields['Name'], salonFields['ID Salon'], salonFields['Edition'], salonFields['Édition']),
      lieu: invoiceText(salonFields['Lieu'], salonFields['Ville'], ef['Lieu']),
    },
    edition: {
      nom: invoiceText(ef['Edition'], ef['Édition'], ef['Nom édition'], ef['Nom'], ef['Année'] ? `Édition ${ef['Année']}` : ''),
      dateDebut: invoiceText(ef['Date début']),
      dateFin: invoiceText(ef['Date fin']),
    },
    lines,
    access: {
      badges: cf['Nombre badges'] || 0,
      invitations: cf['Nombre invitations'] || 0,
      parkingVip: cf['Accès parking VIP'] || 0,
    },
    dates: {
      validation: invoiceText(cf['Date validation']),
      acompte: addDays(dateCmdStr, 5),
      solde: addDays(dateCmdStr, 20),
    },
    statut: cf['Validation'] === 'Validé' ? 'Validé' : invoiceText(cf['Validation'], cf['Statut commande'], cf['Statut']),
    financial: {
      montantHT,
      remisePromo,
      voucherAmount,
      montantTaxe,
      totalTTC,
      netAPayer,
      montantEncaisse,
      resteAPayer,
      promoCode,
      voucherCode,
      taxLabel: invoiceTaxLabel(cf['Pourcentage Taxe'], regimeFiscal),
      regimeFiscal,
    },
  }
}

function renderInvoiceTemplate(doc, data, options = {}) {
    registerFonts(doc)
    const BLUE = '#3766A8'
    const DARK = '#17345F'
    const TEXT = '#111111'
    const MUTED = '#687e7e'
    const LINE = '#D8DEE8'
    const RED = '#FF3030'
    const pageW = 595.28
    const pageH = 841.89
    const marginX = 37
    const tableX = 37
    const tableW = 522
    const colDesignation = 190
    const colQty = 100
    const colUnit = 120
    const colAmount = tableW - colDesignation - colQty - colUnit
    const logoPath = invoiceMadavisionLogoPath()
    const headerImagePath = invoiceHeaderImagePath()
    const invoiceNo = invoiceText(data.dossierNumber, data.invoiceNumber).replace(/^FACT-/, '') || data.invoiceNumber
    const eventName = [...new Set([data.evenement?.nom, data.edition?.nom].map(value => invoiceText(value)).filter(Boolean))].join(' - ')
    const normalizedStatus = invoiceText(data.statut)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
    const isPendingOrDraft = /\b(proforma|attente|pending|brouillon|draft|non valide)\b/.test(normalizedStatus)
    const isFinalInvoice = !isPendingOrDraft && /\b(valide|confirme|paye|solde)\b/.test(normalizedStatus)
    const documentTitle = invoiceText(options.documentTitle).toUpperCase() || (isFinalInvoice ? 'FACTURE' : 'PROFORMA')
    const discount = invoiceMoney(data.financial.remisePromo) + invoiceMoney(data.financial.voucherAmount)
    const totalHT = invoiceMoney(data.financial.montantHT)
    const totalTTC = invoiceMoney(data.financial.totalTTC)
    const netAPayer = invoiceMoney(data.financial.netAPayer) || Math.max(0, totalTTC - discount)
    const totalHTRemise = Math.max(0, totalHT - discount)
    const tax = invoiceMoney(data.financial.montantTaxe)
    const paid = invoiceMoney(data.financial.resteAPayer) <= 0 || invoiceMoney(data.financial.montantEncaisse) >= netAPayer
    let y = 0
    let totalsBottomY = 0

    function money(value) {
      return invoiceFormatMoneyBare(value)
    }

    function drawHeader() {
      doc.save()
      if (headerImagePath) {
        try {
          doc.image(headerImagePath, 0, 0, { width: pageW })
          doc.restore()
          return
        } catch (e) {
          console.warn('[invoice] entete.png ignorée:', e.message)
        }
      }

      doc.fillColor(BLUE)
      doc.moveTo(0, 8).lineTo(216, 8).lineTo(229, 42).lineTo(202, 89).lineTo(0, 89).closePath().fill()
      doc.fillColor(DARK).rect(205, 42, 390, 27).fill()
      if (logoPath) {
        try {
          doc.image(logoPath, 57, 25, { width: 102 })
        } catch (e) {
          drawLogoText(58, 25)
        }
      } else {
        drawLogoText(58, 25)
      }
      doc.restore()
    }

    function drawLogoText(x, yLogo) {
      doc.fillColor(TEXT).font('Poppins-Bold').fontSize(21).text('MADA', x, yLogo, { width: 105, align: 'center' })
      doc.fillColor(BLUE).fontSize(20).text('VISION', x, yLogo + 22, { width: 105, align: 'center' })
    }

    function drawCompanyBlocks() {
      doc.fillColor(TEXT).font('Poppins-Bold').fontSize(11).text('FACTURÉ À', marginX, 122)
      doc.font('Poppins-Regular').fontSize(10).text(data.societe?.nom || '—', marginX, 144, { width: 230 })
      doc.font('Poppins-Bold').fontSize(8.5).text('NIF :', marginX, 166)
      doc.text('STAT :', marginX, 184)
      doc.text('Adresse :', marginX, 202)
      doc.font('Poppins-Regular').fontSize(8.5)
      if (data.societe?.nif) doc.text(data.societe.nif, 78, 166, { width: 190 })
      if (data.societe?.stat) doc.text(data.societe.stat, 78, 184, { width: 190 })
      if (data.societe?.adresse) doc.text(data.societe.adresse, 98, 202, { width: 190 })
      doc.font('Poppins-Bold').fontSize(8.5).text('Date :', marginX, 242)
      doc.font('Poppins-Regular').text(invoiceFormatDate(data.date), 65, 242)
      doc.font('Poppins-Bold').text('Échéance :', marginX, 262)
      doc.font('Poppins-Regular').text(invoiceFormatDate(data.dates?.solde || data.date), 91, 262)

      doc.fillColor(BLUE).font('Poppins-Bold').fontSize(27).text(documentTitle, 366, 86, { width: 185, align: 'left' })
      doc.fillColor(TEXT).fontSize(8.5).text(invoiceNo, 368, 124, { width: 190 })
      doc.font('Poppins-Regular').fontSize(8.5)
        .text('MADAGASCAR, ANTANANARIVO', 368, 144, { width: 190 })
        .text('Société MADA VISION SARL', 368, 156, { width: 190 })
        .text('Anosivavaka, Route du Pape, Dyve', 368, 168, { width: 190 })
        .text('Garden, 3ème étage', 368, 180, { width: 190 })
        .text('contact@mada-vision.com', 368, 212, { width: 190 })
        .text('038 17 250 11', 368, 224, { width: 190 })
      doc.font('Poppins-Bold')
        .text('NIF: 3000649139', 368, 246, { width: 190 })
        .text('STAT : 82300 11 2002 0 10141', 368, 258, { width: 190 })

      doc.fillColor(TEXT).font('Poppins-Bold').fontSize(10).text('Description :', marginX, 298)
      doc.font('Poppins-Regular').fontSize(9.5).text(`Participation à l'événement${eventName ? ` ${eventName}` : ''}`, 121, 298, { width: 400 })
    }

    function drawTableHeader(startY) {
      doc.rect(tableX, startY, tableW, 34).fill(BLUE)
      doc.fillColor('#FFFFFF').font('Poppins-Bold').fontSize(9.5)
      doc.text('Désignation', tableX, startY + 11, { width: colDesignation, align: 'center' })
      doc.text('Quantité', tableX + colDesignation, startY + 11, { width: colQty, align: 'center' })
      doc.text('P.U', tableX + colDesignation + colQty, startY + 11, { width: colUnit, align: 'center' })
      doc.text('Montant', tableX + colDesignation + colQty + colUnit, startY + 11, { width: colAmount, align: 'center' })
      y = startY + 34
    }

    function drawLineItem(item) {
      const qty = Number(item.qty) || 1
      const total = invoiceMoney(item.amount) * qty
      const label = [item.label, item.description].filter(Boolean).join(' - ')
      if (y > 520) {
        drawFooter()
        doc.addPage()
        drawHeader()
        drawTableHeader(120)
      }
      const rowHeight = Math.max(33, doc.heightOfString(label || '—', { width: colDesignation - 18 }) + 18)
      doc.fillColor(TEXT).font('Poppins-Regular').fontSize(7.5)
      doc.text(label || '—', tableX + 8, y + 11, { width: colDesignation - 18 })
      doc.text(String(qty), tableX + colDesignation, y + 11, { width: colQty, align: 'center' })
      doc.text(money(item.amount), tableX + colDesignation + colQty, y + 11, { width: colUnit, align: 'center' })
      doc.text(money(total), tableX + colDesignation + colQty + colUnit, y + 11, { width: colAmount - 8, align: 'right' })
      y += rowHeight
      doc.moveTo(tableX, y).lineTo(tableX + tableW, y).strokeColor(LINE).lineWidth(0.5).stroke()
    }

    function drawTotals() {
      const totalRowY = y
      doc.fillColor(TEXT).font('Poppins-Regular').fontSize(8)
      doc.text('TOTAL (HT)', tableX + colDesignation, totalRowY + 11, { width: colQty + colUnit, align: 'center' })
      doc.text(money(totalHT || totalTTC), tableX + colDesignation + colQty + colUnit, totalRowY + 11, { width: colAmount - 8, align: 'right' })
      y += 33
      doc.moveTo(tableX, y).lineTo(tableX + tableW, y).strokeColor(LINE).lineWidth(0.5).stroke()

      const labelX = 362
      const valueX = 468
      y += 4
      function summary(label, value, bold = false) {
        doc.fillColor(TEXT).font(bold ? 'Poppins-Bold' : 'Poppins-Regular').fontSize(8)
        doc.text(label, labelX, y + 7, { width: 92, align: 'center' })
        doc.font('Poppins-Regular').text(money(value), valueX, y + 7, { width: 86, align: 'right' })
        y += 33
        doc.moveTo(labelX - 16, y).lineTo(tableX + tableW, y).strokeColor(LINE).lineWidth(0.5).stroke()
      }
      if (discount > 0) summary('REMISE', discount, true)
      summary('Total (HT)\navec REMISE', discount > 0 ? totalHTRemise : totalHT, true)
      summary('TVA', tax, true)
      summary('MONTANT', netAPayer, true)
      totalsBottomY = y
    }

    function drawPaidStamp() {
      if (!paid) return
      doc.save()
      doc.rotate(-45, { origin: [140, 504] })
      doc.fillColor(RED).font('Poppins-Bold').fontSize(43).text('Payé', 76, 486, { width: 140, align: 'center' })
      doc.restore()
    }

    function drawPaymentAndSignature() {
      const amountWords = invoiceAmountInWords(netAPayer)
      // let amountLineY = Math.max(612, totalsBottomY + 26)
      // if (amountLineY > 630) {
      //   drawFooter()
      //   doc.addPage()
      //   drawHeader()
      //   amountLineY = 150
      // }
      let amountLineY = Math.max(580, totalsBottomY + 15)
      if (amountLineY > 690) {
        drawFooter()
        doc.addPage()
        drawHeader()
        amountLineY = 150
      }
      const paymentY = amountLineY + 48

      doc.fillColor(TEXT).font('Poppins-Bold').fontSize(7.5)
        .text(`Arrêtée la présente facture à la somme de ${amountWords}.`, 63, amountLineY, { width: 470, align: 'left' })

      doc.font('Poppins-Bold').fontSize(12).text('MODE DE PAIEMENT :', marginX, paymentY)
      doc.font('Poppins-Bold').fontSize(8).text('• VIREMENT :', marginX + 2, paymentY + 22)
      doc.font('Poppins-Regular').fontSize(8).text('00008/00006 02001009138 17', marginX + 58, paymentY + 22)
      doc.text('(Bred Madagasikara)', marginX + 19, paymentY + 35)
      doc.font('Poppins-Bold').text('• Mobile Money :', marginX + 2, paymentY + 53)
      doc.font('Poppins-Regular').text('038 17 250 11', marginX + 82, paymentY + 53)
      doc.text('(Au nom de Koloina)', marginX + 19, paymentY + 66)
      doc.font('Poppins-Bold').text('• Chèque', marginX + 2, paymentY + 84)
      doc.font('Poppins-Regular').text("à L'ordre de \"Madavision\"", marginX + 47, paymentY + 84)

      doc.save()
      doc.rotate(-3, { origin: [460, paymentY + 18] })
      doc.opacity(0.55)
      doc.rect(402, paymentY - 11, 116, 52).strokeColor(BLUE).lineWidth(1.8).stroke()
      doc.fillColor(BLUE).font('Poppins-Bold').fontSize(22).text('MADA', 414, paymentY - 6, { width: 92, align: 'center' })
      doc.fontSize(19).text('VISION', 414, paymentY + 16, { width: 92, align: 'center' })
      doc.restore()
      doc.fillColor(TEXT).font('Poppins-Bold').fontSize(7.5).text('Koloina RANAIVO RAJAONARISOA', 378, paymentY + 67, { width: 170, align: 'center' })
      doc.font('Poppins-Regular').fontSize(7.5).text('Directrice Générale Adjointe', 386, paymentY + 79, { width: 155, align: 'center' })
    }

    function drawFooter() {
      const footerY = 780
      doc.fillColor(DARK).rect(0, 807, 595, 14).fill()
      doc.fillColor(BLUE)
      doc.moveTo(531, 778).lineTo(568, 778).lineTo(553, 832).lineTo(516, 832).closePath().fill()
      doc.strokeColor(BLUE).lineWidth(3).moveTo(0, 797).lineTo(520, 797).stroke()
      doc.fillColor(DARK).font('Poppins-Regular').fontSize(7)
      doc.text('038 17 250 11', 52, footerY)
      doc.text('contact@mada-vision.com', 192, footerY)
      doc.text('www.mada-vision.com', 392, footerY)
      doc.fillColor(BLUE).circle(40, footerY + 3, 3).fill()
      doc.circle(180, footerY + 3, 3).fill()
      doc.circle(380, footerY + 3, 3).fill()
    }

    drawHeader()
    drawCompanyBlocks()
    drawTableHeader(320)

    if (!Array.isArray(data.lines) || data.lines.length === 0) {
      drawLineItem({ label: 'Aucune réservation chiffrée', qty: 1, amount: 0 })
    } else {
      data.lines.forEach(drawLineItem)
    }
    drawTotals()
    drawPaidStamp()
    drawPaymentAndSignature()
    drawFooter()
}

async function generateInvoicePDF(data) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0, compress: true })
    const buffers = []
    doc.on('data', b => buffers.push(b))
    doc.on('end', () => resolve(Buffer.concat(buffers)))
    doc.on('error', reject)

    renderInvoiceTemplate(doc, data)
    doc.end()
  })
}

async function generateProformaContractPDF(data) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0, compress: true })
    const buffers = []
    doc.on('data', b => buffers.push(b))
    doc.on('end', () => resolve(Buffer.concat(buffers)))
    doc.on('error', reject)

    renderInvoiceTemplate(doc, data, { documentTitle: 'PROFORMA' })

    doc.addPage({ size: 'A4', margin: 0 })
    const cgvPath = path.join(__dirname, '..', 'assets', 'pdf', 'cgv.jpg')
    if (fs.existsSync(cgvPath)) {
      doc.image(cgvPath, 0, 0, {
        fit: [595.28, 841.89],
        align: 'center',
        valign: 'center',
      })
    } else {
      registerFonts(doc)
      doc.fillColor('#17345F').font('Poppins-Bold').fontSize(18)
        .text('Conditions Générales de Vente', 48, 90, { width: 499, align: 'center' })
      doc.fillColor('#687e7e').font('Poppins-Regular').fontSize(10)
        .text('Le fichier CGV est introuvable dans assets/pdf/cgv.jpg.', 48, 132, { width: 499, align: 'center' })
    }

    doc.end()
  })
}

// ── Générateur Badges + Invitations ──────────────────────
async function generateBadgesInvitationsPDF(cmdId, options = {}) {
  const data = await buildInvoiceData(cmdId, options)

  // options.nbBadges / options.nbInvitations permettent de bypasser la relecture Airtable
  const nbBadges = options.nbBadges !== undefined ? Number(options.nbBadges) : (Number(data.access?.badges) || 0)
  const nbInv    = options.nbInvitations !== undefined ? Number(options.nbInvitations) : (Number(data.access?.invitations) || 0)
  if (nbBadges === 0 && nbInv === 0) throw new Error('Aucun badge ni invitation à générer.')

  const socNom  = (data.societe?.nom || 'Exposant').toUpperCase()
  const shortId = cmdId.slice(-8).toUpperCase()

  // Chemins des templates
  const BADGE_TPL = path.join(__dirname, '..', 'assets', 'pdf', 'badge-exposant.png')
  const INV_TPL   = path.join(__dirname, '..', 'assets', 'pdf', 'invitation.png')

  // Dimensions originales des templates (px)
  const BADGE_OW = 1500, BADGE_OH = 2100
  const INV_OW   = 2466, INV_OH   = 1168

  // Pré-génération des QR codes (async avant la Promise PDFKit)
  const toQR = (txt) => QRCode.toBuffer(txt, { type: 'png', width: 600, margin: 1 })

  const [badgeQRs, invQRs] = await Promise.all([
    Promise.all(Array.from({ length: nbBadges }, (_, i) => toQR(`BADGE-${shortId}-${i + 1}`))),
    Promise.all(Array.from({ length: nbInv },    (_, i) => toQR(`INV-${shortId}-${i + 1}`))),
  ])

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ autoFirstPage: false, margins: { top: 0, bottom: 0, left: 0, right: 0 } })
    const chunks = []
    doc.on('data', c => chunks.push(c))
    doc.on('end', () => resolve({ buffer: Buffer.concat(chunks), nbBadges, nbInvitations: nbInv }))
    doc.on('error', reject)

    doc.registerFont('Poppins-Bold',    path.join(FONT_DIR, 'Poppins-Bold.ttf'))
    doc.registerFont('Poppins-Regular', path.join(FONT_DIR, 'Poppins-Regular.ttf'))

    // ── BADGES : 3 colonnes × 2 lignes = 6 par page (A4 portrait) ─────────
    // Zone blanche template (1500×2100) : x=6.7%→64.2%  y=32.9%→98%
    {
      const B_COLS = 3, B_ROWS = 2, B_PER_PAGE = B_COLS * B_ROWS
      const B_MX = 10, B_MY = 15, B_GX = 8, B_GY = 10
      const bW = Math.floor((595 - 2*B_MX - (B_COLS - 1)*B_GX) / B_COLS)
      const bH = Math.round(bW * BADGE_OH / BADGE_OW)

      // Zone blanche en pt (mesurée sur le template 1500×2100)
      const WX_OFF = Math.round(0.067 * bW)   // bord gauche zone blanche  6.7%
      const WY_OFF = Math.round(0.329 * bH)   // bord haut zone blanche   32.9%
      const WW     = Math.round(0.575 * bW)   // largeur zone blanche     57.5%
      const WH     = Math.round(0.651 * bH)   // hauteur zone blanche     65.1%
      const PAD    = 5

      for (let i = 0; i < nbBadges; i++) {
        if (i % B_PER_PAGE === 0) doc.addPage({ size: 'A4', layout: 'portrait' })
        const col = i % B_COLS
        const row = Math.floor((i % B_PER_PAGE) / B_COLS)
        const bx  = B_MX + col * (bW + B_GX)
        const by  = B_MY + row * (bH + B_GY)

        doc.image(BADGE_TPL, bx, by, { width: bW, height: bH })

        // Nom société — dans la zone blanche, en haut
        const nX = bx + WX_OFF + PAD
        const nY = by + WY_OFF + PAD
        const nW = WW - 2 * PAD
        doc.font('Poppins-Bold').fontSize(7).fillColor('#0B1A3F')
          .text(socNom, nX, nY, { width: nW, align: 'center', lineBreak: true })

        // QR code — centré dans la zone blanche, sous le nom
        const qS = Math.round(0.80 * WW)
        const qX = bx + WX_OFF + Math.round((WW - qS) / 2)
        const qY = nY + 20
        doc.image(badgeQRs[i], qX, qY, { width: qS, height: qS })

        // Numéro badge — bas de la zone blanche, texte sombre
        const numY = by + WY_OFF + WH - 10
        doc.font('Poppins-Regular').fontSize(4).fillColor('#1B2A4A')
          .text(`${i + 1}-${shortId}`, bx + WX_OFF, numY, { width: WW, align: 'center' })
      }
    }

    // ── INVITATIONS : 1 colonne × 3 lignes = 3 par page (A4 portrait) ──────
    // Template 2466×1168 → mis à l'échelle sur la largeur utile (575pt)
    // Zone QR (droite) : x=72.7%  y=9%  taille=17.5% (carré)
    // Numéro           : sous le QR
    {
      const I_PER_PAGE = 3
      const I_MX = 10, I_MY = 5, I_GY = 4
      // inv width = 595 - 2*10 = 575pt  →  height = 575 * 1168/2466 = 272pt
      // 3 lignes : 3*272 + 2*4 + 2*5 = 834pt < 842pt ✓
      const iW = 595 - 2 * I_MX
      const iH = Math.round(iW * INV_OH / INV_OW)

      for (let i = 0; i < nbInv; i++) {
        if (i % I_PER_PAGE === 0) doc.addPage({ size: 'A4', layout: 'portrait' })
        const row = i % I_PER_PAGE
        const ix  = I_MX
        const iy  = I_MY + row * (iH + I_GY)

        // Fond template
        doc.image(INV_TPL, ix, iy, { width: iW, height: iH })

        // QR code (zone « ENTRÉE UNIQUE » côté droit)
        const qX = ix + Math.round(0.727 * iW)
        const qY = iy  + Math.round(0.090 * iH)
        const qS = Math.round(0.175 * iW)
        doc.image(invQRs[i], qX, qY, { width: qS, height: qS })

        // Numéro invitation
        const numY = qY + qS + 3
        doc.font('Poppins-Regular').fontSize(4).fillColor('#1B2A4A')
          .text(`${i + 1}-${shortId}`, qX, numY, { width: qS + 50, align: 'center' })
      }
    }

    doc.end()
  })
}

async function buildProformaContractAttachment(cmdId, options = {}) {
  const data = await buildInvoiceData(cmdId, options)
  const pdf = await generateProformaContractPDF(data)
  return {
    data,
    attachment: {
      filename: `${invoiceSafeFilename(`proforma-contrat-${data.dossierNumber || data.invoiceNumber}`)}.pdf`,
      content: pdf,
      contentType: 'application/pdf',
    },
  }
}

async function sendExposantValidationConfirmation(cmdId) {
  const { mailer, emailWrapper, escapeHtml } = require('./email')
  const { data, attachment } = await buildProformaContractAttachment(cmdId)
  const socEmail = data.societe.email || ''
  const socNom = data.societe.nom || 'votre société'
  if (!socEmail) {
    return { emailSent: false, to: null, emailNote: 'Aucune adresse email pour le client exposant' }
  }

  const frontendBase = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '')
  const result = await mailer(
    socEmail,
    `Dossier validé — ${data.dossierNumber || 'Madavision'}`,
    emailWrapper(`
      <h2 style="color:#1B2A4A;font-size:18px;margin:0 0 14px">Votre dossier exposant est validé</h2>
      <p>Bonjour ${escapeHtml(socNom)},</p>
      <p>Votre dossier d'inscription Madavision a été validé.</p>
      <div style="background:#EEF2F8;border-left:3px solid #2260A7;padding:14px 18px;border-radius:0 8px 8px 0;margin:18px 0">
        <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#2260A7;margin-bottom:8px">Document joint</div>
        <div style="font-size:15px;font-weight:700;color:#1B2A4A">Facture proforma + contrat d'engagement CGV</div>
        <div style="font-size:12px;color:#5C5649;margin-top:6px">Un seul fichier PDF récapitule votre réservation, les montants, les taxes, les remises éventuelles et l'engagement CGV.</div>
      </div>
      <p style="font-size:13px;color:#5C5649">
        Merci de vérifier les informations du document et de suivre l'échéancier indiqué pour l'acompte 50 % et le solde 50 %.
      </p>
      <div style="margin-top:24px">
        <a href="${frontendBase}/exposant" style="background:#1B2A4A;color:#fff;text-decoration:none;padding:10px 22px;border-radius:8px;display:inline-block;font-weight:600;font-size:13px">Accéder à mon espace exposant</a>
      </div>
    `),
    { attachments: [attachment] }
  )

  return {
    emailSent: result.sent,
    to: socEmail,
    emailNote: result.error || null,
    attachment: attachment.filename,
  }
}

async function sendInvoicePdfByCommandId(cmdId, res, options = {}) {
  try {
    const data = await buildInvoiceData(cmdId, options)
    const pdf = await generateInvoicePDF(data)
    const filename = `${invoiceSafeFilename(data.invoiceNumber)}.pdf`
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.send(pdf)
  } catch(e) {
    const status = e.statusCode || 500
    console.error('[download-invoice]', e.message)
    res.status(status).json({ error: DEBUG ? e.message : (status === 500 ? 'Erreur génération facture' : e.message) })
  }
}

async function sendInvoicePdf(req, res, options = {}) {
  await sendInvoicePdfByCommandId(req.params.id, res, options)
}

module.exports = {
  FONT_DIR,
  fmtMoney,
  fmtMoneyRaw,
  registerFonts,
  fetchImageBuffer,
  handleImageUpload,
  generateInscriptionPDF,
  // shared helpers
  findCommandeByAccessToken,
  buildExposantDocuments,
  linkedRecordId,
  atRecordById,
  mapCommercialAccountOption,
  mapSocieteAccountOption,
  normalizeDateOnly,
  paymentCalendarFields,
  patchCommandeFields,
  paymentCalendarPayload,
  getCommercialSocietes,
  // invoice helpers
  invoiceMoney,
  invoiceText,
  invoiceLinkedIds,
  invoicePickMoney,
  invoiceTaxLabel,
  invoiceFormatMoney,
  invoiceFormatMoneyBare,
  invoiceFormatDate,
  invoiceNumberToFrench,
  invoiceAmountInWords,
  invoiceSafeFilename,
  invoiceMadavisionLogoPath,
  invoiceHeaderImagePath,
  invoiceFetchRecord,
  resolveEditionAndSalon,
  fetchFirstRecordFromTables,
  mapBilanPuissanceRecord,
  fetchBilanPuissance,
  invoiceResolveLinkedLabel,
  buildInvoiceData,
  renderInvoiceTemplate,
  generateInvoicePDF,
  generateProformaContractPDF,
  generateBadgesInvitationsPDF,
  buildProformaContractAttachment,
  sendExposantValidationConfirmation,
  sendInvoicePdfByCommandId,
  sendInvoicePdf,
}
