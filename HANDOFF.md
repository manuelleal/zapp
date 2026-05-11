# HANDOFF.md — Guía operativa Zajuna App

> Documento maestro para continuar el desarrollo en chats nuevos.
> Léelo PRIMERO antes de cualquier prompt. Última actualización: mayo 2026 — Sprint 2.5 (fixes críticos) completo.

---

## 🎯 Estado actual del proyecto

- **Rama activa:** `feature/config-evidencias` (branch off `feature/frontend-react`)
- **HEAD:** commit 2636b52 — feat(foro): calificar posts del foro desde la app (Sprint 2.5 FIX 4)
- **Stack:** Fastify 5 + Prisma 6 + Postgres + Redis + BullMQ + Playwright 1.59
- **Frontend:** React 18 + Vite 5 + Tailwind 3 + shadcn/ui en `web/` — `web/dist` servido por Fastify sin flags
- **`public/` eliminado** ✅

### ✅ Features implementados y probados
1. Auth JWT + credenciales Zajuna cifradas (AES-256-GCM)
2. Scraping de fichas (15 fichas detectadas)
3. Scraping de evidencias + entregas + `moodleId` del aprendiz
4. Dashboard con badges (Sin escanear / Al día / N pendientes)
5. Archivar/restaurar fichas (toggle "Ver archivadas")
6. Modal evidencias con cache + botón "Refrescar" + indicador "hace X"
7. Cerrar/reabrir evidencias **manualmente** (worker NUNCA toca `cerradaAt`)
8. Panel "▸ Aprendices" expandible con filtros + URL directa al grader

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
