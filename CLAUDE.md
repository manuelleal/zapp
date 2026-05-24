# CLAUDE.md — Zajuna App

> **Última actualización:** 24 mayo 2026.
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

## 7. Estado Actual y Pendientes (actualizado 24 mayo 2026)

---

### 🌿 Ramas activas

| Rama | Estado | Qué tiene |
|---|---|---|
| `feature/strict-rap-mapping` | ✅ Lista, sin mergear | Fix actas.js (eliminado rapPorSufijo), scripts vincular/extraer |
| `feature/gradebook-scan-v2` | ✅ Lista, sin mergear | Nuevo obtenerEvidencias() + autoScanWorker fix |

**Las dos ramas deben mergearse a `main` antes de continuar.**

---

### 🗄️ Estado de DB al 24 mayo 2026

| Tabla | Cantidad | Notas |
|---|---|---|
| `Competencia` | 19 | Todas las del programa extraídas hoy |
| `RAP` | 75 | GA01–GA11 completos + transversales |
| `Evidencia` (ficha 3186683) | 48 | Scan viejo — faltan 151 del nuevo worker |
| `RapEvidenciaRel` | 0 | ⚠️ Pendiente vincular |

---

### 🔴 PRÓXIMOS 3 PASOS (en orden exacto)

**Paso 1 — Mergear ramas y reiniciar servidor**
```powershell
git checkout main
git merge feature/strict-rap-mapping
git merge feature/gradebook-scan-v2
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
node api/src/server.js
```

**Paso 2 — Escanear ficha 3186683 con el nuevo worker**
Desde la UI: Dashboard → Ficha 3186683 → "Escanear" (o lanzar desde API).
Resultado esperado: 48 → **199 evidencias** en DB gracias al Gradebook Tree.
También correr el "Modo Dios → Descubrir Competencias" para actualizar el registro de las 19 en DB.

**Paso 3 — Vincular evidencias a RAPs**
```powershell
node scripts/vincularEvidenciasRAPs.js --dry-run   # verificar primero
node scripts/vincularEvidenciasRAPs.js              # ejecutar
```
Resultado esperado: `RapEvidenciaRel` pasa de 0 a ~190 registros.
Las actas pasan de `global-fallback` a modo **`per-rap`** real.

---

### ✅ Resuelto hoy (24 mayo 2026)

**1. Gradebook Tree — captura 100% de evidencias** (`feature/gradebook-scan-v2`)
- `scraper/evidencias.js`: `obtenerEvidencias()` reemplaza las 3 Index Pages por una sola URL: `/grade/edit/tree/index.php?id={courseId}`. Selector: `tr[data-grademax].item a.gradeitemheader`.
- Motivo: las actividades GA4–GA11 estaban ocultas a los aprendices y no aparecían en `/mod/assign/index.php`.
- Resultado test: ficha 3186683 pasó de **48 → 199 evidencias**, **5 → 18 competencias** detectadas.
- `autoScanWorker.js`: `full=true` ahora procesa todas las fichas activas aunque tengan 0 evidencias en DB.

**2. Extracción de Guías desde Zajuna** (`scripts/extraerGuiasDesdeZajuna.js`)
- Las guías SENA son `mod/page` (NO `mod/resource`). Cada una tiene un botón `onclick="window.open(urlPDF)"`.
- El script descubre dinámicamente todos los `mod/page` del curso, extrae el PDF via `window.open`, lo parsea con `pdf-parse` y hace upsert de Competencias y RAPs.
- Resultado: `node scripts/extraerGuiasDesdeZajuna.js 50283` → **15/15 guías OK, 19 competencias, 75 RAPs** en DB.
- Mismo mecanismo de descarga que `scraper/probes/probeGuiaRecurso.js` (ya existía para inglés GA01–GA07).
```powershell
node scripts/extraerGuiasDesdeZajuna.js 50283 --dry-run   # sin escribir en DB
node scripts/extraerGuiasDesdeZajuna.js 50283              # persiste
```

**3. Bug actas.js — eliminado rapPorSufijo** (`feature/strict-rap-mapping`)
- Eliminado el bloque que infería `GA{N} → RAP-0{N}` matemáticamente. Fallaba en competencias transversales.
- Ahora: solo `RapEvidenciaRel` + `MatchingPropuesta(aceptado)`. Sin vínculos → `global-fallback`.

**4. Modo Dios / Simulador de Competencias** (AjustesPage)
- `POST /api/ajustes/descubrir-competencias` → encola worker que lee nombres de evidencias en DB y hace upsert de Competencias.
- `POST /api/ajustes/simular-competencia` → emite nuevo JWT con `competenciaCodigo` embebido.
- `GET /api/competencias` → lista todas las competencias (solo superadmin `ddiddimmo@gmail.com`).
- UI: card "Modo Dios" en AjustesPage, visible solo para superadmin.

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
