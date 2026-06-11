# Madavision Backend — FIM 2026

Backend proxy sécurisé entre le formulaire HTML d'inscription et Airtable.
Le PAT Airtable n'est **jamais exposé au navigateur**.

## Architecture

```
[ Formulaire HTML ]  →  [ Backend Node.js ]  →  [ Airtable ]
       │                  (PAT en .env)
       │                        ↑
       └─ Dashboard exposant ───┘
          (accès par lien unique)
```

## Contenu du projet

```
madavision-backend/
├── server.js                      ← Backend Express
├── package.json
├── .env.example                   ← Modèle de config
├── .gitignore
├── render.yaml                    ← Config déploiement Render.com
├── inscription-fim2026.html       ← Formulaire d'inscription
├── dashboard-exposant.html        ← Dashboard exposant (accès par token)
├── start-local.sh                 ← Script de démarrage local
└── README.md
```

## Installation locale

```bash
# 1. Installer les dépendances
npm install

# 2. Configurer .env
cp .env.example .env
nano .env
# → Remplir AIRTABLE_PAT (créé sur https://airtable.com/create/tokens)

# 3. Lancer le tout (backend + serveur de fichiers)
chmod +x start-local.sh
./start-local.sh
```

→ Ouvrir `http://localhost:8000/inscription-fim2026.html`

## Configuration .env

| Variable | Description | Exemple |
|---|---|---|
| `AIRTABLE_PAT` | Personal Access Token Airtable | `patXXXXXXXX...` |
| `AIRTABLE_BASE` | ID de la base | `appZPM85bUqAmWde2` |
| `ALLOWED_ORIGINS` | Domaines autorisés CORS | `http://localhost:8000,https://madavision.mg` |
| `PORT` | Port d'écoute | `3001` |
| `DEBUG` | Détails erreurs | `false` |

### Scopes PAT requis

Sur https://airtable.com/create/tokens :

- `data.records:read`
- `data.records:write`
- `schema.bases:read`
- Access : la base `appZPM85bUqAmWde2` uniquement

## Endpoints API

| Méthode | Route | Description |
|---|---|---|
| GET  | `/api/health`            | Health check |
| GET  | `/api/bootstrap`         | Données pour formulaire |
| POST | `/api/check-duplicate`   | Vérifie doublon société |
| POST | `/api/inscription`       | Soumission + génère token |
| GET  | `/api/exposant/:token`   | Dashboard exposant complet |

## Flux complet

### 1. Inscription
1. Exposant remplit le formulaire HTML
2. Backend crée Société + Participation + Commande + Lignes
3. Backend génère un **token unique** stocké dans `Participations.Notes`
4. Backend renvoie `accessToken` au formulaire

### 2. Écran de succès
Le formulaire affiche un lien personnel unique :
```
http://localhost:8000/dashboard-exposant.html?token=ABC123XYZ
```

### 3. Dashboard exposant
- L'exposant ouvre son lien
- Le dashboard charge automatiquement son dossier via le token
- Il voit : société, statut, paiements, factures, commercial assigné, badges
- Il peut télécharger son dossier complet en PDF imprimable

## Déploiement gratuit sur Render.com

1. Pousser ce dossier sur GitHub (`.gitignore` exclut `.env`)
2. https://render.com → New → Web Service → connecter le repo
3. Render détecte `render.yaml`
4. Ajouter dans Environment : `AIRTABLE_PAT` + `ALLOWED_ORIGINS`
5. Deploy

URL produite : `https://madavision-backend.onrender.com`

Mettre à jour `apiUrl` dans `inscription-fim2026.html` et `dashboard-exposant.html`.

## Sécurité

- PAT uniquement dans `.env`
- `.env` exclu de Git
- CORS limité aux domaines listés
- Rate limiting : 30 req/min par IP
- Validation et échappement anti-injection
- Token dashboard non-devinable (16 caractères × 32 valeurs)

## Prochains dashboards

- ✓ Dashboard exposant (lien unique par token)
- ☐ Dashboard commercial
- ☐ Dashboard M. Hery
