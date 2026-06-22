# ESTADO ACTUAL — Helper (bitácora de despliegue y pendientes)

> **Última actualización:** 21 junio 2026 (noche). **La app está DESPLEGADA Y VIVA** en producción.
> Este documento es el "punto de control": qué está hecho, dónde vive, cómo se opera y qué
> falta. Para retomar, ver la sección final **"Cómo seguir"**.
>
> ## 🔥 SESIÓN 21 jun (NOCHE) — 4 commits en master, FALTA DESPLEGAR
> **Mañana, primer paso:** `cd /opt/helper && bash scripts/actualizar.sh` (baja los 4 commits,
> corre 2 migraciones — AiUsage + aprobación con backfill — recompila y reinicia). Luego Ctrl+Shift+R.
>
> Commits nuevos (sobre `cd60330`):
> - `f91a0c2` feat(admin): panel superadmin + tracking de consumo de IA + `lastLoginAt` (trabajo de otra sesión, integrado).
> - `de58691` fix(seguridad): criterio único de superadmin (`lib/roles.js`: rol="superadmin" **O** email===SUPERADMIN_EMAIL) + **auto-sanado en login**. Resuelve el reseteo del rol al recrear la DB. Tests `roles.test.js` 6/6.
> - `ff4a708` refactor(ui): "Zajuna"/"SENA" fuera del texto visible (app = **"Helper"**); se CONSERVÓ el aviso legal ("SENA = Responsable del Tratamiento") y el badge del acta oficial GOR-F-084.
> - `c916f0e` feat(auth): **REGISTRO CERRADO** — las cuentas nuevas quedan *pendientes* y el superadmin las aprueba en `/admin` (badge "pendiente" + botón Aprobar + contador). El dueño (SUPERADMIN_EMAIL) entra siempre; los usuarios previos quedaron aprobados por backfill.
>
> **IA en prod:** quedó FUNCIONANDO. La causa de la falla era `OPENROUTER_API_KEY` **DUPLICADA** en el `.env` del server (ganaba la vacía → caía a Anthropic). Ahora una sola línea + `pm2 delete all && pm2 start`. Prueba: `node scripts/verificar-ia.js`. 🔴 **Pendiente del dueño: rotar la key expuesta (mañana).**
>
> **Investigaciones (MD):** anuncios programados por ficha → `docs/INVESTIGACION_ANUNCIOS.md`; cómo evalúa la Extensión en SOFIA → `docs/INVESTIGACION_EXTENSION_SOFIA.md`.
>
> **Decisión:** dominio/HTTPS **sin pagar** → usar **DuckDNS** (subdominio gratis + Caddy saca el SSL) cuando se retome.
>
> **Sesión 21 jun (resumen de lo nuevo, todo desplegado salvo donde se indique):**
> 1. **RAPs vacíos RESUELTOS** — `GET /api/raps` filtraba por `competenciaId` (cuid volátil);
>    ahora `lib/competencia.js` resuelve por **código estable** y auto-vincula. + **biblioteca
>    de RAPs sembrada en prod** (19 competencias / 75 RAPs) con `scripts/seedRaps.js` +
>    `scripts/exportRapsSeed.js` + `scripts/data/raps-seed.json`.
> 2. **Nueva feature "Cargar mis RAPs con IA" (Fase 1):** el instructor **sube su guía PDF** →
>    la IA (OpenRouter/Kimi K2) extrae RAPs+criterios → **PROPONE** → el instructor revisa y
>    confirma (regla #8). Ruta `POST /api/raps/extraer-ia` + cola/worker `extraerRapsIa` +
>    `web/src/components/CargarRapsIaModal.tsx`. Confirmar reusa `POST /api/raps/import`.
> 3. **Acta SIN RAPs:** se genera "por evidencias de la competencia del instructor" cuando no
>    hay RAPs mapeados (antes daba 422). `actas.js` auto-poblar + preview-native.
> 4. **BLINDAJE de datos compartidos:** los RAPs son compartidos por código (cualquiera LEE);
>    al cargar, un instructor solo **AGREGA los que falten** — solo el **superadmin sobrescribe**
>    (cura). Así "la competencia no se traga tu trabajo". + rate-limit IA (5/15min) + worker
>    concurrency 4. `scripts/hacer-superadmin.js <email>`.
> 5. **Saneo:** las descripciones de RAP ya no arrastran el texto de la guía (primera oración).
>
> ⚠️ **OJO operativo:** PM2 NO recarga el `.env` con un `pm2 restart` normal (mantiene env viejo).
> Si cambias un secreto en `/opt/helper/.env`, recrea: `pm2 delete all && pm2 start ecosystem.config.js`.
> ⚠️ **Trabajo en curso de OTRA sesión** (sin commitear por esta): "AI usage tracking + panel admin
> + last login" (`aiClient.js`, `admin.js`, `schema.prisma`, migración `add_ai_usage_and_last_login`).

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
3. 🔴 **ROTAR `OPENROUTER_API_KEY` YA** — la key actual quedó EXPUESTA (se pegó en un chat y en
   el historial bash del server). Genera una nueva en OpenRouter, ponla en `/opt/helper/.env` y
   recrea PM2 (`pm2 delete all && pm2 start ecosystem.config.js`). + poner `SENTRY_DSN` y monitor
   UptimeRobot a `/api/health`.
4. **Branding**: cambiar "Zajuna" → "SENA" en toda la app (nav, "Buscar en Zajuna", Ajustes),
   no solo en el login.
5. **Revisar** por qué 12 fichas quedan en "Archivadas" tras el descubrimiento (el agente dejó
   diagnóstico + fix listo: filtrar cursos `hidden` en `scraper/fichas.js`; sin aplicar).
6. **Invitar 1-2 colegas** al piloto y recoger feedback.
7. Pulido visual de la app (retoques de diseño de bajo riesgo) — ver `docs/auditoria-release/04-design-mobile.md`.

### Features nuevas pedidas (21-jun noche)
- **Anuncios programados por ficha** — el instructor define anuncios y *cuándo* se publican; se reusa la infra de `MensajeProgramado` + el worker de tick. Diseño, prior art y pendientes (cómo publicar en el foro de novedades) en `docs/INVESTIGACION_ANUNCIOS.md`.
- **Evaluación "en SOFIA" estilo Extensión** — entender cómo la Extensión Z registra los juicios evaluativos en SOFIA Plus (distinto de Zajuna) para replicarlo. Investigación en `docs/INVESTIGACION_EXTENSION_SOFIA.md`.

### Seguimiento de la feature de RAPs con IA
8. **Fase 2 — auto-traer la guía DESDE Zajuna** (sin subir PDF): reusa el mismo núcleo IA; el
   punto frágil es localizar/descargar la guía del curso (hay prior art: `extraerGuiasDesdeZajuna.js`,
   `probeGuiaRecurso.js`). Cae al upload (Fase 1) si no la encuentra.
9. **Criterios de los RAPs sembrados**: el seed casi no trae criterios. Para llenarlos, el
   superadmin sube la guía por "Cargar con IA" (extrae criterios) y confirma (sobrescribe).
10. **Ownership por-programa** (para 200 instructores): hoy el blindaje es por rol (solo superadmin
    cura). A futuro, dueño por competencia (requiere migración — coordinar con la migración pendiente
    de la otra sesión).
11. **App se cierra a las ~2h de inactividad** — reportado por el usuario; por diagnosticar.

### Seguridad — backlog (ver §nuevo abajo)
12. **HTTPS (#1)**, rotar key (#3), `npm audit` (1 high en front), rate-limit a Redis, confirmar
    secretos fuertes en prod, gate del panel admin. Detalle en la sección "Seguridad" más abajo.

---

## 6B. Seguridad — backlog priorizado (al 21 jun)

> **DECISIÓN 21-jun (usuario):** se sigue con **features**; el **piloto queda SOLO entre gente
> de confianza** por ahora, asumiendo el riesgo a corto plazo. **HTTPS DIFERIDO** pero dejado
> "listo para hacer" (checklist al final de esta sección).
> ⚠️ Recordatorio honesto: la confianza de las personas NO mitiga el sniffing de red. Esto es
> aceptable **solo** mientras sea piloto cerrado y desde redes propias/de casa — **evitar
> entrar desde WiFi público** (café, etc.) hasta tener HTTPS, porque ahí van las credenciales SENA.

🔴 **Críticos antes de meter más instructores:**
- **HTTPS + dominio (Caddy):** hoy la app va por `http://IP:3000` → contraseñas y JWT viajan
  **SIN cifrar**. Es el riesgo #1. Pasos en `docs/PLAN_DESPLIEGUE.md` §6A; luego ajustar `ALLOWED_ORIGIN`.
- **Rotar `OPENROUTER_API_KEY`** (quedó expuesta — ver §6.3).

🟠 **Importantes:**
- **Recuperar contraseña por correo** (no existe; si alguien la olvida, queda fuera).
- **`npm audit`**: 1 high + 4 moderate (frontend), 2 moderate (backend) — revisar, sobre todo el high.
- **Rate-limit a Redis**: login/registro y extracción IA usan limitador in-memory (se reinicia con
  el proceso y no se comparte entre instancias).
- **Secretos en prod**: confirmar `JWT_SECRET` / `ENCRYPTION_KEY` fuertes y únicos (no placeholders).
  `.env` NO está en git ✓. Evitar pegar secretos en chat/terminal (quedan en el historial).
- **Panel admin** (feature de la otra sesión): asegurar que TODAS las rutas `/api/admin/*` exigen
  `rol=superadmin` antes de exponerlo.

🟡 **Higiene / a futuro:**
- `SENTRY_DSN` (visibilidad de errores) + UptimeRobot a `/api/health`.
- Ownership por-programa de los RAPs (governance a escala — §6.10).
- Revisar por qué el `rol` del superadmin se reseteó a `instructor` en prod.

### HTTPS — listo para hacer (cuando haya dominio) ✅
Diferido por decisión del 21-jun, pero estos son los pasos exactos para activarlo en ~15 min:
1. Conseguir un **dominio** y apuntar un registro **A** a `167.233.61.39` (ej. `helper.tudominio.com`).
2. En el VPS: `apt install caddy`.
3. `/etc/caddy/Caddyfile`:
   ```
   helper.tudominio.com {
       reverse_proxy localhost:3000
   }
   ```
   → `systemctl reload caddy` (Caddy saca el certificado TLS de Let's Encrypt solo).
4. En `/opt/helper/.env`: `ALLOWED_ORIGIN=https://helper.tudominio.com` → `pm2 delete all && pm2 start ecosystem.config.js`.
5. (Opcional) cerrar el puerto 3000 al exterior (firewall `ufw`) para forzar el paso por Caddy.
> Detalle ampliado en `docs/PLAN_DESPLIEGUE.md §6A`.

---

> Auditoría previa más amplia en `docs/auditoria-release/` (release 19 jun: P0 IDOR cerrado, etc.).
> Se puede correr `/security-review` sobre el diff antes de un release.

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
