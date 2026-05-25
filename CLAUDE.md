# CLAUDE.md — Zajuna App

> **Última actualización:** 25 mayo 2026 (auditoría arquitectónica).
> Este documento es la **fuente única de verdad** para los agentes de IA. Contiene las reglas del proyecto, decisiones de arquitectura y comandos de desarrollo. 

## 1. Qué es este proyecto
SaaS multitenant para instructores del SENA que automatiza la gestión de Zajuna (Moodle). Permite revisar evidencias pendientes, calificar, responder foros y enviar mensajes masivos a estudiantes, utilizando Scraping (Playwright) e Inteligencia Artificial (Claude).

---

## 2. Stack Tecnológico
- **Backend:** Node.js + Fastify 5 + BullMQ + Redis + PostgreSQL + Prisma 6
- **Frontend:** React 18 + Vite 5 + Tailwind 3 + shadcn/ui en `web/` — servido por Fastify
- **Scraping:** Playwright 1.59 (workers BullMQ, concurrency controlado)
- **IA:** Anthropic API (Claude Haiku/Sonnet para matching y calificación)
- **Desarrollo Local:** Docker Compose (Postgres 16 + Redis 7)

---

## 3. Guía de Inicio Rápido (Dev Local)
Asegúrate de ejecutar estos comandos al inicio de tu sesión o si cambias algo en el backend/workers:

```powershell
# 1. Asegurar que Redis y Postgres están corriendo (Docker)
docker start zajuna-redis-1
docker-compose up -d

# 2. Matar nodes viejos (¡CRÍTICO! Los workers leen la config solo al arrancar)
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force

# 3. Arrancar el server (inicia API en puerto 3000 + 12 workers)
node api/src/server.js

# 4. Frontend en modo desarrollo (HMR en puerto 5173, opcional)
cd web && npm run dev

# 5. Build del frontend (cuando edites web/)
cd web && npm run build 
# El server sirve estáticos desde web/dist
```

---

## 4. Estructura de Directorios Clave

Ver `docs/ARCHITECTURE.md` para el detalle completo de workers y modelos.

```
C:\zajuna\
├── api/src/              ← Backend Fastify, rutas y workers BullMQ
├── prisma/schema.prisma  ← 17+ Modelos (Fichas, Evidencias, Actas, RAPs...)
├── scraper/              ← Lógica de Playwright y web scraping a Moodle
│   └── seedRapsIngles.js ← Sembrador específico de RAPs de inglés (240202501) desde PDFs
├── scripts/              ← Utilidades de línea de comandos (no son workers BullMQ)
│   ├── extraerTodasLasGuias.js    ← Extractor GENÉRICO de Competencias y RAPs desde PDF local
│   ├── extraerGuiasDesdeZajuna.js ← Crawler Playwright: descarga guías del curso y extrae RAPs
│   └── vincularEvidenciasRAPs.js  ← Crea RapEvidenciaRel en DB (auto inglés, IA para el resto)
├── web/                  ← Frontend React/Vite
├── docs/                 ← Documentación complementaria (Arquitectura, Moodle UI)
└── HANDOFF.md            ← Archivo histórico (NO modificar, solo lectura)
```

---

## 5. Reglas de Desarrollo y Decisiones de Diseño

> **No revertir estas decisiones sin discusión previa con el usuario.**

1. **Multitenant obligatorio:** Todo query a la base de datos debe filtrar explícitamente por `userId`.
2. **Workers son stateless:** Reciben job, ejecutan (abren browser/conexión), cierran y retornan el resultado.
3. **Cierre de evidencias es 100% manual:** El worker NUNCA setea `cerradaAt` automáticamente.
4. **Soft-state para fechas:** Los campos como `archivedAt`, `cerradaAt`, `archivadaAt` son de tipo `DateTime?`, no booleanos.
5. **UI centralizada en React:** No existe carpeta `public/` antigua. Todo va en `web/`.
6. **Migraciones explícitas:** Una migración Prisma por feature lógico con nombres descriptivos en snake_case.
7. **Interacción con UI de Moodle (Zajuna):** Siempre usar POST/fetch a nivel DOM (como en `scraper/configEvidencias.js` o endpoints documentados en `docs/MOODLE_REFERENCE.md`) en lugar de interactuar con checkboxes o botones vía Playwright si hay inestabilidad.
8. **La IA NO actúa sola:** Siempre debe proponer al instructor en la interfaz antes de aplicar (ej. matching o actas).
9. **Hrefs canónicos de Moodle:** Todo módulo (assign/forum/quiz) se almacena con `href = ${BASE_URL}/mod/{tipo}/view.php?id=${actId}`. Cualquier scraper que extraiga links (Gradebook Tree devuelve `grade.php`/`report.php`) debe convertir a la forma canónica antes de upsert. Sin esto, `@@unique([fichaId, href])` falla y se generan duplicados.
10. **Umbral SENA universal:** En `esAprobada()` el umbral es **70/100** + cualitativa `A` / regex "aprobad". Aplica a TODOS los instructores y programas SENA. NO introducir `User.notaUmbral` configurable (confirmado por el usuario el 2026-05-25 — es estándar institucional GOR-F-084 V02).
11. **Estado calificado sin nota numérica NO aprueba:** `estado === "calificado"` y `notaActual == null` se considera "no aprobada" porque no hay evidencia explícita de aprobación. Solo señales `A`/`aprobad` cualitativas o nota numérica ≥70 aprueban.

---

## 6. Variables de Entorno (`.env`)
```env
DATABASE_URL=postgresql://zajuna:zajuna@localhost:5432/zajuna
REDIS_URL=redis://localhost:6379
JWT_SECRET=secreto-largo-jwt
ENCRYPTION_KEY=64chars-hex-para-aes-256-gcm
ANTHROPIC_API_KEY=sk-ant-...
# Credenciales base para tests manuales si es necesario:
ZAJUNA_USER=
ZAJUNA_PASS=
```

---

## 7. Estado Actual y Pendientes (actualizado 25 mayo 2026)

---

### 🌿 Ramas activas

| Rama | Estado | Qué tiene |
|---|---|---|
| `feature/strict-rap-mapping` | ✅ Lista, sin mergear | Fix actas.js (eliminado rapPorSufijo), scripts vincular/extraer |
| `feature/gradebook-scan-v2` | 🔄 Rama actual (2 commits adelante del 24-may) | Gradebook Tree + canonicalización hrefs + calcularEstado estricto + foroDescubrir end-to-end |

**Sin remote configurado** — el `git push` falla con "origin does not appear to be a git repository". Cuando se configure, ambas ramas listas para subir.

---

### 🗄️ Estado de DB al 25 mayo 2026

| Tabla | Cantidad | Notas |
|---|---|---|
| `Competencia` | 19 | Sin cambio |
| `RAP` | 75 | Sin cambio |
| `Evidencia` (global) | **920** | ✅ Sin duplicados, **100% hrefs canónicos `view.php`** (de 998 con 81 duplicados → 920 limpios) |
| `RapEvidenciaRel` | 0 | ⚠️ Sigue pendiente correr `vincularEvidenciasRAPs.js` |

---

### ✅ FASE 1 — COMPLETADA: Captura + canonicalización de evidencias

- Scan ficha 3186683: **48 → 199 evidencias** (Gradebook Tree captura GA4–GA11 ocultas a aprendices).
- `obtenerEvidencias()` ahora emite href canónico `${BASE_URL}/mod/{tipo}/view.php?id=${actId}` independiente de lo que devuelva `a.gradeitemheader` (que a veces es `grade.php` o `report.php`).
- Cleanup completo de duplicados existentes: 81 evidencias huérfanas borradas, FKs migradas sin perder calificaciones.

---

### 🔴 FASE ACTUAL — FASE 2: UI de Selección Masiva por Competencia

**Objetivo:** Construir en la UI la pantalla que permite al instructor seleccionar masivamente evidencias agrupadas por competencia, para marcarlas como revisadas / calificar / generar actas.

**Diseño propuesto:**
- Ruta: `ActasPage` (o nueva `EvidenciasPage`) con agrupación por `Competencia`.
- Cada competencia muestra sus evidencias con estado (entregada, calificada, sin entregar).
- El instructor puede seleccionar un subconjunto y disparar acciones en lote (calificar, generar acta).
- Backend: `GET /api/evidencias?fichaId=&competenciaId=` + acción batch.

**Archivos clave a tocar:**
- `web/src/pages/ActasPage.tsx` (o crear `EvidenciasPage.tsx`)
- `api/src/routes/scan.js` — agregar endpoint de evidencias por competencia si no existe
- `api/src/workers/evidenciasWorker.js` — revisar si hay batch action disponible

---

### 🟠 PENDIENTE: Extracción de Guías de Aprendizaje (bloqueado)

**Problema:** El último intento de `extraerGuiasDesdeZajuna.js` encontró **81 módulos `mod/page`**, pero todos eran **Resúmenes de Sesión**, no Guías de Aprendizaje. Las guías reales probablemente están en:

- **`mod/folder`** — carpetas de Moodle que agrupan archivos (incluiría los PDFs de guía).
- O el instructor necesita **proporcionar el link directo** al recurso/carpeta donde están las guías.

**Siguiente acción:**
1. Ajustar `extraerGuiasDesdeZajuna.js` para también inspeccionar `mod/folder` además de `mod/page`.
2. O pedir al instructor el link directo a la sección de guías del curso en Zajuna.

---

### 🔴 PRÓXIMOS PASOS (en orden)

**Paso 1 — Construir UI Fase 2 (selección masiva por competencia)**
- Diseñar `EvidenciasPage.tsx` con agrupación por competencia y acciones en lote.
- Conectar al backend con filtros `fichaId` + `competenciaId`.

**Paso 2 — Vincular evidencias a RAPs**
```powershell
node scripts/vincularEvidenciasRAPs.js --dry-run   # verificar primero
node scripts/vincularEvidenciasRAPs.js              # ejecutar
```
Resultado esperado: `RapEvidenciaRel` pasa de 0 a ~190 registros.
Las actas pasan de `global-fallback` a modo **`per-rap`** real.

**Paso 3 — Resolver extracción de guías (mod/folder o link directo)**
Ver sección "PENDIENTE: Extracción de Guías" arriba.

**Paso 4 — Mergear `feature/strict-rap-mapping` a `main`**
```powershell
git checkout main
git merge feature/strict-rap-mapping
git merge feature/gradebook-scan-v2
```

---

### ✅ Resuelto hoy (25 mayo 2026)

**1. Canonicalización de hrefs + cleanup de duplicados** (`scraper/evidencias.js`, `scripts/cleanup-duplicates.js`)
- Bug raíz: Gradebook Tree devolvía links `grade.php?id=X` mientras scans viejos guardaban `view.php?id=X` → mismo cmid, dos rows distintos en `@@unique([fichaId, href])`.
- Fix scraper: `obtenerEvidencias()` reconstruye href como `${BASE_URL}/mod/{tipo}/view.php?id=${actId}` afuera del `$$eval`.
- Fix DB: `scripts/cleanup-duplicates.js` agrupa por `(fichaId, nombre)`, elige ganadora (limpio > más entregas > id más viejo) y **migra todas las FKs** (Entrega con merge, EvidenciaConfig, ConfigAudit, RapEvidenciaRel, MatchingPropuesta) sin perder calificaciones.
- Resultado: 998 → 920 evidencias, 0 duplicados, 920/920 con href canónico.

**2. `calcularEstado` con reglas estrictas + umbral 70** (`api/src/routes/actas.js`)
- Antes: `entregas.some(esAprobada)` → 1 evidencia aprobada de 3 daba el RAP APROBÓ falsamente.
- Ahora: `entregas.every(esAprobada)` con evidencias virtuales `sin_entregar` inyectadas si faltan. Mismo cambio en juicio global de la fila.
- `esAprobada` patcheada: umbral 70/100 (nota 0 ya no cuenta como aprobada). Quitado fallback `est === "calificado"` que enmascaraba el bug.
- Aplicado en `/api/actas/:id/auto-poblar` y `/api/actas/preview-native` (los dos endpoints).

**3. Descubrir aprendices con posts en foros sin nota — flujo end-to-end** (`scraper/foroRating.js`, `api/src/workers/foroDescubrirWorker.js`, `api/src/routes/foroRating.js`, `web/src/components/AprendicesPanel.tsx`)
- Función nueva `descubrirCalificacionesPendientesForo(page, actId)` itera view.php + discuss.php y devuelve `{ pendientes, calificados, totalUsers, totalPosts }`.
- Worker `foroDescubrirWorker` (cola `foroDescubrir`) cruza moodleUserId con tabla Aprendiz para enriquecer.
- Endpoint `POST /api/evidencias/:id/foro/descubrir-pendientes` encola el job.
- UI: botón "Verificar en Moodle" en toolbar del foro (`AprendicesPanel.tsx`) + badge amarillo "Sin nota en Moodle" por fila.

**4. `evidenciasWorker` — `normalizarHref` + `fechaScan` + log de 0 activas**
- `normalizarHref(href)` recorta query params extras (`&action=grading`) antes del upsert.
- `fechaScan` se refresca cuando cambia **nota O estado** (antes solo cuando cambiaba estado → "Hace 13 días" congelado).
- Si `activas.length === 0` ahora retorna temprano con `resultado.advertencia` (antes saltaba del 50% al 100% sin pista).

**5. `cambiarFechaWorker` — soporte para fecha de apertura**
- Nuevos campos opcionales en `job.data`: `aperturaFecha` / `aperturaHora`.
- Se pasan a `guardarConfigEvidencia` como `abrirFecha`/`abrirHora`. El audit guarda antes/después de **ambas** fechas.

**6. `extraerGuias{TodasLasGuias,DesdeZajuna}` — `extraerRAPs` ya no arrastra el PDF entero**
- Regex con stop en línea en blanco (`\n[ \t]*\n`) + `.substring(0, 400)` como red de seguridad.
- `FIN` regex extendido con `Presentaci[oó]n` y `Formulaci[oó]n\s+de`.
- `extraerGuiasDesdeZajuna.js`: discovery jerárquico FASE → Actividad de proyecto → Guía de aprendizaje (reemplaza el barrido ciego de 81 `mod/page` que traía resúmenes de sesión).

---

### 📝 Notas técnicas importantes

- **Competencias con nombre `[Sin nombre — Guía N]`**: son competencias transversales que aparecen solo en códigos de RAP del PDF, no en la sección "Competencias". Funcionales para actas pero con nombre placeholder. Corregir manualmente si se necesita presentar al usuario.
- **`240201530` (inducción)**: extrajo mal el nombre del PDF. Irrelevante para actas de formación técnica.
- **`RapEvidenciaRel = 0`**: hasta que no se corra `vincularEvidenciasRAPs.js`, las actas usan `global-fallback` (todos los RAPs de la competencia). Funciona pero sin granularidad por guía.

---

### 🟡 Backlog (media/baja prioridad)

- BUG: Variables `{{nombre}}`, `{{ficha}}`, `{{instructor}}` no se interpolan al enviar mensajes por Zajuna.
- Bandeja de mensajes entrantes del instructor.
- Reportes Excel con `exceljs` desde el backend.

---

### 📜 Scripts de utilidad creados (todos en `scripts/`)

| Script | Qué hace |
|---|---|
| `extraerTodasLasGuias.js <pdf>` | Extrae Competencias+RAPs de un PDF local → DB |
| `extraerGuiasDesdeZajuna.js <courseId>` | Descarga todas las guías del curso en Zajuna → DB |
| `vincularEvidenciasRAPs.js` | Crea `RapEvidenciaRel`: inglés auto, resto lista para IA |
| `diag-ficha.js <codigo>` | Diagnóstico de evidencias de una ficha en DB |
| `diag-competencias.js` | Resumen global de competencias y cobertura en DB |
| `smoke-test-simulador.js` | Test HTTP completo del flujo Modo Dios (11/11 ✅) |

---

## 8. Protocolo de Colaboración Multi-Agente (Antigravity + Windsurf + Claude Code)

Este repositorio está orquestado por **Antigravity (Arquitecto Principal)**. Si eres Windsurf o Claude Code leyendo esto, actúa bajo las siguientes directrices:

1. **Tu Rol:** Eres un "Developer Especializado". Tu objetivo es implementar features puntuales, refactorizar archivos específicos o maquetar UI, **sin alterar la arquitectura global** definida en este documento ni en `ARCHITECTURE.md`.
2. **Fuente de la Verdad:** Este archivo (`CLAUDE.md`) contiene el estado real del sistema. Léelo siempre antes de proponer cambios masivos.
3. **Aislamiento de Ramas:** Realiza tu trabajo en la rama que el humano te indique (ej. `feature/ui-updates` o la rama actual de trabajo).
4. **Handoff (Entrega):** Cuando termines tu tarea, dile al humano: *"He terminado. Puedes pedirle a Antigravity que revise el código, haga la integración o actualice la documentación arquitectónica"*. No intentes modificar este archivo `CLAUDE.md` a menos que se te pida explícitamente.

---

## 9. Auditoría arquitectónica (25 mayo 2026)

> Revisión hecha al cierre de la sesión 25-may con el objetivo de tener un mapa claro de qué está sólido, qué está parcheado y qué hay que mejorar antes de vender la app o de meter features pesadas (próximo "chicharrón").

### 9.1 — Lo que está sólido ✅

| Aspecto | Estado | Notas |
|---|---|---|
| Multi-tenancy | ✅ Aplicado consistente | Todo query filtra por `userId`; rutas usan `verificarFichaDelUsuario`/`verificarActaDelUsuario`. |
| Separación responsabilidad | ✅ Limpia | `routes/` (HTTP), `workers/` (BullMQ), `scraper/` (Playwright), `web/` (UI). |
| Encriptación credenciales | ✅ AES-256-GCM | `zajunaUserEnc`/`zajunaPassEnc` cifrados con `ENCRYPTION_KEY`. No se leen en plano fuera del worker. |
| Workers stateless + concurrency | ✅ | BullMQ con concurrency por tipo (foroRating=2, cambiarFecha=1, evidencias=3). |
| Reglas SENA universales | ✅ Validadas | Umbral 70 + A/D estándar institucional. No requiere config por usuario. |
| Hrefs canónicos | ✅ Resuelto 25-may | Scraper emite `view.php?id=X` siempre. Evita duplicados a futuro. |

### 9.2 — Lo que está roto o parcheado 🩹

| Hallazgo | Severidad | Detalle |
|---|---|---|
| **0 tests backend** | 🔴 Alta | `find api -name "*.test.js"` → vacío. Cualquier refactor es a ciegas. `calcularEstado`/`esAprobada` solo tienen smoke test inline ad-hoc. |
| **36 scripts huérfanos en root** | 🟠 Media | `test-*.js`, `debug-*.js`, `check-*.js`, `dump-*.js`, `diag-*.js`, etc. — basura de debug que no debería vivir en raíz. `.gitignore` no los cubre (están untracked manualmente). |
| **Boilerplate Playwright duplicado** | 🟠 Media | 9 de 14 workers repiten el mismo bloque de 30 líneas (`loadSession` → `chromium.launch` → verificar URL → `login` → `saveSession`). Cualquier fix de auth se replica en 9 lugares. |
| **Sin `/health` endpoint** | 🟠 Media | No hay manera de saber si Redis/Postgres están conectados antes de aceptar requests. Bloqueante para load balancer / k8s readiness probes. |
| **`docs/ARCHITECTURE.md` referenciado pero no existe** | 🟡 Baja | CLAUDE.md sección 4 dice "ver `docs/ARCHITECTURE.md`" — solo hay `docs/MOODLE_REFERENCE.md`. Documentación arquitectónica está dispersa. |
| **`pdf-parse` con API no estándar** | 🟡 Baja | `const { PDFParse } = require("pdf-parse")` + `new PDFParse({...}).getText()` no es la API oficial del paquete. Si actualizas la versión, todo extractor de guías se rompe. Fija la versión en `package.json` o migra a la API estándar. |
| **Rate limit in-memory** | 🟡 Baja | `auth.js` usa `new Map()`. No escala con múltiples instancias y se pierde en restart. OK para tu caso (single node) pero bloqueante al escalar. |
| **`autoScan` cron sin guard** | 🟡 Baja | Repeatable cada 3h. Si Redis está caído al arrancar, el `.then().catch()` solo loguea. No re-intenta. |
| **AIPI ACTA... .docx + acta_03_...pdf borrados sin commit** | 🟡 Baja | `git status` muestra archivos `D` (deleted) desde hace días. Decidir si recuperar o `git rm`. |

### 9.3 — Mejoras recomendadas (priorizadas para próximo chicharrón) 🟢

1. **Tests unitarios mínimos del motor de calificación** (alto retorno, bajo esfuerzo)
   - `api/src/routes/actas.test.js`: `esAprobada`, `calcularEstado`, juicio global. Casos de la sesión 25-may como base.
   - `api/src/workers/evidenciasWorker.test.js`: `normalizarHref` + lógica de upsert canónica.
   - Sugerencia: `vitest` o `node:test` (no agregar Jest pesado).

2. **Extraer `crearSesionPlaywrightAutenticada(userId, encUser, encPass)` a `api/src/lib/playwrightSession.js`**
   - Deduplica las 30 líneas que se repiten en 9 workers.
   - Centraliza el manejo de sesión expirada y `UnrecoverableError`.

3. **`.gitignore` agresivo + limpieza de root**
   - Agregar: `test-*.js`, `debug-*.{js,html}`, `check-*.js`, `scan*.js`, `dump-*.js`, `diag-*.js`, `inject.js`, `enqueue.js`, `find.js`, `walkthrough.md`, `*.xlsx`, `Guia_*.pdf`, `PROJECT_STATUS.md`.
   - Mover scripts útiles a `scripts/` (los demás `git clean -fX`).

4. **Endpoint `GET /api/health`**
   - Pings rápidos a Postgres (`SELECT 1`) y Redis (`PING`). Devuelve 200 con `{ db, redis, uptime }` o 503.
   - Útil para Docker healthcheck, k8s readiness, monitoreo externo (UptimeRobot).

5. **CI mínimo (GitHub Actions o equivalente cuando haya remote)**
   - `node --check` sobre todo `api/src/**/*.js` y `scraper/**/*.js`.
   - `cd web && npm run build` (ya verifica TS).
   - Cuando existan tests, correrlos en PR.

6. **Idempotencia explícita en workers críticos**
   - `foroRatingWorker` con retry attempts > 1 puede repostear ratings si Moodle no respondió. Hoy `defaultJobOptions: retryOpts` tiene `attempts: 3`. Riesgo: doble calificación.
   - Mitigación: tracking de `moodleUserId` ya posteados en `Job.resultado` y skip al retry. O `attempts: 1` para este worker.

7. **`docs/ARCHITECTURE.md` real**
   - Diagrama (mermaid) de Cola ↔ Worker ↔ Scraper ↔ Moodle.
   - Tabla de field maps (`assign`/`forum`/`quiz`) ya documentada en `scraper/configEvidencias.js` — extraer a doc.

8. **Migrar `pdf-parse` a API estándar o pinear versión**
   - `package.json`: `"pdf-parse": "1.1.1"` (exacto, sin `^`). O reescribir extractores con `const pdfParse = require('pdf-parse')` (API real del paquete).

### 9.4 — Seguridad 🔒

| Riesgo | Estado | Acción |
|---|---|---|
| Logs leaking credentials | ✅ No detectado | Grep negativo. Sigan loggeando con `log()` que recibe strings, no objetos. |
| `JWT_SECRET` rotation | ⚠️ No implementado | Si se compromete, todos los tokens activos siguen válidos. Bajo riesgo single-tenant; alto multi-tenant. |
| `ENCRYPTION_KEY` rotation | ⚠️ Difícil | Si rota, hay que re-encriptar todas las `zajunaUserEnc`/`zajunaPassEnc` en DB. Documentar procedimiento antes de vender. |
| CORS | ❓ No verificado | Revisar `api/src/server.js` cuando se expongan dominios externos. |

### 9.5 — Cosas a NO tocar (decisiones explícitas del usuario) 🚫

- Umbral 70 + escala 0-100 + cualitativa A/D — **estándar SENA universal**, no configurable.
- `pdf-parse` con API `PDFParse` — funciona en runtime actual aunque la API sea atípica.
- Cierre de evidencias 100% manual (`cerradaAt` jamás se setea desde worker).
- IA propone, instructor decide (matching/actas).
- Cualquier interacción con UI Moodle vía POST/fetch, NO Playwright click si hay alternativa.

---

## 10. Próximos pasos sugeridos (post-25 mayo)

1. ✅ Hecho hoy: cleanup duplicados, hrefs canónicos, calcularEstado estricto, foroDescubrir end-to-end.
2. 🟢 **Vincular RAPs**: `node scripts/vincularEvidenciasRAPs.js --dry-run` → ejecutar → `RapEvidenciaRel` pasa de 0 a ~190 y las actas usan modo `per-rap` real.
3. 🟢 **UI Fase 2 (selección masiva por competencia)**: pendiente desde el 24-may. Construir `EvidenciasPage.tsx` con agrupación.
4. 🟠 Configurar remote git y push de las dos ramas pendientes (`feature/strict-rap-mapping`, `feature/gradebook-scan-v2`).
5. 🟠 Mergear `feature/strict-rap-mapping` a `main`, después `feature/gradebook-scan-v2`.
6. 🟡 Atacar al menos uno de los puntos 1-4 de la sección 9.3 antes del próximo chicharrón.
