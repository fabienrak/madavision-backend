const { ATBASE, headers } = require('../lib/airtable')
const { requireRole, authenticateRequest, normalizeEmail } = require('../lib/auth')
const { findCommandeByAccessToken } = require('../lib/pdf')

function requireSonia(req, res, next) {
  requireRole('admin_sonia')(req, res, () => {
    req.soniaEmail = req.auth.email
    next()
  })
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

async function requireExposantTokenAccess(req, res, next) {
  try {
    const auth = await authenticateRequest(req)
    if (auth.role !== 'exposant') return res.status(403).json({ error: 'Accès exposant requis.' })

    const cmd = await findCommandeByAccessToken(req.params.token)
    if (!cmd) return res.status(404).json({ error: "Dossier introuvable. Vérifiez votre lien d'accès." })

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
      return res.status(403).json({ error: "Ce dossier n’est pas rattaché à votre compte." })
    }

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

module.exports = {
  requireSonia,
  requireCommercial,
  requireExposantTokenAccess,
  requireExposant,
}
