#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# setup-produccion.sh — Termina el despliegue en el VPS del piloto:
#   genera el .env (con secretos aleatorios), aplica migraciones y arranca PM2.
#
# Se ejecuta DESDE el servidor (no se pega contenido largo a mano — por eso
# vive en el repo y se baja con git pull, evitando que el terminal corte líneas):
#     cd /opt/helper && git pull && bash scripts/setup-produccion.sh
#
# Variables opcionales para sobrescribir los valores por defecto:
#     ALLOWED_ORIGIN=https://midominio.co SUPERADMIN_EMAIL=otro@correo.com bash scripts/setup-produccion.sh
#
# Idempotente: re-ejecutarlo regenera el .env y reinicia. La contraseña de la
# base se regenera y se sincroniza con Postgres en cada corrida.
# ─────────────────────────────────────────────────────────────────────────────
set -e
cd /opt/helper

echo "→ Generando secretos y .env..."
JWT=$(openssl rand -hex 32)
ENC=$(openssl rand -hex 32)
DBPASS=$(openssl rand -hex 16)

# Sincroniza la contraseña del usuario 'zajuna' de Postgres con la generada.
sudo -u postgres psql -c "ALTER USER zajuna WITH PASSWORD '${DBPASS}';"

cat > .env <<EOF
DATABASE_URL=postgresql://zajuna:${DBPASS}@localhost:5432/zajuna
REDIS_URL=redis://localhost:6379
JWT_SECRET=${JWT}
ENCRYPTION_KEY=${ENC}
ALLOWED_ORIGIN=${ALLOWED_ORIGIN:-http://167.233.61.39:3000}
SUPERADMIN_EMAIL=${SUPERADMIN_EMAIL:-ddiddimmo@gmail.com}
ANTHROPIC_API_KEY=
OPENROUTER_API_KEY=
OPENROUTER_MODEL=moonshotai/kimi-k2
SENTRY_DSN=
VITE_SENTRY_DSN=
EOF

echo "→ Aplicando migraciones..."
npx prisma migrate deploy
npx prisma generate

echo "→ Abriendo el puerto 3000 en el firewall..."
ufw allow 3000 || true

echo "→ Arrancando la app con PM2..."
pm2 start ecosystem.config.js || pm2 restart ecosystem.config.js
pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || true
pm2 save

echo ""
echo "===== TODO LISTO ====="
echo ".env creado (valores no-secretos):"
grep -vE 'JWT_SECRET|ENCRYPTION_KEY|DATABASE_URL' .env
echo ""
pm2 status
