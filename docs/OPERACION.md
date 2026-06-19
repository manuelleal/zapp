# OPERACION.md — "Se cayó, ¿qué hago?" (runbook de soporte)

Guía rápida para diagnosticar y arreglar Helper **mientras los instructores lo prueban**.
Dos escenarios: **PRODUCCIÓN** (VPS + PM2, ver `DEPLOY.md`) y **LOCAL** (tu PC, `node ...`).

---

## 🥇 Regla de oro: SIEMPRE empieza por estos 2 pasos

1. **Abre el health check:** `https://TU-DOMINIO/api/health` (o `http://localhost:3000/api/health`).
   - `{"status":"ok","db":true,"redis":true}` → la app y la base están vivas; el problema es puntual (mira logs).
   - No responde / timeout → **el servidor está caído** (ve a §1).
   - `"db":false` → **Postgres caído** (§4). `"redis":false` → **Redis caído** (§4).
2. **Mira los logs** (te dicen el error exacto):
   - Producción: `pm2 logs` (o `pm2 logs api --lines 100` / `pm2 logs workers`).
   - Local: la terminal donde corre `node api/src/server.js` muestra el error.

> Con esos 2 datos ya sabes el 90% de las causas. El resto es elegir el arreglo de abajo.

---

## 📡 Monitoreo: enterarte ANTES de que te avisen

No esperes a que un instructor te escriba. Dos alarmas que valen oro:

- **Sentry (errores con stack + quién lo disparó):** ya está integrado en `server.js`.
  Para activarlo: crea un proyecto gratis en [sentry.io](https://sentry.io) → copia el DSN
  en `.env` como `SENTRY_DSN=...` → `pm2 restart api`. Desde ahí, **cada error 500 te llega
  por correo** con el stack, la URL, y el `userId/email` del instructor que lo causó.
  Sin `SENTRY_DSN` queda desactivado (no rompe nada).
- **UptimeRobot (caídas):** crea un monitor gratis apuntando a `https://TU-DOMINIO/api/health`
  cada 5 min. Si la app se cae, te llega un correo/WhatsApp al instante.

> Con estas dos, te enteras de una caída o un bug **antes** que el instructor — y ya sabes
> el error exacto sin reproducirlo.

---

## Tabla síntoma → causa → arreglo

| Síntoma | Causa probable | Arreglo |
|---|---|---|
| **Página en blanco / no carga** | Servidor caído, o (en dev) Vite 5173 cerrado | §1 — reiniciar API. El build en `:3000` funciona aunque Vite esté caído. |
| **`/api/health` no responde** | Proceso `api` murió (error, OOM, terminal cerrada) | §1 |
| **Tareas quedan "en cola" para siempre** (scan/mensajes no avanzan) | Proceso `workers` caído o Redis caído | §2 (workers) / §4 (Redis) |
| **`db:false` en health** | Postgres caído | §4 |
| **`redis:false` en health** | Redis caído | §4 |
| **Scans fallan / banner "tu contraseña de Zajuna cambió"** | Sesión SSO inválida (el instructor cambió su clave en Zajuna) | El instructor actualiza su clave en **Ajustes → Zajuna**. No es caída de la app. |
| **Un instructor ve error 500 puntual** (una acta, un excel) | Bug en ese caso de datos | Mira `pm2 logs` → busca el stack. Reúne ficha/acta que lo causó y se corrige. La app NO se cae por esto (cada request está aislado). |
| **"Demasiados intentos, espera 15 min" al login** | Rate limit (10 intentos/15 min por IP) | Esperar, o reiniciar `api` resetea el contador (está en memoria). |
| **Cambiaste código y no se ve el cambio** | Falta rebuild/restart | §3 |

---

## §1 — Reiniciar el SERVIDOR (API)

**Producción (PM2):**
```bash
pm2 restart api      # reinicia solo la API (no toca los workers)
pm2 status           # confirma que quedó "online"
```
> PM2 **reinicia solo** los procesos que crashean. Si ves muchos restarts en `pm2 status`,
> hay un error de arranque → `pm2 logs api` para ver por qué.

**Local (tu PC):**
```powershell
# Si la terminal del server sigue abierta: Ctrl+C y vuelve a lanzar.
# Si no, mata node y relanza (OJO: taskkill mata TODOS los node):
taskkill /F /IM node.exe
node api/src/server.js          # API en :3000
```

---

## §2 — Reiniciar los WORKERS (scans, mensajes, actas en segundo plano)

Los workers son un proceso **aparte** de la API (por diseño: un OOM de scraper no tumba la web).
Si los scans/mensajes no avanzan pero la web responde, son los workers.

**Producción:** `pm2 restart workers`
**Local:** `node api/src/worker-entry.js`

> ⚠️ **Un solo proceso de workers.** Nunca lances 2 (duplica navegadores → Moodle invalida la sesión).

---

## §3 — Después de cambiar código / desplegar una corrección

**Producción:**
```bash
cd /opt/helper && git pull
npm install                       # solo si cambiaron dependencias
npx prisma migrate deploy         # solo si hubo migración nueva
cd web && npm run build && cd ..  # solo si cambió el frontend (web/)
pm2 restart api workers           # recarga el código nuevo
```
**Local:** rebuild web (`cd web && npm run build`) si tocaste el front, y reinicia
`node api/src/server.js` (y `worker-entry.js` si tocaste workers). El backend NO recarga
solo: hay que reiniciar el proceso.

---

## §4 — Postgres / Redis caídos

**Producción (servicios del sistema):**
```bash
sudo systemctl restart postgresql
sudo systemctl restart redis-server
```
**Local (Docker):**
```powershell
docker start zajuna-postgres-1 zajuna-redis
# o, desde C:\zajuna:
docker-compose up -d
```
Luego revisa `/api/health` → debe volver a `db:true, redis:true`.

---

## Lo que se RECUPERA SOLO en producción (no entres en pánico)

- **API o workers crashean** → PM2 los relanza automáticamente (por eso se usó `pm2 startup`).
- **Un scraper se queda sin memoria** → solo muere ese contexto; la API sigue sirviendo
  (API y workers son procesos separados — fix P0 de §11 del CLAUDE.md).
- **Un request de un instructor falla** → el `setErrorHandler` global responde un 500 limpio
  a ese instructor; los demás siguen trabajando.

## Lo que NO se recupera solo (requiere acción tuya)

- Postgres/Redis caídos (§4).
- Sesión de Zajuna inválida de un instructor (la actualiza él en Ajustes).
- Un bug de datos puntual (lo corriges con el stack de `pm2 logs`).
- Si la caja entera se reinicia y PM2 no estaba en `startup`: `pm2 resurrect`.

---

## Checklist de 30 segundos cuando alguien dice "no funciona"

1. `GET /api/health` → ¿responde? ¿db/redis en true?
2. `pm2 status` (prod) → ¿api y workers "online"? ¿muchos restarts?
3. `pm2 logs --lines 50` → ¿cuál es el error real?
4. Según lo anterior: reiniciar api (§1), workers (§2), o DB/Redis (§4).
5. Si es un caso de datos puntual → guardar qué ficha/acta lo causó y avisar para corregirlo.
