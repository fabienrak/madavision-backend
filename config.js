require('dotenv').config()
const path = require('path')
const fs   = require('fs')

const cloudinary = require('cloudinary').v2
cloudinary.config({
  cloud_name: 'dcypbnvgc',
  api_key:    '696412765765453',
  api_secret: 'ptZZjJyHWBn549B8LKbXfb7qCSQ',
})

const PAT     = process.env.AIRTABLE_PAT
const BASE    = process.env.AIRTABLE_BASE
const PORT    = parseInt(process.env.PORT) || 3001
const DEBUG   = process.env.DEBUG === 'true'
const ALLOWED = (process.env.ALLOWED_ORIGINS || '*')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)

const EMAIL_ENABLED = process.env.EMAIL_ENABLED === 'true'
const EMAIL_CONFIG  = {
  host:        process.env.SMTP_HOST,
  port:        parseInt(process.env.SMTP_PORT) || 587,
  secure:      process.env.SMTP_SECURE === 'true',
  user:        process.env.SMTP_USER,
  pass:        (process.env.SMTP_PASS || '').replace(/\s/g, ''),
  fromName:    process.env.EMAIL_FROM_NAME    || 'Madavision',
  fromAddress: process.env.EMAIL_FROM_ADDRESS || process.env.SMTP_USER || 'noreply@madavision.mg',
  bcc:         process.env.EMAIL_BCC || '',
}

const UPLOADS_DIR = path.join(__dirname, 'uploads')
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true })

module.exports = {
  PAT, BASE, PORT, DEBUG, ALLOWED,
  EMAIL_ENABLED, EMAIL_CONFIG,
  UPLOADS_DIR,
  cloudinary,
}
