const express = require('express')
const crypto  = require('crypto')
const router  = express.Router()

const { DEBUG } = require('../config')
const {
  normalizeEmail,
  normalizeRole,
  canAttemptLogin,
  findAuthUserByEmail,
  verifyPassword,
  resolveAuthLinkedRecord,
  startAuthSession,
  resetLoginAttempts,
  patchAuthUser,
  authenticateRequest,
  clearAuthCookie,
  ensureMigratedAuthUser,
  tokenHash,
  hashPassword,
  passwordPolicyError,
  authPick,
  PASSWORD_RESET_MS,
  PASSWORD_RESET_MINUTES,
} = require('../lib/auth')
const { mailer, emailWrapper, mailTransporter } = require('../lib/email')

// POST /api/auth/login
router.post('/login', async (req, res) => {
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
      return res.status(403).json({ error: 'Mot de passe non initialisé. Utilisez "mot de passe oublié".' })
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

// GET /api/auth/me
router.get('/me', async (req, res) => {
  try {
    const auth = await authenticateRequest(req)
    res.json({ authenticated: true, user: auth })
  } catch {
    res.status(401).json({ authenticated: false, error: 'Session invalide ou expirée.' })
  }
})

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  clearAuthCookie(res)
  res.json({ success: true })
})

// POST /api/auth/account-status
router.post('/account-status', async (req, res) => {
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

// POST /api/auth/request-password-reset
router.post('/request-password-reset', async (req, res) => {
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

// POST /api/auth/reset-password
router.post('/reset-password', async (req, res) => {
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

module.exports = router
