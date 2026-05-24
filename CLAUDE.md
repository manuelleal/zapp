# CLAUDE.md — Zajuna App

> **Última actualización:** 23 mayo 2026.
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
│   └── extraerTodasLasGuias.js ← Extractor GENÉRICO de Competencias y RAPs desde cualquier PDF
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

## 7. Pendientes y Bugs Actuales (Prioridad)

**🟢 RESUELTOS RECIENTEMENTE (Scraping Robusto)**
- ~~**Skip Usuarios Suspendidos**~~: Resuelto mediante un filtro universal usando `obtenerMatriculados` como fuente de verdad.
- ~~**Moodle Web Services (Sprint 2.7) / CSV**~~: Abortado. El usuario no cuenta con Token oficial de Moodle. En su lugar, se pivotó a un **Scraping Robusto Extremo**:
  - Se utilizan las **Index Pages** (`/mod/assign/index.php`, etc.) para recolectar el 100% de evidencias sin perder ninguna por culpa del DOM colapsado.
  - Se gatilla un auto-escaneo silencioso (`POST /api/scan/auto`) al abrir el Dashboard si pasaron > 2 horas.

**🟢 RESUELTO — Bug modo per-RAP inferido en Actas (feat/extractor-guias-raps)**
- `api/src/routes/actas.js`: eliminado el bloque "Modo per-RAP fallback" de `auto-poblar` y `preview-native` que asumía erróneamente que GA{N} coincide con el sufijo del RAP (`-0N`). La inferencia fallaba en competencias transversales (ej. GA6 evaluando RAP02).
- Comportamiento correcto: si una evidencia no tiene relación explícita en `RapEvidenciaRel` o `MatchingPropuesta` (estado `'aceptado'`), el sistema usa **global-fallback** sin adivinar. El campo `modo` en la respuesta solo puede ser `"per-rap"` o `"global-fallback"` (se elimina `"per-rap-inferido"`).

**🟢 RESUELTO — Pipeline completo Guías → Competencias → RAPs → Evidencias (feat/extractor-guias-raps)**

### `scripts/extraerTodasLasGuias.js` — Paso 1: Extraer Competencias y RAPs desde PDF
Lee cualquier PDF de guía SENA. Acepta variantes de título (`Competencias:`, `Competencia(s):`, `Resultados de aprendizaje:`, `Resultados de aprendizaje a alcanzar:`). Hace `upsert` en `prisma.competencia` y `prisma.rAP`.
```powershell
node scripts/extraerTodasLasGuias.js <ruta.pdf>          # persiste en DB
node scripts/extraerTodasLasGuias.js <ruta.pdf> --dry-run # solo muestra extracción
```

### `scripts/vincularEvidenciasRAPs.js` — Paso 2: Vincular Evidencias a RAPs en DB
Busca evidencias con patrón `GA{N}-{competenciaCodigo}` en su nombre y las vincula en `RapEvidenciaRel`.
- **Competencia `240202501` (inglés):** aplica regla automática `GA{N} → RAP-0{N}` y crea registros en DB.
- **Demás competencias (transversales):** lista las evidencias sin vincular y redirige al módulo de **Matching IA** desde la UI (`Dashboard → Ficha → Evidencias → "Sugerir RAPs con IA"`).
```powershell
node scripts/vincularEvidenciasRAPs.js --dry-run                    # solo muestra
node scripts/vincularEvidenciasRAPs.js                              # vincula inglés
node scripts/vincularEvidenciasRAPs.js --competencia=240202501      # solo una competencia
node scripts/vincularEvidenciasRAPs.js --fichaId=<cuid>             # solo una ficha
```
**Flujo completo recomendado:**
1. `node scripts/extraerTodasLasGuias.js Guia_N.pdf` (por cada guía del programa)
2. `node scripts/vincularEvidenciasRAPs.js` (vincula inglés automáticamente)
3. Usar Matching IA en la interfaz para el resto de competencias.
- NO toca `scraper/seedRapsIngles.js` (sigue operativo para el flujo de inglés puro).

**🟡 MEDIA / BAJA PRIORIDAD**
- BUG: Las variables tipo `{{nombre}}` en los mensajes no se reemplazan en el envío vía Zajuna (interpolar antes de enviar).
- Bandeja de mensajes entrantes del instructor (leer conversaciones).
- Reportes Excel usando `exceljs` desde el backend.

---

## 8. Protocolo de Colaboración Multi-Agente (Antigravity + Windsurf + Claude Code)

Este repositorio está orquestado por **Antigravity (Arquitecto Principal)**. Si eres Windsurf o Claude Code leyendo esto, actúa bajo las siguientes directrices:

1. **Tu Rol:** Eres un "Developer Especializado". Tu objetivo es implementar features puntuales, refactorizar archivos específicos o maquetar UI, **sin alterar la arquitectura global** definida en este documento ni en `ARCHITECTURE.md`.
2. **Fuente de la Verdad:** Este archivo (`CLAUDE.md`) contiene el estado real del sistema. Léelo siempre antes de proponer cambios masivos.
3. **Aislamiento de Ramas:** Realiza tu trabajo en la rama que el humano te indique (ej. `feature/ui-updates` o la rama actual de trabajo).
4. **Handoff (Entrega):** Cuando termines tu tarea, dile al humano: *"He terminado. Puedes pedirle a Antigravity que revise el código, haga la integración o actualice la documentación arquitectónica"*. No intentes modificar este archivo `CLAUDE.md` a menos que se te pida explícitamente.
