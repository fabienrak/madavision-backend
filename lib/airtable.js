const { PAT, BASE } = require('../config')

const ATBASE = `https://api.airtable.com/v0/${BASE}`
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
  await sleep(220)
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

async function patchAirtableWithTypecast(table, id, fields) {
  await sleep(220)
  const res = await fetch(`${ATBASE}/${encodeURIComponent(table)}/${id}`, {
    method: 'PATCH',
    headers: headers(),
    body: JSON.stringify({ fields, typecast: true }),
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

function escapeFormula(str) {
  if (str === null || str === undefined) return ''
  return String(str).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

module.exports = {
  ATBASE,
  headers,
  sleep,
  PLAN_MASSE_FIELDS,
  attachmentUrl,
  atGet,
  atPost,
  atPatchRecord,
  patchAirtableWithTypecast,
  atFind,
  escapeFormula,
}
