# HANDOFF.md — Guía operativa Zajuna App

> Documento maestro para continuar el desarrollo en chats nuevos.
> Léelo PRIMERO antes de cualquier prompt. Última actualización: mayo 2026 — Sprint 2 (config-evidencias) completo.

---

## 🎯 Estado actual del proyecto

- **Rama activa:** `feature/config-evidencias` (branch off `feature/frontend-react`)
- **HEAD:** commit 29abe11 — refactor scraper serialize-form+POST (ver git log)
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

### ✅ Sprint 2 — Configurar evidencias desde la app (commits b2d90ce, 29abe11) COMPLETO
- **`scraper/configEvidencias.js`** — `leerConfigEvidencia` + `guardarConfigEvidencia`
  - Técnica: GET form → `serializarFormulario()` (captura TODOS los campos incl. sesskey/hidden) → overlay de cambios → POST directo con `fetch` dentro del contexto del navegador
  - Igual a la Extensión Z (no usa interacciones UI frágiles)
  - Merge parcial: solo modifica los campos enviados
  - Detecta errores en la respuesta HTML de Moodle
- **Migración Prisma** `config_evidencias_audit` → tabla `ConfigAudit { userId, evidenciaId, actId, antes, despues, fecha }`
- **`api/src/lib/queue.js`** — nueva `configQueue` (BullMQ)
- **`api/src/workers/configWorker.js`** — operaciones `leer` y `guardar`, graba auditoría post-guardar
- **`api/src/routes/configEvidencias.js`** — 3 endpoints:
  - `GET  /api/evidencias/:id/config`       → job `leer`   → `{ jobId }`
  - `PATCH /api/evidencias/:id/config`      → job `guardar` → `{ jobId }`
  - `PATCH /api/evidencias/config/bulk`     → N jobs         → `{ jobIds }`
- **`web/src/components/ConfigEvidenciaDialog.tsx`** — dialog con fecha apertura/entrega/límite + intentos, carga config via polling, bulk support
- **`EvidenciasModal.tsx`** — botón ⚙ Config por fila + botón "Configurar (N)" en toolbar bulk
- **PENDIENTE smoke test real** con actId de Moodle en producción

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
