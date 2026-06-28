// ────────────────────────────────────────────────────────────
//  Madavision Backend — Entry point
// ────────────────────────────────────────────────────────────
require('dotenv').config()

const express = require('express')
const cors    = require('cors')

const { PAT, BASE, PORT, DEBUG, ALLOWED, EMAIL_ENABLED } = require('./config')
const { mailTransporter } = require('./lib/email')
const { requireExposantTokenAccess } = require('./middleware/auth')

// ── Validate required env vars ───────────────────────────────
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

// ── Express app ──────────────────────────────────────────────
const app = express()
app.set('trust proxy', 1)
app.use(express.json({ limit: '2mb' }))

// ── CORS — domaines autorisés ────────────────────────────────
app.use(cors({
  origin: (origin, cb) => {
    // Pas d'origin = requête directe (Postman, curl, mobile)
    if (!origin) return cb(null, true)
    // Autoriser tout en local ou si wildcard
    if (ALLOWED.includes('*') || origin.includes('localhost')) return cb(null, true)
    // Domaine listé
    if (ALLOWED.includes(origin)) return cb(null, true)
    // Wildcards ex: ".madavision.mg" autorise tous les sous-domaines + le domaine racine
    const hostname = (() => { try { return new URL(origin).hostname } catch { return '' } })()
    const suffixMatch = ALLOWED.some(a => a.startsWith('.') && (hostname === a.slice(1) || hostname.endsWith(a)))
    if (suffixMatch) return cb(null, true)
    return cb(new Error(`Origine non autorisée : ${origin}`))
  },
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  credentials: true,
}))

// ── Rate limiting (en mémoire) ────────────────────────────────
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

// ── Routes ───────────────────────────────────────────────────
const authRoutes        = require('./routes/auth')
const debugRoutes       = require('./routes/debug')
const bootstrapRoutes   = require('./routes/bootstrap')
const inscriptionRoutes = require('./routes/inscription')
const otpRoutes         = require('./routes/otp')
const exposantRoutes    = require('./routes/exposant')
const commercialRoutes  = require('./routes/commercial')
const soniaRoutes       = require('./routes/sonia')

app.use('/api/auth',       authRoutes)
app.use('/api/debug',      debugRoutes)
app.use('/api',            bootstrapRoutes)
app.use('/api',            inscriptionRoutes)
app.use('/api',            otpRoutes)

// ── Critical: mount exposant token middleware BEFORE exposant router ──
// This matches the original: app.use('/api/exposant/:token', requireExposantTokenAccess) at line 2392
app.use('/api/exposant/:token', requireExposantTokenAccess)

app.use('/api',            exposantRoutes)
app.use('/api/commercial', commercialRoutes)
app.use('/api/sonia',      soniaRoutes)

// ── 404 ──────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Route non trouvée' })
})

// ── Gestionnaire d'erreurs global ────────────────────────────
app.use((err, req, res, next) => {
  console.error('[unhandled error]', err.message)
  if (err.message?.includes('Origine non autorisée')) {
    return res.status(403).json({ error: err.message })
  }
  res.status(500).json({ error: 'Erreur serveur' })
})

// ── DÉMARRAGE ─────────────────────────────────────────────────
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
