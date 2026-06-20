# ESTADO ACTUAL — Helper (bitácora de despliegue y pendientes)

> **Última actualización:** 20 junio 2026 (madrugada). **La app está DESPLEGADA Y VIVA**
> en producción. Este documento es el "punto de control": qué está hecho, dónde vive,
> cómo se opera y qué falta. Para retomar, ver la sección final **"Cómo seguir"**.

---

## 0. Resumen en una línea
Helper (SaaS para instructores SENA que automatiza Zajuna) está **corriendo en un VPS,
accesible en internet**, en uso real con datos reales. Falta pulido (dominio/HTTPS,
recuperar contraseña, monitoreo) y meter colegas al piloto.

---

## 1. Dónde vive la app (producción)

| Cosa | Valor |
|---|---|
| **URL** | http://167.233.61.39:3000 |
| **Servidor** | VPS Hetzner **CX23** (4 GB RAM), Ubuntu **26.04**, Falkenstein (Alemania) |
| **Carpeta de la app** | `/opt/helper` |
| **Procesos** | PM2: `api` (HTTP, puerto 3000) + `workers` (scrapers BullMQ). `pm2 status` para verlos. |
| **Base de datos** | PostgreSQL local · **Redis** local |
| **Repo** | https://github.com/manuelleal/zapp (privado — clonar con token) |
| **Rama** | `master` |

**Conexión al servidor:** `ssh root@167.233.61.39` (contraseña root la guardaste tú).

---

## 2. Lo que se construyó en esta sesión (todo commiteado y desplegado)

### Funcionalidad
- **Acta oficial GOR-F-084 (DOCX)** con saneo de textos, **logo SENA real** y nota de
  revisión siempre visible. Probada en 5 fichas/competencias.
- **Panel de administración** (`/admin`, solo superadmin): métricas de la plataforma +
  gestión de instructores (suspender/eliminar). `User.rol` / `suspendedAt` / `aceptoTerminosAt`.
- **Aviso legal**: footer permanente + modal de bienvenida (Ley 1581, versión defendible —
  NO dice "no almacena datos" porque sería falso).
- **Mensajes**: estado **"parcial"** (antes marcaba error si fallaba 1 de N), plantillas
  reescritas, diagnóstico de error SMTP (Gmail necesita contraseña de aplicación).
- **Reporte Excel** arreglado: estados correctos (**NE** = no entregó vs **PC** = por
  calificar vs **—** = sin escanear), aviso de "escanea primero", agrupación por guía,
  **enlace en TODAS las celdas** (clic → abre la evidencia del aprendiz en Zajuna),
  modal de selección ordenado por guía (tu competencia primero, "sin guía" al final).
- **Login**: campo "repetir contraseña" + validación, quitada la cédula de ejemplo,
  "Zajuna" → "SENA" en el registro.
- **Descubrimiento de fichas** (`scraper/fichas.js`): ahora trae **TODAS** las fichas vía
  el webservice de Moodle (`core_course_get_enrolled_courses_by_timeline_classification`,
  classification=all). Antes en el servidor solo traía 15 y se saltaba fichas (ej. 3186684).

### Seguridad / infra
- **Sentry** integrado (backend + frontend), se activa con `SENTRY_DSN` / `VITE_SENTRY_DSN`.
- `setErrorHandler` global, IDOR cerrado en `confirm-native`, superadmin sin email hardcodeado.
- `.env.example` + scripts de despliegue.

> Auditoría completa de release: `docs/auditoria-release/00-CONSOLIDADO.md`.

---

## 3. Gotchas del despliegue (para no tropezar otra vez)

1. **Repo privado** → clonar con token: `git clone https://TOKEN@github.com/manuelleal/zapp.git helper`.
2. **Ubuntu 26.04 no lo soporta Playwright 1.59** → se instalaron las libs de Chromium a
   mano y se bajó el navegador con un "disfraz" temporal:
   `sed -i 's/VERSION_ID="26.04"/VERSION_ID="24.04"/' /etc/os-release` (y restaurar después).
3. **Pegar bloques largos en la terminal CORROMPE las líneas** → por eso TODO se hace con
   scripts del repo, no pegando contenido a mano.
4. **`git pull` dejaba la rama desincronizada** → usar `git fetch origin && git reset --hard origin/master`.
5. **`git reset` sin `npm install`** dejaba librerías viejas (el api crasheaba por falta de
   `@sentry/node`) → por eso `actualizar.sh` SIEMPRE corre `npm install`.

---

## 4. Cómo subir un cambio nuevo (el ciclo de trabajo)

1. **En el PC** (C:\zajuna): se hace el cambio → `git commit` → `git push origin master`.
2. **En el servidor**: `cd /opt/helper && bash scripts/actualizar.sh`
   - Hace: `git fetch + reset --hard` → `npm install` (back y front) → migraciones → build → `pm2 restart`.
3. En el navegador: **Ctrl + Shift + R** (refresco forzado) para ver el cambio.

> Si algo se cae mientras prueban: **`docs/OPERACION.md`** (runbook de soporte).

---

## 5. Secretos / configuración del servidor (`/opt/helper/.env`)

Generados/puestos en el deploy (NO están en git):
- `DATABASE_URL` (contraseña de DB aleatoria), `REDIS_URL`, `JWT_SECRET`, `ENCRYPTION_KEY` ✅
- `ALLOWED_ORIGIN=http://167.233.61.39:3000`, `SUPERADMIN_EMAIL=ddiddimmo@gmail.com` ✅
- **Pendientes de poner:** `OPENROUTER_API_KEY` (rotar la vieja), `SENTRY_DSN`, `VITE_SENTRY_DSN`.

---

## 6. Pendientes (roadmap, en orden sugerido)

1. **Dominio + HTTPS** (Caddy) — que deje de ser una IP y las contraseñas viajen cifradas.
   Pasos en `docs/PLAN_DESPLIEGUE.md` §6A. Luego cambiar `ALLOWED_ORIGIN` al dominio.
2. **Recuperar contraseña por correo** — feature nueva (tokens + email). Necesita el correo
   activo (contraseña de aplicación de Gmail en Ajustes).
3. **Rotar `OPENROUTER_API_KEY`** + poner `SENTRY_DSN` (monitoreo de errores) y un monitor
   UptimeRobot a `/api/health`.
4. **Branding**: cambiar "Zajuna" → "SENA" en toda la app (nav, "Buscar en Zajuna", Ajustes),
   no solo en el login.
5. **Revisar** por qué 12 fichas quedan en "Archivadas" tras el descubrimiento.
6. **Invitar 1-2 colegas** al piloto y recoger feedback.
7. Pulido visual de la app (retoques de diseño de bajo riesgo) — ver `docs/auditoria-release/04-design-mobile.md`.

---

## 7. Cómo seguir (para retomar con Claude)

- **Abre Claude Code en la carpeta del proyecto:** `C:\zajuna` (el mismo de siempre).
- Di **"seguimos"** — la **memoria de Claude persiste entre sesiones**, así que ya tendrá el
  contexto de todo esto (qué se hizo, el despliegue, los pendientes).
- Si quieres trabajar el servidor en vivo, ten a mano la terminal con `ssh root@167.233.61.39`.
- Documentos de referencia en el repo:
  - `docs/ESTADO_ACTUAL.md` ← este (el punto de control).
  - `docs/PLAN_DESPLIEGUE.md` ← pasos de despliegue (incl. dominio/HTTPS).
  - `docs/OPERACION.md` ← qué hacer si algo se cae.
  - `docs/auditoria-release/` ← auditoría completa (bugs, diseño, seguridad).
  - `CLAUDE.md` ← fuente de verdad del proyecto.

> **En una frase:** abre `C:\zajuna`, di "seguimos", y arrancamos por el dominio + HTTPS
> (o por lo que prefieras de la lista de pendientes).
