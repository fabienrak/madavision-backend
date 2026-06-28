const crypto = require('crypto')
const { PAT, BASE, DEBUG } = require('../config')
const { atGet, atPost, atPatchRecord, atFind, escapeFormula } = require('./airtable')

// ── Auth constants ──────────────────────────────────────────
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

function badgesFromStandSurface(totalM2) {
  if (!totalM2 || totalM2 <= 0) return 2
  return Math.max(2, Math.ceil(totalM2 / 9))
}

function isRestrictedStandSurface(fields = {}) {
  return Math.abs(standSurfaceM2(fields) - RESTRICTED_STAND_SURFACE_M2) <= 0.5
}

function generateToken() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let token = ''
  for (let i = 0; i < 16; i++) {
    token += chars[Math.floor(Math.random() * chars.length)]
  }
  return token
}

module.exports = {
  AUTH_TABLE,
  AUTH_COOKIE,
  AUTH_SECRET,
  AUTH_SESSION_HOURS,
  AUTH_SESSION_MS,
  PASSWORD_RESET_MINUTES,
  PASSWORD_RESET_MS,
  PASSWORD_HASH_ITERATIONS,
  authLoginAttempts,
  authUserCache,
  authPick,
  authFieldName,
  normalizeEmail,
  normalizeRole,
  authBool,
  passwordPolicyError,
  linkedIdFromAny,
  normalizeAuthUser,
  publicAuthUser,
  authUsers,
  findAuthUserByEmail,
  findAuthUserById,
  patchAuthUser,
  base64url,
  signAuthPayload,
  verifyAuthToken,
  hashPassword,
  verifyPassword,
  tokenHash,
  readCookie,
  requestAuthToken,
  setAuthCookie,
  clearAuthCookie,
  authRateKey,
  canAttemptLogin,
  resetLoginAttempts,
  findCommercialByEmail,
  resolveAuthLinkedRecord,
  startAuthSession,
  ensureAuthUser,
  ensureMigratedAuthUser,
  authenticateRequest,
  requireRole,
  RESTRICTED_STAND_SURFACE_M2,
  MIN_RESTRICTED_STANDS,
  parseStandSurfaceM2,
  standSurfaceM2,
  badgesFromStandSurface,
  isRestrictedStandSurface,
  generateToken,
}
