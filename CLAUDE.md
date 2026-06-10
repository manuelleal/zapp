# CLAUDE.md — Zajuna App

> **Última actualización:** 9 junio 2026 (tarde) — **MATCHING IA AUTOMÁTICO funcionando**: 17 competencias mapeadas en un comando, RapEvidenciaRel 477→2147. Pruebas multi-tenant y flujo real técnico OK. Ver §14.
> _(9 jun 2026, tarde: se reemplazó el mapeo manual con Gemini por **matching IA automático** (`scripts/matchearCompetenciaIA.js` + `aiClient.js` vía OpenRouter/Kimi). Pruebas multi-tenant 36/36, flujo real técnico/tecnólogo end-to-end con creds reales, auditorías de 4 features, fix de registro (competenciaId). Ver §14.)_
> _(9 jun 2026: sesión de demo — **RapEvidenciaRel pasó de 0 a 307** (vincularEvidenciasRAPs.js ejecutado). `competenciaId` del usuario asignado a inglés (240202501). RAPs page rediseñada. Extractor PDF fix. UX fixes aplicados. Ver §13.)_
> _(2 jun 2026: refactor P0 de producción — los **5 fixes P0 de §11.3 implementados y commiteados** en rama `refactor/p0-process-split`: API/workers separados, browser Chromium compartido, bloqueo de recursos, semáforo de contexts, rate-limit real. Validado en vivo: scans reales corren por el pool nuevo. Ver §11.3 y tabla de ramas.)_
> _(1 jun 2026: auditoría de producción Opus — §11: bottleneck de proceso único, causa real del OOM, fetch ya al ~70%, triaje P0/P1/P2, infra recomendada. Scan Capa 1+2 commiteado en `58d1e2a`; Fase 2 UI aún sin commitear.)_
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
#    OJO Windows: `Get-Process node | Stop-Process` a veces NO los mata todos y
#    quedan worker-entry duplicados (duplican browsers → Moodle invalida sesión).
#    Usar taskkill y verificar que quedan 0:
taskkill /F /IM node.exe
Get-Process node -ErrorAction SilentlyContinue   # debe estar vacío

# 3. Arrancar API y workers — AHORA SON DOS PROCESOS (ver §11.1 / §11.3 P0 #1)
#    Producción: pm2 start ecosystem.config.js  (apps: api + workers)
#    Dev (dos terminales o ambos en background):
node api/src/server.js        # API HTTP en puerto 3000 (sin workers)
node api/src/worker-entry.js  # los 15 workers BullMQ (sin HTTP)

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

## 5.1 Cómo escribir y comentar el código (OBLIGATORIO para todos los agentes)

> Objetivo: que cualquiera que entre nuevo NO se pierda. Antes de dar por
> terminado un archivo, pregúntate: *"si alguien lo abre por primera vez, ¿entiende
> qué hace y por qué, sin leer otros archivos?"*. Si no, faltan comentarios.

**Estilo de código**
- Sigue el estilo del archivo que tocas (indentación, comillas, nombres). No
  reformatees código que no estás cambiando.
- Nombres descriptivos en el dominio del SENA/Moodle (`evidencia`, `ficha`, `rap`,
  `actId`/`cmid`, `entrega`). No abrevies de más.
- Funciones cortas y con una responsabilidad. La lógica de negocio compartida vive
  en UN solo lugar y se importa (ej. `FIELD_MAPS`/`extraerFecha` en
  `scraper/configEvidencias.js`); no la dupliques.
- Multi-tenant SIEMPRE: todo query filtra por `userId` (ver regla #1).

**Comentarios — el QUÉ se ve en el código, comenta el POR QUÉ**
- **Cabecera (docstring) en CADA archivo nuevo o tocado a fondo**: qué hace, qué
  cola/ruta atiende, su `job.data`/params, y los gotchas. Mira como referencia
  `scraper/configEvidenciasFetch.js`, `api/src/workers/fichasWorker.js` y la
  cabecera con índice de rutas de `api/src/routes/actas.js`.
- Comenta lo **no obvio**: decisiones, workarounds de Moodle, reglas SENA, trampas
  (ej. el `disabledIf` por JS de Moodle, el TLS de cadena incompleta de Zajuna).
- NO comentes lo trivial (`i++ // incrementa i`). Explica intención, no mecánica.
- Marca lo incierto con `// TODO(doc): confirmar` en vez de inventar. **No alucines**:
  si afirmas que existe un archivo/función/script, verifícalo con `grep`/`glob`/`git`.
- Divide archivos largos con divisores de sección
  (`// ─── Nombre de sección ───`).
- Comentarios y docstrings en español (como el resto del repo).

**Antes de cerrar una tarea**
- `node --check` a todo archivo `.js` tocado.
- Si cambiaste arquitectura o agregaste deps, actualízalo en este `CLAUDE.md` y en
  `DEVELOPER_ONBOARDING.md`.
- Working tree compartido: verifica `git branch --show-current`; no hagas
  `checkout`/`reset --hard`/`stash`/`clean` que pisen a otra sesión activa.
- Commits descriptivos con prefijo (`feat:`/`fix:`/`perf:`/`docs:`/`refactor:`).

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

## 7. Estado Actual y Pendientes (actualizado 31 mayo 2026)

---

### 🌿 Ramas activas

| Rama | Estado | Qué tiene |
|---|---|---|
| `refactor/p0-process-split` | 🔄 **Rama actual** (forkeada de gradebook-scan-v2, 2 jun) — **5 fixes P0 commiteados y validados en vivo**; falta test de carga + merge | `worker-entry.js` + `lib/browserPool.js` (browser compartido + bloqueo recursos + semáforo) + `ecosystem.config.js` (api/workers) + rate-limit real. Ver §11.3 |
| `feature/gradebook-scan-v2` | ✅ Base del refactor — scan Capa 1+2 commiteado (`58d1e2a`); Fase 2 UI aún sin commitear | Gradebook Tree + hrefs canónicos + calcularEstado estricto + foroDescubrir + **scan perf Capa 1 (DB en lote) + Capa 2 (AJAX list_participants)** + Fase 2 UI en progreso |
| `feature/strict-rap-mapping` | ✅ Lista, sin mergear | Fix actas.js (eliminado rapPorSufijo), scripts vincular/extraer |
| `fix/mensaje-template-vars` | 🔄 En progreso | Fix interpolación `{{nombre}}`/`{{ficha}}`/`{{instructor}}` en mensajes |
| `fix/actas-autopoblar-v2` | ❓ Sin revisar | Fix autopoblar actas v2 |
| `fix/skip-suspended-users` | ❓ Sin revisar | Skip de usuarios suspendidos en scraping |
| `feat/extractor-guias-raps` | ❓ Sin revisar | Extractor de guías y RAPs |
| `feat/frontend-resilience-e2e` | ❓ Sin revisar | Resiliencia frontend + tests E2E |
| `feat/scan-progress` | ❓ Sin revisar | Progreso de scan en tiempo real |
| `feature/actas-nativas-fastsync` | ❓ Sin revisar | Actas nativas con sync rápido |
| `feature/csv-and-robust-scraping` | ❓ Sin revisar | CSV parser + scraping robusto |

> **✅ Remote configurado (verificado 9-jun tarde):** `origin = https://github.com/manuelleal/zapp.git`, con ramas pusheadas. `master` se pushea normalmente. Además `master` está ADELANTE de `refactor/p0-process-split` (el refactor P0 ya vive en master).
> **⚠️ Rama default es `master`** (no `main`) — los comandos de merge del Paso 4 deben usar `master`.

---

### 🗄️ Estado de DB al 31 mayo 2026

| Tabla | Cantidad (31 may) | Notas |
|---|---|---|
| `Competencia` | 19 | Sin cambio |
| `RAP` | 75 | Sin cambio |
| `Evidencia` (global) | **2164** | Subió de 920 (25 may) — más scans/fichas. Hrefs canónicos `view.php`. |
| `Entrega` | 1383 | — |
| `Aprendiz` | 535 | ⚠️ Incluye duplicados sucios (`ACADRIAN…` vs `ADRIAN…`); el dedup heurístico de `actas.js` los limpia en memoria. |
| `RapEvidenciaRel` | **0** | 🔴 **BLOQUEANTE de actas** (ver Paso 0). Sin esto, `auto-poblar`/`preview-native` devuelven 422 a todo. |
| `MatchingPropuesta(aceptado)` | **0** | 🔴 La otra fuente del mapeo RAP→evidencia, también vacía. |
| `ActaSeguimiento` | 0 | No hay actas creadas. |

---

### ✅ FASE 1 — COMPLETADA: Captura + canonicalización de evidencias

- Scan ficha 3186683: **48 → 199 evidencias** (Gradebook Tree captura GA4–GA11 ocultas a aprendices).
- `obtenerEvidencias()` ahora emite href canónico `${BASE_URL}/mod/{tipo}/view.php?id=${actId}` independiente de lo que devuelva `a.gradeitemheader` (que a veces es `grade.php` o `report.php`).
- Cleanup completo de duplicados existentes: 81 evidencias huérfanas borradas, FKs migradas sin perder calificaciones.

---

### 🟡 FASE ACTUAL — FASE 2: UI en progreso (sin commitear, 28 mayo)

**Cambios en working tree — pendientes de commit:**

| Archivo | Cambio |
|---|---|
| `api/src/routes/scan.js` | +`GET /api/scan/progress` — devuelve contadores BullMQ de la cola evidencias |
| `api/src/workers/evidenciasWorker.js` | ⚡ Capa 1 (DB en lote: preload aprendices, `findMany` entregas, `createMany`+`$transaction`; quita nav muerta) **+ Capa 2** (bloque sesskey→resolver assignId→batch `mod_assign_list_participants`; rama assign con fallback DOM). |
| `scraper/evidencias.js` | +`obtenerSesskey`, `resolverAssignInfo`, `estadoDesdeParticipante`, `listarParticipantesBatch` (Capa 2 AJAX). |
| `prisma/schema.prisma` + migración `add_evidencia_assign_instance_id` | +`assignId Int?` / `contextId Int?` en `Evidencia` (cache del instance id para el AJAX). |
| `scripts/probe-ws-token.js`, `probe-ajax-participants.js`, `probe-capa2-flow.js` | Probes de diagnóstico (token WS, disponibilidad AJAX, cadena Capa 2). Read-only, no escriben DB. |
| `scraper/auth.js` | TIMEOUT aumentado 30 000 ms → 90 000 ms (fix timeouts de auth frecuentes) |
| `scraper/csvParser.js` | Export de `parsearCSV` que faltaba en el módulo |
| `web/src/pages/ActasPage.tsx` | +509 líneas: flujo nativo multi-paso con `PreviewNativeResult`, step de preview, modales de warning/422, navigate post-confirm |
| `web/src/pages/Dashboard.tsx` | +`ScanProgress` interface + query polleando `/api/scan/progress` (3 s activo / 15 s idle), `isScanning` flag, `selectedFichaId` filter |
| `web/src/pages/EvidenciasConfig.tsx` | +barra búsqueda por nombre/código de competencia, filtro Todas/Activas/Inactivas, collapse por guía |
| `web/tests/e2e/actas-flow.spec.ts` | Tests E2E ampliados +130 líneas para el flujo nativo |

**Estado:** Trabajo real avanzado. Falta revisar si está completo antes de commitear.

> **Nota (31 may):** las filas de **scan** (`evidenciasWorker.js`, `scraper/evidencias.js`, `prisma/schema.prisma` + migración, probes) **ya están commiteadas** en `58d1e2a` (rama `feature/gradebook-scan-v2`). El resto de la tabla (Fase 2 UI, `auth.js`, `csvParser.js`) sigue **pendiente de commit**.

---

### ⚡ ANÁLISIS DE VELOCIDAD DEL SCAN (31 mayo 2026)

> Objetivo: acelerar la carga de evidencias del primer scan y compararla con cómo lo hace la **Extensión Z** (la extensión de Chrome que usan los instructores SENA, ya documentada en `docs/MOODLE_REFERENCE.md` como ingeniería inversa de `root.PiOpq-8m.js`).

**Cómo carga evidencias el scan hoy (`api/src/workers/evidenciasWorker.js`):** todo secuencial vía DOM con Playwright. El cuello de botella es la **Fase 2**, que por **cada** evidencia activa hace un `page.goto(...&action=grading)` y raspa la tabla HTML (~2-4 s c/u), y por **cada** alumno hace 3 queries secuenciales a Postgres (`aprendiz.upsert` + `entrega.findUnique` + `create/update`). Con 50 evidencias × 30 alumnos eran ~50 navegaciones DOM seriales + ~4500 queries una-a-una.

**Cómo lo hace la Extensión Z:** NO raspa DOM por actividad. Corre dentro del navegador ya autenticado y usa los endpoints JSON de Moodle con el `sesskey` de la sesión:
`POST /lib/ajax/service.php?sesskey={k}&info=mod_assign_list_participants` → devuelve por actividad un JSON con todos los participantes (`submitted`/`requiregrading`/`isSuspended`), sin renderizar la tabla de grading. Es ~5-10× más liviano que cargar el HTML.

**Probe de token WS (Camino 1) — VEREDICTO: muerto para SENA.**
`node scripts/probe-ws-token.js` → `/login/token.php` responde **HTTP 200 pero `invalidlogin`**. Causa: el login de SENA NO es el nativo de Moodle (ver `scraper/auth.js:35-49`: entra por el portal raíz `https://zajuna.sena.edu.co` con `typeDocument`/`document`/`form_login_user`, no por `/login/index.php`). Es un **SSO/portal federado**: el usuario Moodle no tiene contraseña interna, así que `token.php` lo rechaza. **No se puede obtener token con usuario+clave.** → Hay que ir por el **Camino 2** (reusar la sesión Playwright + `sesskey` + `/lib/ajax/service.php`), que es exactamente lo que hace la Extensión Z.

**Plan en dos capas:**

- **🟢 CAPA 1 — APLICADA y COMMITEADA (`58d1e2a`, 31 may) en `evidenciasWorker.js`:**
  1. Eliminada la navegación muerta a `/course/view.php` (~2 s, su resultado no se usaba).
  2. Escrituras a DB **en lote**: se pre-cargan todos los aprendices de la ficha en 1 query (Map en memoria); los faltantes se crean con `createMany`; las entregas previas de cada evidencia se traen con 1 `findMany` (no N `findUnique`); y los create/update/historial se ejecutan con `createMany` + `$transaction`. Pasa de ~4500 queries seriales a unas decenas de round-trips. **Mismas reglas de negocio** (override CSV, umbral, `fechaScan`, `calificandoAt`, cierre manual) — sólo cambia el patrón de acceso a DB.
  - ⚠️ NO se derivaron los matriculados del CSV (idea inicial descartada): el CSV no trae `moodleUserId`, que es imprescindible para mensajes/calificación y para el filtro de suspendidos. Esa fuente la da el grade report o, mejor, el AJAX de la Capa 2.

- **🟢 CAPA 2 — APLICADA, VALIDADA EN VIVO y COMMITEADA (`58d1e2a`, 31 may):** el estado de los `assign` se lee por `mod_assign_list_participants` (AJAX JSON) en vez de raspar el DOM de `view.php?action=grading`.
  - **Toolbox confirmado contra SENA** (probe en vivo `scripts/probe-ajax-participants.js`): `mod_assign_list_participants` ✅ y `core_grades_get_enrolled_users_for_selector` ✅ están habilitadas sobre la sesión (sesskey). `mod_assign_get_assignments`, `mod_assign_get_submissions`, `mod_assign_get_grades`, `core_course_get_contents`, `gradereport_user_get_grade_items` → ❌ `servicenotavailable` (capadas). El token WS (`/login/token.php`) → ❌ `invalidlogin` (login SSO de SENA, no nativo Moodle).
  - **Resolver `cmid→assignid`:** como las WS de mapeo están capadas, se resuelve igual que la Extensión Z — leyendo `data-assignmentid`/`data-contextid` del grader HTML (`/mod/assign/view.php?id={cmid}&action=grader`) **una sola vez** y cacheando en `Evidencia.assignId`/`contextId` (migración `add_evidencia_assign_instance_id`).
  - **Flujo:** worker saca el sesskey → resuelve assignIds faltantes (concurrencia 5) → **1 POST batch** `mod_assign_list_participants` para todos los assigns activos → mapea `submitted`/`requiregrading`/`submissionstatus` a `calificado`/`pendiente`/`sin_entregar` (la nota la sigue poniendo el CSV). **Fallback a DOM** (`revisarEntregas`) intacto si falta sesskey, no se resolvió assignId, o el batch falla.
  - **Medido en vivo** (ficha 3186684, courseId 51083): resolución cmid→assignid ~385-785 ms c/u; batch de 3 assigns (147 participantes) en **1 POST = 2,7 s**. Con assignId ya cacheado, el scan recurrente queda en ~1 batch sin importar el nº de evidencias.
  - **Archivos:** `scraper/evidencias.js` (+`obtenerSesskey`, `resolverAssignInfo`, `estadoDesdeParticipante`, `listarParticipantesBatch`), `api/src/workers/evidenciasWorker.js` (bloque CAPA 2 + rama assign con fallback), `prisma/schema.prisma` + migración. Probes: `scripts/probe-ws-token.js`, `scripts/probe-ajax-participants.js`, `scripts/probe-capa2-flow.js`.

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

**🔴 Paso 0 — BLOQUEADOR CRÍTICO: actas no se pueden poblar (diagnosticado 31 may)**
- Confirmado contra DB: `RapEvidenciaRel = 0` **y** `MatchingPropuesta(aceptado) = 0`.
- En `api/src/routes/actas.js`, `auto-poblar` y `preview-native` arman el mapa RAP→evidencias **solo** desde esas dos tablas. Al estar vacías, `rapsSinEvidencias` junta TODOS los rapIds → **422 `RAP_SIN_EVIDENCIAS` siempre**. Y `const modoPerRap = true` está hardcodeado → las ramas `global-fallback` son **código muerto**.
- **Efecto:** es imposible generar/previsualizar cualquier acta. `web/src/components/MapeoAlVueloModal.tsx` (nuevo, sin trackear) es el parche a medio hacer para mapear al vuelo.
- **Fix (decidir camino):** (1) correr `vincularEvidenciasRAPs.js` para poblar `RapEvidenciaRel`; (2) terminar `MapeoAlVueloModal`; (3) reactivar un `global-fallback` razonable.
- Ver memoria `project_actas_blocker.md`. **Prioridad #1 antes de tocar nada más de actas.**

**Paso 1 — Revisar y commitear trabajo Fase 2 pendiente**
- El **scan (Capa 1+2) ya está commiteado** en `58d1e2a`. Falta el resto: `ActasPage.tsx`, `Dashboard.tsx`, `EvidenciasConfig.tsx`, `auth.js`, `csvParser.js`.
- Probar flujo en browser antes de commitear.
- `git add` selectivo (no incluir scripts debug de root).

**Paso 2 — Vincular evidencias a RAPs (resuelve el Paso 0)**
```powershell
node scripts/vincularEvidenciasRAPs.js --dry-run   # verificar primero
node scripts/vincularEvidenciasRAPs.js              # ejecutar
```
Resultado esperado: `RapEvidenciaRel` pasa de 0 a ~190 registros → los endpoints dejan de cortar con 422 y el modo per-RAP empieza a funcionar de verdad.

**Paso 3 — Revisar ramas pendientes**
Hay 8 ramas sin revisar (ver tabla de ramas). Antes de mergear, auditar cuáles están completas y cuáles están a medias.

**Paso 4 — Mergear a `master`** (no `main`)
```powershell
git checkout master
git merge feature/strict-rap-mapping
git merge feature/gradebook-scan-v2
```

**Paso 5 — Resolver extracción de guías (mod/folder o link directo)**
Ver sección "PENDIENTE: Extracción de Guías" arriba.

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
- **`RapEvidenciaRel = 0` (BLOQUEANTE, corregido el diagnóstico 31 may)**: el `global-fallback` que se mencionaba aquí **ya no existe** — `actas.js` tiene `modoPerRap = true` hardcodeado, así que con la tabla vacía los endpoints de actas devuelven **422 `RAP_SIN_EVIDENCIAS` a todo**. No es "funciona sin granularidad": es "no funciona". Correr `vincularEvidenciasRAPs.js` o terminar `MapeoAlVueloModal`. Ver Paso 0 de Próximos Pasos.

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
| **Tests backend parciales** | 🟡 Baja | Existe `api/src/lib/calificacion.test.js` y `package.json` corre `node --test`. La cobertura es mínima pero la infraestructura existe. |
| **39 scripts huérfanos en root** | 🟠 Media | `test-*.js`, `debug-*.js`, `check-*.js`, `dump-*.js`, `diag-*.js`, etc. — basura de debug que no debería vivir en raíz. `.gitignore` no los cubre (están untracked manualmente). Crecieron de 36 a 39 desde el 25-may. |
| **Boilerplate Playwright duplicado** | 🟠 Media | 15 workers repiten bloque de inicialización. Cualquier fix de auth se replica en muchos lugares. |
| **Endpoint `/health` existente** | ✅ Resuelto | Ya existe en `server.js:63-74` haciendo `SELECT 1` y `redis.ping()`. |
| **`docs/ARCHITECTURE.md` referenciado pero no existe** | ✅ Resuelto | El archivo **sí existe** (`docs/ARCHITECTURE.md`). Este ítem estaba incorrecto. |
| **`pdf-parse` con API no estándar** | 🟡 Baja | `const { PDFParse } = require("pdf-parse")` + `new PDFParse({...}).getText()` no es la API oficial del paquete. Si actualizas la versión, todo extractor de guías se rompe. Fija la versión en `package.json` o migra a la API estándar. |
| **Rate limit in-memory + bug** | ✅ Resuelto (P0 #5) | `RATE_MAX = process.env.RATE_MAX \|\| 10` — corregido en `refactor/p0-process-split`. |
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

## 10. Próximos pasos sugeridos (post-28 mayo)

1. ✅ Hecho 25-may: cleanup duplicados, hrefs canónicos, calcularEstado estricto, foroDescubrir end-to-end.
2. 🔄 **En progreso (sin commitear)**: scan/progress endpoint, auth timeout fix, Fase 2 UI (ActasPage nativa, Dashboard polling, EvidenciasConfig búsqueda/filtro).
3. 🟢 **Commitear Fase 2**: revisar que esté completo en browser → `git add` selectivo → commit.
4. 🟢 **Vincular RAPs**: `node scripts/vincularEvidenciasRAPs.js --dry-run` → ejecutar → `RapEvidenciaRel` pasa de 0 a ~190 y las actas usan modo `per-rap` real.
5. 🟠 Auditar las 8 ramas sin revisar (ver tabla §7) antes de mergear.
6. 🟠 Configurar remote git y push de ramas a origin.
7. 🟠 Mergear ramas listas a `master` (no `main`).
8. 🔴 **Implementar Refactor P0 (Bloqueador Producción)**: Ver **§11** (auditoría de producción). Separar API de workers en PM2, usar Playwright compartido + context-por-job, y bloquear recursos (OOM Fix).

---

## 11. Auditoría de producción / despliegue (1 junio 2026 — sesión Opus)

> Sesión disparada por el handoff *"Technical Debt & Production Bottlenecks"*. Tres conclusiones que reordenan ese documento:
> 1. **El cuello de botella #1 no es Playwright; es que la API y los 15 workers corren en UN solo proceso** (§11.1). Eso convierte un OOM de scraper en una caída total de la app.
> 2. **Varios "pendientes" del handoff ya estaban resueltos** en el código (ver §9.2): `/health` existe, hay infra de tests (`calificacion.test.js`), Capa 2 AJAX y cacheo de sesión en Redis ya están.
> 3. **El bloqueador real del producto sigue siendo actas** (`RapEvidenciaRel=0`, §Paso 0), NO la infraestructura. Hoy generar actas devuelve **422 a todo usuario**. Optimizar para "+100 instructores" antes de arreglar eso es prematuro.

### 11.1 — Hallazgo central: proceso único (no está en el handoff)

`api/src/server.js:96-110` hace `require()` de la API **y de los 15 workers en el mismo proceso Node**. Consecuencias:
- Un OOM de cualquier scraper **tumba también la API** — los instructores ven la app caída, no solo el scan.
- La concurrencia real de navegadores = **suma de todas las colas**. Workers que lanzan Chromium: `fichas=5 + evidencias=3 + foroRating=2 + foroDescubrir=2 + (config, leerConfig, leerConfigLote, cambiarFecha, cambiarConfig, mensajes, syncParticipantes, descubrirCompetencias)=1 c/u` → **hasta ~19-20 Chromium simultáneos en un proceso** (`matchingIa` y `emailMasivo` no lanzan browser). A 150-300 MB c/u = 3-6 GB solo de navegadores.
- Cada job hace `chromium.launch()` nuevo (**browser-por-job**), no un browser compartido con contextos. Lanzar el browser es lo caro; un context son pocos MB.
- **Cero bloqueo de recursos:** ningún worker usa `page.route`/abort. Se descargan imágenes/CSS/fuentes/media inútiles en cada navegación. Confirmado por grep.

→ **Eso es el OOM**, no "un scan grande".

### 11.2 — Q2 (fetch con cookies, −90% RAM): viable y YA al ~70% construido

- `scraper/evidencias.js:541` `listarParticipantesBatch` **ya** consulta `mod_assign_list_participants` por `fetch()` con `credentials:"include"`, en lote. **Pero corre dentro de `page.evaluate()`** → todavía dentro de Chromium (gana "JSON vs DOM", NO gana "matar Chromium").
- `api/src/lib/sessionStore.js` **ya** persiste el `storageState` (cookies) en Redis cifrado, TTL 2h.
- `api/src/lib/fetchWithRetry.js` **ya** es el helper Node (modelado en la Extensión Z) — pero **NO se importa en ningún worker** (cableado a medias).
- **Gap exacto:** sacar el `fetch` de `page.evaluate` a Node → extraer cookies del `storageState` → header `Cookie` + `fetchWithRetry`; parsear HTML con **cheerio** (falta en `package.json`). El `sesskey` se obtiene con regex (ya se hace en `resolverAssignInfo`).
- **Lo que NO se puede sacar de Chromium:** el LOGIN (portal SSO con JS de SENA, `scraper/auth.js:33-49`; por eso `token.php` da `invalidlogin`). Solución: un worker de "acuñar sesión" que solo loguea y guarda `storageState`; todo lo demás (lecturas y la mayoría de escrituras, regla #7) pasa a Node fetch.
- **Riesgo a validar ANTES de migrar:** WAF/Cloudflare con fingerprint TLS (JA3) podría bloquear un `fetch` crudo de Node donde Chromium pasaba. Probe de 1 archivo en Node con cookies vivas antes de comprometer la migración.

### 11.3 — Triaje para v1.0.0 (P0 / P1 / P2)

**✅ P0 — COMPLETADOS (rama `refactor/p0-process-split`, 2 jun 2026). 5 commits `refactor(p0):`:**
1. ✅ **API y workers en procesos distintos** — `api/src/worker-entry.js` (nuevo) carga los 15 workers; `server.js` ya no; `ecosystem.config.js` con apps `api` + `workers` (workers `instances:1` fork — 2+ duplicaría browsers → Moodle invalida sesión). Un OOM de scraper ya no tumba la API.
2. ✅ **Browser compartido + context-por-job** — `api/src/lib/browserPool.js` (nuevo): `getBrowser()` singleton long-lived con auto-relanzamiento + `acquireContext()`/`releaseContext()`. Los **11 workers** que hacían `chromium.launch()` migrados; ninguno llama `browser.close()`.
3. ✅ **Bloqueo de recursos** — `acquireContext` aborta `image/stylesheet/font/media/other`; deja pasar `document/script/xhr/fetch`. Kill-switch `BROWSER_BLOCK_RESOURCES=0`.
4. ✅ **Cap global de contexts** — semáforo `BROWSER_MAX_CONTEXTS` (default 10) en `browserPool.js`.
5. ✅ **Rate-limit real** — `auth.js`: `RATE_MAX = process.env.RATE_MAX || 10` (antes 500 hardcodeado con comentario "5").

> **Verificado:** 22/22 tests verdes; smoke del pool (1 browser, N contexts, semáforo respetado); bloqueo de recursos contra sitio real (imgs/CSS abortados, document/script pasan). **Validado en vivo:** scans reales del autoScan corrieron por el pool nuevo — login SSO ✓, export CSV ✓, Capa 2 AJAX (`mod_assign_list_participants` por fetch) ✓ con el bloqueo activo.
> **Pendiente:** test de carga 3-15 scans concurrentes con credenciales → merge a master → `pm2 start ecosystem.config.js`. Con esto el OOM se va **sin** migrar a fetch — compra tiempo para la migración (P1 #7) con calma.

**🟠 P1 — post-launch (~3-4 días):**
6. `api/src/lib/playwrightSession.js` factory (dedupe el boilerplate login/sesión de ~12 workers; aísla el riesgo "SENA cambia el selector → editar 12 archivos").
7. **Migrar la ruta de LECTURA a Node fetch** (probe WAF → evidencias → cheerio). El −90% RAM real de §11.2.
8. Rate limiter a Redis (ya hay `ioredis`).
9. `autoScan` fail-safe (re-registrar al reconectar Redis + manejo de jobs `stalled`; hoy si Redis cae al boot solo loguea, `lib/queue.js:35`).
10. Idempotencia `foroRating` (`attempts:1` o trackear `moodleUserId` ya posteados; hoy `attempts:3` → riesgo de doble calificación).

**🟡 P2 — higiene (cuando puedas):**
11. **Limpieza de basura — inventario verificado en `docs/CLEANUP_AUDIT.md`** (3 agentes Sonnet + verificación manual, 2 jun): ~7 MB de binarios/logs **tracked** a purgar con `git rm --cached` (root.*.js, vendor.*.js, server logs, ~30 probe PNGs, 7 PDFs), ~39 scripts de debug ignorados a borrar del disco, código muerto (`EvidenciasModal` 656 líneas, `fetchWithRetry`, `fichasQueueEvents`, `apiFetchWithRetry`/`configCache`), duplicación (`usePollJob`×4, `actIdFromHref`×3), y 2 worktrees clutter. ⚠️ Nota: `worker-entry.js` **ya existe** (creado en el refactor P0, 2 jun). `playwrightSession.js` sigue sin existir (factory de P1 #6, aún no escrita — no asumir que está).
12. Tests del motor (`calcularEstado`/`esAprobada`/`normalizarHref`; infra ya existe).
13. **SSE/WebSockets en vez de polling: DIFERIR.** A 100 usuarios el polling cada 3-15s es perfectamente sostenible; no es bloqueador de v1.0.0.

### 11.4 — Infra recomendada (respuesta a Q1)

- **1 VPS robusto (Hetzner CPX31/41, ~€15-25/mes)** — NO serverless, NO k8s. Costo total realista **USD 20-40/mes**.
- **Serverless (Lambda/Cloud Run):** cold start de Chromium brutal + límite de tiempo de ejecución + pelea con la restricción de **1 sesión Moodle por usuario** (afinidad de sesión dolorosa). Mal encaje.
- **k8s:** sobreingeniería para 100 usuarios; el costo operativo supera al de infra.
- **PM2:** app `api` (puede ir cluster, es HTTP stateless) + app `workers` (fork, **1 instancia**). Redis + Postgres en la misma caja con backups diarios para arrancar; Postgres gestionado (Neon/Supabase) si se quiere HA.
- El escalado horizontal real **no es más cajas, es sacar las lecturas de Chromium** (P1 #7). Un worker de lectura por fetch pesa decenas de MB.

### 11.5 — Nota estratégica (prioridad de negocio)

El handoff pregunta *"¿cómo soporto +100 instructores?"* mientras la función estrella (generar actas) devuelve **422 a todos** por `RapEvidenciaRel=0` (§Paso 0). **Secuencia recomendada:** P0 (estabilizar, ~1 día) → **desbloquear actas** → ponerlo frente a ~5 instructores reales → decidir P1 con datos de uso real. *No construir para 100 instructores hasta tener 10 contentos.*

### 11.6 — Migración a fetch+cheerio (junio 2026)

Se documenta la migración de lectura de configuración de evidencias (fechas/intentos) de Playwright a **fetch nativo de Node + cheerio** en la rama `experimento/node-fetch-modedit`:
- **Beneficios:** Chromium se reduce a usarse SOLO para el login inicial. Esto disminuye drásticamente el uso de memoria (RAM) y permite mayor concurrencia en los workers (ej. `leerConfigLoteWorker.js`), ya que la lectura de formularios se hace vía `fetch` usando la cookie de sesión SSO.
- **Nuevas Dependencias:** Se agregó `cheerio` para parsear HTML de forma ligera. También se utiliza `undici` (Agent nativo de Node) para proporcionar un dispatcher TLS relajado (`rejectUnauthorized: false`), vital para tolerar la cadena de certificados incompleta que envía Zajuna en ciertos endpoints.
- **Gotcha (REGLA CLAVE - disabledIf):** Moodle aplica una regla JavaScript que deshabilita selects de fechas (year, month, day, etc.) cuando su correspondiente checkbox `[enabled]` está apagado. Dado que Cheerio parsea HTML sin ejecutar JavaScript, puede extraer valores obsoletos ("stale") de estos campos que el DOM original oculta. Para evitar que Moodle rechace un POST silenciosamente (devolviendo HTTP 200 sin guardar), `configEvidenciasFetch.js` emula manualmente este comportamiento eliminando los sufijos de fecha si `[enabled] != "1"`. (Todo el flujo está validado con probe de paridad, ya removido).

---

## 12. Directorio `C:\zajuna-excel\` (9 junio 2026)

`C:\zajuna-excel\` **es el mismo repositorio git** (`zajuna`), un checkout independiente en la rama `feat/excel-report`. No es un proyecto separado.

**Diferencia con `C:\zajuna\`:** tiene un commit más reciente que no está mergeado a `master`:
```
21205cb feat(reporte): nuevo excel interactivo y con estilos (Z-Mejorado)
```
Ese commit contiene mejoras al reporte Excel ("Z-Mejorado") sobre los commits de Excel que sí están en `master` (`21ff1cc` y anteriores).

**También tiene** `NOTAS_PARA_CLAUDE.md` con un bug reportado sobre `EvidenciasConfig.tsx` ("cargar fechas → no sale nada") — revisar antes de mergear.

**~~Acción pendiente~~ RESUELTO (auditoría 9-jun tarde):** el commit `21205cb` ("Z-Mejorado") está **DETRÁS** de master, no adelante — `git diff` confirma que master ya contiene y supera ese Excel. **No hay nada que mergear de `zajuna-excel`** en cuanto al reporte. Lo único rescatable de ese checkout era el bug de `EvidenciasConfig.tsx` ("cargar fechas no sale nada"), ya corregido en master (commit `d6d64a4`).

> ⚠️ `docs/CLEANUP_AUDIT.md` está **OBSOLETO** (escrito antes del refactor P0, 2 jun). Dice que `api/src/worker-entry.js` "no existe" cuando en realidad ya existe. No usarlo como fuente de verdad — leer el código directamente.

---

## 13. Sesión de demo (9 junio 2026)

### 13.1 — Lo que se hizo ✅

**Bloqueador actas resuelto:**
- `User.competenciaId` estaba `null` → asignado a `240202501` (inglés) en DB
- Corrido `node scripts/vincularEvidenciasRAPs.js` → **307 registros en `RapEvidenciaRel`** (antes: 0)
- `POST /api/actas/:id/auto-poblar` probado en vivo: 51 aprendices procesados, modo `per-rap` ✅

**RAPs page rediseñada (`web/src/pages/RapsPage.tsx`):**
- Eliminados botones "Exportar JSON" / "Importar JSON" (no se usaban)
- Agregado botón "Actualizar" con toast de confirmación
- Badge con conteo de RAPs en el header
- Estado vacío mejorado (sin mencionar JSON)

**Extractor RAPs desde PDF (`scripts/extraerTodasLasGuias.js`):**
- Bug raíz: el PDF SENA usa `o` (letra O minúscula) como viñeta, NO `•` (bullet Unicode) — formato plantilla GFPI-F-135
- Regex actualizado para aceptar ambos: `•` (guías inglés) y `o` al inicio de línea (guías técnicas)
- Corte limpio en primera oración, tope 300 chars
- Validado: 10/10 RAPs desde PDF real, 3/3 desde texto simulado

**UX fixes (`ActasPage.tsx`, `RapsPage.tsx`):**
- Modal título: "Nueva Acta de Seguimiento — Flujo Nativo" → "Nueva Acta de Seguimiento"
- Botón "Vista Previa" duplicado en modal → eliminado del cuerpo, queda solo en footer
- Banner amarillo cuando `noParticiparon === poblados` o `evidenciasVinculadas === 0`: "Escanea la ficha antes de generar el acta"
- Desvincular RAP↔evidencia pide confirmación antes de ejecutar
- Build: ✅ sin errores TypeScript

### 13.2 — Estado de DB al 9 junio 2026

| Tabla | Cantidad | Notas |
|---|---|---|
| `RapEvidenciaRel` | **307** | ✅ Desbloqueado — inglés auto, resto pendiente IA |
| `ActaSeguimiento` | 1 (borrador) | Creada en prueba, ficha 3186683 |
| `Evidencia` | 2164 | Sin cambio |
| `Entrega` GA5/GA6 | 51 c/u | Escaneadas. GA1–GA4 pendientes de scan |
| `User.competenciaId` | Asignado | ddiddimmo@gmail.com → 240202501 |

### 13.3 — Pendientes inmediatos

1. **Scan de fichas activas** — GA1–GA4 de inglés tienen 0 entregas en DB. El scan completo requiere workers con sesión Moodle activa. Disparar desde Dashboard → "Escanear" con sesión válida.
2. **Matching IA para otras competencias** — `RapEvidenciaRel` solo tiene inglés (307). El resto de competencias (37 en DB) necesitan matching. Integración con **Kimi API** (créditos disponibles) es el siguiente paso — reemplaza/complementa el módulo de Matching IA existente.
3. **Simular instructores multi-tenant** — crear usuarios de prueba con competencias distintas para validar aislamiento multitenant antes del demo.
4. **Smoke test completo en browser** — correr `/verify` con sesión activa después del scan.
5. **Merge `feat/excel-report`** — commit `21205cb` ("Z-Mejorado") en `C:\zajuna-excel\` pendiente de review y merge a `master`.

### 13.4 — Integración Kimi API (pendiente)

El usuario tiene acceso a créditos gratuitos de **Kimi** (Moonshot AI). Uso prioritario:

| Caso de uso | Impacto | Notas |
|---|---|---|
| **Matching RAP↔evidencia** para competencias no-inglés | 🔴 Alto | Desbloquea actas para todos los instructores. Reemplaza el módulo IA existente (vacío) |
| **Extracción RAPs** desde PDFs con formato irregular | 🟡 Medio | Para guías que no siguen el patrón `o CODIGO:` |
| **Feedback automático** al calificar entregas | 🟡 Medio | Post-demo |

Para integrar: Kimi usa API compatible con OpenAI (`https://api.moonshot.cn/v1`). Cambiar `baseURL` en el cliente Anthropic actual o agregar cliente paralelo. Modelo recomendado: `moonshot-v1-8k`.

### 13.5 — Hallazgos de auditoría (para próxima sesión)

**Seguridad (antes de mostrar a alguien):**
- `JWT_SECRET=zajuna_jwt_secret_cambiar_en_prod` hardcodeado en `.env` — cambiar con `openssl rand -hex 32`
- `SUPERADMIN_EMAIL=ddiddimmo@gmail.com` expuesto en `.env` y `ajustes.js`

**Performance:**
- Sin `@@index` en Prisma schema — agregar `@@index([fichaId])`, `@@index([userId])` en modelos críticos
- N+1 en `GET /api/actas/:id` con 50+ participantes

**Calificaciones reales (Extensión Z vs Zajuna):**
- Zajuna tiene el estado (entregó/no entregó) via `mod_assign_list_participants` ✅
- Las notas numéricas reales vienen del grader report: `GET /grade/report/grader/index.php?id={courseId}` con selector `input[name="grade[{userid}][{itemid}]"]` — pendiente de implementar en el scan
- Por ahora: el auto-poblar muestra el banner amarillo si no hay datos recientes

---

## 14. Sesión 9 junio 2026 (tarde) — Matching IA automático + pruebas E2E

> Sesión larga. Objetivo cumplido: **el bloqueador real del producto (mapeo RAP↔evidencia para competencias no-inglés) quedó resuelto con IA automática.** Se dejó de depender del mapeo manual con Gemini.

### 14.1 — 🟢 LO GRANDE: Matching IA automático funcionando

**Problema que resolvía:** las actas solo funcionaban para inglés (1 guía = 1 RAP, fórmula). Las competencias técnicas no tenían `RapEvidenciaRel` → 422 `RAP_SIN_EVIDENCIAS`. El plan inicial (Gemini leyendo PDFs guía por guía) no escalaba ("un año haciendo acta por acta").

**Solución implementada:**
- **`api/src/lib/aiClient.js`** (nuevo) — cliente IA agnóstico de proveedor. Selección por env `AI_PROVIDER` (auto → OpenRouter si hay `OPENROUTER_API_KEY`, si no Kimi/Moonshot, si no Anthropic). Usa `fetch` directo (sin SDK nuevo). Función `chatJSON({system,user,maxTokens})`.
  - **Gotcha:** Kimi K2 vía Novita (OpenRouter) NO soporta `response_format:json_object` → devuelve 400. Por eso el JSON-mode es **opt-in** (`AI_JSON_MODE=1`); por defecto se confía en el prompt ("devuelve SOLO JSON") + `extraerJSON()` por regex.
  - Env nuevas en `.env`: `OPENROUTER_API_KEY` (ya puesta), `OPENROUTER_MODEL` (default `moonshotai/kimi-k2`).
- **`scripts/matchearCompetenciaIA.js`** (nuevo) — pone la IA a mapear sola. NO usa PDFs: usa el texto limpio ya en DB (nombre de evidencia con código `GA{n}-{comp}-AA{m}-EV{nn}` + descripción/criterios de RAP). Flujo: 1 llamada IA por competencia → deduplica evidencias por código canónico GA-AA-EV → upsert `RapEvidenciaRel` en TODAS las filas de ese código. Uso: `node scripts/matchearCompetenciaIA.js <comp|--todas> [--dry-run]`.
- **`scripts/importarMapeoRaps.js`** (nuevo) — alternativa: importa un `.md` curado por IA externa (formato de `raps.md`, tabla evidencia→RAP + criterios). Útil para mapeos puntuales de alta calidad. Se usó con `raps.md` (Guía 01).

**Resultado del run `--todas`:** **17 competencias mapeadas automáticamente**, casi todas confianza alta. **`RapEvidenciaRel`: 477 → 2147.** Criterios: 0 → 5 (del import de raps.md).

**Pendientes del matching:**
- ~20 competencias tienen evidencias pero su `Competencia`/`RAP` **no existe en DB** → extraer sus guías primero (`extraerTodasLasGuias.js`) y re-correr el comando.
- `240201528` dio 0 vínculos (mismatch de formato de código) — caso puntual a revisar.
- **Deduplicar evidencias**: cada código tiene ~10 filas `Evidencia` por scans repetidos (ver 14.4). El matching linkea todas; conviene dedup antes de generar actas en serio.
- Revisar las de confianza media (220201501, 220501095, 220501097 tuvieron algunas).

### 14.2 — Pruebas E2E con datos reales (todas verdes)

- **`scripts/test-multitenant.js`** — 36/36 ✅, 0 fugas de aislamiento. 2 instructores de prueba (`instructor1/2.test@zajuna.local` / `Test1234!`) conservados en DB para browser. Cleanup: `--cleanup`.
- **`scripts/setup-instructor-real.js`** + **`driver-descubrir-fichas.js`** + **`driver-escanear-evidencias.js`** + **`driver-acta-real.js`** — probaron el flujo REAL como "otro instructor" reusando las credenciales Zajuna del superadmin (copiadas cifradas) con competencia técnica. Instructor `instructor.real.test@zajuna.local` / `Test1234!`.
  - Scan real: tecnólogo ADSI (course 51083) 199 evidencias / 19 competencias; técnico Programación de Software (course 77767) 74 evidencias, 47 aprendices con notas reales.
  - Validado: evidencias cargan ✓, filtro por activación ✓ (Fase 1 discovery / Fase 2 solo activas), acta corta limpio sin vínculos (422) y funciona con vínculos ✓.
- **`scripts/test-flujo-completo.js`** — 20/20 ✅ post-mortem del flujo completo (cargar→calificar→dashboard→actualizar→acta→reportes) con datos sembrados.

### 14.3 — Fix de registro (bug real encontrado)

`api/src/routes/auth.js`: `POST /api/auth/register` ahora **vincula `User.competenciaId`** buscando la `Competencia` por código. Antes quedaba `null` → el matching IA fallaba con "El usuario no tiene competencia asignada" (le pasó al superadmin el 9-jun). Cualquier instructor nuevo lo habría sufrido.

### 14.4 — Auditorías de 4 features (agentes)

- **Velocidad:** quedan cuellos — (1) **doble carga del grader report** (`evidenciasWorker.js:77` matriculados y `:182` notas pegan a la misma URL `perpage=5000` — quick-win <1h); (2) foros/quiz siguen 100% DOM serial; (3) lectura del scan aún en Chromium (migración fetch+cheerio a medias); (4) faltan `@@index` en Prisma. NO hay N+1 en auto-poblar (ya usa `in:`+`_count`).
- **Config de evidencias (bug "cargar fechas no sale nada"):** causa en `api/src/routes/configEvidencias.js:202-208` — el GET responde `fromCache:true` por existir `EvidenciaConfig` (que solo guarda `raw`) pero el `config` sale de **otra columna** (`Evidencia.configCache`), que puede ser null → front sin datos ni jobId → vacío sin error. **Dos caches desincronizados.** Además la vista Tabla no muestra error si el lote falla 100% (sesión SSO expirada → tabla vacía silenciosa). Fix: unificar cache + degradar a error si `leidas===0`.
- **Mensajes (estilo Extensión Z):** el envío FUNCIONA (`scraper/mensajes.js:12`, AJAX `core_message_send_instant_messages`) y la interpolación `{{nombre}}/{{ficha}}/{{instructor}}` ya está OK (`mensajeFormativoWorker.js:26`). **Hueco:** el listado de evidencias pendientes por aprendiz NO se inyecta — el dato (`dest.evidencias`) y el formateador (`construirMensaje`, `scraper/mensajes.js:87`) existen, pero el worker no los usa. **Fix (~15 líneas):** agregar token `{{evidencias}}` que expanda los pendientes por destinatario.
- **Excel:** el reporte propio (`fichas.js:188`, `GET /api/fichas/:id/reporte-excel`) **ya supera a la Extensión Z** (la Z no genera Excel, opera en vivo). El commit "Z-Mejorado" de `C:\zajuna-excel` está **DETRÁS** de master → §12 desactualizada, no hay nada que mergear del Excel. Falta solo **pulido visual** (encabezados largos, fila de resumen por evidencia) + marcar suspendidos.

### 14.5 — Operación / gotchas de la sesión

- **App "en blanco" = Vite dev (5173) caído.** Los procesos node (`server.js`, `worker-entry.js`, `vite`) se mueren si se cierra la terminal/sesión de Windows que los lanzó. Relanzar: `node api/src/server.js`, `node api/src/worker-entry.js`, `cd web && npm run dev`. El build en `:3000` siempre funciona aunque Vite esté caído.
- **Scripts de prueba/temporales creados** (no commiteados, varios en root `scripts/`): `test-multitenant.js`, `test-flujo-completo.js`, `setup-instructor-real.js`, `driver-*.js`, `importarMapeoRaps.js`, `matchearCompetenciaIA.js`, `raps.md`. Borrar usuarios/datos de prueba antes de producción.
- **Pendientes inmediatos heredados:** ~~JWT_SECRET real~~ (rotado 9-jun noche), ~~dedup de evidencias~~ (descartado: medido 0 duplicados por ficha), extraer guías de las ~20 competencias faltantes, ~~los fixes de 14.4~~ (aplicados y commiteados 9-jun noche: nota+estado en calificar `9f7956a`, config fechas `d6d64a4`, mensajes `dc1f6bc`+`57b5f39`, perf grader+índices `5f585fa`).

### 14.6 — 🔴 TAREA PARA MAÑANA (10-jun): selector de evidencias en Mensajes

**Problema (detectado por el usuario):** el auto-poblado de `{{evidencias}}` (`api/src/routes/mensajes.js`, bloque "Auto-poblar {{evidencias}} desde DB") toma TODAS las evidencias `activaParaScan` de la ficha. Pero en una ficha (grupo) dan clase VARIOS instructores — el instructor solo conoce/gestiona las evidencias de SU competencia y no debe mandarle al aprendiz pendientes de competencias ajenas.

**Cómo lo resuelve la Extensión Z (docs/MOODLE_REFERENCE.md):** la Z corre DENTRO del curso que el instructor está viendo (su competencia), así que su `{{evidencias}}` ("lista de evidencias pendientes/**desaprobadas**") siempre es del contexto elegido. Nuestra app ve la ficha completa → necesita selección explícita.

**Diseño acordado (implementar mañana):**
1. **UI:** en `web/src/pages/MensajesPage.tsx`, agregar un selector de evidencias **igual al `ExcelModal` de `web/src/pages/Fichas.tsx`** (agrupado por competencia · Guía N, la competencia del instructor primero y premarcada, checkboxes por evidencia). El front manda `evidenciaIds: string[]` en el POST `/api/mensajes/enviar-masivo`.
2. **Backend (`api/src/routes/mensajes.js`):** si llegan `evidenciaIds`, el auto-poblado de `{{evidencias}}` filtra `evidenciaId: { in: evidenciaIds }` (validando pertenencia al userId). Si NO llegan, fallback más seguro que el actual: filtrar por la competencia del usuario (`Evidencia.nombre contains user.competenciaCodigo`) en vez de todas las activas.
3. **Paridad con la Z:** incluir también las **desaprobadas** (nota <70 o cualitativa D) además de las `sin_entregar` — la Z reporta ambas listas (ver `construirMensaje()` en `scraper/mensajes.js`, que ya soporta los dos arrays). Sugerencia: checkbox "incluir desaprobadas" en la UI.
4. Tests: caso con evidenciaIds, caso fallback por competencia, y verificación multi-tenant (no se cuelan evidencias de otro userId).
