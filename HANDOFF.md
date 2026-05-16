# HANDOFF.md — Guía operativa Zajuna App

> Documento maestro para continuar el desarrollo en chats nuevos.
> Léelo PRIMERO antes de cualquier prompt. Última actualización: **16 mayo 2026 — Plan Modular Configurador Evidencias iniciado. Módulo 1 completo, pendiente smoke test.**

---

## 🎯 Estado actual del proyecto

- **Rama activa:** `feature/config-evs-1-lectura` (branch off `master`)
- **HEAD:** commit `e469cfc` — feat(módulo-1): lectura de configuración de evidencias
- **Stack:** Fastify 5 + Prisma 6 + Postgres + Redis + BullMQ + Playwright 1.59
- **Frontend:** React 18 + Vite 5 + Tailwind 3 + shadcn/ui en `web/` — `web/dist` servido por Fastify sin flags
- **`public/` eliminado** ✅

---

## 🗺️ PLAN MODULAR — CONFIGURADOR DE EVIDENCIAS (iniciado 16 mayo 2026)

Plan de 6 módulos independientes en branches separadas. Regla: **NO empezar N+1 hasta que N pase smoke test y se haga merge a master.**

| # | Branch | Estado | Smoke test |
|---|--------|--------|------------|
| **1** | `feature/config-evs-1-lectura` | ✅ Código completo | ⏳ Pendiente usuario |
| **2** | `feature/config-evs-2-batch-duedate` | 🔲 No iniciado | — |
| **3** | `feature/config-evs-3-batch-config` | 🔲 No iniciado | — |
| **4** | `feature/config-evs-4-raps` | 🔲 No iniciado | — |
| **5** | `feature/config-evs-5-raps-io` | 🔲 No iniciado | — |
| **6** | `feature/config-evs-6-matching-ia` | 🔲 No iniciado | — |

### ✅ MÓDULO 1 — Lectura de configuración actual (commit `e469cfc`)

**Contexto:** La mayor parte del módulo ya existía en el codebase (Sprint 2 + 2.5 + 2.6). El trabajo fue agregar la tabla dedicada, los campos raw faltantes y separar correctamente la lectura de la escritura.

**Qué había antes vs. qué se construyó:**

| Componente | Estado previo | Cambio |
|---|---|---|
| `scraper/configEvidencias.js` → `leerConfigEvidencia` | ✅ Existía completo | ➕ Agrega campo `raw` con 7 campos Moodle nativos |
| `configWorker.js` | ✅ Existía (leer + guardar) | Sin cambio — sigue manejando saves |
| `GET /api/evidencias/:id/config` | ✅ Existía (solo configCache) | 🔄 Ahora verifica `EvidenciaConfig` table primero |
| `EvidenciaConfig` tabla | ❌ No existía | ✅ Nueva — migración `20260516214733` |
| `leerConfigEvidenciaWorker.js` | ❌ No existía | ✅ Nuevo worker dedicado en queue `leerConfig` |
| `leerConfigQueue` en `queue.js` | ❌ No existía | ✅ Nueva cola BullMQ |
| Botón "Ver config" por fila | Existía como "Config" (editable) | 🔄 Renombrado, abre modal `readOnly=true` |
| `ConfigEvidenciaDialog` | ✅ Existía (editable, con Save) | ➕ Prop `readOnly` — sin Guardar, inputs disabled |

**Campos raw ahora extraídos por el scraper:**
- `duedate` (fecha de entrega Moodle)
- `allowsubmissionsfromdate` (apertura de entregas)
- `cutoffdate` (fecha límite/extensión)
- `maxattempts` (intentos permitidos)
- `attemptreopenmethod` ← **nuevo**
- `submissiondrafts` ← **nuevo**
- `sendnotifications` ← **nuevo**

**Flujo GET /api/evidencias/:id/config (post-módulo 1):**
```
1. ¿EvidenciaConfig más reciente < 4h?  → 200 { config, raw, fromCache: true }
2. ¿configCache inline < 4h (legacy)?   → 200 { config, fromCache: true }
3. Sin cache o ?force=1                 → 202 { jobId } → leerConfigQueue → leerConfigEvidenciaWorker
                                                           ↓
                                            Guarda en EvidenciaConfig + actualiza configCache
```

**Archivos modificados en este módulo:**
```
prisma/schema.prisma                          ← +EvidenciaConfig model + relation
api/src/workers/leerConfigEvidenciaWorker.js  ← NUEVO
api/src/lib/queue.js                          ← +leerConfigQueue
api/src/routes/configEvidencias.js            ← GET actualizado + encolarLeerConfigJob()
api/src/server.js                             ← require leerConfigEvidenciaWorker
scraper/configEvidencias.js                   ← +raw fields en retorno de leerConfigEvidencia
web/src/components/ConfigEvidenciaDialog.tsx  ← +prop readOnly
web/src/components/EvidenciasModal.tsx        ← botón "Ver config" → readOnly: true
```

**Smoke test a realizar (usuario):**
1. `node api/src/server.js`
2. Abrir 3 fichas distintas → modal evidencias
3. Click **"Ver config"** en 3 evidencias diferentes
4. Verificar que los campos coincidan con `/course/modedit.php?update={actId}` en Zajuna manual
5. Segunda apertura del mismo modal debe ser instantánea (cache `EvidenciaConfig`)
6. `?force=1` debe forzar re-lectura desde Moodle

**⚠️ Dudas / issues abiertos:**
- Sesión concurrente si usuario dispara read + save simultáneamente (no es problema en M1, sí en M2+)
- `npx prisma generate` requiere detener servidor en Windows (DLL bloqueado) — esto es conocido

---

### 🔲 MÓDULO 2 — Cambio masivo de fecha de cierre (pendiente)

**Pre-requisito:** Módulo 1 smoke test ✅ + merge a master.

**Spec técnica:**
- **Tabla nueva:** `ConfigChangeJob { id, userId, fichaId, evidenciaIds[], campo, valorAntes, valorDespues, status, errorMsg }`
- **Worker:** `cambiarFechaWorker.js` — login → por cada cmid navega a modedit → lee form completo → modifica solo `duedate[year/month/day/hour/minute]` → submit
- **Endpoint:** `POST /api/evidencias/batch/duedate`
  - Body: `{ evidenciaIds: [], nuevaFecha: "2026-06-15T23:59" }`
- **Frontend:**
  - Checkbox por fila (ya existe) + "Configurar (N)" en bulk toolbar
  - Input `datetime-local` para la nueva fecha
  - Confirmación obligatoria antes de aplicar
  - Polling del job + progreso X/Y
  - Al terminar: resumen de éxitos/fallos por evidencia
- **Reglas:** fallo en una evidencia NO aborta el batch; audit log cada cambio con valorAntes/después

**Branch:** `feature/config-evs-2-batch-duedate`

---

### 🔲 MÓDULO 3 — Cambio masivo otras fechas y flags (pendiente)

**Pre-requisito:** Módulo 2 ✅

**Spec técnica:**
- Generalizar `cambiarFechaWorker.js` → `cambiarConfigEvidenciaWorker.js` (recibe map de campos)
- **Endpoint:** `POST /api/evidencias/batch/config`
  - Body: `{ evidenciaIds: [], cambios: { duedate?, openDate?, cutoffDate?, notify?, drafts?, maxAttempts? } }`
- Validación backend: `openDate > duedate` → rechazar antes de tocar Zajuna
- **Frontend:** modal "Configurar evidencias seleccionadas" con campos opcionales (solo aplica los llenados)

**Branch:** `feature/config-evs-3-batch-config`

---

### 🔲 MÓDULO 4 — RAPs locales (pendiente)

**Pre-requisito:** Módulo 3 ✅

**Spec técnica:**
- **Tabla nueva:** `RapEvidenciaRel { rapId, evidenciaId, createdAt }` (join table)
- **Endpoints:**
  - `POST /api/raps` — crear RAP
  - `GET /api/competencias/:id/raps`
  - `POST /api/raps/:rapId/evidencias` — asociar evidencia a RAP
  - `DELETE /api/raps/:rapId/evidencias/:evidenciaId`
- **Frontend:** pantalla "Mis RAPs" por competencia; multiselect de evidencias; tabla evidencias muestra RAP(s)

**Nota:** el modelo `RAP` ya existe en el schema con `criterios` y `feedbacks`. La tabla `RapEvidenciaRel` es nueva (actualmente `RAP` no tiene relación directa con `Evidencia`).

**Branch:** `feature/config-evs-4-raps`

---

### 🔲 MÓDULO 5 — Import/Export JSON de RAPs (pendiente)

**Pre-requisito:** Módulo 4 ✅

**Spec técnica:**
- `GET /api/competencias/:id/raps/export` → JSON `{ raps: [], relaciones: [] }`
- `POST /api/competencias/:id/raps/import` → valida y upsert
- **Frontend:** botones "Exportar JSON" / "Importar JSON" + input file + preview antes de importar

**Branch:** `feature/config-evs-5-raps-io`

---

### 🔲 MÓDULO 6 — Matching IA Evidencias ↔ RAPs (pendiente)

**Pre-requisito:** Módulo 5 ✅

**Spec técnica:**
- Instalar `@anthropic-ai/sdk`
- **Worker:** `matchingIaWorker.js` — prompt a Claude por cada evidencia: `"dado nombre+descripción evidencia, cuál RAP de esta lista evalúa? Devuelve JSON {rapId, confianza, razon}"`
- `confianza ≥ 80` → propuesta automática; `< 80` → revisión manual
- **Tabla nueva:** `MatchingPropuesta { evidenciaId, rapId, confianza, razon, estado: propuesto|aprobado|rechazado, decidedAt }`
- **Frontend:** botón "Sugerir matching con IA" → vista de revisión con [Aprobar] [Rechazar] [Editar y aprobar] → aprobadas → `RapEvidenciaRel`
- **Modelo IA a usar:** `claude-sonnet-4-6` (modelo actual del proyecto)

**Branch:** `feature/config-evs-6-matching-ia`

---

### ✅ Features implementados y probados (acumulado a 16 mayo 2026)
1. Auth JWT + credenciales Zajuna cifradas (AES-256-GCM)
2. Scraping de fichas (15 fichas detectadas)
3. Scraping de evidencias + entregas + `moodleId` del aprendiz
4. Dashboard con badges (Sin escanear / Al día / N pendientes)
5. Archivar/restaurar fichas (toggle "Ver archivadas")
6. Modal evidencias con cache + botón "Refrescar" + indicador "hace X"
7. Cerrar/reabrir evidencias **manualmente** (worker NUNCA toca `cerradaAt`)
8. Panel "▸ Aprendices" expandible con filtros + URL directa al grader
9. Configurar evidencias: leer config actual desde Moodle (Módulo 1 ✅)
10. Tabla `EvidenciaConfig` + worker dedicado `leerConfigEvidenciaWorker`
11. Modal "Ver config" read-only por fila de evidencia

### ✅ Sprint 1.1 — React setup (commit 35b7485) COMPLETO
- `web/` con Vite 5 + React 18 + TypeScript + Tailwind 3 + shadcn/ui
- Login.tsx + Dashboard.tsx con paridad completa al vanilla
- `SERVE_REACT=1` en server.js para servir `web/dist`

### ✅ Sprint 1.2 — Modal evidencias + Panel aprendices (commits b5d2831, 5dde387, 31d1a94) COMPLETO
- `web/src/components/EvidenciasModal.tsx`: Dialog shadcn, header con `tiempoRelativo`, toggle "Ver cerradas", Refrescar + pollJob, cerrar/reabrir evidencia
- `web/src/components/AprendicesPanel.tsx`: filtros client-side, lista con badges, links a Moodle
  - Nombre del aprendiz **pendiente** = link a `action=grading` (tabla de entregas, 2 pasos para calificar)
  - Botón "Calificar" a la derecha = link a `action=grader&userid=X` (calificador directo si hay sesión Moodle activa)
  - Botón "Ver entrega" para calificados/sin entregar
- `Dashboard.tsx`: "Ver evidencias" abre EvidenciasModal
- **Nota Moodle**: `action=grader&userid=X` directo solo funciona si hay sesión previa en Zajuna; sin sesión redirige al overview. El nombre-link usa `action=grading` que siempre funciona.

### ✅ Sprint 1.3 — Bulk close evidencias (commit 23ad0fb) COMPLETO
- Endpoint `PATCH /api/evidencias/bulk` en `api/src/routes/archivar.js`
- Checkbox por fila + select-all (indeterminate) en `EvidenciasModal.tsx`
- Toolbar flotante: Cancelar / Reabrir / Cerrar + Dialog de confirmación
- Smoke test pasó: CERRAR 200 `{actualizadas:2}`, REABRIR 200 `{actualizadas:2}`, 404 fake-id correcto

### ✅ Sprint 1.4 — QA + cleanup + merge (COMPLETO)
- Smoke test completo (todos los endpoints): 200 en fichas, archivar, evidencias, aprendices, bulk close/reopen, 404 bulk fake-id
- `public/` legacy eliminado
- `SERVE_REACT` flag eliminado de `server.js` — siempre sirve `web/dist`
- `feature/archivar-fichas-evidencias` ya era ancestro de `feature/frontend-react` (merge implícito)
- Docs actualizados (CLAUDE.md + HANDOFF.md)

### ✅ Sprint 2 — Configurar evidencias desde la app (commits b2d90ce, 29abe11, 0335583) COMPLETO
- **`scraper/configEvidencias.js`** — `leerConfigEvidencia` + `guardarConfigEvidencia`
  - Técnica: GET form → `serializarFormulario()` (captura TODOS los campos incl. sesskey/hidden) → overlay de cambios → POST directo con `fetch` dentro del contexto del navegador
  - Igual a la Extensión Z (no usa interacciones UI frágiles)
  - Merge parcial: solo modifica los campos enviados
- **Migración Prisma** `config_evidencias_audit` → tabla `ConfigAudit { userId, evidenciaId, actId, antes, despues, fecha }`
- **`configQueue` + `configWorker.js` + `api/src/routes/configEvidencias.js`** — 3 endpoints leer/guardar/bulk
- **`ConfigEvidenciaDialog.tsx`** en `EvidenciasModal.tsx` — botón ⚙ por fila + bulk toolbar
- **PENDIENTE smoke test real** con actId de Moodle en producción

### ✅ Sprint 2.5 — FIXES CRÍTICOS (rama `feature/config-evidencias`) COMPLETO

| # | Commit   | Cambio |
|---|----------|--------|
| 1 | `10f88df` | `revisarEntregasForo` lee `form.postratingform` (vista del foro tipo blog o iterando `discuss.php` para tipo general). Cruza con grade report para `sin_entregar`. Smoke: 52 aprendices en 5.8s (actId=3615995, courseId=51083). También `borrador`/`reabierto` → `pendiente` (opción B). |
| 2 | `6d0e535` | `Evidencia.configCache Json?` + `configCacheAt DateTime?`. `GET /api/evidencias/:id/config` devuelve 200 + `fromCache:true` si TTL<4h, sino 202 + jobId. `?force=1` salta cache. Worker persiste cache tras leer/guardar. Dialog muestra badge "Cache (<4h)" + botón "Actualizar desde Moodle". |
| 3 | `8d98505` | Helper `gaNum()` + `sortEvidencias()` en `EvidenciasModal` (useMemo). Orden: abiertas primero, luego por nº GA ASC, luego nombre. |
| 4 | `2636b52` | `scraper/foroRating.js` + `foroRatingQueue` + `foroRatingWorker.js` + `PATCH /api/evidencias/:id/foro/calificar` + input numérico por fila en `AprendicesPanel`. POST a `/rating/rate.php` con sesskey/itemid/scaleid/etc. del form serializado. |

**Smoke tests pendientes (manual):**
- FIX 2: abrir `ConfigEvidenciaDialog` 2 veces; 2ª debería traer cache instantáneo.
- FIX 3: visual con varias evidencias GA1..GA6 mezcladas.
- FIX 4: poner una nota a un post real del foro 3615995 y verificar en Moodle.

---

### ✅ Sprint 2.6 — Multi-tipo + UX + perf (rama `feature/config-evidencias`)

| # | Commit   | Cambio |
|---|----------|--------|
| D | `7a9b5a2` | `configWorker concurrency: 2 → 1`. Causa: Zajuna invalida sesiones paralelas del mismo usuario; bulk de 3+ disparaba "Formulario modedit no encontrado" porque la 2ª sesión expulsaba a la 1ª y `/course/modedit.php` redirigía al login. Mensaje de error ahora distingue redirect-a-login vs cmId inválido. |
| B | `7a9b5a2` | `scraper/configEvidencias.js`: detecta tipo por `body.classList` (`path-mod-assign|forum|quiz`) y usa `FIELD_MAPS` replicando extensión Z: **forum** `duedate→apertura, cutoffdate→entrega`; **quiz** `timeopen→apertura, timeclose→entrega`; **assign** 3 fechas + `maxattempts`. Config retornado incluye `tipo`. Dialog adaptativo oculta cutoff/intentos cuando no aplica (también en bulk mixto). |
| C | `7a9b5a2` | Validación inline `cutoff ≥ entrega ≥ apertura` antes de POST (Moodle rechaza). |
| A | `7a9b5a2` | Evidencias agrupadas por GA con headers colapsables (`groupByGA`, chevron + folder + contador), checkbox por grupo (`toggleGroupSelect`). Solución a "evidencias escondidas" en cursos largos. |
| E | `7a9b5a2` | Extraída `obtenerMatriculados(page, courseId)`. Worker la llama 1 sola vez por scan y la pasa como cache a cada `revisarEntregasForo` y `revisarEntregasQuiz`. ~5s ahorrados × N forums/quizzes. |
| F | `e6fb2ba` | `obtenerEvidencias` incluye `/mod/quiz/` (antes excluía explícitamente con regex `cuestionario|quiz`). Causa de "18/24" en inglés (6 cuestionarios faltaban). Tipo `"quiz"` despachado a `revisarEntregasQuiz` (básico: lista matriculados como `sin_entregar`; scrape real de attempts queda para Sprint 2.7). |
| G | `dab1003` | Timeout fix: `obtenerMatriculados` usa `perpage=5000` (no `0`), `domcontentloaded`, 90s. Forum view 60s. |
| — | `ff26a3c` | `setNotFoundHandler` + `sendFile("index.html")` para SPA fallback (`/dashboard` ya no 404). |

### 🔴 Bug abierto — verificar mañana tras restart completo

**Síntoma:** "Formulario modedit no encontrado" sigue saliendo al guardar config (reportado tras Sprint 2.6).

**Hipótesis ordenadas por probabilidad:**
1. **Más probable:** worker no fue reiniciado tras `7a9b5a2`. `concurrency` se lee al instanciar `new Worker(...)`. Hay que matar todos los `node.exe` y relanzar `node api/src/server.js`. Verificación: el log debería mostrar `[configWorker]` 1 sola vez por bulk en lugar de en paralelo.
2. Sesión de Zajuna del usuario expira entre el `leer` (auditoría antes) y el `guardar`. Solución: hacer leer+guardar en una sola navegación (no doble `goto modedit`).
3. cmId enviado al worker no corresponde a una actividad editable por ese usuario (permisos). Solución: log de `page.url()` después del `goto` para confirmar redirect.

**Próximos pasos para mañana:**
1. **Verificar bug**: `Get-Process node | Stop-Process -Force` → `node api/src/server.js` → reproducir bulk de 3 evidencias mismo tipo. Capturar log completo (tiene `[config] GET ...` y `[config] Formulario no visible. URL=...`).
2. **Si persiste**: refactorizar `guardarConfigEvidencia` para aceptar el form ya serializado de `leerConfigEvidencia`, eliminando el segundo `navegarFormulario`.

---

### 🚀 Sprint 2.7 propuesto — Migrar a Moodle Web Services API

**Idea validada del usuario:** la extensión Z (`root.PiOpq-8m.js`) es 50-100× más rápida porque NO usa scraping; usa Moodle WS:
- `mod_assign_get_assignments` (1 POST por curso → todas las assigns con fechas + ids)
- `mod_forum_get_forums_by_courses`
- `mod_quiz_get_quizzes_by_courses`
- `mod_assign_get_submissions` (estados de entrega masivos)
- `core_enrol_get_enrolled_users` (matriculados)

**Tiempo estimado:** scan completo de un curso pasa de **~10 min → ~5-15s**.

**Requisito previo:** obtener `wstoken` del usuario y guardarlo cifrado igual que `zajunaUserEnc`. Dos opciones:
- (a) Login UI: el usuario lo pega manualmente desde `/zajuna/user/managetoken.php`.
- (b) Scraper hace login web y luego navega a `/admin/tool/mobile/launch.php?service=moodle_mobile_app&...` para extraer el token automáticamente.

**Plan:**
1. Schema: `User.zajunaTokenEnc String?`.
2. `scraper/moodleWS.js` con helpers `wsCall(token, fn, params)`.
3. Reemplazar `obtenerEvidencias`/`revisarEntregas`/`revisarEntregasForo`/`revisarEntregasQuiz` por equivalentes WS. Mantener fallback Playwright si no hay token.
4. UI: input "Token Moodle" en perfil/setup.

**Otras mejoras pendientes (orden):**
- Scrape real de quiz attempts (`/mod/quiz/report.php?id=X&mode=overview`) para detectar quién presentó y la nota — si Sprint 2.7 se hace, viene gratis con `mod_quiz_get_user_attempts`.
- HANDOFF: actualizar prompts viejos cuando Sprint 2.7 esté.

### 🧭 UX confirmada del panel Aprendices (referencia para Sprint 2.7)

Comportamiento deseado, ya implementado parcialmente en `AprendicesPanel.tsx`:

| Click en | Estado del aprendiz | Va a |
|---|---|---|
| **Nombre** | `pendiente` (assign) | `/mod/assign/view.php?id={cmId}&action=grading` → tabla de entregas (búsqueda) |
| **Nombre** | otros estados | actualmente NO clickable → **bug menor**: extender a todos los estados |
| **Calificar** (botón verde) | `pendiente` + tiene `moodleId` | `?action=grader&userid={X}&useridlistid=0` → calificador directo |
| **Ver entrega** (azul) | `calificado` / `sin_entregar` + tiene `moodleId` | mismo `action=grader` |
| (nada) | sin `moodleId` | bug: queda sin acción |

### 🐛 Caso pendiente: aprendiz sin `moodleId`

**Síntoma:** badge "Pendiente" o "Sin entregar" sin botón Calificar/Ver entrega (visto el 12-may en datos cacheados de hace 1 día).

**Causa:** el scraper de assigns no siempre captura `moodleId` (los datos viejos pre-fix quedan con `aprendiz.moodleId = null` en BD). Confirmado en `@c:\zajuna\web\src\components\AprendicesPanel.tsx:277-291` (sin moodleId → `<span ... />` vacío).

**Workaround temporal:** Refrescar la evidencia (`prisma.aprendiz.upsert` actualiza `moodleId` si el scan nuevo lo trae — ver `@c:\zajuna\api\src\workers\evidenciasWorker.js:67-71`).

**Fix definitivo:** Sprint 2.7 con `core_enrol_get_enrolled_users` traerá `moodleId` garantizado para todo aprendiz matriculado. Mientras tanto, agregar fallback en UI: si `moodleId == null`, mostrar link al **nombre** (no botón) a `action=grading` para que el instructor busque manualmente.

**Scripts diagnóstico** (en `scripts/`, no committeados — `scripts/` está en .gitignore):
- `inspect-foro.js` — vuelca HTML de un foro real (usar para debug de selectores)
- `smoke-foro.js` — corre `revisarEntregasForo` standalone con un actId/courseId

---

### Sprint 2.5 — Notas técnicas (foro Moodle)

**Tipos de foro detectados:**
- `forumtype-blog` / `forumtype-single`: posts visibles en `/mod/forum/view.php` directamente. Los `form.postratingform` aparecen ahí.
- `forumtype-general`: la vista solo lista discussions. Hay que entrar a cada `/mod/forum/discuss.php?d=X` para ver posts + ratings.

**Form `form.postratingform` (golden form — sirve para leer Y calificar):**
```
action = /rating/rate.php
hidden fields:
  contextid, component=mod_forum, ratingarea=post,
  itemid={postId}, scaleid, rateduserid={moodleUserId},
  aggregation=3, sesskey, returnurl
control:
  <select name="rating">  (valor "-999" = "Calificar...")
```

**Estados resultantes en `revisarEntregasForo`:**
- `calificado`: `select[name=rating].value` ≠ `-999` y ≠ `""` y ≠ `-1`
- `pendiente`: el alumno publicó pero `select.value` = `-999`/`""`
- `sin_entregar`: matriculado en el curso pero no figura en ningún form de rating

---

### 🔭 Sprints anteriores (referencia rápida)

#### 1. `revisarEntregasForo` está MAL implementada → REESCRIBIR (HISTÓRICO — ya hecho en FIX 1 de 2.5)
**Rama:** `feature/config-evidencias` — archivo: `scraper/evidencias.js`

La implementación actual usa el **grade report** del curso para obtener participantes del foro. Esto está mal.

**Lo que muestra el foro real en Moodle** (confirmado en producción):
- URL: `/mod/forum/view.php?id={actId}`
- Cada estudiante publica un **tema de debate** (discussion thread) en el foro
- Cada post tiene un dropdown/input de calificación: `Calificación máxima: 80 (1)` con selector numérico
- El instructor califica directamente en esa página
- Los posts **no aparecen** si el alumno no entregó (sin_entregar)

**Implementación correcta de `revisarEntregasForo(page, actId)`:**
```
1. page.goto(`/mod/forum/view.php?id={actId}`)
2. Buscar todos los posts/discussions:
   - Autores: a[href*="/user/profile.php?id="], a[href*="/user/view.php?id="]
   - Calificación dada: input[name*="rating"], select near "Calificación máxima", o .ratinggrade
3. Estado:
   - Tiene calificación numérica → "calificado"
   - Tiene post pero sin calificación → "pendiente"
   - No aparece en la lista → "sin_entregar" (necesita cruzar con enrolled students)
4. Para obtener todos los alumnos incluyendo los que no han publicado:
   - Usar mod_assign_list_participants (NO es solo para assigns — usar core_enrol_get_enrolled_users)
   - O leer la lista del grade report solo para el listado de nombres, sin buscar columna
   - O navegar a `/grade/report/grader/index.php?id={courseId}&perpage=0` y extraer SOLO la columna de alumnos (th[scope="row"])
```

**Selectores clave del foro Moodle** (ver screenshot adjunto en commit):
```javascript
// Posts/discussions de la vista del foro
'.discussion'          // Moodle 3.x — cada fila de debate
'article.forum-post'   // Moodle 4.x
'.author a[href*="profile"]'  // Link al perfil del autor
'.rating select, .rating input[type="number"]' // Input de calificación
'.ratingnum'           // Valor numérico ya asignado
```

**IMPORTANTE**: La lista SOLO muestra quienes publicaron. Los que no han publicado no aparecen. Para obtener `sin_entregar`, se necesita cruzar con la lista de enrolled students.

#### 2. Configurar evidencias es muy lenta → OPTIMIZAR
**Problema**: Cada `GET /api/evidencias/:id/config` lanza un job BullMQ que:
  1. Inicia Playwright browser (10-15s)
  2. Login en Moodle (10-15s)
  3. Navega al modedit (5-10s)
  4. Total: ~30-45 segundos por evidencia

**Solución propuesta**: Cachear la última configuración leída en DB.
- Añadir campos a `Evidencia`: `configCache Json?` + `configCacheAt DateTime?`
- `GET /api/evidencias/:id/config`: si `configCacheAt` < 24h → devolver cache INMEDIATAMENTE (sin job)
- `PATCH /api/evidencias/:id/config`: después de guardar, actualizar el cache
- Añadir botón "Forzar re-lectura" en el dialog para invalidar cache manualmente

**Alternativa más simple**: Devolver el cache inmediatamente Y lanzar job de refresco en background. La UI muestra el cache mientras llega el nuevo valor.

#### 3. Ordenar evidencias por número de guía (GA1 → GA2 → GA3...)
**Problema**: Las evidencias se muestran ordenadas alfabéticamente. El nombre contiene el código GA1, GA2, GA3... (Guía 1, Guía 2, etc.)

**Solución**: Ordenar por el número extraído del código GA:
- Regex para extraer: `/GA(\d+)/i` del nombre de la evidencia
- Ordenar por: número GA **ascendente** (GA1 primero, GA2, GA3...) dentro de cada estado
- En el frontend (`EvidenciasModal.tsx`): aplicar sort client-side antes de renderizar
- En el backend (`GET /api/fichas/:fichaId/evidencias`): cambiar `orderBy` a ordenar por nombre considerando GA number

**Ejemplo de ordenamiento esperado:**
```
GA1-240202501-AA1-EV01 (guía 1)
GA1-240202501-AA1-EV02 (guía 1, evidencia 2)
GA2-240202501-AA2-EV01 (guía 2)
GA3-240202501-AA2-EV01 (guía 3)
GA4-240202501-AA1-EV01 (guía 4)
```

### 📂 Documentación crítica (leer en este orden)
1. `CLAUDE.md` — contexto rápido del proyecto
2. `ARCHITECTURE.md` — diseño completo y modelo de datos
3. `zajuna-nav.md` — endpoints Moodle/Zajuna investigados
4. **Este archivo (`HANDOFF.md`)** — sprints + prompts listos

---

## 🗓️ Plan de sprints (orden definitivo)

| # | Sprint | Tamaño | Modelo IA recomendado |
|---|---|---|---|
| **✅ 1.1** | Setup React+Vite+Tailwind+shadcn (paridad Login + Dashboard) | Medio (~150k tokens) | **Claude Sonnet 4.5** |
| **✅ 1.2** | Migrar Modal evidencias + Panel aprendices a React | Medio (~150k) | **Claude Sonnet 4.5** |
| **✅ 1.3** | Bulk close evidencias (selección múltiple + endpoint `/bulk`) | Pequeño (~50k) | **Claude Sonnet 4.5** o Haiku |
| **✅ 1.4** | QA + borrar `public/` legacy + merge a master | Pequeño (~30k) | **Claude Haiku 4** |
| **✅ 2** | Configurar evidencias (fechas apertura/entrega/extensión + intentos, bulk) — equivalente a la extensión Z | Grande (~300k) | Claude Sonnet 4.5 |
| **3** | Bandeja de mensajes (lectura) | Grande (~250k) | Claude Sonnet 4.5 |
| **4** | Foros (listar + drill-down) | Grande (~300k) | Claude Sonnet 4.5 |
| **5** | Anuncios masivos | Mediano (~200k) | Claude Sonnet 4.5 |

**Regla:** un chat por paso (1.1, 1.2, 1.3, 1.4) para mantener tokens bajos.

---

## 💰 Reglas para reducir tokens

### Tú (usuario)
- Prompts cortos y directos: "implementa 1.2", "smoke test", "commit"
- **No pegues archivos** — el agente los lee con `read_file`
- Cierra el chat al terminar un paso, abre uno nuevo con el prompt del siguiente
- Pide diffs, no código completo cuando revises

### Agente
- Llamadas paralelas de tools cuando son independientes
- `code_search` en vez de leer 5 archivos completos
- `multi_edit` en vez de varios `edit` sueltos
- Smoke tests inline con `node -e "..."`, no crear `.tmp.js`

---

## 🤖 Modelos por tarea

| Tarea | Modelo | Por qué |
|---|---|---|
| Arquitectura / decisiones | Claude Sonnet 4.5 o Opus 4.1 | Razonamiento profundo |
| Implementación de features | **Claude Sonnet 4.5** | Mejor balance |
| Edits puntuales, smoke tests | Claude Haiku 4 | Barato |
| Debug complejo (>3 turnos sin avanzar) | Opus 4.1 / GPT-5 / o3 | Vale los tokens |
| Auditoría codebase | Gemini 2.5 Pro | 2M context |
| QA exhaustivo | Claude Sonnet 4.5 | Investigación + reporte |

---

## 📋 Prompts listos para hoy

### 🔹 PROMPT 1 — Sprint 1.1: Setup React+Vite+Tailwind+shadcn

> **Modelo:** Claude Sonnet 4.5
> **Chat nuevo:** sí
> **Duración estimada:** 2-3 horas

```
Soy instructor del SENA. Trabajo en c:\zajuna. Lee primero HANDOFF.md, CLAUDE.md y ARCHITECTURE.md para entender el contexto.

OBJETIVO DE ESTE CHAT: Sprint 1.1 — Setup del nuevo frontend React.

PASOS A EJECUTAR
1. Crear rama nueva: git checkout -b feature/frontend-react (desde feature/archivar-fichas-evidencias)
2. Crear carpeta web/ con Vite + React 18 + TypeScript + Tailwind + shadcn/ui
3. Configurar:
   - Vite proxy a localhost:3000 para /api/*
   - Tailwind con colores SENA (verde #00A650 como --sena-green)
   - shadcn/ui: button, card, input, dialog, badge, checkbox, switch
   - React Router 6 (rutas: /login, /dashboard)
   - TanStack Query para fetch + cache
   - Zustand para auth store (jwt en localStorage, igual que ahora)
4. Implementar paridad de Login.tsx (igual que public/index.html sección login)
5. Implementar Dashboard.tsx con tabla de fichas (paridad con renderFichas):
   - Columnas: Código, Programa, Nombre, Pendientes, Acciones
   - Toggle "Ver archivadas"
   - Botones: Escanear fichas, Archivar/Restaurar
   - Badges: "Sin escanear" / "Al día" / "N pendientes"
6. NO migrar todavía el modal de evidencias (eso es Sprint 1.2)
7. Build: npm run build dentro de web/ → genera web/dist/
8. Configurar Fastify api/src/server.js para servir web/dist en lugar de public/ (con flag de entorno SERVE_REACT=1 para alternar)
9. Smoke test: levantar todo, login, ver tabla de fichas
10. Commit en la rama feature/frontend-react

REGLAS
- NO tocar el backend (api/, prisma/, scraper/) salvo el cambio mínimo en server.js
- public/ se mantiene intacto (se borra hasta el Sprint 1.4)
- Endpoints actuales (ya en CLAUDE.md) — no inventes nuevos en este sprint
- Usuario de prueba: ddiddimmo@gmail.com (id: cmox0zru00000thac2id9m45b)
- Si algo no compila, NO inventes — pregúntame

ENTREGABLES
- web/ funcional con Login + Dashboard básico
- Comando de dev documentado: cd web && npm run dev (puerto 5173 con proxy)
- Comando prod: cd web && npm run build (sirve desde Fastify)
- 1 commit limpio con mensaje "feat(frontend): setup React+Vite+Tailwind con paridad Login/Dashboard"

Empieza confirmando que viste los .md y proponiendo las dependencias exactas (versiones) antes de instalar.
```

---

### 🔹 PROMPT 2 — Sprint 1.2: Modal evidencias + Panel aprendices en React

> **Modelo:** Claude Sonnet 4.5
> **Chat nuevo:** sí (cuando termines 1.1)
> **Duración estimada:** 2-3 horas

```
Continúo trabajando en c:\zajuna, rama feature/frontend-react.
Lee HANDOFF.md y verifica que el Sprint 1.1 está completo (web/ con Login y Dashboard funcionando).

OBJETIVO DE ESTE CHAT: Sprint 1.2 — Migrar Modal de evidencias + Panel de aprendices a React.

PASOS
1. Crear componente <EvidenciasModal fichaId={...} onClose={...} />
   - Header: nombre ficha + indicador "Actualizado hace X" (igual que tiempoRelativo en app.js)
   - Botón "Refrescar" → POST /api/fichas/:id/evidencias/scan + polling /api/jobs/:id
   - Toggle "Ver cerradas"
   - Lista de evidencias con badges (Pendientes/Calificados/Sin entregar)
   - Por evidencia: botones "Aprendices" / "Zajuna" / "Cerrar"
2. Crear componente <AprendicesPanel evidenciaId={...} />
   - Toolbar con filtros: Todos / Pendientes / Calificados / Sin entregar (client-side)
   - Lista con scroll: nombre + badge estado + botón "Abrir entrega"
   - URL: https://zajuna.sena.edu.co/zajuna/mod/assign/view.php?id={actId}&rownum=0&action=grader&userid={moodleId}
3. Integrar en Dashboard: click "Ver evidencias" abre el modal
4. Usar shadcn Dialog + Badge + Button + Switch
5. TanStack Query para cache: useEvidencias(fichaId), useEntregas(evidenciaId)
6. Smoke: abrir modal de la ficha 3070432, expandir aprendices, verificar URLs
7. Commit: "feat(frontend): modal evidencias + panel aprendices en React"

REGLAS (mismas que antes)
- NO tocar backend
- NO implementar bulk close todavía (Sprint 1.3)
- Si encuentras un bug del backend → repórtalo, no lo arregles aquí
```

---

### 🔹 PROMPT 3 — Sprint 1.3: Bulk close evidencias

> **Modelo:** Claude Sonnet 4.5 (o Haiku si te queda contexto)
> **Chat nuevo:** sí
> **Duración estimada:** 1 hora

```
Continúo en c:\zajuna, rama feature/frontend-react. Lee HANDOFF.md.
Sprints 1.1 y 1.2 completos. Modal de evidencias funciona en React.

OBJETIVO: Sprint 1.3 — Selección múltiple + acciones masivas de evidencias.

BACKEND
1. Nuevo endpoint en api/src/routes/archivar.js (o crear archivar-bulk.js):
   PATCH /api/evidencias/bulk
   Body: { ids: string[], cerrada: boolean }
   - Validar que TODAS las evidencias pertenecen al user (404/403 si no)
   - prisma.evidencia.updateMany con cerradaAt = new Date() o null
   - Retornar { actualizadas: N }

FRONTEND
2. En <EvidenciasModal>:
   - Checkbox por fila + checkbox "seleccionar todo"
   - Cuando hay >0 seleccionadas → toolbar flotante: "Cerrar (N)" / "Reabrir (N)" / "Cancelar selección"
   - Confirmación antes de cerrar (Dialog: "¿Cerrar N evidencias?")
   - Después de aplicar → invalidar query useEvidencias

3. Smoke test del endpoint con node -e "..."
4. Commit: "feat: selección múltiple y acciones masivas de evidencias"
```

---

### 🔹 PROMPT 4 — Sprint 1.4: QA + cleanup + merge

> **Modelo:** Claude Haiku 4
> **Chat nuevo:** sí
> **Duración estimada:** 30-45 min

```
c:\zajuna, rama feature/frontend-react. Lee HANDOFF.md.

OBJETIVO: Cierre del Sprint 1.

1. Smoke test completo: login → fichas → archivar → modal → aprendices → bulk close
2. Borrar public/ legacy (excepto si tiene algo que necesites)
3. Quitar el flag SERVE_REACT del server.js → ahora siempre sirve web/dist
4. Actualizar CLAUDE.md y HANDOFF.md (marcar Sprint 1 como completo)
5. git merge feature/archivar-fichas-evidencias en feature/frontend-react (si hay conflicts, resolverlos)
6. Crear PR mental (commit final): "Sprint 1 completo: frontend React + bulk evidencias"
7. Reportar status final

NO empezar Sprint 2 en este chat.
```

---

### 🔴 PROMPT 5 — Sprint 2.5: Fixes críticos foros + config + ordenamiento

> **Modelo:** Claude Opus (obligatorio — lógica compleja de scraping)
> **Rama:** `feature/config-evidencias`
> **Chat nuevo:** sí

```
c:\zajuna, rama feature/config-evidencias. Lee HANDOFF.md y CLAUDE.md completos.
Lee también: scraper/evidencias.js, api/src/workers/evidenciasWorker.js,
web/src/components/EvidenciasModal.tsx, web/src/components/ConfigEvidenciaDialog.tsx

CONTEXTO CRÍTICO — lee la sección "Sprint 2.5 — FIXES CRÍTICOS" del HANDOFF antes de tocar cualquier archivo.

OBJETIVO: Corregir 3 problemas en rama feature/config-evidencias.

══════════ FIX 1 — revisarEntregasForo (CRÍTICO) ══════════
Archivo: scraper/evidencias.js
La función revisarEntregasForo() usa el grade report del curso (INCORRECTO).

Cómo funciona REALMENTE el foro en Zajuna/Moodle:
- URL: /mod/forum/view.php?id={actId}
- Cada alumno publica un "tema de debate" (discussion thread)
- Cada post muestra: autor (link a profile.php), y un input de calificación numérica
  junto al texto "Calificación máxima: X (1)"
- Solo aparecen los alumnos que publicaron. Los que NO publicaron no aparecen.

Reescribir revisarEntregasForo(page, actId, courseId) así:
1. page.goto(`${BASE_URL}/mod/forum/view.php?id=${actId}`)
2. Extraer todos los posts visibles:
   - Autor: a[href*="profile.php?id="] o a[href*="user/view.php?id="] dentro de cada post
   - moodleId: extraer id= del href del perfil
   - Calificación: buscar input o select near ".rating" o text "Calificación máxima"
   - Si tiene calificación numérica (no vacío, no "-") → "calificado"
   - Si tiene post pero sin calificación → "pendiente"
3. Para alumnos que NO publicaron → "sin_entregar":
   - Navegar a /grade/report/grader/index.php?id={courseId}&perpage=0
   - Extraer SOLO la lista de alumnos (th[scope="row"] o .userfield en tbody)
   - Los que no están en la lista del foro → sin_entregar
4. Retornar array unificado: [...publicaron, ...sinPublicar]

Selectores a probar (ajustar según HTML real con page.content() si fallan):
- Posts del foro: .forumpost, article.forum-post, div[data-post-id], tr.discussion
- Autor dentro de un post: .author a, .username a, a[href*="profile.php"]
- Rating: .rating select, .rating input, span.ratingnum, .ratinggrade

══════════ FIX 2 — Cachear config evidencia (velocidad) ══════════
Problema: leer config tarda 30-45s porque lanza Playwright cada vez.
Solución: cache en DB con TTL de 4 horas.

BACKEND:
1. Migración Prisma: agregar a Evidencia:
   configCache  Json?
   configCacheAt DateTime?

2. Endpoint GET /api/evidencias/:id/config:
   - Si configCache existe y configCacheAt > hace 4h → devolver { config: ev.configCache, fromCache: true } INMEDIATAMENTE (código 200, sin job)
   - Si cache expiró o no existe → comportamiento actual (lanzar job, devolver { jobId })

3. Worker configWorker.js operación "leer":
   - Después de leer config de Moodle → actualizar prisma.evidencia { configCache: config, configCacheAt: new Date() }

4. Worker configWorker.js operación "guardar":
   - Después de guardar exitoso → actualizar configCache con los nuevos valores

FRONTEND (ConfigEvidenciaDialog.tsx):
5. Cuando la respuesta del GET tiene { config, fromCache: true } → mostrar config INMEDIATAMENTE
   sin polling. Agregar badge "⚡ Cache (< 4h)" junto al título.
6. Cuando hay cache disponible → botón "Actualizar desde Moodle" que fuerza el job aunque haya cache.

══════════ FIX 3 — Ordenar evidencias por número GA ══════════
Los nombres de evidencias tienen el patrón: GA1-..., GA2-..., GA3-..., GA4-...
"GA1" = Guía 1, "GA4" = Guía 4.
El usuario quiere verlas ordenadas GA1 → GA2 → GA3 → GA4 (ascendente por número de guía).

FRONTEND (EvidenciasModal.tsx):
- Antes de renderizar la lista, aplicar sort:
  function gaNum(nombre: string): number {
    const m = nombre.match(/GA(\d+)/i)
    return m ? parseInt(m[1]) : 999
  }
  Ordenar: por gaNum ASC, luego nombre ASC como desempate.
- Aplicar DENTRO de cada grupo (abiertas / cerradas se mantienen separadas).

BACKEND (opcional si el sort client-side es suficiente):
- En GET /api/fichas/:fichaId/evidencias, el orderBy actual es [cerradaAt asc, nombre asc].
- Si se prefiere DB sort: reemplazar por raw SQL con REGEXP_REPLACE para extraer el número GA.
  Alternativa simple: dejar el sort en frontend.

══════════ FIX 4 — Calificar posts del foro desde la app ══════════
El foro muestra un selector numérico ("Calificación máxima: 80") por cada post de alumno.
El instructor asigna la nota directamente ahí. Implementar esto en la app:

SCRAPER — nueva función calificarPostForo(page, actId, ratings):
  ratings = [{ moodleUserId, nota }]  ← nota = número (ej: 80, 100)
  1. page.goto(`/mod/forum/view.php?id={actId}`)
  2. Serializar el formulario de ratings (puede haber un form por post o un form global)
     - Buscar: form[action*="rate.php"] o form[action*="forum"]
     - Campos: rating[{postId}], o select[name*="rating"]
  3. Para cada post que tenga un input de rating:
     - Identificar el autor (link profile → moodleId)
     - Si moodleId está en ratings[] → setear el valor
  4. Hacer POST del formulario (misma técnica serialize+POST que configEvidencias)
  5. Verificar que no hay error en la respuesta

API — nuevo endpoint:
  PATCH /api/evidencias/:id/foro/calificar
  Body: { ratings: [{ moodleUserId: string, nota: number }] }
  → lanza job → retorna { jobId }

FRONTEND — en AprendicesPanel.tsx cuando esForo:
  - Por cada fila de alumno con moodleId: mostrar input numérico (o select) con la nota actual
  - Botón "Guardar calificaciones" → PATCH bulk de todos los modificados
  - Integrar con el polling de jobs existente

NOTA: La nota puede estar limitada a valores discretos según la config del foro.
Usar el mismo <select> del HTML para restringir opciones, o un input libre.

══════════ CONTEXTO SCREENSHOT — FORO REAL ══════════
El foro en Zajuna se ve así (confirmado en producción):
- Cada alumno publica UN tema de debate (discussion thread) con el código de la evidencia en el título
  Ejemplo: "blog GA4-240202501-AA1-EV03." o "Blog GA4-240202501-AA1-EV03"
- Debajo del contenido de cada post aparece: "Calificación máxima: 80 (1)" con un <select> numérico
  donde el instructor elige la nota (80, 100, etc.)
- Hay alumnos que ya tienen calificación (el select muestra el valor) y otros sin calificar
- Al final del foro aparece un banner: "Se ha alcanzado la fecha límite para publicar"
- El botón principal es "Añadir un nuevo tema de debate"
- Los posts están en una tabla o lista; cada fila tiene: avatar, nombre del alumno (link),
  título del post, fecha, y en la parte inferior el área de rating
- Usar page.content() para ver el HTML real y ajustar selectores antes de implementar

══════════ ERROR CONOCIDO — config (NO usar selectores UI) ══════════
El enfoque ANTIGUO de configEvidencias.js usaba selectores Playwright como:
  locator('#id_allowsubmissionsfromdateenabled').check()
Esto fallaba con:
  "locator.check: Timeout 30000ms exceeded.
   waiting for locator('#id_allowsubmissionsfromdateenabled')"
Porque el checkbox no tiene ese ID en Moodle 4.x o está en una sección colapsada.

El enfoque CORRECTO (ya implementado en scraper/configEvidencias.js) es:
  GET form → serializarFormulario() → overlay → POST con fetch()
NO usar ningún locator.check(), selectOption() ni interacciones UI para el config.
Si encuentras algún locator en configEvidencias.js → ELIMINARLO y reemplazar por el enfoque POST.

══════════ REGLA DE ORO ══════════
⚠️ ANTES DE ESCRIBIR CÓDIGO: muéstrame tu plan con los selectores que vas a usar.
⚠️ Si un selector falla en runtime → muéstrame el HTML (page.content()) y propón 2-3 alternativas ANTES de implementar.
⚠️ NO hagas commits sin confirmarme que el smoke test pasó.
⚠️ Trabaja un fix a la vez, confirma antes de pasar al siguiente.

══════════ REGLAS TÉCNICAS ══════════
- Rama: feature/config-evidencias (ya existe)
- Tests: smoke test de revisarEntregasForo con un foro real (actId conocido)
- Commit por fix: 3 commits separados
- NO tocar funcionalidad de Sprint 1 o 2 que ya funciona
- Si un selector del foro no existe en el HTML real → loguear page.content() y ajustar

ENTREGABLES
- revisarEntregasForo reescrita y probada con smoke test
- Config con cache (GET < 100ms si hay cache)
- Evidencias ordenadas por GA1, GA2, GA3...
- 3 commits + HANDOFF.md actualizado
```

---

### 🔴 PROMPT 6 — Sprint 2.7: Migración a Moodle Web Services API

> **Modelo:** Claude Opus (obligatorio — diseño + auth + reescritura de 4 scrapers)
> **Rama:** `feature/moodle-ws` (crear desde `feature/config-evidencias`)
> **Chat nuevo:** sí
> **Pre-requisito:** servidor levantado (ver `START.md`)

```
c:\zajuna, branch nueva feature/moodle-ws desde feature/config-evidencias.
Lee HANDOFF.md y START.md completos antes de hacer NADA.
Lee tambien estos archivos clave:
- scraper/auth.js
- scraper/evidencias.js  (4 scrapers actuales con Playwright)
- scraper/configEvidencias.js
- api/src/workers/evidenciasWorker.js
- api/src/workers/configWorker.js
- prisma/schema.prisma  (modelos User, Aprendiz, Evidencia, Entrega)
- web/src/components/AprendicesPanel.tsx  (UX confirmada, secciones nombre/Calificar)

CONTEXTO — lee la seccion "Sprint 2.7 propuesto" + "UX confirmada del panel
Aprendices" + "Caso pendiente: aprendiz sin moodleId" del HANDOFF.

OBJETIVO: reducir el scan completo de un curso de ~10 min a ~5-15s usando
Moodle Web Services (la extension Z lo hace asi). Mantener Playwright como
fallback automatico si el usuario no tiene token configurado.

══════════ FASE 0 — Reconocimiento (NO escribir codigo aun) ══════════
1. Probar manualmente que estos endpoints de Zajuna funcionan con un token
   de prueba (yo te paso uno en chat). Endpoint base:
   https://zajuna.sena.edu.co/zajuna/webservice/rest/server.php
   Funciones a validar (formato: POST application/x-www-form-urlencoded):
   - core_webservice_get_site_info        (test rapido del token)
   - mod_assign_get_assignments(courseids[])
   - mod_forum_get_forums_by_courses(courseids[])
   - mod_quiz_get_quizzes_by_courses(courseids[])
   - mod_assign_get_submissions(assignmentids[])
   - mod_forum_get_forum_discussions(forumid)
   - mod_forum_get_discussion_posts(discussionid)
   - mod_quiz_get_user_attempts(quizid, userid)
   - core_enrol_get_enrolled_users(courseid)
   - gradereport_user_get_grade_items(courseid)

   Reportar al usuario: cuales devuelven datos utiles, cuales dan
   "accessexception" (no habilitadas para el rol instructor), tamaño
   del JSON tipico.

══════════ FASE 1 — Capa de WS ══════════
Archivo nuevo: scraper/moodleWS.js
  - exporta wsCall(token, fnName, params) que hace POST y maneja errores
    (token expirado, accessexception, throttle). Devuelve JSON parseado.
  - exporta wrappers tipados: getAssignments, getForums, getQuizzes,
    getAssignSubmissions, getForumPosts, getQuizAttempts, getEnrolled.
  - log con [ws] prefix.

══════════ FASE 2 — Token storage ══════════
1. Migracion Prisma: agregar a User -> zajunaTokenEnc String? (cifrado AES-GCM
   con el mismo helper crypto.js que zajunaUserEnc/zajunaPassEnc).
2. Endpoint PUT /api/auth/token  body { token } -> valida con
   core_webservice_get_site_info, cifra y guarda. Devuelve { ok, fullname }.
3. UI: pagina/seccion "Perfil" con input de token + boton "Validar y guardar".
   Muestra estado: "No configurado" / "Valido (usuario X)".

══════════ FASE 3 — Reemplazar scrapers ══════════
Reescribir 4 funciones manteniendo SU MISMA FIRMA y FORMATO DE SALIDA
para no romper el worker actual:

- obtenerEvidencias(page|token, competenciaCodigo, courseId)
  -> usar getAssignments + getForums + getQuizzes en paralelo (Promise.all),
     mergear, filtrar por nombre.includes(competenciaCodigo), devolver
     [{ texto, href, actId (cmid), tipo }]
  
- revisarEntregas(token, assignCmId)  (assign)
  -> getAssignSubmissions, cruzar con getEnrolled para detectar sin_entregar.
  
- revisarEntregasForo(token, forumCmId, courseId, matriculadosCache)
  -> getForumDiscussions + getForumPosts por discussion. Cruzar con
     enrolled. Devolver mismo shape que la version actual.

- revisarEntregasQuiz(token, quizCmId, courseId)
  -> getQuizAttempts por usuario (loop sobre enrolled). Estado:
     "calificado" si attempt.sumgrades != null, "pendiente" si attempt
     existe pero no calificado, "sin_entregar" si no hay attempt.

══════════ FASE 4 — Dispatch en el worker ══════════
evidenciasWorker.js:
- Si user.zajunaTokenEnc esta seteado -> usar ruta WS (sin Playwright!).
- Si no -> ruta Playwright actual (no romper retro-compat).
- El job actual de "evidencias" debe ser ~50-100x mas rapido cuando hay token.
- moodleId de cada aprendiz viene de core_enrol_get_enrolled_users:
  garantizado != null -> SOLUCIONA el bug "aprendiz sin moodleId" sin
  mas cambios.

══════════ FASE 5 — UX gap menor ══════════
En AprendicesPanel.tsx, extender el link del nombre a TODOS los estados
(no solo "pendiente" + assign). Asi click-en-nombre siempre lleva a la
tabla de busqueda. Cambio chico, ya hay if/else en linea ~231.

══════════ REGLA DE ORO ══════════
⚠️ ANTES DE FASE 1: confirmar conmigo los resultados de FASE 0 (que
   endpoints estan disponibles). Si mod_assign_get_submissions da
   accessexception para instructor -> hay que negociar alternativa.
⚠️ Mantener Playwright funcional como fallback. NUNCA borrarlo.
⚠️ 1 commit por FASE, mensajes claros.
⚠️ Smoke test al final: scan completo con token vs sin token, comparar
   tiempos y consistencia de datos.

ENTREGABLES
- scraper/moodleWS.js con 8+ helpers tipados
- Migracion + endpoint /api/auth/token + UI perfil
- 4 scrapers con nueva ruta WS + fallback Playwright
- moodleId siempre poblado (bug resuelto)
- Nombre clickable para todos los estados
- HANDOFF.md actualizado con seccion "Sprint 2.7 completo"
```

---

### 🟢 PROMPT — MÓDULO 2: Cambio masivo de fecha de cierre

> **Pre-requisito:** Módulo 1 smoke test ✅ + merge a master
> **Modelo:** Claude Sonnet 4.6
> **Branch:** `feature/config-evs-2-batch-duedate` (desde master)

```
c:\zajuna. Lee HANDOFF.md completo — sección "PLAN MODULAR" y "MÓDULO 2".
Confirma que estás en master y que EvidenciaConfig table existe antes de empezar.

OBJETIVO: Módulo 2 del Plan Modular — cambio masivo de fecha de cierre (duedate).

BACKEND
1. Migración Prisma: nueva tabla ConfigChangeJob
   { id, userId, fichaId String?, evidenciaIds Json, campo String,
     valorAntes String?, valorDespues String, status String, errorMsg String?,
     creadoAt DateTime }
2. Worker cambiarFechaWorker.js en queue "cambiarFecha" (concurrency: 1):
   - Para cada evidenciaId: login → enableEditMode → navegarFormulario →
     serializarFormulario → aplicarFecha solo en duedate[year/month/day/hour/minute]
     → POST → verificar → guardar ConfigChangeJob con antes/después
   - Si falla UNA evidencia: loguear error, continuar con la siguiente (NO abortar batch)
   - Al terminar: actualizar job.resultado con { exitosas, fallidas, detalle[] }
3. Endpoint POST /api/evidencias/batch/duedate
   Body: { evidenciaIds: string[], nuevaFecha: "2026-06-15T23:59" }
   - Validar que todas las evidencias pertenecen al usuario
   - Crear ConfigChangeJob, encolar, devolver { jobId }

FRONTEND
4. En EvidenciasModal.tsx, bulk toolbar: añadir botón "Cambiar fecha (N)"
   - Abre modal con input datetime-local
   - Confirmación obligatoria: "¿Cambiar duedate de N evidencias a [fecha]?"
   - Al confirmar: POST /api/evidencias/batch/duedate
   - Polling del job + progreso "X de Y completados"
   - Al terminar: mostrar resumen (N exitosas, M fallidas con detalle)

REGLAS
- Confirmación obligatoria antes de cualquier write a Zajuna
- Audit log: ConfigChangeJob guarda valorAntes y valorDespues por evidencia
- Fallo parcial OK: el batch sigue aunque fallen algunas

SMOKE TEST
- Seleccionar 3 evidencias de una ficha de prueba
- Cambiar fecha de cierre a 2026-12-31T23:59
- Verificar en Zajuna las 3 quedaron con la nueva fecha
- Revisar ConfigChangeJob en DB con `npx prisma studio`

Empieza confirmando la rama y que ves la tabla EvidenciaConfig en el schema.
```

---

### 🟢 PROMPT — MÓDULO 3: Cambio masivo otras fechas y flags

> **Pre-requisito:** Módulo 2 smoke test ✅ + merge a master
> **Branch:** `feature/config-evs-3-batch-config`

```
c:\zajuna. Lee HANDOFF.md sección "MÓDULO 3" del Plan Modular.
Branch nueva: feature/config-evs-3-batch-config desde master.

OBJETIVO: Generalizar el worker de Módulo 2 para soportar múltiples campos.

BACKEND
1. Renombrar / extender cambiarFechaWorker.js → cambiarConfigEvidenciaWorker.js
   - Recibe cambios: { duedate?, openDate?, cutoffDate?, notify?, drafts?, maxAttempts? }
   - Aplica solo los campos presentes (merge parcial, igual que guardarConfigEvidencia)
   - Reutilizar FIELD_MAPS de scraper/configEvidencias.js
2. Endpoint POST /api/evidencias/batch/config
   Body: { evidenciaIds: string[], cambios: { duedate?, openDate?, cutoffDate?, notify?, drafts?, maxAttempts? } }
   - Validación: si openDate > duedate → rechazar con 400 ANTES de tocar Zajuna
3. Mantener POST /api/evidencias/batch/duedate como alias (backward compat)

FRONTEND
4. Modal "Configurar evidencias seleccionadas" con campos opcionales
   - Solo aplica campos con valor, los vacíos no se modifican
   - Hint visual por campo: "Solo se aplica si tiene valor"
   - Reutilizar lógica de ConfigEvidenciaDialog donde sea posible

SMOKE TEST
- 5 evidencias, 3 cambios simultáneos (duedate + openDate + maxAttempts)
- Verificar en Zajuna
```

---

### 🟢 PROMPT — MÓDULO 4: RAPs locales

> **Pre-requisito:** Módulo 3 smoke test ✅ + merge a master
> **Branch:** `feature/config-evs-4-raps`

```
c:\zajuna. Lee HANDOFF.md sección "MÓDULO 4" del Plan Modular.
Lee también prisma/schema.prisma para entender el modelo RAP existente.
Branch nueva: feature/config-evs-4-raps desde master.

OBJETIVO: Módulo 4 — RAPs locales y su relación con evidencias.

NOTA IMPORTANTE: el modelo RAP ya existe (tiene competenciaId, codigo, descripcion,
criterios, feedbacks). Lo que falta es la relación muchos-a-muchos con Evidencia.

BACKEND
1. Migración Prisma: tabla RapEvidenciaRel { rapId, evidenciaId, createdAt }
   - Relaciones: RAP @relation y Evidencia @relation
   - @@unique([rapId, evidenciaId])
2. Endpoints:
   POST /api/raps             body { competenciaId, codigo, descripcion }
   GET  /api/competencias/:id/raps
   GET  /api/raps/:rapId                    (detalle)
   PATCH /api/raps/:rapId                   (editar)
   DELETE /api/raps/:rapId                  (borrar si no tiene evidencias)
   POST /api/raps/:rapId/evidencias          body { evidenciaId }
   DELETE /api/raps/:rapId/evidencias/:evidenciaId

FRONTEND
3. Pantalla nueva "Mis RAPs" (ruta /raps o pestaña en dashboard)
   - Lista de RAPs por competencia del usuario
   - Crear / editar / borrar RAP
   - Por RAP: multiselect de evidencias para asociar
4. En tabla de evidencias: columna/badge mostrando RAP(s) asociados

SMOKE TEST
- Crear 5 RAPs para la competencia del usuario
- Asociar evidencias
- Refrescar: persisten
```

---

### 🟢 PROMPT — MÓDULO 6: Matching IA Evidencias ↔ RAPs

> **Pre-requisito:** Módulo 5 smoke test ✅ + merge a master
> **Branch:** `feature/config-evs-6-matching-ia`

```
c:\zajuna. Lee HANDOFF.md sección "MÓDULO 6" del Plan Modular.
Branch nueva: feature/config-evs-6-matching-ia desde master.

OBJETIVO: Módulo 6 — Matching automático con Claude API.

IMPORTANTE: Usa @anthropic-ai/sdk con prompt caching donde sea posible.
Modelo recomendado: claude-sonnet-4-6 (el más reciente Sonnet disponible).

BACKEND
1. npm install @anthropic-ai/sdk
2. Worker matchingIaWorker.js en queue "matchingIa":
   - Para cada evidencia: construir prompt con nombre + descripción de la evidencia
     y lista de RAPs disponibles (con codigo + descripcion)
   - Prompt al Claude API: "Dado este nombre de evidencia: [X], ¿cuál RAP de esta lista
     evalúa mejor? Devuelve JSON { rapId, confianza: 0-100, razon: string }"
   - Usar system prompt con cache_control: ephemeral (lista de RAPs es estática)
   - confianza >= 80 → crear MatchingPropuesta con estado "propuesto"
   - confianza < 80 → estado "revision_manual"
3. Tabla MatchingPropuesta { id, evidenciaId, rapId, confianza, razon, estado, decidedAt }
4. Endpoints:
   POST /api/evidencias/batch/matching-ia  body { evidenciaIds: string[] }
   GET  /api/evidencias/matching-propuestas (las pendientes del usuario)
   PATCH /api/matching-propuestas/:id/aprobar
   PATCH /api/matching-propuestas/:id/rechazar
   → Las aprobadas crean entrada en RapEvidenciaRel

FRONTEND
5. Botón "Sugerir matching con IA" en la pantalla de RAPs
6. Vista de revisión: lista de propuestas con:
   - Evidencia | RAP sugerido | Confianza (badge color: verde≥80, amarillo<80) | Razón
   - Botones [Aprobar] [Rechazar] [Editar y aprobar]
7. Aprobar → crea RapEvidenciaRel, actualiza tabla de evidencias

SMOKE TEST
- 10 evidencias reales + 5 RAPs reales
- Las propuestas tienen sentido pedagógico
- Aprobar/rechazar funciona y persiste
```

---

## 🔄 Cómo continuar mañana / próximos chats

1. Abre chat nuevo
2. Pega el prompt del sprint correspondiente
3. **Importante:** el primer mensaje SIEMPRE debe pedirle al agente leer este `HANDOFF.md` primero
4. Al terminar el sprint, haz commit y vuelve a este archivo a marcar el progreso
5. Si te quedas atascado >3 turnos, sube de modelo (Sonnet → Opus)

---

## 📞 Datos rápidos

- **Usuario QA:** ddiddimmo@gmail.com (id `cmox0zru00000thac2id9m45b`)
- **Ficha con datos completos:** 3070432 (52 aprendices por evidencia)
- **Levantar entorno:**
  ```powershell
  docker-compose up -d
  node api/src/server.js   # sirve web/dist en puerto 3000
  # Dev frontend con HMR:
  cd web && npm run dev    # puerto 5173 con proxy a 3000
  ```
- **Build producción:** `cd web && npm run build` (genera `web/dist/`)
- **DB inspector:** `npx prisma studio`
- **Smoke test JWT:**
  ```powershell
  node -e "require('dotenv').config(); const {createSigner}=require('fast-jwt'); const sign=createSigner({key:process.env.JWT_SECRET}); console.log(sign({id:'cmox0zru00000thac2id9m45b',email:'ddiddimmo@gmail.com'}))"
  ```

---

## 🚦 Decisiones tomadas (no revertir sin discusión)

1. **Cierre de evidencias 100% manual** — el worker NUNCA toca `cerradaAt`
   - Razón: fechas viejas no implican que fue revisado
2. **Soft state con DateTime?** — `archivedAt`, `cerradaAt` son nullable, no booleanos
3. **moodleId del aprendiz se popula en cada Refrescar** — datos viejos quedan en `null` hasta el próximo scan
4. **Frontend va a React+Vite+Tailwind+shadcn** — vanilla JS no escala
5. **Una migración Prisma por feature lógico** — nombres descriptivos en snake_case
