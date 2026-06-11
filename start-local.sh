#!/bin/bash
# By FabienRak
# Script de test local — lance le backend + serveur de fichiers

echo "═══════════════════════════════════════════════════"
echo "  MADAVISION 2026 — Démarrage local"
echo "═══════════════════════════════════════════════════"
echo ""
echo "Avant de lancer :"
echo "  1. Vérifier que le fichier .env contient votre PAT"
echo "  2. Avoir Node.js installé (version 18+)"
echo ""
echo "Démarrage du backend (port 3001)..."
echo ""

# Démarrer le backend en arrière-plan
node server.js &
BACKEND_PID=$!

# Attendre que le backend démarre
sleep 2

# Démarrer un serveur de fichiers statiques sur le port 8000
echo ""
echo "Démarrage du serveur de fichiers (port 8000)..."
echo ""
echo "═══════════════════════════════════════════════════"
# echo "  Ouvrez dans votre navigateur :"
# echo ""
# echo "  • Formulaire d'inscription :"
# echo "    http://localhost:8000/inscription-fim2026.html"
# echo ""
# echo "  • Dashboard exposant (avec un token) :"
# echo "    http://localhost:8000/dashboard-exposant.html?token=XXXXX"
# echo ""
echo "  Ctrl+C pour arrêter"
echo "═══════════════════════════════════════════════════"

# Fonction de nettoyage à l'arrêt
cleanup() {
  echo ""
  echo "→ Arrêt en cours..."
  kill $BACKEND_PID 2>/dev/null
  kill $HTTP_PID 2>/dev/null
  exit 0
}
trap cleanup SIGINT SIGTERM

# Serveur HTTP simple via Node
node -e "
const http = require('http')
const fs   = require('fs')
const path = require('path')
const port = 8000

http.createServer((req, res) => {
  let p = req.url.split('?')[0]
  if (p === '/') p = '/inscription-fim2026.html'
  const file = path.join(__dirname, p)
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return }
    const ext = path.extname(file).toLowerCase()
    const mime = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css' }[ext] || 'application/octet-stream'
    res.writeHead(200, { 'Content-Type': mime + '; charset=utf-8' })
    res.end(data)
  })
}).listen(port, () => console.log('Static server on http://localhost:' + port))
" &
HTTP_PID=$!

wait
