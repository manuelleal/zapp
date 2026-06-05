# Developer Onboarding — Zajuna App

> Guía para cualquier desarrollador que entre al proyecto hoy.
> Lee esto antes de tocar cualquier archivo. Tiempo estimado: 20 min.

---

## 1. Qué es el proyecto

SaaS para instructores del SENA (Colombia) que automatiza la gestión de la plataforma **Zajuna** (Moodle institucional). Un instructor puede:

- Ver sus fichas (grupos de aprendices) y sus evidencias de aprendizaje
- Configurar fechas y parámetros de entregas masivamente
- Asociar evidencias a Resultados de Aprendizaje (RAPs)
- Usar IA (Claude API) para sugerir qué RAP evalúa cada evidencia
- Generar actas de seguimiento en Word
- Enviar mensajes formativos a aprendices vía Moodle

---

## 2. Flujo de vida de un request

```
Browser (React)
    │  HTTP + JWT en header Authorization
    ▼
Fastify :3000  (api/src/server.js)
    │
    ├─ @fastify/jwt verifica el token en el hook preHandler
    │  → si falla: 401 inmediato, el handler nunca corre
    │
    ├─ Route handler valida el body (schema Fastify o checks manuales)
    │  → si falla: 400 inmediato, sin tocar la DB
    │
    ├─ Prisma query con WHERE userId = req.user.id
    │  → garantiza aislamiento multi-tenant (nunca datos cruzados)
    │
    ├─ Si la tarea es pesada (Playwright, Claude API):
    │   └─ queue.add(...)  → BullMQ encola el job
    │       └─ Worker BullMQ (proceso separado dentro del mismo node)
    │           ├─ Playwright scraping en Zajuna
    │           └─ actualiza Job.status en DB (queued → running → done/error)
    │
    └─ Response al browser
         • 200/201: datos
         • 202: { jobId } → el frontend hace polling en GET /api/jobs/:id
         • 400: validación fallida
         • 401: sin token / expirado
         • 403: recurso de otro usuario
         • 404: recurso inexistente
         • 422: regla de negocio violada (ej: apertura > entrega)
         • 500: bug real — NO debe ocurrir en producción
```

---

## 3. Mapa del tesoro — dónde está cada cosa

```
C:\zajuna\
│
├── api/src/
│   ├── server.js              ← Fastify + plugins + registro de rutas + workers
│   │
│   ├── routes/                ← CONTROLADORES HTTP (1 archivo = 1 dominio)
│   │   ├── auth.js            POST /api/auth/register|login
│   │   ├── fichas.js          GET/POST/PUT/DELETE /api/fichas
│   │   ├── evidencias.js      GET/PATCH /api/evidencias/* (scan, activar, entregas)
│   │   ├── archivar.js        PATCH /api/fichas/:id y /api/evidencias/:id|bulk (archivar/cerrar)
│   │   ├── configEvidencias.js GET/PATCH /api/evidencias/:id/config (leer/guardar config Moodle)
│   │   ├── batchConfig.js     POST /api/evidencias/batch/duedate|config (M2+M3)
│   │   ├── raps.js            GET/POST/DELETE /api/raps + import/export (M4+M5)
│   │   ├── matchingIa.js      POST /api/matching/iniciar + propuestas (M6)
│   │   ├── actas.js           CRUD /api/actas + download Word (M7)
│   │   ├── mensajes.js        POST/GET /api/mensajes (M7 mensajería)
│   │   ├── foroRating.js      PATCH /api/evidencias/:id/foro/calificar
│   │   ├── scan.js            POST /api/scan/full + GET /api/scan/status
│   │   └── jobs.js            GET /api/jobs/:id (polling de estado)
│   │
│   ├── workers/               ← WORKERS BullMQ (tareas pesadas, corren async)
│   │   ├── fichasWorker.js         Playwright: descubre fichas en Zajuna
│   │   ├── evidenciasWorker.js     Playwright: revisa entregas y estados
│   │   ├── configWorker.js         Playwright: lee/guarda config de evidencia
│   │   ├── leerConfigEvidenciaWorker.js  Playwright: lectura dedicada de config
│   │   ├── cambiarFechaWorker.js   Playwright: cambio masivo de duedate (M2)
│   │   ├── cambiarConfigWorker.js  Playwright: cambio masivo de cualquier campo (M3)
│   │   ├── foroRatingWorker.js     Playwright: califica posts de foro
│   │   ├── autoScanWorker.js       Cron: scan automático cada 3h de evidencias activas
│   │   ├── matchingIaWorker.js     Claude API: sugiere RAP por evidencia (M6)
│   │   └── mensajeFormativoWorker.js  Playwright: envía mensajes en Moodle (M7)
│   │
│   ├── lib/
│   │   ├── queue.js           Instancias BullMQ (8 colas: fichas, evidencias, config,
│   │   │                        leerConfig, cambiarFecha, cambiarConfig, matchingIa, mensajes)
│   │   ├── crypto.js          AES-256-GCM encrypt/decrypt (credenciales Zajuna por usuario)
│   │   ├── sessionStore.js    Caché Redis de sesiones Playwright activas
│   │   └── fetchWithRetry.js  HTTP helper con reintentos exponenciales
│   │
│   └── db/
│       └── client.js          Singleton PrismaClient
│
├── scraper/                   ← MÓDULOS PLAYWRIGHT reutilizables (importados por workers)
│   ├── auth.js                login(), cerrarModal(), BASE_URL
│   ├── fichas.js              descubrirFichas(page, competenciaCodigo)
│   ├── evidencias.js          obtenerEvidencias(), revisarEntregas*()
│   ├── configEvidencias.js    leerConfigEvidencia(), guardarConfigEvidencia()
│   ├── foroRating.js          calificarPostForo()
│   └── mensajes.js            enviarMensajeInterno()
│
├── prisma/
│   ├── schema.prisma          MODELO DE DATOS (ver sección 5)
│   └── migrations/            Historial de migraciones SQL (NO ignorar en git)
│
└── web/src/                   ← FRONTEND React 18 + Vite + Tailwind + shadcn/ui
    ├── App.tsx                Rutas React Router v6
    ├── pages/                 Páginas completas (Dashboard, EvidenciasConfig, RapsPage,
    │                            MatchingIaPage, ActasPage, Login)
    ├── components/            Componentes reutilizables (EvidenciasModal, AprendicesPanel,
    │                            BatchConfigModal, ConfigEvidenciaDialog + shadcn/ui)
    ├── api/                   Hooks TanStack Query (useEvidencias, useEntregas, etc.)
    ├── store/                 Zustand auth store (JWT en localStorage)
    └── lib/                   Utilidades (cn, fetch wrapper)
```

---

## 4. Modelo de datos — tablas clave

| Tabla | Propósito | Relaciones clave |
|---|---|---|
| `User` | Instructor autenticado. Guarda credenciales Zajuna cifradas | → Ficha, Job |
| `Ficha` | Grupo de aprendices en Moodle | → Evidencia, Aprendiz |
| `Evidencia` | Actividad de aprendizaje (assign/foro/quiz) | → Entrega, EvidenciaConfig, RapEvidenciaRel |
| `Aprendiz` | Estudiante de la ficha | → Entrega |
| `Entrega` | Estado de un aprendiz en una evidencia | → HistorialEstado |
| `EvidenciaConfig` | Config leída de Moodle (fechas, intentos). TTL 4h | → Evidencia |
| `ConfigChangeJob` | Auditoría de cambios masivos de config (M2+M3) | → User |
| `RAP` | Resultado de Aprendizaje. Pertenece a una Competencia | → Criterio, RapEvidenciaRel |
| `RapEvidenciaRel` | Join M↔N entre RAP y Evidencia (M4) | |
| `MatchingPropuesta` | Sugerencia de Claude API: qué RAP evalúa una evidencia (M6) | |
| `ActaSeguimiento` | Acta de reunión de seguimiento (M7) | → ActaParticipante |
| `MensajeFormativo` | Registro de mensajes enviados a aprendices (M7) | |
| `Job` | Estado de cualquier job BullMQ (queued/running/done/error) | |

**Soft deletes:** `archivedAt` (Ficha) y `cerradaAt` (Evidencia) son `DateTime?`. `null` = activo. Nunca borrar en cascada.

---

## 5. Reglas de Oro del Proyecto

### Seguridad

```
REGLA 1 — Multi-tenant obligatorio
Cada query a Prisma DEBE incluir userId = req.user.id.
Nunca confiar en un ID recibido del cliente sin cruzarlo con el usuario.

REGLA 2 — IDOR check antes de actuar
Antes de modificar cualquier recurso: findUnique() + check .userId !== req.user.id → 403.
Los helpers verificarFichaDelUsuario() y verificarActaDelUsuario() en actas.js
son el patrón de referencia.

REGLA 3 — Credenciales nunca en plano
zajunaUserEnc / zajunaPassEnc se cifran con AES-256-GCM al guardar (crypto.js).
Se descifran solo dentro del worker, justo antes de usarlas, y no se loguean.
```

### Validación de inputs

```
REGLA 4 — Validar ANTES de tocar la DB
El orden correcto es:
  1. Validar body (schema Fastify o checks manuales)
  2. Verificar ownership del recurso (IDOR check)
  3. Lógica de negocio
  4. Escritura en DB

REGLA 5 — Usar Fastify schema para validación estructural
Para rutas con body complejo, declarar schema: { body: { type: "object", ... } }
en el segundo argumento de fastify.post(). Fastify retorna 400 automáticamente.
Ver POST /api/actas como ejemplo de referencia.

REGLA 6 — Nunca pasar NaN a Prisma
parseInt/parseFloat deben validarse antes: if (isNaN(n)) return 400.
```

### Base de datos y transacciones

```
REGLA 7 — Usar prisma.$transaction para operaciones atómicas
Cuando se crean o modifican N filas que deben ser consistentes entre sí,
envolver en prisma.$transaction([...ops]).
Ejemplo: auto-poblar actas (actas.js) usa $transaction para todos los upserts
de participantes.

REGLA 8 — Evitar N+1 con findMany + in
En lugar de:
  for (const item of items) {
    await prisma.entrega.findMany({ where: { aprendizId: item.id } })
  }
Usar:
  await prisma.entrega.findMany({ where: { aprendizId: { in: items.map(i=>i.id) } } })
  // luego agrupar en memoria con Map()
```

### Workers y Event Loop

```
REGLA 9 — No bloquear el Event Loop
Las tareas de Playwright (30-90s) y Claude API van a workers BullMQ.
Los handlers HTTP retornan 202 + jobId en < 100ms.
El frontend hace polling en GET /api/jobs/:id cada 3s.
NUNCA iniciar Playwright directamente en un route handler.

REGLA 10 — Workers son stateless
Un worker recibe datos del job, abre browser, ejecuta, cierra browser, retorna.
No guardan estado en variables del módulo.
La sesión Moodle se cachea en Redis (sessionStore.js) para reutilizarla entre jobs
del mismo usuario, pero se invalida al detectar logout/expulsión.

REGLA 11 — concurrency: 1 en workers de Zajuna
Zajuna invalida sesiones paralelas del mismo usuario.
Todos los workers de Playwright deben instanciarse con concurrency: 1.
```

### Frontend

```
REGLA 12 — TanStack Query para estado del servidor
Usar useQuery / useMutation con invalidateQueries() para sincronizar la UI.
No usar useState para datos que vienen de la API.

REGLA 13 — JWT solo en memoria de React (Zustand store)
El token se guarda en localStorage vía el auth store (web/src/store/).
No se pasa entre componentes — cada hook de API lo lee del store directamente.
```

---

## 6. Stack de desarrollo local

```powershell
# Requisitos previos: Node 20+, Docker Desktop

# 1. Levantar Postgres 16 + Redis 7
docker-compose up -d

# 2. Variables de entorno (copiar y rellenar)
cp .env.example .env

# 3. Aplicar migraciones (solo primera vez)
npx prisma migrate deploy

# 4. Explorar DB
npx prisma studio        # abre en http://localhost:5555

# 5. Arrancar backend (puerto 3000, sirve web/dist en /)
node api/src/server.js

# 6. Dev frontend con HMR (puerto 5173, proxy → 3000)
cd web && npm run dev

# 7. Build de producción del frontend
cd web && npm run build  # genera web/dist/

# 8. Reinicio rápido del servidor (mata proceso + relanza)
bash /c/zajuna/restart.sh
```

**Nota Windows:** `npx prisma generate` puede fallar si el servidor está activo (`query_engine.dll` bloqueado). Detener el servidor primero.

---

## 7. Variables de entorno requeridas

| Variable | Descripción |
|---|---|
| `DATABASE_URL` | `postgresql://zajuna:zajuna@localhost:5432/zajuna` |
| `REDIS_URL` | `redis://localhost:6379` |
| `JWT_SECRET` | String secreto para firmar tokens JWT |
| `ENCRYPTION_KEY` | 64 chars hex (32 bytes) para AES-256-GCM |
| `ANTHROPIC_API_KEY` | API key de Anthropic para Claude (M6 Matching IA) |
| `ZAJUNA_USER` | Cédula del instructor (solo para CLI local) |
| `ZAJUNA_PASS` | Contraseña Zajuna (solo para CLI local) |

---

## 8. Módulos implementados (estado al 17 mayo 2026)

| # | Módulo | Descripción | Estado |
|---|---|---|---|
| M1 | Lectura config | Leer config actual de evidencia desde Moodle (con cache 4h) | ✅ Completo |
| M2 | Batch duedate | Cambio masivo de fecha de entrega | ✅ Completo |
| M3 | Batch config | Cambio masivo de cualquier campo de config | ✅ Completo |
| M4 | RAPs locales | CRUD de Resultados de Aprendizaje + asociación ↔ Evidencia | ✅ Completo |
| M5 | Import/Export JSON | Exportar e importar catálogo de RAPs | ✅ Completo |
| M6 | Matching IA | Claude API sugiere qué RAP evalúa cada evidencia | ✅ Completo |
| M7 | Actas | Actas de seguimiento con descarga Word + mensajes formativos | ⚠️ ~70% (UI básica) |

---

## 9. Flujo de un job BullMQ (referencia)

```
POST /api/fichas/:id/evidencias/scan
         │
         ▼
  1. Route handler:
     - Valida JWT + ownership de ficha
     - prisma.job.create({ status: "queued" })  ← crea registro en DB
     - evidenciasQueue.add("scan", { jobId, ... })  ← encola en Redis
     - return 202 { jobId }  ← responde inmediato

         │  (en paralelo, en el mismo proceso Node)
         ▼
  2. evidenciasWorker (BullMQ):
     - Recibe job de Redis
     - prisma.job.update({ status: "running" })
     - Playwright: login → navegar → extraer datos
     - prisma.evidencia.upsert(...)  ← persiste datos
     - prisma.job.update({ status: "done", resultado: {...} })

         │  (frontend haciendo polling)
         ▼
  3. GET /api/jobs/:id  ← frontend cada 3 segundos
     - prisma.job.findUnique({ where: { id: jobId, userId } })
     - Retorna { status, progreso, resultado }
     - Si status === "done" → frontend para el polling y actualiza UI
```

---

## 10. Usuarios y datos de QA

| Dato | Valor |
|---|---|
| Usuario QA | `ddiddimmo@gmail.com` |
| userId | `cmox0zru00000thac2id9m45b` |
| Ficha con datos completos | `3070432` (52 aprendices) |

**Generar JWT de prueba:**
```powershell
node -e "
require('dotenv').config();
const {createSigner} = require('fast-jwt');
const s = createSigner({ key: process.env.JWT_SECRET });
console.log(s({ id: 'cmox0zru00000thac2id9m45b', email: 'ddiddimmo@gmail.com', nombre: 'QA' }));
"
```

---

## 11. Lecturas adicionales

| Documento | Propósito |
|---|---|
| `CLAUDE.md` | Contexto rápido del proyecto, reglas de desarrollo |
| `ARCHITECTURE.md` | Diagrama de arquitectura y modelo de datos original |
| `HANDOFF.md` | Estado de sprints, prompts listos para continuar |
| `zajuna-nav.md` | Endpoints Moodle/Zajuna investigados (selectores, formularios) |
| `prisma/schema.prisma` | Fuente de verdad del modelo de datos actual |
