const express = require('express')
const router  = express.Router()

const { DEBUG, BASE } = require('../config')
const { atGet, headers, PLAN_MASSE_FIELDS, attachmentUrl } = require('../lib/airtable')

// GET /api/health
router.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'madavision-backend',
    time: new Date().toISOString(),
  })
})

// GET /api/bootstrap — charge tout ce qu'il faut au formulaire
router.get('/bootstrap', async (req, res) => {
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
        const standSalonIds = f['Edition'] || f['Édition'] || f['Editions'] || f['Éditions'] || []
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
          editionIds: r.fields['Edition'] || [],
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
        banques:            optionsOf('Paiements', 'Banque'),
      },
    })

  } catch (e) {
    console.error('[bootstrap] error:', e.message)
    res.status(500).json({
      error: DEBUG ? e.message : 'Erreur lors du chargement des données'
    })
  }
})

module.exports = router
