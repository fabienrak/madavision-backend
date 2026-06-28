const express = require('express')
const router  = express.Router()

const { atGet } = require('../lib/airtable')

// GET /api/debug/salons
router.get('/salons', async (req, res) => {
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
router.get('/stands', async (req, res) => {
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

module.exports = router
