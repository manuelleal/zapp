# Zajuna App — Arquitectura del Sistema

> Última actualización: 17 mayo 2026.
> Estado: M1-M6 Config Evidencias completos. Sprint Actas v2 en curso.

---

## Visión general

Plataforma web multitenant para instructores SENA que automatiza la gestión de Zajuna/Moodle:
scraping de evidencias, calificación asistida por IA, actas de seguimiento institucionales y
mensajería formativa a aprendices.

---

## Stack

| Capa | Tecnología |
|------|-----------|
| API | Node.js + Fastify 5 |
| Cola de tareas | BullMQ + Redis 7 |
| Base de datos | PostgreSQL 16 + Prisma 6 |
| Frontend | React 18 + Vite 5 + Tailwind 3 + shadcn/ui |
| Auth | JWT (`@fastify/jwt`) + bcrypt |
| Credenciales Zajuna | AES-256-GCM cifrado en DB (`api/src/lib/crypto.js`) |
| Scraping | Playwright 1.59 (workers BullMQ, concurrency 3) |
| IA | Claude API — `claude-haiku-4-5-20251001` (matching), Sonnet para lógica |
| Deploy objetivo | Railway (Postgres + Redis nativos) |

---

## Estructura real de carpetas

```
C:\zajuna\
├── api/src/
│   ├── server.js                        ← Fastify puerto 3000, sirve web/dist
│   ├── routes/
│   │   ├── auth.js                      ← POST /api/auth/register|login
│   │   ├── fichas.js                    ← GET/POST /api/fichas, PATCH /:id
│   │   ├── evidencias.js                ← GET /api/fichas/:id/evidencias, PATCH bulk
│   │   ├── archivar.js                  ← PATCH /api/evidencias/bulk (cerrar)
│   │   ├── configEvidencias.js          ← GET/POST /api/evidencias/:id/config
│   │   ├── batchConfig.js               ← POST /api/evidencias/batch/duedate|config
│   │   ├── foroRating.js                ← PATCH /api/evidencias/:id/foro/calificar
│   │   ├── scan.js                      ← POST /api/fichas/:id/evidencias/scan
│   │   ├── jobs.js                      ← GET /api/jobs/:id
│   │   ├── raps.js                      ← CRUD /api/raps, /api/competencias/:id/raps
│   │   ├── matchingIa.js                ← POST /api/evidencias/batch/matching-ia
│   │   ├── actas.js                     ← CRUD /api/actas, auto-poblar, Word download
│   │   ├── actasImport.js               ← POST /api/actas/import-csv/* (pausado en UI)
│   │   └── mensajes.js                  ← POST /api/mensajes (MensajeFormativo)
│   ├── workers/
│   │   ├── fichasWorker.js              ← BullMQ: descubrirFichas via Playwright
│   │   ├── evidenciasWorker.js          ← BullMQ: revisarEntregas por ficha
│   │   ├── configWorker.js              ← BullMQ: leer config Moodle (legacy)
│   │   ├── leerConfigEvidenciaWorker.js ← BullMQ: leer config con cache EvidenciaConfig
│   │   ├── cambiarFechaWorker.js        ← BullMQ: cambiar duedate bulk
│   │   ├── cambiarConfigWorker.js       ← BullMQ: cambiar config múltiple bulk
│   │   ├── foroRatingWorker.js          ← BullMQ: calificar post de foro
│   │   ├── autoScanWorker.js            ← BullMQ: scan automático programado
│   │   ├── matchingIaWorker.js          ← BullMQ: matching evidencias↔RAPs via Claude
│   │   └── mensajeFormativoWorker.js    ← BullMQ: enviar mensaje interno Zajuna
│   ├── db/client.js                     ← singleton PrismaClient
│   └── lib/
│       ├── crypto.js                    ← AES-256-GCM encrypt/decrypt
│       └── queue.js                     ← todas las colas BullMQ
│
├── scraper/
│   ├── auth.js                          ← login(), cerrarModal(), BASE_URL
│   ├── fichas.js                        ← descubrirFichas(page, competencia)
│   ├── evidencias.js                    ← revisarEntregas*, obtenerEvidencias
│   ├── configEvidencias.js              ← leerConfigEvidencia, guardarConfigEvidencia
│   ├── mensajes.js                      ← enviarMensajeInterno Zajuna Playwright
│   └── csvParser.js                     ← parsearCSVActa (sin HTTP, testeable)
│
├── web/src/
│   ├── pages/
│   │   ├── Login.tsx
│   │   ├── Dashboard.tsx                ← fichas + modal evidencias
│   │   ├── EvidenciasConfig.tsx         ← configurador bulk fechas+config
│   │   ├── RapsPage.tsx                 ← CRUD RAPs + asociar evidencias
│   │   ├── MatchingIaPage.tsx           ← revisar propuestas IA
│   │   ├── ActasPage.tsx                ← actas de seguimiento (sprint v2 en curso)
│   │   └── (futuro) MensajesPage.tsx
│   ├── components/
│   │   ├── Layout.tsx                   ← sidebar + nav
│   │   ├── EvidenciasModal.tsx          ← modal evidencias por ficha
│   │   ├── AprendicesPanel.tsx          ← tabla aprendices con filtros
│   │   ├── ConfigEvidenciaDialog.tsx    ← leer/editar config evidencia
│   │   └── BatchConfigModal.tsx         ← modal bulk config fechas
│   ├── api/client.ts                    ← apiFetch + ApiError
│   ├── store/auth.ts                    ← Zustand: jwt + user
│   └── App.tsx                          ← React Router rutas
│
├── prisma/schema.prisma                 ← 16 modelos (ver abajo)
├── docker-compose.yml                   ← postgres:16 + redis:7
└── .env                                 ← DATABASE_URL, REDIS_URL, JWT_SECRET, ENCRYPTION_KEY, ANTHROPIC_API_KEY
```

---

## Modelo de datos (schema.prisma — estado 17 mayo 2026)

```
Competencia   (id, codigo, nombre)
  └── RAP[]   (id, competenciaId, codigo, descripcion)
        └── Criterio[]
        └── RapEvidenciaRel[]   ← vínculo manual RAP↔Evidencia
        └── MatchingPropuesta[] ← propuesta IA (estado: propuesto|aceptado|rechazado)

User          (id, nombre, email, passwordHash, zajunaUserEnc, zajunaPassEnc,
               competenciaCodigo, competenciaNombre, competenciaId)
  └── Ficha[]  (id, userId, codigo, programa, courseId, nombre, archivedAt)
       └── Evidencia[]  (id, fichaId, nombre, href, tipo, cerradaAt,
                         configCache, configCacheAt, activaParaScan)
            └── Entrega[]      (id, evidenciaId, aprendizId, estado, notaActual, fechaScan)
            └── EvidenciaConfig[]   (raw Json, scannedAt)
            └── ConfigAudit[]
            └── RapEvidenciaRel[]
            └── MatchingPropuesta[]
       └── Aprendiz[]   (id, fichaId, nombre, moodleId, documento)
            └── Entrega[]
            └── ActaParticipante[]
       └── ActaSeguimiento[]
       └── MensajeFormativo[]
  └── Job[]
  └── ConfigChangeJob[]
  └── MatchingPropuesta[]
  └── ActaSeguimiento[]
  └── MensajeFormativo[]

ActaSeguimiento  (id, userId, fichaId, numero, fecha, hora, lugar, objetivo,
                  conclusiones, compromisos Json, rapIds Json, estado,
                  notas*, archivadaAt*)   ← * pendientes migración sprint v2
  └── ActaParticipante[]  (id, actaId, aprendizId, juicio,
                           rapStatus Json*, hasUngraded Boolean*)  ← * pendientes
  └── MensajeFormativo[]

MensajeFormativo  (id, userId, actaId, fichaId, canal, asunto, cuerpo,
                   destinatarios Json, estado, enviadoAt, templateTipo)
```

---

## Flujos principales

### Scraping de evidencias
```
POST /api/fichas/:id/evidencias/scan
  → Job BullMQ → evidenciasWorker
    → Playwright login → obtenerEvidencias(page, competencia)
    → por evidencia: revisarEntregas | revisarEntregasForo | revisarEntregasQuiz
    → upsert Evidencia + Entrega + Aprendiz en DB
```

### Configurar evidencia (leer + guardar)
```
GET /api/evidencias/:id/config
  → ¿EvidenciaConfig < 4h? → { config, fromCache:true }
  → si no: Job → leerConfigEvidenciaWorker → Playwright → EvidenciaConfig.create

POST /api/evidencias/:id/config
  → Job → configWorker → Playwright → serializarFormulario() → POST Moodle → ConfigAudit
```

### Matching IA
```
POST /api/evidencias/batch/matching-ia { evidenciaIds }
  → Job → matchingIaWorker
    → por evidencia: prompt Claude (nombre evidencia + lista RAPs)
    → MatchingPropuesta.create (confianza, razon, estado)
PATCH /api/matching-propuestas/:id/aprobar
  → MatchingPropuesta.update(estado=aceptado) + RapEvidenciaRel.create
```

### Actas de seguimiento (sprint v2 — en curso)
```
POST /api/actas/:id/auto-poblar
  → por RAP en acta: RapEvidenciaRel + MatchingPropuesta(aceptado) → evidencias de la ficha
  → por aprendiz: Entrega por esas evidencias → rapStatus + juicio (3 estados) + hasUngraded
  → upsert ActaParticipante

GET /api/actas/:id/download/gor-f-084
  → genera Word institucional GOR-F-084 V02 (tabla participantes, resumen, notas)
```

---

## Colas BullMQ activas

| Queue | Worker | Concurrency | Uso |
|-------|--------|-------------|-----|
| `fichas` | fichasWorker | 3 | Descubrir fichas de un instructor |
| `evidencias` | evidenciasWorker | 3 | Scrapear entregas de una ficha |
| `leerConfig` | leerConfigEvidenciaWorker | 1 | Leer config de una evidencia |
| `config` | configWorker | 1 | Guardar config (legacy) |
| `cambiarFecha` | cambiarFechaWorker | 1 | Bulk duedate |
| `cambiarConfig` | cambiarConfigWorker | 1 | Bulk config múltiple |
| `foroRating` | foroRatingWorker | 1 | Calificar posts foro |
| `autoScan` | autoScanWorker | 1 | Scan programado |
| `matchingIa` | matchingIaWorker | 2 | Claude matching evidencias↔RAPs |
| `mensajeFormativo` | mensajeFormativoWorker | 1 | Enviar mensaje Zajuna |

---

## Decisiones de diseño (no revertir sin discusión)

1. **Cierre de evidencias 100% manual** — el worker NUNCA toca `cerradaAt`
2. **Soft state con `DateTime?`** — `archivedAt`, `cerradaAt`, `archivadaAt` son nullable
3. **Multitenant desde el inicio** — todo query filtra por `userId`
4. **`zajuna-evidencias.js` no se toca** — CLI de referencia y respaldo
5. **Workers stateless** — reciben job, ejecutan, cierran browser, retornan
6. **IA no actúa sola** — siempre muestra al instructor antes de aplicar
7. **Una migración Prisma por feature lógico** — nombres descriptivos snake_case
8. **CSV import eliminado del UI** — auto-poblar lee DB directamente (ver HANDOFF-ACTAS.md)
