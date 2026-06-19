# DEPLOY.md — Runbook de despliegue de Helper

> Estado tras la auditoría del 19 jun 2026: **GO para push, NO-GO de despliegue** hasta
> completar los 4 bloques de abajo. El código está listo; lo que falta es **infra/ops**.
> Referencia de infra recomendada: §11.4 de `CLAUDE.md` (1 VPS, NO serverless/k8s).

---

## 0. Pre-requisitos
- Un VPS (recomendado **Hetzner CPX31/41**, ~€15-25/mes) con Ubuntu 22.04+.
- Un dominio apuntando al VPS (registro A).
- Acceso SSH al VPS.

---

## 1. 🔴 Rotar secretos expuestos (ANTES de exponer nada)

### 1.1 `OPENROUTER_API_KEY` (estuvo en chats/worktrees — comprometida)
1. Entra a https://openrouter.ai/keys → **revoca** la key actual.
2. Crea una nueva → cópiala al `.env` de producción (`OPENROUTER_API_KEY=...`).
3. Reinicia los workers (`pm2 restart workers`).

### 1.2 `JWT_SECRET` (recomendado generar uno nuevo para prod)
```bash
openssl rand -hex 32   # pega el resultado en JWT_SECRET del .env de prod
```
> ⚠️ Rotar `JWT_SECRET` invalida todas las sesiones activas (los instructores
> tendrán que volver a iniciar sesión). En producción virgen no afecta a nadie.

### 1.3 `ENCRYPTION_KEY` — **NO rotar a la ligera**
Cifra las credenciales Zajuna (`zajunaUserEnc/PassEnc`) y el SMTP en DB. Si la rotas,
hay que **re-cifrar** todo o los instructores pierden sus credenciales guardadas. En
un despliegue nuevo (DB virgen) sí genera una key nueva con `openssl rand -hex 32`.

---

## 2. ⚠️ Configurar `ALLOWED_ORIGIN`
En el `.env` de producción:
```env
ALLOWED_ORIGIN=https://TU-DOMINIO.com
```
(hoy el default es `http://localhost:3000` → CORS bloquearía el front en prod).

---

## 3. 🔴 Provisionar el VPS y arrancar la app

```bash
# --- en el VPS ---
# 3.1 Dependencias
sudo apt update && sudo apt install -y nodejs npm postgresql redis-server git
sudo npm i -g pm2

# 3.2 Postgres: crear DB y usuario (ajusta credenciales)
sudo -u postgres psql -c "CREATE USER zajuna WITH PASSWORD 'CAMBIA_ESTO';"
sudo -u postgres psql -c "CREATE DATABASE zajuna OWNER zajuna;"

# 3.3 Código
git clone <repo> /opt/helper && cd /opt/helper
cp .env.example .env       # y EDITA .env con los valores reales (pasos 1 y 2)
npm install

# 3.4 DB: aplicar migraciones (NO 'migrate dev' en prod)
npx prisma migrate deploy
npx prisma generate

# 3.5 Frontend
cd web && npm install && npm run build && cd ..

# 3.6 Arrancar API + workers con PM2 (app api + app workers, ver ecosystem.config.js)
pm2 start ecosystem.config.js
pm2 save && pm2 startup    # para que reviva tras reboot
```

> Recordatorio (§11.4): la app `workers` corre **1 instancia (fork)** — 2+ duplicarían
> browsers y Moodle invalidaría la sesión. La app `api` sí puede ir en cluster.

---

## 4. ⚠️ Reverse proxy con TLS + HSTS

Con **Caddy** (TLS automático vía Let's Encrypt, lo más simple):
```
# /etc/caddy/Caddyfile
TU-DOMINIO.com {
    reverse_proxy localhost:3000
    header Strict-Transport-Security "max-age=31536000; includeSubDomains"
}
```
```bash
sudo apt install -y caddy && sudo systemctl reload caddy
```
Con esto quedan cubiertos HTTPS y HSTS (los demás headers de seguridad ya los pone
`server.js`: X-Frame-Options, nosniff, Referrer-Policy, Permissions-Policy).

---

## 5. Operación
- **Healthcheck:** `GET https://TU-DOMINIO.com/api/health` → 200 si DB+Redis OK.
- **Logs:** `pm2 logs` · **estado:** `pm2 status`.
- **Backups:** cron diario de `pg_dump` (Postgres) — imprescindible antes de tener usuarios reales.
- **Redis/Postgres** en la misma caja para arrancar; mover Postgres a gestionado (Neon/Supabase) si se quiere HA.

---

## Checklist GO/NO-GO (de la auditoría)
- [ ] `OPENROUTER_API_KEY` rotada
- [ ] `JWT_SECRET` de prod (y `ENCRYPTION_KEY` si DB virgen)
- [ ] `ALLOWED_ORIGIN` = dominio real
- [ ] `SUPERADMIN_EMAIL` seteada (sin esto nadie es superadmin)
- [ ] `prisma migrate deploy` aplicado
- [ ] `web/dist` buildeado
- [ ] PM2 con api + workers (workers 1 instancia)
- [ ] TLS/HSTS en el proxy
- [ ] Backup diario de Postgres configurado
- [ ] `GET /api/health` responde 200
