#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# actualizar.sh — Sube los últimos cambios al servidor de producción (VPS).
#
#   Uso (en el servidor):   cd /opt/helper && bash scripts/actualizar.sh
#
# Hace TODO el ciclo de actualización de forma robusta:
#   1. Trae el código de GitHub (fetch + reset, evita el "Already up to date"
#      que dejaba la copia local desincronizada con un simple git pull).
#   2. Reinstala dependencias de backend Y frontend (clave: si el código nuevo
#      usa una librería nueva, ej. @sentry/node, hay que instalarla — un reset
#      sin npm install dejaba node_modules viejo y el api se caía).
#   3. Aplica migraciones de base de datos.
#   4. Recompila el frontend.
#   5. Reinicia api + workers con PM2.
#
# El .env NO se toca (está fuera de git). git reset no borra archivos ignorados.
# ─────────────────────────────────────────────────────────────────────────────
set -e
cd /opt/helper

echo "→ [1/5] Bajando código de GitHub..."
git fetch origin
git reset --hard origin/master

echo "→ [2/5] Dependencias backend..."
npm install

echo "→ [3/5] Dependencias + build frontend..."
cd web && npm install && npm run build && cd ..

echo "→ [4/5] Migraciones de base de datos..."
npx prisma migrate deploy
npx prisma generate

echo "→ [5/5] Reiniciando api + workers..."
pm2 restart all

echo ""
echo "===== ACTUALIZADO ✅ ====="
pm2 status
