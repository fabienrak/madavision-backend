// ════════════════════════════════════════════════════════════
//  MADAVISION BACKEND — FIM 2026
//  Proxy sécurisé entre le formulaire HTML et Airtable
// ════════════════════════════════════════════════════════════

const express    = require('express')
const cors       = require('cors')
const nodemailer = require('nodemailer')
const PDFDocument = require('pdfkit')
const fs         = require('fs')
const path       = require('path')
const crypto     = require('crypto')
const cloudinary = require('cloudinary').v2
require('dotenv').config()

cloudinary.config({
  cloud_name: 'dcypbnvgc',
  api_key: '696412765765453',
  api_secret: 'ptZZjJyHWBn549B8LKbXfb7qCSQ'
})

// Dossier d'uploads pour les BCs et dossiers exposants
const UPLOADS_DIR = path.join(__dirname, 'uploads')
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true })

function fmtMoney(value) {
  const n = Math.round(Number(value || 0))
  return n.toLocaleString('fr-FR', { maximumFractionDigits: 0 }).replace(/\s/g, '.') + ' Ar'
}
const FONT_DIR = '/Users/mac/Desktop/my_project/MADAVISION/madavision-react/assets/fonts/'

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
    row('Total HT (Stands + Activités)', fmtMoney(totalHT))
    row('Régime fiscal appliqué', currentTaxLabel)
    row('Montant de la taxe', fmtMoney(montantTaxe))
    
    y += 8
    doc.rect(50, y, W, 30).fill(BLEU)
    doc.fillColor('#fff').font('Poppins-Bold').fontSize(12)
       .text('MONTANT TOTAL (nets inclus)', 65, y + 9)
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
      .text('Banque : BNI MADAGASCAR - Agence : ANALAKELY', 65, y + 12)
      .text('Compte : 00005 01010 12345678901 23', 65, y + 24)
      .text('Ordre : MADAVISION', 65, y + 36)

    // Mobile Money
    doc.fillColor(NOIR).font('Poppins-Bold').fontSize(8).text('MOBILE MONEY', 300, y)
    doc.font('Poppins-Regular').fontSize(8).fillColor(GRIS)
      .text('MVOLA : 034 02 235 44', 300, y + 12)
      .text('AIRTEL MONEY : 033 02 235 44', 300, y + 24)
      .text('ORANGE MONEY : 032 02 235 44', 300, y + 36)
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

// ────────────────────────────────────────────────────────────
//  CONFIGURATION
// ────────────────────────────────────────────────────────────
const PAT     = process.env.AIRTABLE_PAT
const BASE    = process.env.AIRTABLE_BASE
const PORT    = parseInt(process.env.PORT) || 3001
const DEBUG   = process.env.DEBUG === 'true'
const ALLOWED = (process.env.ALLOWED_ORIGINS || '*')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)

// Configuration email
const EMAIL_ENABLED = process.env.EMAIL_ENABLED === 'true'
const EMAIL_CONFIG  = {
  host:   process.env.SMTP_HOST,
  port:   parseInt(process.env.SMTP_PORT) || 587,
  secure: process.env.SMTP_SECURE === 'true',
  user:   process.env.SMTP_USER,
  // App Password Gmail : supprimer les espaces (Google affiche "xxxx xxxx xxxx xxxx")
  pass:   (process.env.SMTP_PASS || '').replace(/\s/g, ''),
  fromName:    process.env.EMAIL_FROM_NAME    || 'Madavision',
  // Pour Gmail : fromAddress DOIT être identique à SMTP_USER
  fromAddress: process.env.EMAIL_FROM_ADDRESS || process.env.SMTP_USER || 'noreply@madavision.mg',
  bcc:         process.env.EMAIL_BCC || '',
}

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
      // Nécessaire pour certains serveurs SMTP stricts (OVH, Exchange)
      tls:    { rejectUnauthorized: false },
    })
    // Test de connexion au démarrage
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

if (!PAT || !BASE) {
  console.error('❌ Erreur : AIRTABLE_PAT et AIRTABLE_BASE doivent être définis dans .env')
  console.error('   Copiez .env.example en .env et remplissez les valeurs')
  process.exit(1)
}

if (!PAT.startsWith('pat')) {
  console.warn('⚠ AIRTABLE_PAT ne commence pas par "pat" — vérifiez le format')
}
if (!BASE.startsWith('app')) {
  console.warn('⚠ AIRTABLE_BASE ne commence pas par "app" — vérifiez le format')
}

// POST /api/sonia/valider/:id — valider une commande (Commandes.Validation → Validé)
// NB: l'assignation commercial est une action SÉPARÉE via /api/sonia/assigner/:cmdId


// ────────────────────────────────────────────────────────────
//  APP EXPRESS
// ────────────────────────────────────────────────────────────
const app = express()
app.set('trust proxy', 1)
app.use(express.json({ limit: '2mb' }))

// ── CORS — domaines autorisés ────────────────────────────
app.use(cors({
  origin: (origin, cb) => {
    // Pas d'origin = requête directe (Postman, curl, mobile)
    if (!origin) return cb(null, true)
    // Autoriser tout en local ou si wildcard
    if (ALLOWED.includes('*') || origin.includes('localhost')) return cb(null, true)
    // Domaine listé
    if (ALLOWED.includes(origin)) return cb(null, true)
    return cb(new Error(`Origine non autorisée : ${origin}`))
  },
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  credentials: true,
}))

// ── Rate limiting (en mémoire) ────────────────────────────
const requests = new Map()
const RATE_LIMIT  = 30          // 30 requêtes
const RATE_WINDOW = 60 * 1000   // par minute par IP

app.use((req, res, next) => {
  // Le health check n'est pas rate-limité (utile pour Render)
  if (req.path === '/api/health') return next()

  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim()
            || req.socket.remoteAddress
            || 'unknown'
  const now = Date.now()
  const arr = (requests.get(ip) || []).filter(t => now - t < RATE_WINDOW)

  if (arr.length >= RATE_LIMIT) {
    return res.status(429).json({
      error: 'Trop de requêtes — réessayez dans une minute'
    })
  }

  arr.push(now)
  requests.set(ip, arr)

  // Cleanup périodique pour ne pas faire grossir la map
  if (requests.size > 5000) {
    for (const [k, v] of requests.entries()) {
      if (v.length === 0 || (now - v[v.length - 1]) > RATE_WINDOW * 2) {
        requests.delete(k)
      }
    }
  }
  next()
})

// ────────────────────────────────────────────────────────────
//  HELPERS AIRTABLE
// ────────────────────────────────────────────────────────────
const ATBASE  = `https://api.airtable.com/v0/${BASE}`
const headers = () => ({
  Authorization: `Bearer ${PAT}`,
  'Content-Type': 'application/json',
})
const sleep = ms => new Promise(r => setTimeout(r, ms))
const PLAN_MASSE_FIELDS = ['Plan de masse', 'Plan masse', 'Plan', 'Floor plan']

function attachmentUrl(fields, names) {
  for (const name of names) {
    const value = fields?.[name]
    const first = Array.isArray(value) ? value[0] : null
    if (first?.url) return first.url
  }
  return null
}

async function atGet(table, params = '') {
  let records = [], offset = null
  do {
    let url = `${ATBASE}/${encodeURIComponent(table)}`
    const qs = []
    if (offset) qs.push(`offset=${offset}`)
    if (params) qs.push(params)
    if (qs.length) url += '?' + qs.join('&')

    const res  = await fetch(url, { headers: headers() })
    const data = await res.json()

    if (!res.ok) {
      const msg = data?.error?.message || `HTTP ${res.status}`
      throw new Error(`atGet "${table}" : ${msg}`)
    }
    records.push(...(data.records || []))
    offset = data.offset || null
  } while (offset)
  return records
}

async function atPost(table, fields) {
  await sleep(220) // respect rate limit ~5 req/s Airtable
  const res = await fetch(`${ATBASE}/${encodeURIComponent(table)}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ fields }),
  })
  const data = await res.json()
  if (!res.ok) {
    const msg = data?.error?.message || `HTTP ${res.status}`
    throw new Error(`atPost "${table}" : ${msg}`)
  }
  return data
}

async function atPatchRecord(table, id, fields) {
  await sleep(220)
  const res = await fetch(`${ATBASE}/${encodeURIComponent(table)}/${id}`, {
    method: 'PATCH',
    headers: headers(),
    body: JSON.stringify({ fields }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const msg = data?.error?.message || `HTTP ${res.status}`
    throw new Error(`atPatch "${table}" : ${msg}`)
  }
  return data
}

async function atFind(table, formula) {
  const url = `${ATBASE}/${encodeURIComponent(table)}?filterByFormula=${encodeURIComponent(formula)}&maxRecords=10`
  const res = await fetch(url, { headers: headers() })
  const data = await res.json()
  if (!res.ok) {
    const msg = data?.error?.message || `HTTP ${res.status}`
    throw new Error(`atFind "${table}" : ${msg}`)
  }
  return data.records || []
}

// Helper escape pour formules Airtable
function escapeFormula(str) {
  if (str === null || str === undefined) return ''
  return String(str).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

// ── Authentification applicative ───────────────────────────
const AUTH_TABLE = 'Utilisateurs'
const AUTH_COOKIE = process.env.AUTH_COOKIE_NAME || 'madavision_session'
const AUTH_SECRET = process.env.AUTH_SECRET || process.env.SESSION_SECRET || PAT
const AUTH_SESSION_HOURS = Math.max(1, Number(process.env.AUTH_SESSION_HOURS || 8))
const AUTH_SESSION_MS = AUTH_SESSION_HOURS * 60 * 60 * 1000
const PASSWORD_RESET_MINUTES = Math.max(10, Number(process.env.PASSWORD_RESET_MINUTES || 60))
const PASSWORD_RESET_MS = PASSWORD_RESET_MINUTES * 60 * 1000
const PASSWORD_HASH_ITERATIONS = Math.max(120000, Number(process.env.PASSWORD_HASH_ITERATIONS || 180000))
const authLoginAttempts = new Map()
let authUserCache = { expires: 0, records: [] }

if (!process.env.AUTH_SECRET && !process.env.SESSION_SECRET) {
  console.warn('⚠ AUTH_SECRET non défini — AIRTABLE_PAT est utilisé comme secret de session. Définissez AUTH_SECRET en production.')
}

function authPick(fields = {}, names = []) {
  for (const name of names) {
    if (fields[name] !== undefined && fields[name] !== null && fields[name] !== '') return fields[name]
  }
  return ''
}

function authFieldName(fields = {}, names = [], fallback) {
  return names.find(name => Object.prototype.hasOwnProperty.call(fields, name)) || fallback
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase()
}

function normalizeRole(role) {
  const raw = String(role || '').trim().toLowerCase()
  if (['admin_sonia', 'sonia', 'admin', 'administrateur', 'administration'].includes(raw)) return 'admin_sonia'
  if (['commercial', 'sales', 'sales_rep'].includes(raw)) return 'commercial'
  if (['exposant', 'client', 'societe', 'société'].includes(raw)) return 'exposant'
  return raw
}

function authBool(value) {
  if (value === undefined || value === null || value === '') return true
  if (typeof value === 'boolean') return value
  const raw = String(value).trim().toLowerCase()
  return !['false', '0', 'non', 'no', 'inactive', 'inactif', 'désactivé', 'desactive'].includes(raw)
}

function passwordPolicyError(password) {
  const value = String(password || '')
  if (value.length < 8) return 'Le mot de passe doit contenir au moins 8 caractères.'
  if (!/[A-Za-zÀ-ÿ]/.test(value) || !/\d/.test(value)) {
    return 'Le mot de passe doit contenir au moins une lettre et un chiffre.'
  }
  return ''
}

function linkedIdFromAny(value) {
  if (Array.isArray(value)) return value.find(v => String(v || '').startsWith('rec')) || ''
  if (typeof value === 'string' && value.startsWith('rec')) return value
  return ''
}

function normalizeAuthUser(record) {
  const f = record.fields || {}
  const role = normalizeRole(authPick(f, ['role', 'Role', 'Rôle']))
  const linkedRecordId = linkedIdFromAny(authPick(f, [
    'airtableRecordId',
    'Airtable Record ID',
    'Record Airtable',
    'Record lié',
    'Record lie',
    'Société',
    'Societé',
    'Commercial',
    'Commerciaux',
  ]))
  return {
    id: record.id,
    email: normalizeEmail(authPick(f, ['email', 'Email', 'E-mail', 'Mail'])),
    passwordHash: authPick(f, ['passwordHash', 'Password Hash', 'Hash mot de passe', 'Mot de passe hash']),
    role,
    linkedRecordId,
    active: authBool(authPick(f, ['active', 'Active', 'Actif', 'Statut'])),
    rawFields: f,
  }
}

function publicAuthUser(user) {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    linkedRecordId: user.linkedRecordId || '',
  }
}

async function authUsers({ refresh = false } = {}) {
  if (!refresh && authUserCache.expires > Date.now()) return authUserCache.records
  const records = await atGet(AUTH_TABLE)
  authUserCache = { expires: Date.now() + 30 * 1000, records }
  return records
}

async function findAuthUserByEmail(email, role = '') {
  const cleanEmail = normalizeEmail(email)
  const cleanRole = normalizeRole(role)
  if (!cleanEmail) return null
  const records = await authUsers()
  const record = records.find(r => {
    const user = normalizeAuthUser(r)
    return user.email === cleanEmail && (!cleanRole || user.role === cleanRole)
  })
  return record ? normalizeAuthUser(record) : null
}

async function findAuthUserById(id) {
  if (!id) return null
  const records = await authUsers()
  const record = records.find(r => r.id === id)
  return record ? normalizeAuthUser(record) : null
}

async function patchAuthUser(user, logicalFields) {
  const f = user.rawFields || {}
  const fields = {}
  if (Object.prototype.hasOwnProperty.call(logicalFields, 'passwordHash')) {
    fields[authFieldName(f, ['passwordHash', 'Password Hash', 'Hash mot de passe', 'Mot de passe hash'], 'passwordHash')] = logicalFields.passwordHash
  }
  if (Object.prototype.hasOwnProperty.call(logicalFields, 'lastLogin')) {
    fields[authFieldName(f, ['lastLogin', 'Last Login', 'Dernière connexion', 'Derniere connexion'], 'lastLogin')] = logicalFields.lastLogin
  }
  if (Object.prototype.hasOwnProperty.call(logicalFields, 'passwordResetTokenHash')) {
    fields[authFieldName(f, ['passwordResetTokenHash', 'Password Reset Token Hash', 'Token reset hash'], 'passwordResetTokenHash')] = logicalFields.passwordResetTokenHash
  }
  if (Object.prototype.hasOwnProperty.call(logicalFields, 'passwordResetExpires')) {
    fields[authFieldName(f, ['passwordResetExpires', 'Password Reset Expires', 'Expiration reset'], 'passwordResetExpires')] = logicalFields.passwordResetExpires
  }
  if (Object.prototype.hasOwnProperty.call(logicalFields, 'linkedRecordId')) {
    fields[authFieldName(f, ['airtableRecordId', 'Airtable Record ID', 'Record Airtable', 'Record lié', 'Record lie'], 'airtableRecordId')] = logicalFields.linkedRecordId || ''
  }
  if (Object.prototype.hasOwnProperty.call(logicalFields, 'active')) {
    fields[authFieldName(f, ['active', 'Active', 'Actif', 'Statut'], 'active')] = logicalFields.active
  }
  if (Object.keys(fields).length === 0) return null
  authUserCache.expires = 0
  return atPatchRecord(AUTH_TABLE, user.id, fields)
}

function base64url(input) {
  return Buffer.from(input).toString('base64url')
}

function signAuthPayload(payload) {
  const header = { alg: 'HS256', typ: 'JWT' }
  const body = {
    ...payload,
    iat: Date.now(),
    exp: Date.now() + AUTH_SESSION_MS,
  }
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(body))}`
  const signature = crypto.createHmac('sha256', AUTH_SECRET).update(unsigned).digest('base64url')
  return `${unsigned}.${signature}`
}

function verifyAuthToken(token) {
  const parts = String(token || '').split('.')
  if (parts.length !== 3) throw new Error('invalid_token')
  const [header, payload, signature] = parts
  const expected = crypto.createHmac('sha256', AUTH_SECRET).update(`${header}.${payload}`).digest('base64url')
  const received = Buffer.from(signature)
  const expectedBuffer = Buffer.from(expected)
  if (received.length !== expectedBuffer.length || !crypto.timingSafeEqual(received, expectedBuffer)) throw new Error('bad_signature')
  const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  if (!data.exp || Date.now() > data.exp) throw new Error('expired')
  return data
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('base64url')
  const hash = crypto.pbkdf2Sync(String(password), salt, PASSWORD_HASH_ITERATIONS, 32, 'sha256').toString('base64url')
  return `pbkdf2$sha256$${PASSWORD_HASH_ITERATIONS}$${salt}$${hash}`
}

function verifyPassword(password, storedHash) {
  const stored = String(storedHash || '')
  const parts = stored.split('$')
  if (parts.length !== 5 || parts[0] !== 'pbkdf2') return false
  const [, digest, iterRaw, salt, hash] = parts
  const iterations = Number(iterRaw)
  if (digest !== 'sha256' || !iterations || !salt || !hash) return false
  const computed = crypto.pbkdf2Sync(String(password), salt, iterations, 32, 'sha256').toString('base64url')
  return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(hash))
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex')
}

function readCookie(req, name) {
  const raw = req.headers.cookie || ''
  return raw.split(';').map(s => s.trim()).reduce((acc, part) => {
    const idx = part.indexOf('=')
    if (idx <= 0) return acc
    const key = decodeURIComponent(part.slice(0, idx))
    const value = decodeURIComponent(part.slice(idx + 1))
    acc[key] = value
    return acc
  }, {})[name]
}

function requestAuthToken(req) {
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim()
  return bearer || readCookie(req, AUTH_COOKIE) || ''
}

function setAuthCookie(res, token) {
  res.cookie(AUTH_COOKIE, token, {
    httpOnly: true,
    secure: process.env.AUTH_COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production',
    sameSite: process.env.AUTH_COOKIE_SAMESITE || 'lax',
    maxAge: AUTH_SESSION_MS,
    path: '/',
  })
}

function clearAuthCookie(res) {
  res.clearCookie(AUTH_COOKIE, {
    httpOnly: true,
    secure: process.env.AUTH_COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production',
    sameSite: process.env.AUTH_COOKIE_SAMESITE || 'lax',
    path: '/',
  })
}

function authRateKey(req, email, role) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown'
  return `${ip}:${normalizeEmail(email)}:${normalizeRole(role)}`
}

function canAttemptLogin(req, email, role) {
  const key = authRateKey(req, email, role)
  const now = Date.now()
  const entry = authLoginAttempts.get(key) || { count: 0, resetAt: now + 15 * 60 * 1000 }
  if (now > entry.resetAt) {
    authLoginAttempts.set(key, { count: 1, resetAt: now + 15 * 60 * 1000 })
    return true
  }
  if (entry.count >= 8) return false
  entry.count += 1
  authLoginAttempts.set(key, entry)
  return true
}

function resetLoginAttempts(req, email, role) {
  authLoginAttempts.delete(authRateKey(req, email, role))
}

async function startAuthSession(res, user) {
  const linkedRecordId = await resolveAuthLinkedRecord(user)
  const token = signAuthPayload({
    uid: user.id,
    email: user.email,
    role: user.role,
    linkedRecordId,
  })
  setAuthCookie(res, token)
  return publicAuthUser({ ...user, linkedRecordId })
}

async function resolveAuthLinkedRecord(user) {
  if (user.linkedRecordId) return user.linkedRecordId
  if (user.role === 'commercial') {
    const commercial = await findCommercialByEmail(user.email)
    return commercial?.id || ''
  }
  if (user.role === 'exposant') {
    const records = await atFind('Sociétés', `LOWER({Email})="${escapeFormula(user.email)}"`)
    return records[0]?.id || ''
  }
  return ''
}

async function ensureAuthUser({ email, role, linkedRecordId, password, passwordHash }) {
  const cleanEmail = normalizeEmail(email)
  const cleanRole = normalizeRole(role)
  if (!cleanEmail || !cleanRole) return null

  const existing = await findAuthUserByEmail(cleanEmail, cleanRole)
  if (existing) {
    const patch = {}
    if (linkedRecordId && !existing.linkedRecordId) patch.linkedRecordId = linkedRecordId
    if ((password || passwordHash) && !existing.passwordHash) {
      const policyError = password ? passwordPolicyError(password) : ''
      if (policyError) throw new Error(policyError)
      patch.passwordHash = passwordHash || hashPassword(password)
    }
    if (Object.keys(patch).length > 0) {
      const updated = await patchAuthUser(existing, patch)
      return normalizeAuthUser(updated)
    }
    return existing
  }

  const finalPasswordHash = passwordHash || (password ? hashPassword(password) : '')

  const record = await atPost(AUTH_TABLE, {
    email: cleanEmail,
    role: cleanRole,
    airtableRecordId: linkedRecordId || '',
    active: true,
    ...(finalPasswordHash ? { passwordHash: finalPasswordHash } : {}),
  })
  authUserCache.expires = 0
  return normalizeAuthUser(record)
}

async function ensureMigratedAuthUser(email, role) {
  const cleanRole = normalizeRole(role)
  if (cleanRole === 'commercial') {
    const commercial = await findCommercialByEmail(email)
    if (!commercial?.id) return null
    return ensureAuthUser({ email, role: cleanRole, linkedRecordId: commercial.id })
  }
  if (cleanRole === 'exposant') {
    const records = await atFind('Sociétés', `LOWER({Email})="${escapeFormula(normalizeEmail(email))}"`)
    if (!records[0]?.id) return null
    return ensureAuthUser({ email, role: cleanRole, linkedRecordId: records[0].id })
  }
  return null
}

async function authenticateRequest(req) {
  const token = requestAuthToken(req)
  const payload = verifyAuthToken(token)
  const user = await findAuthUserById(payload.uid)
  if (!user || !user.active) throw new Error('inactive_user')
  return {
    ...publicAuthUser(user),
    linkedRecordId: payload.linkedRecordId || user.linkedRecordId || '',
  }
}

function requireRole(allowedRoles) {
  const roles = (Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles]).map(normalizeRole)
  return async (req, res, next) => {
    try {
      const auth = await authenticateRequest(req)
      if (!roles.includes(auth.role)) {
        return res.status(403).json({ error: 'Accès non autorisé pour ce rôle.' })
      }
      req.auth = auth
      next()
    } catch (e) {
      res.status(401).json({ error: 'Session invalide ou expirée. Reconnectez-vous.' })
    }
  }
}

const RESTRICTED_STAND_SURFACE_M2 = 25
const MIN_RESTRICTED_STANDS = 2

function parseStandSurfaceM2(value) {
  if (typeof value === 'number') return value
  if (Array.isArray(value)) return parseStandSurfaceM2(value[0])

  const text = String(value || '').trim()
  const dimensions = text.match(/(\d+(?:[.,]\d+)?)\s*(?:m|metres?|mètres?)?\s*(?:x|X|×|\*)\s*(\d+(?:[.,]\d+)?)/i)
  if (dimensions) {
    const width = Number(dimensions[1].replace(',', '.')) || 0
    const depth = Number(dimensions[2].replace(',', '.')) || 0
    return width * depth
  }

  const match = text.match(/(\d+(?:[.,]\d+)?)/)
  return match ? Number(match[1].replace(',', '.')) || 0 : 0
}

function standSurfaceM2(fields = {}) {
  return parseStandSurfaceM2(
    fields['Surface'] ??
    fields['Superficie'] ??
    fields['Dimension'] ??
    fields['Dimensions'] ??
    fields['surface']
  )
}

function isRestrictedStandSurface(fields = {}) {
  return Math.abs(standSurfaceM2(fields) - RESTRICTED_STAND_SURFACE_M2) <= 0.5
}

// Générateur de token aléatoire pour accès dashboard exposant
function generateToken() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'  // sans 0/O/I/1 pour lisibilité
  let token = ''
  for (let i = 0; i < 16; i++) {
    token += chars[Math.floor(Math.random() * chars.length)]
  }
  return token
}

// ── Email utilities ────────────────────────────────────────

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

// ── Auth routes ────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email)
    const password = String(req.body?.password || '')
    const requestedRole = normalizeRole(req.body?.role || req.body?.space)

    if (!email || !password || !requestedRole) {
      return res.status(400).json({ error: 'Email, mot de passe et rôle requis.' })
    }
    if (!canAttemptLogin(req, email, requestedRole)) {
      return res.status(429).json({ error: 'Trop de tentatives. Réessayez dans 15 minutes.' })
    }

    const user = await findAuthUserByEmail(email, requestedRole)
    const genericError = 'Identifiants invalides.'
    if (!user || !user.active || user.role !== requestedRole) {
      return res.status(401).json({ error: genericError })
    }
    if (!user.passwordHash) {
      return res.status(403).json({ error: 'Mot de passe non initialisé. Utilisez “mot de passe oublié”.' })
    }
    if (!verifyPassword(password, user.passwordHash)) {
      return res.status(401).json({ error: genericError })
    }

    const linkedRecordId = await resolveAuthLinkedRecord(user)
    if (user.role === 'commercial' && !linkedRecordId) {
      return res.status(403).json({ error: 'Compte commercial non lié à Airtable.' })
    }
    if (user.role === 'exposant' && !linkedRecordId) {
      return res.status(403).json({ error: 'Compte exposant non lié à une société.' })
    }

    const publicUser = await startAuthSession(res, { ...user, linkedRecordId })
    resetLoginAttempts(req, email, requestedRole)
    patchAuthUser(user, { lastLogin: new Date().toISOString() }).catch(e => console.warn('[auth/login] lastLogin:', e.message))

    res.json({
      success: true,
      user: publicUser,
    })
  } catch (e) {
    console.error('[auth/login]', e.message)
    res.status(500).json({ error: DEBUG ? e.message : 'Erreur de connexion' })
  }
})

app.get('/api/auth/me', async (req, res) => {
  try {
    const auth = await authenticateRequest(req)
    res.json({ authenticated: true, user: auth })
  } catch {
    res.status(401).json({ authenticated: false, error: 'Session invalide ou expirée.' })
  }
})

app.post('/api/auth/logout', (req, res) => {
  clearAuthCookie(res)
  res.json({ success: true })
})

app.post('/api/auth/account-status', async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email)
    const requestedRole = normalizeRole(req.body?.role || req.body?.space)
    if (!email || !requestedRole) {
      return res.status(400).json({ error: 'Email et rôle requis.' })
    }
    const user = await findAuthUserByEmail(email, requestedRole)
    res.json({
      exists: !!user,
      active: user ? user.active : true,
      hasPassword: !!user?.passwordHash,
      needsPassword: !user || !user.passwordHash,
    })
  } catch (e) {
    console.error('[auth/account-status]', e.message)
    res.status(500).json({ error: DEBUG ? e.message : 'Erreur de vérification du compte' })
  }
})

app.post('/api/auth/request-password-reset', async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email)
    const requestedRole = normalizeRole(req.body?.role || req.body?.space)
    if (!email || !requestedRole) {
      return res.status(400).json({ error: 'Email et rôle requis.' })
    }

    let user = await findAuthUserByEmail(email, requestedRole)
    if (!user && ['commercial', 'exposant'].includes(requestedRole)) {
      user = await ensureMigratedAuthUser(email, requestedRole)
    }
    const response = { success: true, message: 'Si ce compte existe, un lien de réinitialisation a été envoyé.' }
    if (!user || !user.active || user.role !== requestedRole) return res.json(response)

    const rawToken = crypto.randomBytes(32).toString('base64url')
    const expires = new Date(Date.now() + PASSWORD_RESET_MS).toISOString()
    await patchAuthUser(user, {
      passwordResetTokenHash: tokenHash(rawToken),
      passwordResetExpires: expires,
    })

    const frontendBase = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '')
    const resetUrl = `${frontendBase}/reset-password?email=${encodeURIComponent(email)}&role=${encodeURIComponent(user.role)}&token=${encodeURIComponent(rawToken)}`
    const result = await mailer(
      email,
      'Réinitialisation de votre mot de passe — Madavision',
      emailWrapper(`
        <h2 style="color:#1B2A4A;font-size:18px;margin:0 0 14px">Réinitialisation du mot de passe</h2>
        <p>Une demande de réinitialisation a été faite pour votre compte Madavision.</p>
        <p>Ce lien expire dans ${PASSWORD_RESET_MINUTES} minutes.</p>
        <div style="margin-top:22px">
          <a href="${resetUrl}" style="background:#1B2A4A;color:#fff;text-decoration:none;padding:10px 22px;border-radius:8px;display:inline-block;font-weight:600;font-size:13px">Définir mon mot de passe</a>
        </div>
      `)
    )

    res.json({
      ...response,
      emailSent: result.sent,
      resetToken: !mailTransporter || DEBUG ? rawToken : undefined,
      resetUrl: !mailTransporter || DEBUG ? resetUrl : undefined,
    })
  } catch (e) {
    console.error('[auth/request-password-reset]', e.message)
    res.status(500).json({ error: DEBUG ? e.message : 'Erreur de réinitialisation' })
  }
})

app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email)
    const token = String(req.body?.token || '')
    const password = String(req.body?.password || '')
    const requestedRole = normalizeRole(req.body?.role || req.body?.space)

    if (!email || !token || !password || !requestedRole) {
      return res.status(400).json({ error: 'Email, rôle, token et mot de passe requis.' })
    }
    const policyError = passwordPolicyError(password)
    if (policyError) return res.status(400).json({ error: policyError })

    const user = await findAuthUserByEmail(email, requestedRole)
    if (!user || !user.active || user.role !== requestedRole) {
      return res.status(400).json({ error: 'Lien de réinitialisation invalide.' })
    }

    const resetHash = authPick(user.rawFields, ['passwordResetTokenHash', 'Password Reset Token Hash', 'Token reset hash'])
    const resetExpiresRaw = authPick(user.rawFields, ['passwordResetExpires', 'Password Reset Expires', 'Expiration reset'])
    const resetExpires = resetExpiresRaw ? new Date(resetExpiresRaw).getTime() : 0
    if (!resetHash || resetHash !== tokenHash(token) || !resetExpires || Date.now() > resetExpires) {
      return res.status(400).json({ error: 'Lien de réinitialisation expiré ou invalide.' })
    }

    await patchAuthUser(user, {
      passwordHash: hashPassword(password),
      passwordResetTokenHash: '',
      passwordResetExpires: null,
    })

    res.json({ success: true })
  } catch (e) {
    console.error('[auth/reset-password]', e.message)
    res.status(500).json({ error: DEBUG ? e.message : 'Erreur de réinitialisation' })
  }
})

// ────────────────────────────────────────────────────────────
//  ROUTES
// ────────────────────────────────────────────────────────────

// Health check (utilisé par Render pour vérifier que le service est UP)
// GET /api/debug/salons — test direct table Salons (dev)
app.get('/api/debug/salons', async (req, res) => {
  try {
    const records = await atGet('Salons')
    res.json({
      count: records.length,
      fields: records[0] ? Object.keys(records[0].fields) : [],
      records: records.map(r => ({ id: r.id, fields: r.fields }))
    })
  } catch(e) {
    res.status(500).json({ error: e.message, tip: 'Vérifiez le nom exact de la table dans Airtable' })
  }
})

// GET /api/debug/stands — diagnostic filtre stands par événement
app.get('/api/debug/stands', async (req, res) => {
  try {
    const [standsResp, salonsResp, editionsResp] = await Promise.all([
      atGet('Stands'),
      atGet('Salons'),
      atGet('Éditions'),
    ])

    // Reconstruction salonToEditionsMap (même logique que bootstrap)
    const salonToEditionsMap = {}
    editionsResp.forEach(r => {
      const ef = r.fields
      const linked = ef['Salon'] || ef['Salons'] || ef['Salon lié'] || ef['ID Salon'] || []
      const ids = Array.isArray(linked) ? linked : (linked ? [linked] : [])
      ids.filter(Boolean).forEach(salonId => {
        if (!salonToEditionsMap[salonId]) salonToEditionsMap[salonId] = []
        salonToEditionsMap[salonId].push(r.id)
      })
    })

    const salons = salonsResp.map(r => {
      const f = r.fields
      const direct = f['Éditions'] || f['Editions'] || f['Edition'] || f['Édition'] || []
      return {
        id: r.id,
        label: f['Nom du salon'] || f['ID Salon'] || r.id,
        editionIds_direct: direct,
        editionIds_reverse: salonToEditionsMap[r.id] || [],
        editionIds_final: direct.length > 0 ? direct : (salonToEditionsMap[r.id] || []),
      }
    })

    const stands = standsResp.slice(0, 20).map(r => ({
      id:   r.id,
      code: r.fields['ID Stand'] || '—',
      // Champ "Editions" qui lie directement aux Salons (votre config)
      directSalonIds:   r.fields['Editions']  || r.fields['Éditions'] || [],
      // Champ "Edition" qui lie aux Éditions (config alternative)
      indirectEditions: r.fields['Édition']   || r.fields['Edition']  || [],
      // Tous les champs contenant "edition" pour diagnostic
      allEditionFields: Object.entries(r.fields)
        .filter(([k]) => k.toLowerCase().includes('edition') || k.toLowerCase().includes('édition') || k.toLowerCase().includes('salon'))
        .reduce((acc, [k,v]) => ({ ...acc, [k]: v }), {}),
    }))

    res.json({
      salons,
      editions: editionsResp.map(r => ({
        id: r.id,
        nom: r.fields['Nom édition'] || r.id,
        salonField: r.fields['Salon'] || r.fields['Salons'] || null,
      })),
      standsTotal: standsResp.length,
      standsSample: stands,
      tip: 'Vérifiez que editionIds_final des salons et editionIds des stands se correspondent',
    })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'madavision-backend',
    time: new Date().toISOString(),
  })
})

// ── /api/bootstrap — charge tout ce qu'il faut au formulaire ──
app.get('/api/bootstrap', async (req, res) => {
  try {
    const [salonsResp, catalogueResp, codesPromoResp, schemaResp, optActResp] = await Promise.all([
      atGet('Salons').catch(e => { console.warn('[bootstrap] Salons fetch failed:', e.message); return [] }),
      atGet('Stands'),
      atGet('Codes promo').catch(() => []),
      fetch(`https://api.airtable.com/v0/meta/bases/${BASE}/tables`, {
        headers: headers()
      }).then(r => r.json()).catch(() => ({ tables: [] })),
      atGet('Activités optionnelles').catch(() => []),
    ])

    console.log(`[bootstrap] Salons: ${salonsResp.length}, Stands: ${catalogueResp.length}`)
    if (salonsResp.length > 0) {
      console.log('[bootstrap] Salons fields:', Object.keys(salonsResp[0].fields))
      console.log('[bootstrap] Salons[0]:', JSON.stringify(salonsResp[0].fields).slice(0, 200))
    }

    // ── Salons (pour Step 1 inscription) ──────────────────────
    const salons = salonsResp.map(r => {
      const f = r.fields
      return {
        airtableId:  r.id,
        idSalon:     f['ID Salon']      || '',
        label:       f['Nom du salon']  || f['Nom'] || f['Name'] || f['ID Salon'] || '—',
        edition:     f['Edition']       || f['Édition'] || f['Nom édition'] || f['Année'] || '',
        description: f['Description']  || f['Notes'] || '',
        lieu:        f['Lieu'] || f['Ville'] || f['Lieu du salon'] || '',
        statut:      f['Statut'] || 'Actif',
        dateDebut:   f['Date début']   || f['Date de début'] || f['Date debut'] || f['Date de debut'] || '',
        dateFin:     f['Date fin']     || f['Date de fin']   || f['Date fin']   || f['Date de fin']   || '',
        editionIds:  [r.id], // Désormais l'ID du Salon sert d'ID d'édition
        logo:        f['Logo']?.[0]?.url || null,
        planMasseUrl: attachmentUrl(f, PLAN_MASSE_FIELDS),
      }
    })

    // ── Les Éditions sont maintenant mappées directement depuis les Salons ──
    const editions = salons.map(s => ({
      id:        s.airtableId,
      nom:       s.edition || s.label,
      dateDebut: s.dateDebut,
      dateFin:   s.dateFin,
      lieu:      s.lieu,
      statut:    s.statut
    }))

    // ── Catalogue stands actifs (depuis table Stands) ──
    const catalogue = catalogueResp
      .filter(r => {
        const statut = r.fields['Statut'] || 'Disponible'
        return statut !== 'Annulé'
      })
      .map(r => {
        const f = r.fields

        // Le champ 'Édition' dans Stands pointe maintenant vers la table Salons
        const standSalonIds = f['Édition'] || f['Edition'] || f['Editions'] || f['Éditions'] || []
        const salonIds = Array.isArray(standSalonIds) ? standSalonIds : [standSalonIds]

        return {
          airtableId:  r.id,
          id:          r.id,
          code:        f['ID Stand'] || r.id,
          libelle:     f['ID Stand'] || '—',
          type:        f['Spécificités'] || 'Autres',
          typeProduit: f['Spécificités'] || 'Autres',
          surface:     f['Dimension']    || '',
          prix:        f['Prix']         || 0,
          statut:      f['Statut']       || 'Disponible',
          salonIds,  // ← filtre frontend : stand.salonIds.includes(salon.airtableId)
        }
      })

    // ── Activités optionnelles ──
    const optionalActivities = optActResp.map(r => ({
      id:          r.id,
      label:       r.fields['Nom activité'] || r.fields['Nom'] || 'Sans titre',
      type:        r.fields['Type activité'] || '',
      description: r.fields['Description / thème'] || '',
      prix:        r.fields['Prix unitaire'] || 0,
      dateCreneau: r.fields['Date et créneau'] || '',
      statut:      r.fields['Statut'] || '',
    }))

    // ── Codes promo actifs et valides ──
    const todayStr = new Date().toISOString().slice(0, 10)  // "2026-05-18"
    const codesPromo = {}
    codesPromoResp.forEach(r => {
      const f = r.fields
      if (!f['Code'] || !f['Valeur']) return

      const statut = f['Statut'] || ''
      if (statut === 'Désactivé' || statut === 'Expiré') return

      // Comparaison par date pure (insensible au fuseau)
      const dDeb = f['Date début validité'] ? String(f['Date début validité']).slice(0, 10) : null
      const dFin = f['Date fin validité']   ? String(f['Date fin validité']).slice(0, 10)   : null
      if (dDeb && todayStr < dDeb) return
      if (dFin && todayStr > dFin) return

      const type = String(f['Type'] || '').toLowerCase()
      const isPct = type.includes('%') || type.includes('pct') || type.includes('pourcent')

      codesPromo[String(f['Code']).toUpperCase()] = {
        airtableId: r.id,
        type:   isPct ? 'pct' : 'fixe',
        valeur: f['Valeur'],
        label:  f['Motif'] || `${f['Valeur']}${isPct ? ' %' : ' Ar'} de réduction`,
      }
    })

    // ── Options Single Select depuis le schéma ──
    const tables = schemaResp.tables || []
    const findTable = (n) => tables.find(t => t.name === n)
    const findField = (t, n) => t?.fields?.find(f => f.name === n)
    const optionsOf = (table, field) => {
      const t = findTable(table)
      const f = findField(t, field)
      return f?.options?.choices?.map(c => c.name) || []
    }

    // ── Emplacements = Stands avec leur statut ──
    const emplacements = catalogueResp
      .filter(r => r.fields['ID Stand'])
      .map(r => {
        const statut = r.fields['Statut'] || 'Disponible'
        return {
          id:         r.id,
          numero:     r.fields['ID Stand'] || '',
          zone:       r.fields['Spécificités'] || '',
          specs:      r.fields['Dimension'] || '',
          tarif:      r.fields['Tarif référence'] || 0,
          statut,
          editionIds: r.fields['Édition'] || [],
          libre:      !statut || ['Libre', 'Disponible'].includes(statut),
        }
      })
      .sort((a, b) => a.numero.localeCompare(b.numero, undefined, { numeric: true, sensitivity: 'base' }))

    res.json({
      salons,
      editions,
      catalogue,
      optionalActivities,
      codesPromo,
      emplacements,
      options: {
        statutsExposant:    optionsOf('Participations', 'Statut exposant'),
        activitesGratuites: optionsOf('Participations', 'Activité gratuite choisie'),
        regimesFiscaux:     optionsOf('Sociétés', 'Régime fiscal'),
        typesEntite:        optionsOf('Sociétés', "Type d'entité"),
      },
    })

  } catch (e) {
    console.error('[bootstrap] error:', e.message)
    res.status(500).json({
      error: DEBUG ? e.message : 'Erreur lors du chargement des données'
    })
  }
})

// ── /api/check-duplicate — vérifier société existante ──
app.post('/api/check-duplicate', async (req, res) => {
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

// ── GET /api/societes/search?q=... — recherche société par nom pour préremplissage ──
// Retourne id, nom, typeEntite, secteur, adresse, nif, stat, nbMembres,
// regimeFiscal, statutExposant (dernière participation), commercial, commercialId,
// hasDossier, nbDossiers
app.get('/api/societes/search', async (req, res) => {
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

// ────────────────────────────────────────────────────────────
//  VOUCHER — vérification et utilisation fractionnable
// ────────────────────────────────────────────────────────────

// POST /api/voucher/check — vérifie un voucher, son propriétaire et sa transférabilité
app.post('/api/voucher/check', async (req, res) => {
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

// ── /api/inscription — soumission complète ──
app.post('/api/inscription', async (req, res) => {
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

    const cmdFields = {
      'Societé':         [socId],
      'Statut commande': 'En attente validation',
      'Validation':      'A Valider',
      'Date commande':   new Date().toISOString().slice(0, 10),
      'Notes':           notes.join('\n'),
      'Activités optionnelles': data.activitesOptionnellesIds || [],
      'Token d\'accès':   accessToken
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
        salonLabel:       data.salonLabel    || data.editionLabel || '',
        salonLieu:        data.salonLieu     || data.lieu         || '',
        salonDateDebut:   data.salonDateDebut || '',
        salonDateFin:     data.salonDateFin   || '',
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
      const espaceUrl    = `${frontendBase}/exposant/${accessToken}`
      const numDossier   = cmd.id.slice(-8).toUpperCase()
      const nomSoc       = escapeHtml(data.nomSociete || data.nomSoc || 'votre société')
      const salonLabel   = escapeHtml(data.salonLabel || data.editionLabel || '')

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

// ────────────────────────────────────────────────────────────
//  EMPLACEMENTS — disponibilité temps réel
// ────────────────────────────────────────────────────────────

// GET /api/emplacements?editionId=... — liste avec statut à jour
// Permet au formulaire de rafraîchir la disponibilité avant soumission
app.get('/api/emplacements', async (req, res) => {
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

// ────────────────────────────────────────────────────────────
//  ROUTES DASHBOARD EXPOSANT
// ────────────────────────────────────────────────────────────

app.use('/api/exposant/:token', requireExposantTokenAccess)

// GET /api/exposant/:token — récupère le dossier complet d'un exposant
app.get('/api/exposant/:token', async (req, res) => {
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

    // 3. Édition liée (via la commande)
    const editionId = (cf['Édition'] || cf['Edition'] || cf['Societé'] || [])[0]
    let edition = null
    if (editionId) {
      const edRes  = await fetch(`${ATBASE}/${encodeURIComponent('Salons')}/${editionId}`, { headers: headers() })
      if (edRes.ok) {
        const edData = await edRes.json()
        const ef = edData.fields || {}
        edition = {
          id: edData.id,
          nom:       ef['Edition'] || ef['Nom du salon'] || edData.id,
          dateDebut: ef['Date début'] || ef['Date de début'] || '',
          dateFin:   ef['Date fin'] || ef['Date de fin'] || '',
          lieu:      ef['Lieu'] || ef['Ville'] || '',
          salonId:   edData.id,
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
      notes:           cf['Notes'] || '',
      paiements:       cf['Paiements'] || [],
      documentsFinanciers: cf['Documents financiers'] || [],
      stands:          standLabels.join(', '),
      standItems:      stands,
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
      documentsFinanciers,
      optionalActivities,
      bilan,
    })

  } catch (e) {
    console.error('[exposant] error:', e.message)
    res.status(500).json({ error: DEBUG ? e.message : 'Erreur de chargement du dossier' })
  }
})

// ── GET /api/sonia/dossier/:id — Récupère un dossier complet pour le commercial ──
app.get('/api/sonia/dossier/:id', requireSonia, async (req, res) => {
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
        paiements.push({
          id: pid,
          montant: parseMGA_local(pd['Montant payé'] || pd['Montant']),
          mode:    pd['Mode de paiement'] || pd['Mode paiement'] || '—',
          date:    pd['Date paiement'] || pd['Date'] || '',
          reference: pd['Référence'] || '',
          valide:  pd['Validé par M. Hery'] === true || (pd['Statut'] || '') === 'Validé',
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
        accesParkingVIP: cf['Accès parking VIP'] || 0,
        notes: cf['Notes'] || '',
      },
      societe: { ...sf, id: societeId, idEntreprise: sf['ID Entreprise'] || null },
      statutExposant: sf['Statut exposant (from Participations)'] || 'Exposant', // Récupérer le statut exposant de la société
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

// POST /api/exposant/:token/bilan — ajouter un équipement
app.post('/api/exposant/:token/bilan', async (req, res) => {
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
app.patch('/api/exposant/:token/bilan/:id', async (req, res) => {
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
app.delete('/api/exposant/:token/bilan/:id', async (req, res) => {
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

// ────────────────────────────────────────────────────────────
//  ENVOI EMAIL DOSSIER
// ────────────────────────────────────────────────────────────

// POST /api/send-dossier — envoie le dossier par email au client
// ────────────────────────────────────────────────────────────
//  OTP — Validation email avant inscription
// ────────────────────────────────────────────────────────────

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

// POST /api/send-otp — génère et envoie un code OTP par email
app.post('/api/send-otp', async (req, res) => {
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
app.post('/api/verify-otp', async (req, res) => {
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

// ────────────────────────────────────────────────────────────
//  RECONNEXION PAR CODE ENTREPRISE (exposant déjà inscrit)
// ────────────────────────────────────────────────────────────

// Masque l'email pour affichage : jean.dupont@example.mg → j***t@example.mg
function maskEmail(email) {
  if (!email || !email.includes('@')) return '****'
  const [local, domain] = email.split('@')
  if (local.length <= 2) return `${local[0]}*@${domain}`
  return `${local[0]}${'*'.repeat(Math.min(local.length - 2, 4))}${local[local.length - 1]}@${domain}`
}

// OTP store pour la reconnexion par code entreprise (keyed par socId, jamais par email)
const otpStoreCompany = new Map()  // socId → { code, expiry, email }

// POST /api/company-code/check
// Vérifie si le code entreprise existe dans Airtable (champ "ID Entreprise" de Sociétés)
// Retourne l'email masqué et socId — l'email réel NE QUITTE JAMAIS le serveur
app.post('/api/company-code/check', async (req, res) => {
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
app.post('/api/company-code/forgot', async (req, res) => {
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
app.post('/api/company-code/send-otp', async (req, res) => {
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
app.post('/api/company-code/verify-otp', async (req, res) => {
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

// ────────────────────────────────────────────────────────────
//  ESPACE CLIENT — tous les dossiers d'un email
// ────────────────────────────────────────────────────────────

async function findCommandeByAccessToken(rawToken) {
  const token = String(rawToken || '').toUpperCase().replace('TOKEN:', '').replace(/[^A-Z0-9]/g, '')
  if (!token || token.length < 5) return null
  const safeToken = escapeFormula(token)
  const formula = `OR({Token d'accès}="${safeToken}", FIND("TOKEN:${safeToken}", {Notes}) > 0)`
  const records = await atFind('Commandes', formula)
  return records[0] || null
}

async function requireExposantTokenAccess(req, res, next) {
  try {
    const auth = await authenticateRequest(req)
    if (auth.role !== 'exposant') return res.status(403).json({ error: 'Accès exposant requis.' })

    const cmd = await findCommandeByAccessToken(req.params.token)
    if (!cmd) return res.status(404).json({ error: 'Dossier introuvable. Vérifiez votre lien d’accès.' })

    const cf = cmd.fields || {}
    const societeId = (cf['Societé'] || cf['Société'] || [])[0]
    if (!societeId) return res.status(404).json({ error: 'Société introuvable' })

    if (auth.linkedRecordId && auth.linkedRecordId === societeId) {
      req.auth = auth
      req.exposantEmail = auth.email
      req.exposantSocieteId = societeId
      req.exposantCommand = cmd
      return next()
    }

    const socResp = await fetch(`${ATBASE}/${encodeURIComponent('Sociétés')}/${societeId}`, { headers: headers() })
    const socData = socResp.ok ? await socResp.json() : null
    const socEmail = normalizeEmail(socData?.fields?.['Email'])
    if (!socEmail || socEmail !== auth.email) {
      return res.status(403).json({ error: 'Ce dossier n’est pas rattaché à votre compte.' })
    }montantTaxe

    req.auth = auth
    req.exposantEmail = auth.email
    req.exposantSocieteId = societeId
    req.exposantCommand = cmd
    next()
  } catch (e) {
    res.status(401).json({ error: 'Session exposant invalide ou expirée. Reconnectez-vous.' })
  }
}

function requireExposant(req, res, next) {
  requireRole('exposant')(req, res, () => {
    req.exposantEmail = req.auth.email
    req.exposantSocieteId = req.auth.linkedRecordId || ''
    next()
  })
}

// GET /api/espace-client?email=... — tous les dossiers pour cet email (après OTP)
app.get('/api/espace-client', requireExposant, async (req, res) => {
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

          // ── Édition ──
          const edId = (cf['Édition'] || cf['Edition'] || [])[0]
          let edition = { nom: 'FIM 2026', id: edId }
          if (edId) {
            try {
              const er = await fetch(`${ATBASE}/${encodeURIComponent('Éditions')}/${edId}`, { headers: headers() })
              if (er.ok) { const ef = (await er.json()).fields; edition.nom = ef['Nom édition'] || ef['Nom'] || edition.nom }
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

// ────────────────────────────────────────────────────────────
//  ESPACE EXPOSANT — Actions (annulation, modification)
// ────────────────────────────────────────────────────────────

// POST /api/exposant/:token/cancel — annuler la commande
app.post('/api/exposant/:token/cancel', async (req, res) => {
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

// POST /api/exposant/:token/update — modifier les infos exposant
app.post('/api/exposant/:token/update', async (req, res) => {
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

    // ── NOUVEAU : Traitement du logo via Cloudinary ──
    data.logoUrl = await handleImageUpload(data.logoUrl || data.logoSocieteUrl || data.logoParticipation || data.logo)

    // Champs modifiables par l'exposant (infos de contact uniquement)
    const socFields = {}
    if (data.telephone)       socFields['Téléphone']        = data.telephone
    if (data.adresse)         socFields['Adresse']          = data.adresse
    if (data.contact)         socFields['Contact principal'] = data.contact
    if (data.fonction)        socFields['Fonction contact']  = data.fonction
    if (data.logoUrl) {
      socFields['Logo'] = [{ url: data.logoUrl }]
    }

    if (Object.keys(socFields).length > 0) {
      await fetch(`${ATBASE}/${encodeURIComponent('Sociétés')}/${socId}`, {
        method: 'PATCH',
        headers: headers(),
        body: JSON.stringify({ fields: socFields }),
      })
    }

    // Demandes de modification (stand, emplacement) → note dans la participation
    if (data.demandeModification) {
      const noteActuelle = cf['Notes'] || ''
      const noteAjout = `\n[DEMANDE MODIFICATION ${new Date().toLocaleDateString('fr-FR')}] ${data.demandeModification}`
      await fetch(`${ATBASE}/${encodeURIComponent('Commandes')}/${cmd.id}`, {
        method: 'PATCH',
        headers: headers(),
        body: JSON.stringify({ fields: { 'Notes': (noteActuelle + noteAjout).trim() } }),
      })
    }

    // Modification des stands sélectionnés
    if (Array.isArray(data.standIds)) {
      const cmdFields = {}
      cmdFields['Stand ou service commandé'] = data.standIds
      cmdFields['Validation'] = 'A valider'
      cmdFields['Statut commande'] = 'En attente de validation'

      await fetch(`${ATBASE}/${encodeURIComponent('Commandes')}/${cmd.id}`, {
        method: 'PATCH',
        headers: headers(),
        body: JSON.stringify({ fields: cmdFields }),
      })

      const currentStandIds = (cf['Stand ou service commandé'] || []).map(id => String(id))
      const newStandIds = data.standIds.map(String)
      const toFree = currentStandIds.filter(id => !newStandIds.includes(id))
      const toReserve = newStandIds.filter(id => !currentStandIds.includes(id))

      for (const id of toFree) {
        try {
          await fetch(`${ATBASE}/${encodeURIComponent('Stands')}/${id}`, {
            method: 'PATCH',
            headers: headers(),
            body: JSON.stringify({ fields: { 'Statut': 'Disponible' } }),
          })
        } catch(e) { console.warn(`[update] free stand ${id}:`, e.message) }
      }

      for (const id of toReserve) {
        try {
          await fetch(`${ATBASE}/${encodeURIComponent('Stands')}/${id}`, {
            method: 'PATCH',
            headers: headers(),
            body: JSON.stringify({ fields: { 'Statut': 'Réservé' } }),
          })
        } catch(e) { console.warn(`[update] reserve stand ${id}:`, e.message) }
      }
    }

    res.json({ success: true, message: 'Informations mises à jour.' })
  } catch(e) {
    console.error('[update] error:', e.message)
    res.status(500).json({ error: DEBUG ? e.message : 'Erreur lors de la mise à jour' })
  }
})

// ────────────────────────────────────────────────────────────
//  PAIEMENT EXPOSANT — déclaration de paiement
// ────────────────────────────────────────────────────────────
app.post('/api/exposant/:token/paiement', async (req, res) => {
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

      // B. Template pour l'Exposant
      const exhibHtml = emailWrapper(`
        <h2 style="color:#195b98;font-size:18px;margin:0 0 14px">Déclaration de paiement reçue</h2>
        <p>Bonjour,</p>
        <p>Nous avons bien enregistré votre déclaration de paiement de <strong>${fmtMoney(montant)}</strong>.</p>
        <div style="background:#E8F7EF;border-left:4px solid #1E7F54;padding:16px 20px;border-radius:0 12px 12px 0;margin:20px 0">
          <p style="margin:0;font-size:13px;color:#165f3e;line-height:1.5">
            Notre équipe administrative va procéder à la vérification de la transaction. 
            Le statut de votre règlement sera mis à jour dans votre espace exposant sous <strong>24–48h ouvrables</strong>.
          </p>
        </div>
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

// ────────────────────────────────────────────────────────────
//  UPLOAD BON DE COMMANDE
// ────────────────────────────────────────────────────────────
app.post('/api/exposant/:token/upload-bc', async (req, res) => {
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
app.get('/api/exposant/:token/download-bc/:filename', (req, res) => {
  const token    = (req.params.token || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  const cleanToken = token.replace('TOKEN', '').replace(/[^A-Z0-9]/g, '')
  const filename = (req.params.filename || '').replace(/[^a-zA-Z0-9._-]/g, '_')
  const filePath = path.join(UPLOADS_DIR, cleanToken, filename)
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Fichier introuvable' })
  res.download(filePath, filename)
})

// GET /api/exposant/:token/download-dossier — téléchargement PDF dossier d'inscription
// Sert le PDF pré-généré si disponible, sinon le génère à la volée depuis Airtable
app.get('/api/exposant/:token/download-dossier', async (req, res) => {
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

    // Société + Édition en parallèle
    const societeId = (cf['Societé'] || cf['Société'] || [])[0]
    const editionId = (cf['Édition'] || cf['Edition'] || [])[0]
    if (!societeId) return res.status(404).json({ error: 'Société introuvable.' })

    const [socData, edData] = await Promise.all([
      fetch(`${ATBASE}/${encodeURIComponent('Sociétés')}/${societeId}`, { headers: headers() }).then(r => r.json()),
      editionId ? fetch(`${ATBASE}/${encodeURIComponent('Éditions')}/${editionId}`, { headers: headers() }).then(r => r.json()) : Promise.resolve(null),
    ])
    const sf = socData.fields || {}
    const ef = edData?.fields  || {}

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
      salonLabel:       ef['Nom édition']  || ef['Année']     || '',
      salonLieu:        ef['Lieu']                            || '',
      salonDateDebut:   ef['Date début']                      || '',
      salonDateFin:     ef['Date fin']                        || '',
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


// app.post('/api/send-dossier', async (req, res) => {
//   try {
//     // Vérifier que l'email est configuré
//     if (!EMAIL_ENABLED || !mailTransporter) {
//       return res.status(503).json({
//         error: 'L\'envoi d\'email n\'est pas configuré sur le serveur'
//       })
//     }

//     // const { email, nomSociete, numDossier, htmlDossier, dashboardUrl } = req.body || {}

//     const {
//       email, nomSociete, numDossier, htmlDossier, dashboardUrl,
//       // Infos société (pour l'entête email)
//       nif, stat, adresse, telephone: telSoc, siteWeb, emailSociete,
//       logoSocieteUrl,         // URL publique logo société (depuis Airtable)
//       // Données financières (formules identiques Airtable)
//       totalStands    = 0,    // Total TTC stands (champ Cumul Airtable)
//       totalActivites = 0,    // Prix activités optionnelles
//       remisePromo    = 0,    // Montant remise code promo
//       montantVoucher = 0,    // Montant utilisé voucher
//       regimeFiscal   = '',   // '0.2' | '0.08' | '0' ou texte
//       stands         = [],   // [{label, prix}] détail des stands
//       activites      = [],   // [{label, prix}] détail des activités
//     } = req.body || {}

//     // Validation
//     if (!email || !email.includes('@')) {
//       return res.status(400).json({ error: 'Email invalide' })
//     }
//     if (!htmlDossier) {
//       return res.status(400).json({ error: 'Contenu du dossier manquant' })
//     }
//     if (!nomSociete) {
//       return res.status(400).json({ error: 'Nom de société manquant' })
//     }

//     // Nom de fichier pour la pièce jointe
//     const safeName = String(nomSociete).replace(/[^a-zA-Z0-9-_]/g, '_').slice(0, 40)
//     const filename = `Dossier_${(numDossier || 'export').replace(/[^a-zA-Z0-9-_]/g,'_')}_${safeName}.html`

//     // Email HTML — corps du message
//     const emailHtml = `
// <!DOCTYPE html>
// <html><head><meta charset="UTF-8"/></head>
// <body style="font-family:Arial,sans-serif;color:#1A1814;line-height:1.6;max-width:600px;margin:0 auto;padding:20px">
//   <div style="background:linear-gradient(135deg,#0A7070 0%,#085959 100%);color:#fff;padding:28px 24px;border-radius:10px 10px 0 0">
//     <div style="font-size:22px;font-weight:700;margin-bottom:4px">MADAVISION</div>
//     <div style="font-size:13px;opacity:.9">2026</div>
//   </div>

//   <div style="background:#fff;border:1px solid #E8E3DA;border-top:none;padding:28px 24px;border-radius:0 0 10px 10px">
//     <h2 style="color:#0A7070;font-size:18px;margin:0 0 14px 0">Confirmation d'inscription</h2>

//     <p>Bonjour,</p>

//     <p>Nous avons bien reçu l'inscription de <strong>${escapeHtml(nomSociete)}</strong> à la <strong>l'evenement de Madavision</strong>.</p>

//     <div style="background:#E6F4F4;border-left:3px solid #0A7070;padding:14px 18px;border-radius:0 8px 8px 0;margin:18px 0">
//       <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#0A7070;margin-bottom:6px">Numéro de dossier</div>
//       <div style="font-family:monospace;font-size:14px;font-weight:700;color:#085959">${escapeHtml(numDossier || '—')}</div>
//     </div>

//     <p>Vous trouverez en pièce jointe votre <strong>dossier d'inscription complet</strong> avec toutes les informations utiles (informations société, stand réservé, conditions de règlement).</p>

//     ${dashboardUrl ? `
//     <div style="background:#FEF3E8;border:1px solid #C87B2F;border-radius:8px;padding:16px 18px;margin:18px 0">
//       <div style="font-size:12px;font-weight:700;color:#C87B2F;margin-bottom:8px">🔑 Votre espace exposant personnel</div>
//       <div style="font-size:13px;margin-bottom:12px">Accédez à tout moment à votre dossier, suivez les paiements et téléchargez vos factures :</div>
//       <a href="${escapeHtml(dashboardUrl)}" style="background:#0A7070;color:#fff;text-decoration:none;padding:10px 22px;border-radius:8px;display:inline-block;font-weight:600;font-size:13px">Accéder à mon espace</a>
//       <div style="font-size:11px;color:#9B9183;margin-top:10px;word-break:break-all">${escapeHtml(dashboardUrl)}</div>
//     </div>
//     ` : ''}

//     <h3 style="color:#0A7070;font-size:14px;margin:22px 0 8px 0">Prochaines étapes</h3>
//     <ol style="padding-left:20px;font-size:13px;color:#5C5649">
//       <li>L'Administration Madavision validera votre dossier et l'éligibilité de votre activité</li>
//       <li>Vous recevrez un email de confirmation avec les instructions de règlement</li>
//       <li>Signature du contrat (sous 7 jours) puis règlement de l'acompte</li>
//       <li>Confirmation finale et préparation de votre stand</li>
//     </ol>

//     <p style="margin-top:24px">Pour toute question, n'hésitez pas à répondre à cet email ou à contacter votre commercial dès qu'il vous sera assigné.</p>

//     <p style="margin-bottom:0">Cordialement,<br><strong>L'équipe Madavision</strong></p>
//   </div>

//   <div style="text-align:center;padding:14px;color:#9B9183;font-size:11px">
//     Madavision · 2026<br>
//     Cet email a été envoyé automatiquement, vous pouvez y répondre directement.
//   </div>
// </body></html>`

//     // Envoi
//     const mailOptions = {
//       from:    `"${EMAIL_CONFIG.fromName}" <${EMAIL_CONFIG.fromAddress}>`,
//       to:      email,
//       subject: `Confirmation d'inscription — ${nomSociete}`,
//       html:    emailHtml,
//       attachments: [
//         {
//           filename,
//           content:     htmlDossier,
//           contentType: 'text/html; charset=utf-8',
//         },
//       ],
//     }
//     if (EMAIL_CONFIG.bcc) mailOptions.bcc = EMAIL_CONFIG.bcc

//     const info = await mailTransporter.sendMail(mailOptions)

//     res.json({
//       success: true,
//       messageId: info.messageId,
//       message: `Email envoyé à ${email}`,
//     })

//   } catch (e) {
//     console.error('[send-dossier] error:', e.message)
//     res.status(500).json({
//       error: DEBUG ? e.message : 'Impossible d\'envoyer l\'email. Veuillez réessayer.'
//     })
//   }
// })



// ════════════════════════════════════════════════════════
//  SONIA DASHBOARD — Authentification OTP + Validation
// ════════════════════════════════════════════════════════

app.post('/api/send-dossier', async (req, res) => {
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

const SONIA_EMAILS = (process.env.SONIA_EMAILS || process.env.SONIA_EMAIL || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
const otpStoreSonia = {}  // { email: { code, expires } }
const otpStoreCommercial = {}  // { email: { code, expires, commercialId } }

// POST /api/sonia/send-otp
app.post('/api/sonia/send-otp', async (req, res) => {
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
app.post('/api/sonia/verify-otp', (req, res) => {
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

function requireSonia(req, res, next) {
  requireRole('admin_sonia')(req, res, () => {
    req.soniaEmail = req.auth.email
    next()
  })
}

async function findCommercialByEmail(email) {
  const cleanEmail = String(email || '').trim().toLowerCase()
  if (!cleanEmail) return null
  const records = await atGet('Commerciaux')
  const record = records.find(r => {
    const f = r.fields || {}
    return [f['Email'], f['Email professionnel'], f['Mail']]
      .filter(Boolean)
      .some(v => String(v).trim().toLowerCase() === cleanEmail)
  })
  if (!record) return null
  const f = record.fields || {}
  return {
    id: record.id,
    nom: f['Nom'] || f['Nom complet'] || f['Prénom Nom'] || cleanEmail,
    email: f['Email'] || f['Email professionnel'] || f['Mail'] || cleanEmail,
    telephone: f['Téléphone'] || f['Tel'] || '',
    objectifStands: Number(f['Objectif stands'] || f['Objectif stands'] || f['objectifStands'] || 0),
    objectifCA: Number(f['Objectif CA'] || f['Objectif ca'] || f['objectifCA'] || 0),
  }
}

function requireCommercial(req, res, next) {
  requireRole('commercial')(req, res, () => {
    req.commercialEmail = req.auth.email
    req.commercialId = req.auth.linkedRecordId
    if (!req.commercialId) {
      return res.status(403).json({ error: 'Compte commercial non lié à Airtable.' })
    }
    next()
  })
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

function linkedRecordId(value) {
  if (Array.isArray(value) && value[0]?.startsWith('rec')) return value[0]
  if (typeof value === 'string' && value.startsWith('rec')) return value
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
  return values.map(v => String(v || '')).filter(v => v.startsWith('rec'))
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

function invoiceFormatDate(value) {
  const text = invoiceText(value)
  if (!text) return '—'
  const date = new Date(text)
  if (Number.isNaN(date.getTime())) return text
  return date.toLocaleDateString('fr-FR')
}

function invoiceSafeFilename(value) {
  return String(value || 'facture')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90) || 'facture'
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
    edition: { id: idToFetch, nom: f['Edition'] || f['Nom du salon'] },
    evenement: { id: idToFetch, nom: f['Nom du salon'], lieu: f['Lieu'] }
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
      const err = new Error('Ce dossier n’est pas assigné à ce commercial.')
      err.statusCode = 403
      throw err
    }
  }

  let editionId = invoiceLinkedIds(cf['Édition'] || cf['Edition'] || cf['Societé'])[0]
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

  // CALCUL DE SÉCURITÉ : Recalcul HT brut depuis les lignes réelles (Stands + Activités)
  const montantHT = lines.reduce((sum, item) => sum + invoiceMoney(item.amount) * (Number(item.qty) || 1), 0)
  
  const remisePromo = invoicePickMoney(cf, ['Montant remise promo', 'Remise promo', 'Remise accordée'], 0)
  const voucherAmount = invoicePickMoney(cf, ['Montant voucher appliqué', 'Voucher appliqué', 'Montant voucher'], 0)

  const rawTax = sf['Régime fiscal'] || sf['Regime fiscal'] || '0.2'
  const taxRate = String(rawTax).includes('20') ? 0.2 : String(rawTax).includes('8') ? 0.08 : parseFloat(rawTax) || 0
  
  // Formule Airtable : Taxe sur HT brut, Remises sur le TTC total
  const montantTaxe = Math.round(montantHT * taxRate)
  const totalTTCBase = montantHT + montantTaxe
  const netAPayer = Math.max(0, totalTTCBase - remisePromo - voucherAmount)
  const totalTTC = netAPayer // On utilise le Net comme montant TTC final
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
      nom: invoiceText(salonFields['Nom du salon'], salonFields['Nom'], salonFields['Name'], salonFields['ID Salon']),
      lieu: invoiceText(salonFields['Lieu'], salonFields['Ville'], ef['Lieu']),
    },
    edition: {
      nom: invoiceText(ef['Nom édition'], ef['Nom'], ef['Année'] ? `Édition ${ef['Année']}` : ''),
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
      montantEncaisse,
      resteAPayer,
      promoCode,
      voucherCode,
      taxLabel: invoiceTaxLabel(cf['Pourcentage Taxe'], regimeFiscal),
      regimeFiscal,
    },
  }
}

async function generateInvoicePDF(data) {
  const logoExposantBuffer = await fetchImageBuffer(data.societe.logoUrl)

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48, compress: true })
    const buffers = []
    doc.on('data', b => buffers.push(b))
    doc.on('end', () => resolve(Buffer.concat(buffers)))
    doc.on('error', reject)

    registerFonts(doc)
    const NAVY = '#0d0d0d'
    const BLEU = '#195b98'
    const GRAY = '#687e7e'
    const LIGHT = '#EEF2F8'
    const W = 499
    let y = 48

    function ensure(height = 40) {
      if (y + height <= 780) return
      doc.addPage()
      y = 48
    }
    function section(title) {
      ensure(34)
      doc.rect(48, y, W, 24).fill(LIGHT)
      doc.fillColor(NAVY).font('Poppins-Bold').fontSize(9).text(title.toUpperCase(), 60, y + 8)
      y += 34
    }
    function row(label, value, x = 60, width = 210) {
      if (value === null || value === undefined || value === '') return
      ensure(18)
      doc.fillColor(GRAY).font('Poppins-Regular').fontSize(8).text(label, x, y, { width })
      doc.fillColor(NAVY).font('Poppins-Bold').fontSize(9).text(String(value), x + width, y, { width: 547 - x - width, align: 'right' })
      y += 16
    }
    function moneyRow(label, value, strong = false) {
      ensure(18)
      doc.fillColor(strong ? NAVY : GRAY).font(strong ? 'Poppins-Bold' : 'Poppins-Regular').fontSize(strong ? 10 : 9).text(label, 330, y, { width: 105 })
      doc.fillColor(strong ? BLEU : NAVY).font('Poppins-Bold').fontSize(strong ? 10 : 9).text(invoiceFormatMoney(value), 435, y, { width: 112, align: 'right' })
      y += strong ? 18 : 15
    }

    doc.rect(48, y, W, 100).fill(BLEU)
    doc.fillColor('#fff').font('Poppins-Bold').fontSize(18).text('MADAVISION', 64, y + 15)
    doc.font('Poppins-Regular').fontSize(9).text('Facture de vente', 64, y + 38)
    doc.font('Poppins-Regular').fontSize(7.5).fillColor('#E6F4F4')
    const contactParts = []
    contactParts.push('NIF : 3000001053 • STAT : 92391 11 1993 0 00002')
    contactParts.push('Adresse : Enceinte Gare Soarano, Analakely, Antananarivo')
    contactParts.push('Tel : +261 20 22 235 44 • Email : contact@madavision.mg')
    contactParts.forEach((part, i) => {
      doc.text(part, 64, y + 56 + i * 12)
    })

    doc.fillColor('#fff').font('Poppins-Bold').fontSize(14)
      .text(data.societe?.nom || data.invoiceNumber, 350, y + 14, { width: 180, align: 'right' })
    doc.font('Poppins-Regular').fontSize(8)
      .text(`Émise le ${new Date(data.date).toLocaleDateString('fr-FR')}`, 350, y + 38, { width: 180, align: 'right' })
    doc.font('Poppins-Bold').fontSize(8).fillColor('#E6F4F4')
      .text(data.invoiceNumber, 350, y + 56, { width: 180, align: 'right' })
    if (logoExposantBuffer) {
      doc.image(logoExposantBuffer, 495, 85, { width: 40 })
    }
    y += 115

    section('Client')
    row('Société', data.societe.nom)
    row('ID Entreprise', data.societe.idEntreprise)
    row('NIF / STAT', [data.societe.nif, data.societe.stat].filter(Boolean).join(' / '))
    row('Adresse', data.societe.adresse)
    row('Email', data.societe.email)
    y += 8

    section('Événement')
    row('Événement', data.evenement.nom)
    row('Édition', data.edition.nom)
    row('Lieu', data.evenement.lieu)
    row('Numéro dossier', data.dossierNumber)
    y += 8

    section('Commandes & réservations')
    ensure(28)
    doc.fillColor(GRAY).font('Poppins-Bold').fontSize(8)
    doc.text('Désignation', 60, y, { width: 250 })
    doc.text('Qté', 326, y, { width: 35, align: 'right' })
    doc.text('PU', 375, y, { width: 75, align: 'right' })
    doc.text('Total', 462, y, { width: 85, align: 'right' })
    y += 14
    doc.moveTo(60, y).lineTo(547, y).strokeColor('#D9E0EA').lineWidth(0.5).stroke()
    y += 8

    if (data.lines.length === 0) {
      row('Lignes', 'Aucune réservation chiffrée')
    } else {
      data.lines.forEach(item => {
        const qty = Number(item.qty) || 1
        const total = invoiceMoney(item.amount) * qty
        ensure(34)
        doc.fillColor(NAVY).font('Poppins-Bold').fontSize(9).text(item.label || '—', 60, y, { width: 250 })
        if (item.description) doc.fillColor(GRAY).font('Poppins-Regular').fontSize(7).text(item.description, 60, y + 11, { width: 250 })
        doc.fillColor(NAVY).font('Poppins-Regular').fontSize(9).text(String(qty), 326, y, { width: 35, align: 'right' })
        doc.text(invoiceFormatMoney(item.amount), 375, y, { width: 75, align: 'right' })
        doc.font('Poppins-Bold').text(invoiceFormatMoney(total), 462, y, { width: 85, align: 'right' })
        y += item.description ? 28 : 20
      })
    }

    y += 8
    row('Badges / Invitations / Parking VIP', `${data.access.badges || 0} / ${data.access.invitations || 0} / ${data.access.parkingVip || 0}`)
    y += 8

    section('Résumé financier')
    moneyRow('Montant HT', data.financial.montantHT)
    if (data.financial.remisePromo > 0) moneyRow(`Remise promo${data.financial.promoCode ? ` (${data.financial.promoCode})` : ''}`, -data.financial.remisePromo)
    if (data.financial.voucherAmount > 0) moneyRow(`Voucher${data.financial.voucherCode ? ` (${data.financial.voucherCode})` : ''}`, -data.financial.voucherAmount)
    moneyRow(`TVA / Taxe ${data.financial.taxLabel}`, data.financial.montantTaxe)
    doc.moveTo(330, y + 2).lineTo(547, y + 2).strokeColor('#D9E0EA').lineWidth(0.5).stroke()
    y += 10
    moneyRow('Total TTC', data.financial.totalTTC, true)
    moneyRow('Montant soldé', data.financial.montantEncaisse)
    moneyRow('Reste à payer', data.financial.resteAPayer, true)

    y = Math.max(y + 18, 735)
    doc.moveTo(48, y).lineTo(547, y).strokeColor(BLEU).lineWidth(1).stroke()
    y += 10
    doc.fillColor(GRAY).font('Poppins-Regular').fontSize(7)
      .text('Facture générée automatiquement à partir des données Airtable Commandes, Stands, Éditions, Salons et Société.', 48, y, { width: W, align: 'center' })

    doc.end()
  })
}

async function generateProformaContractPDF(data) {
  const logoExposantBuffer = await fetchImageBuffer(data.societe.logoUrl)

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48, compress: true })
    const buffers = []
    doc.on('data', b => buffers.push(b))
    doc.on('end', () => resolve(Buffer.concat(buffers)))
    doc.on('error', reject)

    registerFonts(doc)
    const NAVY = '#0d0d0d'
    const BLEU = '#195b98'
    const GRAY = '#687e7e'
    const LIGHT = '#EEF2F8'
    const BORDER = '#D9E0EA'
    const W = 499
    let y = 48

    function ensure(height = 40) {
      if (y + height <= 780) return
      doc.addPage()
      y = 48
    }
    function header(title, subtitle) {
      doc.rect(48, y, W, 90).fill(BLEU)
      doc.fillColor('#fff').font('Poppins-Bold').fontSize(18).text('MADAVISION', 64, y + 15)
      doc.font('Poppins-Regular').fontSize(8).fillColor('#E6F4F4')
      doc.text('NIF : 3000001053 • STAT : 92391 11 1993 0 00002', 64, y + 40)
      doc.text('Enceinte Gare Soarano, Analakely, Antananarivo', 64, y + 52)
      doc.text('contact@madavision.mg • www.madavision.mg', 64, y + 64)
      
      doc.fillColor('#fff').font('Poppins-Bold').fontSize(12).text(title, 335, y + 17, { width: 195, align: 'right' })
      doc.fontSize(10).text(subtitle, 335, y + 35, { width: 195, align: 'right' })
      doc.font('Poppins-Regular').fontSize(8).text(`Émis le ${invoiceFormatDate(data.date)}`, 335, y + 55, { width: 195, align: 'right' })
      if (logoExposantBuffer) {
        doc.image(logoExposantBuffer, 490, 60, { width: 40 })
      }
      y += 105
    }
    function section(title) {
      ensure(34)
      doc.rect(48, y, W, 24).fill(LIGHT)
      doc.fillColor(NAVY).font('Poppins-Bold').fontSize(9).text(title.toUpperCase(), 60, y + 8)
      y += 34
    }
    function row(label, value, x = 60, labelWidth = 150) {
      if (value === null || value === undefined || value === '') return
      ensure(18)
      doc.fillColor(GRAY).font('Poppins-Regular').fontSize(8).text(label, x, y, { width: labelWidth })
      doc.fillColor(NAVY).font('Poppins-Bold').fontSize(9).text(String(value), x + labelWidth, y, { width: 547 - x - labelWidth, align: 'right' })
      y += 16
    }
    function moneyRow(label, value, strong = false) {
      ensure(18)
      doc.fillColor(strong ? NAVY : GRAY).font(strong ? 'Poppins-Bold' : 'Poppins-Regular').fontSize(strong ? 10 : 9).text(label, 330, y, { width: 105 })
      doc.fillColor(strong ? BLEU : NAVY).font('Poppins-Bold').fontSize(strong ? 10 : 9).text(invoiceFormatMoney(value), 435, y, { width: 112, align: 'right' })
      y += strong ? 18 : 15
    }
    function paragraph(text, options = {}) {
      ensure(options.height || 34)
      doc.fillColor(options.color || NAVY).font(options.font || 'Poppins-Regular').fontSize(options.size || 9)
        .text(text, 60, y, { width: 475, lineGap: 3, align: options.align || 'left' })
      y = doc.y + (options.gap ?? 10)
    }
    function bullet(text) {
      ensure(32)
      doc.fillColor(BLEU).font('Poppins-Bold').fontSize(11).text('•', 62, y)
      doc.fillColor(NAVY).font('Poppins-Regular').fontSize(9).text(text, 78, y, { width: 455, lineGap: 3 })
      y = doc.y + 8
    }

    const proformaNumber = `PROFORMA N° ${data.dossierNumber || data.invoiceNumber}`
    const acompte = Math.round(invoiceMoney(data.financial.totalTTC) * 0.5)
    const solde = Math.max(0, invoiceMoney(data.financial.totalTTC) - acompte)

    header('FACTURE PROFORMA', proformaNumber)

    section('Client & dossier')
    row('Société', data.societe.nom)
    row('ID Entreprise', data.societe.idEntreprise)
    row('NIF / STAT', [data.societe.nif, data.societe.stat].filter(Boolean).join(' / '))
    row('Email', data.societe.email)
    row('Événement / Édition', [data.evenement.nom, data.edition.nom].filter(Boolean).join(' — '))
    row('Numéro dossier', data.dossierNumber)
    row('Statut', data.statut)
    row('Date validation', invoiceFormatDate(data.dates.validation))
    y += 8

    section('Commandes & réservations')
    ensure(28)
    doc.fillColor(GRAY).font('Poppins-Bold').fontSize(8)
    doc.text('Désignation', 60, y, { width: 250 })
    doc.text('Qté', 326, y, { width: 35, align: 'right' })
    doc.text('PU', 375, y, { width: 75, align: 'right' })
    doc.text('Total', 462, y, { width: 85, align: 'right' })
    y += 14
    doc.moveTo(60, y).lineTo(547, y).strokeColor(BORDER).lineWidth(0.5).stroke()
    y += 8

    if (data.lines.length === 0) {
      row('Lignes', 'Aucune réservation chiffrée')
    } else {
      data.lines.forEach(item => {
        const qty = Number(item.qty) || 1
        const total = invoiceMoney(item.amount) * qty
        ensure(34)
        doc.fillColor(NAVY).font('Poppins-Bold').fontSize(9).text(item.label || '—', 60, y, { width: 250 })
        if (item.description) doc.fillColor(GRAY).font('Poppins-Regular').fontSize(7).text(item.description, 60, y + 11, { width: 250 })
        doc.fillColor(NAVY).font('Poppins-Regular').fontSize(9).text(String(qty), 326, y, { width: 35, align: 'right' })
        doc.text(invoiceFormatMoney(item.amount), 375, y, { width: 75, align: 'right' })
        doc.font('Poppins-Bold').text(invoiceFormatMoney(total), 462, y, { width: 85, align: 'right' })
        y += item.description ? 28 : 20
      })
    }

    y += 8
    row('Badges / Invitations / Parking VIP', `${data.access.badges || 0} / ${data.access.invitations || 0} / ${data.access.parkingVip || 0}`)
    y += 8

    section('Résumé financier proforma')
    moneyRow('Montant HT', data.financial.montantHT)
    if (data.financial.remisePromo > 0) moneyRow(`Remise promo${data.financial.promoCode ? ` (${data.financial.promoCode})` : ''}`, -data.financial.remisePromo)
    if (data.financial.voucherAmount > 0) moneyRow(`Voucher${data.financial.voucherCode ? ` (${data.financial.voucherCode})` : ''}`, -data.financial.voucherAmount)
    moneyRow(`TVA / Taxe ${data.financial.taxLabel}`, data.financial.montantTaxe)
    doc.moveTo(330, y + 2).lineTo(547, y + 2).strokeColor(BORDER).lineWidth(0.5).stroke()
    y += 10
    moneyRow('Total TTC', data.financial.totalTTC, true)
    moneyRow('Montant soldé', data.financial.montantEncaisse)
    moneyRow('Reste à payer', data.financial.resteAPayer, true)
    y += 4
    row('Acompte 50 %', `${invoiceFormatMoney(acompte)} — échéance ${invoiceFormatDate(data.dates.acompte)}`)
    row('Solde 50 %', `${invoiceFormatMoney(solde)} — échéance ${invoiceFormatDate(data.dates.solde)}`)

    // --- RIB Madavision ---
    y += 20
    doc.rect(60, y, 475, 55).strokeColor(BORDER).lineWidth(0.5).stroke()
    doc.fillColor(BLEU).font('Poppins-Bold').fontSize(8).text('MODALITÉS DE RÈGLEMENT (RIB)', 70, y + 10)
    doc.fillColor(NAVY).font('Poppins-Regular').fontSize(7.5)
      .text('Banque : BNI MADAGASCAR - Agence : ANALAKELY', 70, y + 25)
      .text('Compte : 00005 01010 12345678901 23', 70, y + 37)
    doc.text('Virement ou chèque à l\'ordre de MADAVISION', 300, y + 25, { width: 220, align: 'right' })
    y += 70

    doc.addPage()
    y = 48
    header('Contrat exposant', 'Engagement CGV')

    section('Engagement contractuel')
    paragraph(
      `La société ${data.societe.nom || 'exposante'} confirme son inscription au dossier ${data.dossierNumber || '—'} et accepte les conditions de participation communiquées par Madavision pour ${[data.evenement.nom, data.edition.nom].filter(Boolean).join(' — ') || 'l’événement'}.`
    )
    bullet('L’exposant certifie que les informations administratives, fiscales, commerciales et les réservations indiquées dans ce dossier sont exactes.')
    bullet('L’exposant s’engage à respecter les Conditions Générales de Vente, le règlement général de l’événement, les consignes techniques, les règles de sécurité et les échéances de paiement.')
    bullet('La réservation du stand et des services associés reste conditionnée à la validation administrative du dossier et au respect du calendrier de règlement.')
    bullet('Toute modification, annulation ou demande complémentaire doit être validée par l’administration Madavision avant application.')
    bullet('Le présent document regroupe la facture proforma et l’engagement CGV dans un seul fichier PDF transmis à l’exposant.')

    y += 8
    section('Synthèse de paiement')
    row('Total TTC engagé', invoiceFormatMoney(data.financial.totalTTC))
    row('Acompte 50 %', `${invoiceFormatMoney(acompte)} — ${invoiceFormatDate(data.dates.acompte)}`)
    row('Solde 50 %', `${invoiceFormatMoney(solde)} — ${invoiceFormatDate(data.dates.solde)}`)
    y += 14

    ensure(120)
    const boxY = y
    doc.rect(60, boxY, 210, 92).strokeColor(BORDER).lineWidth(0.8).stroke()
    doc.rect(325, boxY, 210, 92).strokeColor(BORDER).lineWidth(0.8).stroke()
    doc.fillColor(NAVY).font('Poppins-Bold').fontSize(9).text('Pour l’exposant', 72, boxY + 12)
    doc.fillColor(GRAY).font('Poppins-Regular').fontSize(8).text('Nom, date, signature et cachet', 72, boxY + 30)
    doc.fillColor(NAVY).font('Poppins-Bold').fontSize(9).text('Pour Madavision', 337, boxY + 12)
    doc.fillColor(GRAY).font('Poppins-Regular').fontSize(8).text('Validation administrative', 337, boxY + 30)
    doc.moveTo(72, boxY + 72).lineTo(258, boxY + 72).strokeColor(BORDER).lineWidth(0.5).stroke()
    doc.moveTo(337, boxY + 72).lineTo(523, boxY + 72).strokeColor(BORDER).lineWidth(0.5).stroke()
    y = boxY + 116

    doc.moveTo(48, 760).lineTo(547, 760).strokeColor(BLEU).lineWidth(1).stroke()
    doc.fillColor(GRAY).font('Poppins-Regular').fontSize(7)
      .text('Document généré automatiquement à partir des données Airtable Commandes, Stands, Éditions, Salons et Société.', 48, 772, { width: W, align: 'center' })

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

async function sendInvoicePdf(req, res, options = {}) {
  try {
    const data = await buildInvoiceData(req.params.id, options)
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

// POST /api/commercial/send-otp — OTP commercial basé sur la table Commerciaux
app.post('/api/commercial/send-otp', async (req, res) => {
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
app.post('/api/commercial/verify-otp', (req, res) => {
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

// GET /api/sonia/debug — voir les champs bruts Airtable (dev uniquement)
app.get('/api/sonia/debug', requireSonia, async (req, res) => {
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



// GET /api/commercial/dossiers — dossiers limités au commercial connecté
app.get('/api/commercial/dossiers', requireCommercial, async (req, res) => {
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
    // const activityMap = {}
    // const editionMap = {}

    filteredRecords.forEach(r => {
      const f = r.fields || {}
      ;(f['Stand ou service commandé'] || []).forEach(id => { if (id?.startsWith('rec')) standIds.add(id) })
      ;(f['Activités optionnelles'] || []).forEach(id => { if (id?.startsWith('rec')) activityIds.add(id) })
      ;(f['Edition'] || f['Edition'] || []).forEach(id => { if (id?.startsWith('rec')) { editionIds.add(id); salonIds.add(id); } })
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

    const editionMap = {}
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
        commandes: [{ id: r.id, stand: standsLabel, montant: netAPayer, reste: resteAPayer, statut: f['Statut commande'] || '—' }],
        numDossier: f['Numero de dossier'] || f['ID Commande'] || r.id.slice(-8).toUpperCase(),
        montantTotal: netAPayer,
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
app.get('/api/commercial/dossier/:id', requireCommercial, async (req, res) => {
  try {
    const cmdId = req.params.id
    const cmdResp = await fetch(`${ATBASE}/${encodeURIComponent('Commandes')}/${cmdId}`, { headers: headers() })
    if (!cmdResp.ok) return res.status(404).json({ error: 'Commande introuvable' })
    const cmd = await cmdResp.json()
    const cf = cmd.fields || {}

    const societeId = linkedRecordId(cf['Societé'] || cf['Société'])
    const societeMap = await getCommercialSocietes(req.commercialId)
    if (!societeId || !societeMap[societeId]) {
      return res.status(403).json({ error: 'Ce dossier n’est pas assigné à ce commercial.' })
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
        montantHT: totalHT,
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
        accesParkingVIP: cf['Accès parking VIP'] || 0,
        notes: cf['Notes'] || '',
      },
      societe: { ...sf, id: societeId, idEntreprise: sf['ID Entreprise'] || null },
      statutExposant: sf['Statut exposant (from Participations)'] || 'Exposant',
      edition,
      evenement,
      stands,
      optionalActivities,
      supplements,
      bilan,
      commercial,
    })
  } catch(e) {
    console.error('[commercial/dossier/:id]', e.message)
    res.status(500).json({ error: DEBUG ? e.message : 'Erreur de chargement du dossier commercial' })
  }
})

// POST /api/commercial/dossier/:id/payment-calendar — dates de paiement du dossier assigné
app.post('/api/commercial/dossier/:id/payment-calendar', requireCommercial, async (req, res) => {
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
      return res.status(403).json({ error: 'Ce dossier n’est pas assigné à ce commercial.' })
    }

    const updated = await patchCommandeFields(cmdId, fields)
    res.json({ success: true, commande: paymentCalendarPayload(updated) })
  } catch(e) {
    console.error('[commercial/payment-calendar]', e.message)
    res.status(500).json({ error: DEBUG ? e.message : 'Erreur de mise à jour du calendrier de paiement' })
  }
})

// GET /api/commercial/dossier/:id/download-invoice — facture PDF limitée au commercial assigné
app.get('/api/commercial/dossier/:id/download-invoice', requireCommercial, async (req, res) => {
  await sendInvoicePdf(req, res, { commercialId: req.commercialId })
})

// POST /api/commercial/dossier/:id/email-invoice — envoyé par email au client exposant
app.post('/api/commercial/dossier/:id/email-invoice', requireCommercial, async (req, res) => {
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

    if (!socEmail) {
      return res.status(400).json({ error: 'Aucune adresse email pour le client' })
    }

    // Générer le PDF
    const invoiceData = await buildInvoiceData(id, { commercialId: req.commercialId })
    const pdf = await generateInvoicePDF(invoiceData)
    const filename = `${invoiceSafeFilename(invoiceData.invoiceNumber)}.pdf`

    const result = await mailer(
      socEmail,
      `Facture Madavision — ${socNom}`,
      emailWrapper(`
        <h2 style="color:#1B2A4A;font-size:18px;margin:0 0 14px">Votre facture Madavision FIM 2026</h2>
        <p>Bonjour ${escapeHtml(socNom)},</p>
        <p>Veuillez trouver ci-joint la facture pour votre participation à l evenement.</p>
        <div style="background:#EEF2F8;border-radius:10px;padding:18px;margin:18px 0">
          <div style="font-size:16px;font-weight:700;color:#1B2A4A">${Number(invoiceData.total).toLocaleString('fr-FR')} Ar TTC</div>
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
app.post('/api/commercial/cancel-request/:id', requireCommercial, async (req, res) => {
  try {
    const id = req.params.id
    const { raison } = req.body || {}
    if (!raison || !String(raison).trim()) {
      return res.status(400).json({ error: 'Motif d’annulation requis' })
    }

    const cmdResp = await fetch(`${ATBASE}/${encodeURIComponent('Commandes')}/${id}`, { headers: headers() })
    if (!cmdResp.ok) return res.status(404).json({ error: 'Commande introuvable' })
    const cmd = await cmdResp.json()
    const cf = cmd.fields || {}
    const societeId = linkedRecordId(cf['Societé'] || cf['Société'])
    const societeMap = await getCommercialSocietes(req.commercialId)
    if (!societeId || !societeMap[societeId]) {
      return res.status(403).json({ error: 'Ce dossier n’est pas assigné à ce commercial.' })
    }

    const societe = societeMap[societeId]
    const commercial = await findCommercialByEmail(req.commercialEmail)
    const numDossier = cf['Numero de dossier'] || cf['ID Commande'] || id.slice(-8).toUpperCase()

    const result = await mailer(
      EMAIL_CONFIG.fromAddress,
      `Demande d’annulation dossier — ${societe.nom}`,
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

app.get('/api/sonia/accounts', requireSonia, async (req, res) => {
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

app.post('/api/sonia/accounts', requireSonia, async (req, res) => {
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
    const frontendBase = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '')
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
          <a href="${accessUrl}" style="background:#1B2A4A;color:#fff;text-decoration:none;padding:10px 22px;border-radius:8px;display:inline-block;font-weight:600;font-size:13px">Accéder à mon espace</a>
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

// GET /api/sonia/dossiers — liste commandes classées par Validation
app.get('/api/sonia/dossiers', requireSonia, async (req, res) => {
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
        paiementsMap[cId].push({
          id:      r.id,
          montant: parseMGA2(f['Montant payé'] || f['Montant']),
          mode:    f['Mode de paiement'] || f['Mode paiement'] || f['Mode'] || '—',
          date:    f['Date paiement'] || f['Date'] || '',
          reference: f['Référence'] || '',
          statut:  f['Statut'] || 'En attente',
          notes:   f['Notes'] || '',
          valide:  f['Validé par M. Hery'] === true || (f['Statut'] || '') === 'Validé',
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
      const sIds = f['Societé'] || f['Société'] || []
      if (Array.isArray(sIds)) sIds.forEach(id => { if (id && id.startsWith('rec')) societeIds.add(id) })

      // Stands liés (champ link → array de record IDs)
      const stIds = f['Stand ou service commandé'] || []
      if (Array.isArray(stIds)) stIds.forEach(id => { if (id && id.startsWith('rec')) standIds.add(id) })

      // Édition liée
      const edIds = f['Édition'] || f['Edition'] || []
      if (Array.isArray(edIds)) edIds.forEach(id => { 
        if (id && id.startsWith('rec')) { editionIds.add(id); salonIds.add(id); } 
      })
      const actIds = f['Activités optionnelles'] || []
      if (Array.isArray(actIds)) actIds.forEach(id => { if (id && id.startsWith('rec')) activityIds.add(id) })
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
      const socLinkedIds = f['Societé'] || f['Société'] || []
      const societeId    = Array.isArray(socLinkedIds) && socLinkedIds[0]?.startsWith('rec') ? socLinkedIds[0] : null
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
      const stLinkedIds = f['Stand ou service commandé'] || []
      let standsLabel
      if (Array.isArray(stLinkedIds) && stLinkedIds.length > 0 && stLinkedIds[0]?.startsWith('rec')) {
        // Ce sont des IDs → résoudre via batch
        standsLabel = stLinkedIds.map(id => standMap[id]?.label || id).join(', ')
      } else {
        // Ce sont déjà des noms (lookup texte)
        standsLabel = Array.isArray(stLinkedIds) ? stLinkedIds.join(', ') : String(stLinkedIds || '—')
      }
      const standCount = Array.isArray(stLinkedIds)
        ? stLinkedIds.filter(Boolean).length
        : String(stLinkedIds || '').split(',').map(s => s.trim()).filter(Boolean).length

      const participationId = Array.isArray(f['Participation']) ? f['Participation'][0] : null
      const edLinkedIds = f['Édition'] || f['Edition'] || []
      const fallbackStand = Array.isArray(stLinkedIds)
        ? stLinkedIds.map(id => standMap[id]).find(Boolean)
        : null
      const editionId = (Array.isArray(edLinkedIds) && edLinkedIds[0]?.startsWith('rec') ? edLinkedIds[0] : null) || fallbackStand?.salonId || null
      const edition = editionId ? editionMap[editionId] : null
      const salonId = editionId || fallbackStand?.salonId || null
      const evenement = salonId ? salonMap[salonId] : null

      // RECALCUL DYNAMIQUE (formules identiques à Airtable)
      // Les prix stands/activités sont déjà TTC (taxe incluse)
      // On extrait le HT à rebours pour calculer la taxe
      const totalHTStands = (Array.isArray(stLinkedIds) && stLinkedIds[0]?.startsWith('rec')) ? stLinkedIds.reduce((sum, id) => sum + (standMap[id]?.prix || 0), 0) : 0
      const totalHTActs = (f['Activités optionnelles'] || []).reduce((sum, id) => sum + (activityMap[id]?.prix || 0), 0)
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



// POST /api/sonia/valider/:id — valider une commande (Commandes.Validation → Validé)
// NB: l'assignation commercial est une action SÉPARÉE via /api/sonia/assigner/:cmdId
app.post('/api/sonia/valider/:id', requireSonia, async (req, res) => {
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
app.post('/api/sonia/status/:id', requireSonia, async (req, res) => {
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
app.post('/api/sonia/dossier/:id/payment-calendar', requireSonia, async (req, res) => {
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
app.get('/api/sonia/dossier/:id/download-invoice', requireSonia, async (req, res) => {
  await sendInvoicePdf(req, res)
})

// POST /api/sonia/dossier/:id/email-invoice — envoyé par email au client exposant (admin)
app.post('/api/sonia/dossier/:id/email-invoice', requireSonia, async (req, res) => {
  try {
    const id = req.params.id
    const frontendBase = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '')

    const cmdResp = await fetch(`${ATBASE}/${encodeURIComponent('Commandes')}/${id}`, { headers: headers() })
    if (!cmdResp.ok) return res.status(404).json({ error: 'Commande introuvable' })
    const cmd = await cmdResp.json()
    const cf = cmd.fields || {}
    const societeId = linkedRecordId(cf['Societé'] || cf['Société'])

    const [socData, cmdData] = await Promise.all([
      societeId ? fetch(`${ATBASE}/${encodeURIComponent('Sociétés')}/${societeId}`, { headers: headers() }).then(r => r.json()).catch(() => ({ fields: {} })) : Promise.resolve({ fields: {} }),
      Promise.resolve(cmd),
    ])

    const socEmail = socData.fields?.['Email'] || ''
    const socNom = socData.fields?.['Raison sociale'] || socData.fields?.['Nom'] || 'votre société'
    const commercialId = linkedRecordId(cf['Commerciaux'] || cf['Commercial affecté'])
    let commNom = '—'
    if (commercialId) {
      const commResp = await fetch(`${ATBASE}/${encodeURIComponent('Commerciaux')}/${commercialId}`, { headers: headers() })
      if (commResp.ok) {
        const commData = await commResp.json()
        commNom = commData.fields?.['Nom'] || commData.fields?.['Nom complet'] || '—'
      }
    }

    if (!socEmail) {
      return res.status(400).json({ error: 'Aucune adresse email pour le client exposant' })
    }

    const invoiceData = await buildInvoiceData(id)
    const pdf = await generateInvoicePDF(invoiceData)
    const filename = `${invoiceSafeFilename(invoiceData.invoiceNumber)}.pdf`

    const result = await mailer(
      socEmail,
      `Facture Madavision — ${socNom}`,
      emailWrapper(`
        <h2 style="color:#1B2A4A;font-size:18px;margin:0 0 14px">Votre facture Madavision FIM 2026</h2>
        <p>Bonjour ${escapeHtml(socNom)},</p>
        <p>Veuillez trouver ci-joint la facture pour votre participation à l'evenement.</p>
        <div style="background:#EEF2F8;border-radius:10px;padding:18px;margin:18px 0">
          <div style="font-size:16px;font-weight:700;color:#1B2A4A">${Number(invoiceData.total).toLocaleString('fr-FR')} Ar TTC</div>
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
app.post('/api/sonia/cancel-request/:id', requireSonia, async (req, res) => {
  try {
    const id = req.params.id
    const { raison } = req.body || {}
    if (!raison || !String(raison).trim()) {
      return res.status(400).json({ error: 'Motif d’annulation requis' })
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
      `Demande d’annulation dossier — ${socNom}`,
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
app.post('/api/sonia/rejeter/:id', requireSonia, async (req, res) => {
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
app.post('/api/sonia/assigner/:cmdId', requireSonia, async (req, res) => {
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
        fetch(`${ATBASE}/${encodeURIComponent('Commerciaux')}/${commercialId}`, { headers: headers() }).then(r => r.json()),
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
            commNom:    commData.fields?.['Nom'] || commData.fields?.['Nom complet'] || 'Commercial',
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
app.post('/api/sonia/resend-alert', requireSonia, async (req, res) => {
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
app.post('/api/sonia/notify-exposant/:id', requireSonia, async (req, res) => {
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
      commId ? fetch(`${ATBASE}/${encodeURIComponent('Commerciaux')}/${commId}`, { headers: headers() }).then(r => r.json()) : Promise.resolve({ fields: {} }),
    ])

    const socEmail = socData.fields?.['Email'] || ''
    const socNom   = socData.fields?.['Raison sociale'] || socData.fields?.['Nom'] || 'votre société'
    const commNom  = commData.fields?.['Nom'] || commData.fields?.['Nom'] || 'votre commercial'

    if (!socEmail) return res.status(400).json({ error: 'Aucune adresse email pour le client exposant' })

    const result = await mailer(
      socEmail,
      `Commercial assigné à votre dossier — Madavision`,
      emailWrapper(`
        <h2 style="color:#1B2A4A;font-size:18px;margin:0 0 14px">Un commercial vous suit désormais</h2>
        <p>Bonjour,</p>
        <p>Nous vous informons qu'un commercial a été assigné à votre dossier d'inscription pour la FIM 2026.</p>
        <div style="background:#EEF2F8;border-left:3px solid #2260A7;padding:14px 18px;border-radius:0 8px 8px 0;margin:18px 0">
          <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#2260A7;margin-bottom:8px">Votre commercial</div>
          <div style="font-size:16px;font-weight:700;color:#1B2A4A">${escapeHtml(commNom)}</div>
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

// ════════════════════════════════════════════════════════

// ── FIN SONIA ──

// ── 404 ──
app.use((req, res) => {
  res.status(404).json({ error: 'Route non trouvée' })
})

// ── Gestionnaire d'erreurs global ──
app.use((err, req, res, next) => {
  console.error('[unhandled error]', err.message)
  if (err.message?.includes('Origine non autorisée')) {
    return res.status(403).json({ error: err.message })
  }
  res.status(500).json({ error: 'Erreur serveur' })
})

// ────────────────────────────────────────────────────────────
//  DÉMARRAGE
// ────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log('━'.repeat(60))
  console.log(`  ✓ Madavision Backend FIM 2026 — démarré sur le port ${PORT}`)
  console.log('━'.repeat(60))
  console.log(`  Base Airtable : ${BASE}`)
  console.log(`  Origines      : ${ALLOWED.length ? ALLOWED.join(', ') : '*'}`)
  console.log(`  Mode debug    : ${DEBUG ? 'ON' : 'OFF'}`)
  console.log(`  Email         : ${EMAIL_ENABLED ? (mailTransporter ? 'activé' : 'config manquante') : 'désactivé'}`)
  console.log(`  Health check  : http://localhost:${PORT}/api/health`)
  console.log('━'.repeat(60))
})

// Gestion arrêt propre
process.on('SIGTERM', () => {
  console.log('\n→ Arrêt du serveur (SIGTERM)')
  process.exit(0)
})
process.on('SIGINT', () => {
  console.log('\n→ Arrêt du serveur (SIGINT)')
  process.exit(0)
})
