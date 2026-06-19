# PLAN_DESPLIEGUE.md — Subir Helper a producción para el piloto

> Objetivo: dejar la app accesible en una URL para que tus colegas instructores la
> prueben y te den feedback. Decisión ya tomada: **1 VPS** (no Railway/serverless,
> porque los workers usan Chromium/Playwright + Redis + 1 sesión Moodle por usuario).
> Estado: **código ya pusheado a GitHub** (`origin/master`, commit `6470b22`).
> Soporte cuando algo falle: ver `docs/OPERACION.md`.

---

## 0. Lo que necesitas tener a mano antes de empezar
- [ ] Cuenta en **Hetzner Cloud** (recomendado, ~€8/mes) o DigitalOcean.
- [ ] Una **SSH key** (o usar password del server).
- [ ] *(Recomendado)* un **dominio** apuntando al server (ej. `helper.midominio.co`).
      Sin dominio se puede empezar con la IP, pero sin HTTPS (ver Fase 5, opción B).
- [ ] Si el repo `manuelleal/zapp` es **privado**: un **Personal Access Token (PAT)**
      de GitHub (github.com → Settings → Developer settings → Tokens → "classic",
      permiso `repo`). Si es público, no hace falta.
- [ ] Los **secretos** listos (ver Fase 4): OpenRouter key rotada, DSN de Sentry, etc.

---

## 1. Crear el servidor (panel de Hetzner, ~5 min)
1. New Project → Add Server.
2. **Ubuntu 22.04**, tipo **CPX21** (3 vCPU / 4 GB RAM). *Los 4 GB importan por Chromium.*
3. Añade tu SSH key.
4. Crea el server y **anota la IP pública**.
5. *(Si tienes dominio)* en tu proveedor DNS: registro **A** `@` (o `helper`) → la IP.

---

## 2. Instalar el entorno (pegar en el server)
Conéctate: `ssh root@TU_IP` y pega este bloque completo:

```bash
# Node 20 + utilidades del sistema
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get update && apt-get install -y nodejs postgresql redis-server git ufw

# PM2 (gestor de procesos)
npm install -g pm2

# Firewall básico (deja SSH, HTTP y HTTPS)
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable

# Postgres: crear base y usuario (CAMBIA la contraseña)
sudo -u postgres psql -c "CREATE USER zajuna WITH PASSWORD 'PON_UNA_CLAVE_FUERTE';"
sudo -u postgres psql -c "CREATE DATABASE zajuna OWNER zajuna;"

# Redis y Postgres arrancan al boot
systemctl enable --now redis-server postgresql
```

---

## 3. Clonar la app e instalar dependencias
```bash
cd /opt

# Repo PÚBLICO:
git clone https://github.com/manuelleal/zapp.git helper

# Repo PRIVADO (usa tu PAT en vez de TOKEN):
# git clone https://TOKEN@github.com/manuelleal/zapp.git helper

cd helper
npm install

# CRÍTICO para los workers: navegador + librerías de sistema de Chromium.
# (Esto es lo que en Railway/serverless es un dolor; aquí es 1 comando.)
npx playwright install --with-deps chromium
```

---

## 4. Crear el `.env` de producción
```bash
cp .env.example .env
nano .env   # rellena los valores reales
```
Valores a poner (genera secretos con `openssl rand -hex 32`):

| Variable | Valor |
|---|---|
| `DATABASE_URL` | `postgresql://zajuna:LA_CLAVE_DE_LA_FASE_2@localhost:5432/zajuna` |
| `REDIS_URL` | `redis://localhost:6379` |
| `JWT_SECRET` | nuevo `openssl rand -hex 32` |
| `ENCRYPTION_KEY` | nuevo `openssl rand -hex 32` (servidor nuevo = DB vacía, OK generar uno) |
| `ALLOWED_ORIGIN` | `https://TU_DOMINIO` (o `http://TU_IP:3000` si vas sin dominio) |
| `SUPERADMIN_EMAIL` | tu correo (el dueño/admin) |
| `OPENROUTER_API_KEY` | **rotada** (revoca la vieja en openrouter.ai y crea una nueva) |
| `SENTRY_DSN` | DSN del proyecto backend en sentry.io (o vacío para desactivar) |
| `VITE_SENTRY_DSN` | DSN del frontend (puede ser el mismo proyecto) |

> ⚠️ El `.env` NO está en git (a propósito). Se crea a mano en cada servidor.

---

## 5. Migraciones, build y arranque
```bash
cd /opt/helper
npx prisma migrate deploy      # aplica las migraciones (NO 'migrate dev' en prod)
npx prisma generate
cd web && npm run build && cd ..   # compila el frontend (usa VITE_SENTRY_DSN)

pm2 start ecosystem.config.js  # arranca api + workers (workers SIEMPRE 1 instancia)
pm2 save && pm2 startup        # para que reviva tras reiniciar el server
pm2 status                     # ambos deben quedar "online"
```
Prueba rápida: `curl http://localhost:3000/api/health` → `{"status":"ok","db":true,"redis":true}`.

---

## 6. Exponer al mundo

### Opción A — Con dominio (HTTPS automático, recomendado)
```bash
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt-get update && apt-get install -y caddy

# Configura el proxy + HTTPS automático:
cat > /etc/caddy/Caddyfile <<'EOF'
TU_DOMINIO {
    reverse_proxy localhost:3000
    header Strict-Transport-Security "max-age=31536000; includeSubDomains"
}
EOF
systemctl reload caddy
```
Listo: `https://TU_DOMINIO` queda con HTTPS válido (Let's Encrypt automático).

### Opción B — Solo IP (prueba corta, sin HTTPS)
```bash
ufw allow 3000
```
Queda en `http://TU_IP:3000`. ⚠️ Las contraseñas viajan sin cifrar — solo para una
prueba muy corta; pásate a la Opción A para el piloto real.

---

## 7. Crear tu usuario admin e invitar
1. Entra a la URL → **Regístrate** (con el correo que pusiste en `SUPERADMIN_EMAIL`).
2. Como ese correo es superadmin, verás el menú **"Admin"** con las métricas.
   - Si por algún motivo no quedaste superadmin, en el server:
     ```bash
     cd /opt/helper && node -e "const p=require('./api/src/db/client'); p.user.update({where:{email:'TU_CORREO'},data:{rol:'superadmin'}}).then(()=>{console.log('ok');process.exit()})"
     ```
3. Pásales la URL a tus colegas. Cada uno se registra con SUS credenciales de Zajuna.
4. Desde `/admin` ves quién entró, sus fichas, evidencias, actas y mensajes.

---

## 8. Checklist GO-LIVE
- [ ] `pm2 status` → api y workers "online".
- [ ] `https://TU_DOMINIO/api/health` → 200, db+redis true.
- [ ] Login funciona (tú).
- [ ] Un scan de prueba corre (encola y termina) → confirma que Playwright está OK.
- [ ] `OPENROUTER_API_KEY` rotada · `ALLOWED_ORIGIN` = dominio real.
- [ ] Sentry recibiendo (fuerza un error de prueba si quieres) + UptimeRobot apuntando a `/api/health`.
- [ ] Backup diario de Postgres: `crontab -e` →
      `0 3 * * * pg_dump -U zajuna zajuna > /root/backup-$(date +\%F).sql`

---

## 9. Actualizar la app después (cuando haya correcciones)
```bash
cd /opt/helper && git pull
npm install                         # si cambiaron dependencias
npx prisma migrate deploy           # si hubo migración nueva
cd web && npm run build && cd ..    # si cambió el frontend
pm2 restart api workers
```

---

## 10. ¿Un MCP para que Claude lo pruebe después? — SÍ, se puede
Una vez la app esté en una URL pública, hay 3 formas de que yo (Claude) la pruebe:

1. **Chequeos rápidos sin MCP (ya disponible):** puedo consultar endpoints públicos con
   WebFetch (ej. `https://TU_DOMINIO/api/health`) para verificar que está viva. No puede
   loguearse ni navegar la app autenticada.
2. **MCP de navegador (lo ideal para probar de verdad):** instalas un **Playwright MCP**
   (servidor MCP de automatización de navegador) y lo conectas a Claude Code. Con eso yo
   puedo **abrir la app, iniciar sesión con una cuenta de prueba, hacer clic, descargar el
   Excel, generar un acta y tomar capturas** — probarla como un usuario real. Se configura
   con `claude mcp add` (o en `.mcp.json` del proyecto). Dame una cuenta de prueba en el
   piloto y desde ahí valido flujos end-to-end.
3. **MCP a medida (avanzado):** si más adelante quieres que monitoree métricas o haga
   pruebas programadas, se puede exponer un MCP propio que llame a `/api/admin/*` con un
   token de servicio. Es para automatización seria, no para el piloto.

**Para el piloto, la opción 2 (Playwright MCP) es la que querrás** cuando me pidas "pruébalo
y dime si algo se rompió". Cuando llegues a eso, te dejo los pasos exactos de instalación.

---

## Resumen en 6 líneas
1. Server Hetzner CPX21 Ubuntu 22.04 → anota IP (+ dominio opcional).
2. Pega el bloque de la Fase 2 (instala todo + Postgres/Redis).
3. Clona el repo, `npm install`, `playwright install --with-deps chromium`.
4. Crea `.env` con los secretos reales (Fase 4).
5. `migrate deploy` → `build` web → `pm2 start ecosystem.config.js`.
6. Caddy con tu dominio (Fase 6A) → regístrate → invita colegas.
