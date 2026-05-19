# CLAUDE.md — Zajuna App

## Qué es este proyecto
SaaS multitenant para instructores del SENA que automatiza la gestión de Zajuna (Moodle).
Permite revisar evidencias pendientes, calificar, responder foros y mensajes con ayuda de IA.
Desarrollador: instructor SENA Bucaramanga — inglés y otras competencias.

---

## Stack real (implementado, mayo 2026)
- **Backend:** Node.js + Fastify 5 + BullMQ + Redis + PostgreSQL + Prisma 6
- **Frontend:** React 18 + Vite 5 + Tailwind 3 + shadcn/ui en `web/` — servido desde `web/dist` por Fastify
- **Scraping:** Playwright 1.59 (workers BullMQ, concurrency 3)
- **IA:** Claude API — fase 2 (no implementado)
- **Deploy objetivo:** Railway (Postgres + Redis nativos)
- **Dev local:** Docker Compose (Postgres 16 + Redis 7)
- **Rama activa:** `feat/frontend-resilience-e2e`

---

## Estructura de carpetas REAL (estado actual)
```
C:\zajuna\
├── api/
│   └── src/
│       ├── server.js              ← Fastify, puerto 3000
│       ├── routes/
│       │   ├── auth.js            ← POST /api/auth/register | POST /api/auth/login
│       │   ├── fichas.js          ← POST/GET /api/fichas, PATCH /api/fichas/:id
│       │   ├── scan.js            ← POST /api/fichas/:fichaId/evidencias/scan
│       │   ├── archivar.js        ← PATCH /api/fichas/:id (archiva/restaura)
│       │   ├── evidencias.js      ← GET/PATCH evidencias, GET entregas
│       │   ├── jobs.js            ← GET /api/jobs/:id
│       │   ├── configEvidencias.js← GET/POST config de una evidencia (fechas, intentos)
│       │   ├── batchConfig.js     ← POST /api/evidencias/batch/duedate | /batch/config
│       │   ├── raps.js            ← CRUD RAPs + criterios + asociaciones RAP↔Evidencia
│       │   ├── matchingIa.js      ← POST /api/matching/iniciar, GET propuestas/historial, PATCH decisión
│       │   ├── foroRating.js      ← PATCH /api/evidencias/:id/foro/calificar
│       │   ├── actas.js           ← CRUD actas, participantes, auto-poblar, cerrar, download DOCX
│       │   ├── actasImport.js     ← POST /api/actas/import-csv/preview | /api/actas/:id/import-csv
│       │   ├── mensajes.js        ← POST/GET mensajes, enviar-masivo (zajuna+email), sync-emails
│       │   └── ajustes.js         ← GET/POST/DELETE /api/ajustes/correo (SMTP), probar conexión
│       ├── workers/
│       │   ├── fichasWorker.js        ← BullMQ: login → descubrirFichas → upsert DB
│       │   ├── evidenciasWorker.js    ← scrapea entregas + estados + moodleId
│       │   ├── autoScanWorker.js      ← re-scan automático programado
│       │   ├── configWorker.js        ← lee config actual de una evidencia (Playwright)
│       │   ├── leerConfigEvidenciaWorker.js ← lee campos de config individual
│       │   ├── cambiarFechaWorker.js  ← cambia fecha de entrega (batch duedate)
│       │   ├── cambiarConfigWorker.js ← cambia config masiva de evidencias
│       │   ├── matchingIaWorker.js    ← propone asociaciones RAP↔Evidencia con IA
│       │   ├── foroRatingWorker.js    ← califica posts de foro vía Playwright
│       │   ├── mensajeFormativoWorker.js ← envía mensajes internos Moodle (zajuna)
│       │   ├── emailMasivoWorker.js   ← envío masivo por SMTP (nodemailer)
│       │   └── syncParticipantesWorker.js ← sincroniza emails de aprendices desde Zajuna
│       ├── db/
│       │   └── client.js          ← singleton PrismaClient
│       └── lib/
│           ├── crypto.js          ← AES-256-GCM encrypt/decrypt credenciales Zajuna
│           ├── queue.js           ← BullMQ Queue + Redis connection (ioredis)
│           └── aprendices.js      ← filtrarAprendicesValidos() — filtra nombres inválidos
├── prisma/
│   └── schema.prisma              ← tablas: User Ficha Job Evidencia Aprendiz Entrega
│                                    Historial AIFeedback RAP Criterio Competencia
│                                    RapEvidenciaRel MatchingPropuesta ConfigChangeJob
│                                    ActaSeguimiento ActaParticipante MensajeFormativo
│                                    ConfigCorreo
├── scraper/
│   ├── auth.js                    ← login(), cerrarModal(), BASE_URL, TIMEOUT, log
│   ├── fichas.js                  ← descubrirFichas(page, competenciaCodigo)
│   ├── evidencias.js              ← scrapea actividades y entregas de una ficha
│   ├── mensajes.js                ← enviarMensaje() interno Moodle (usado por worker)
│   ├── configEvidencias.js        ← lee y escribe config de evidencia en Zajuna
│   ├── csvParser.js               ← parsearCSVActa() — importa CSV GOR-F-084 V02
│   ├── foroRating.js              ← califica posts de foro Moodle
│   ├── extractGuiaRaps.js         ← extrae RAPs desde PDFs de guías (script utilidad)
│   ├── seedRapsIngles.js          ← siembra RAPs inglés en DB desde JSON
│   └── probes/                    ← scripts de prueba/investigación (NO producción)
│       ├── probeRaps.js
│       ├── probeH1DbAnalysis.js
│       ├── probeH1v2Analysis.js
│       ├── probeH2GuiasIterator.js
│       ├── probeH3PdfBatch.js
│       ├── probeCourseScan.js
│       ├── probeGuiaHtmlExtract.js
│       ├── probeClicAqui.js
│       ├── probeGuiaRecurso.js
│       ├── probeCompetencias.js
│       ├── probeCursosOtros.js
│       └── probe-participantes.js
├── web/
│   └── src/
│       ├── components/            ← EvidenciasModal.tsx, AprendicesPanel.tsx + shadcn ui/
│       ├── api/                   ← hooks TanStack Query (useEvidencias, useEntregas, etc.)
│       ├── App.tsx                ← React Router: /login → /dashboard
│       └── main.tsx
├── zajuna-evidencias.js           ← CLI original FUNCIONAL — NO TOCAR
├── ARCHITECTURE.md                ← diseño completo del sistema (leer antes de cualquier feature)
├── HANDOFF-ACTAS.md               ← handoff sprint Actas v2
├── docker-compose.yml             ← postgres:16-alpine + redis:7-alpine
└── .env                           ← ZAJUNA_USER, ZAJUNA_PASS, DATABASE_URL, REDIS_URL, JWT_SECRET, ENCRYPTION_KEY
```

---

## Comandos para arrancar en desarrollo
```powershell
# 1. Levantar Postgres + Redis
docker-compose up -d

# 2. Crear/sincronizar tablas (solo primera vez o tras cambiar schema)
npx prisma migrate dev

# 3. Abrir Prisma Studio (explorar DB)
npx prisma studio

# 4. Arrancar servidor (puerto 3000) — sirve web/dist en /
node api/src/server.js

# 4b. Dev frontend con HMR (proxy → localhost:3000)
cd web && npm run dev   # puerto 5173

# 5. Probar scraper fichas CLI
echo 1 | node scraper/fichas.js --no-headless
```

---

## Variables de entorno (.env)
```env
ZAJUNA_USER=           ← cédula del instructor (para CLI)
ZAJUNA_PASS=           ← contraseña Zajuna (para CLI)
DATABASE_URL=postgresql://zajuna:zajuna@localhost:5432/zajuna
REDIS_URL=redis://localhost:6379
JWT_SECRET=            ← string secreto para JWT
ENCRYPTION_KEY=        ← 64 chars hex (32 bytes) para AES-256-GCM
```

---

## API endpoints implementados
| Método | Ruta | Auth | Descripción |
|--------|------|------|-------------|
| POST | `/api/auth/register` | No | Crea usuario, cifra credenciales Zajuna, retorna JWT |
| POST | `/api/auth/login` | No | Verifica password, retorna JWT |
| POST | `/api/fichas/scan` | JWT | Crea job BullMQ → worker hace login y descubre fichas |
| GET | `/api/fichas?incluirArchivadas=1` | JWT | Fichas del usuario (filtra archivadas, conteo de pendientes) |
| PATCH | `/api/fichas/:id` | JWT | `{archivada: bool}` — archiva/restaura |
| POST | `/api/fichas/:fichaId/evidencias/scan` | JWT | Re-scrapea evidencias de una ficha |
| GET | `/api/fichas/:fichaId/evidencias?incluirCerradas=1` | JWT | Evidencias con conteos pendientes/calificados/sin entregar |
| PATCH | `/api/evidencias/:id` | JWT | `{cerrada: bool}` — cerrar/reabrir manualmente |
| PATCH | `/api/evidencias/bulk` | JWT | `{ids: string[], cerrada: bool}` — bulk cerrar/reabrir N evidencias |
| GET | `/api/evidencias/:id/entregas?estado=...` | JWT | Aprendices con estado + moodleId + actId para URL grader |
| GET | `/api/evidencias/:id/config` | JWT | Lee config actual de una evidencia (fechas, intentos) |
| POST | `/api/evidencias/:id/config` | JWT | Encola escritura de config en Zajuna (Playwright) |
| POST | `/api/evidencias/batch/duedate` | JWT | Cambio masivo de fecha de entrega (M2) |
| GET | `/api/evidencias/batch/duedate/:id` | JWT | Estado de un job de batch duedate |
| POST | `/api/evidencias/batch/config` | JWT | Cambio masivo de múltiples campos de config (M3) |
| PATCH | `/api/evidencias/:id/foro/calificar` | JWT | Califica posts de un foro Moodle vía Playwright |
| GET | `/api/jobs/:id` | JWT | Polling de job: queued → running → done/error |
| GET | `/api/raps` | JWT | Lista RAPs de la competencia del usuario (con criterios) |
| GET | `/api/raps/export` | JWT | Exporta RAPs+criterios como JSON descargable |
| POST | `/api/raps/import` | JWT | Importa RAPs desde JSON; upsert por código |
| GET | `/api/raps/:rapId` | JWT | Detalle de un RAP con criterios y evidencias asociadas |
| GET | `/api/raps/:rapId/evidencias` | JWT | Evidencias asociadas a un RAP |
| POST | `/api/raps/:rapId/evidencias/:evidenciaId` | JWT | Asocia una evidencia a un RAP |
| DELETE | `/api/raps/:rapId/evidencias/:evidenciaId` | JWT | Quita asociación RAP↔Evidencia |
| POST | `/api/matching/iniciar` | JWT | Encola job de matching IA (propone RAP↔Evidencia) |
| GET | `/api/matching/propuestas` | JWT | Lista propuestas pendientes del matching IA |
| GET | `/api/matching/historial` | JWT | Lista propuestas aprobadas/rechazadas |
| PATCH | `/api/matching/propuestas/:id` | JWT | `{decision: "aprobado"\|"rechazado"}` — acepta o rechaza propuesta |
| POST | `/api/actas` | JWT | Crea acta de seguimiento (borrador) |
| GET | `/api/actas?fichaId=...&incluirArchivadas=1` | JWT | Lista actas del usuario |
| GET | `/api/actas/:id` | JWT | Detalle de acta con participantes, mensajes y RAPs |
| PATCH | `/api/actas/:id` | JWT | Edita acta: conclusiones, compromisos, rapIds, archivada, notas |
| DELETE | `/api/actas/:id` | JWT | Elimina acta y sus participantes |
| POST | `/api/actas/:id/participantes` | JWT | Upsert participantes con juicio y rapStatus |
| DELETE | `/api/actas/:id/participantes/:participanteId` | JWT | Elimina un participante del acta |
| POST | `/api/actas/:id/auto-poblar` | JWT | Auto-puebla participantes calculando juicio desde entregas |
| POST | `/api/actas/:id/cerrar` | JWT | Cierra el acta (estado: borrador → cerrada) |
| GET | `/api/actas/:id/download` | JWT | Descarga acta como DOCX (formato libre) |
| GET | `/api/actas/:id/download/gor-f-084` | JWT | Descarga acta en formato institucional GOR-F-084 V02 |
| POST | `/api/actas/import-csv/preview` | JWT | Parsea CSV GOR-F-084 y clasifica filas SIN escribir en DB |
| POST | `/api/actas/:id/import-csv` | JWT | Confirma import CSV: upsert Aprendiz + ActaParticipante |
| POST | `/api/mensajes` | JWT | Crea y encola mensaje formativo (canal: zajuna\|manual) |
| GET | `/api/mensajes?actaId=...&fichaId=...` | JWT | Lista mensajes del usuario |
| GET | `/api/mensajes/:id` | JWT | Detalle de un mensaje |
| GET | `/api/mensajes/aprendices?fichaId=...` | JWT | Lista aprendices de una ficha (para seleccionar destinatarios) |
| GET | `/api/mensajes/historial?fichaId=...` | JWT | Historial de mensajes con ficha embebida (últimos 100) |
| POST | `/api/mensajes/sync-emails` | JWT | Encola job de sincronización de emails desde Zajuna |
| GET | `/api/mensajes/sync-emails/:jobId` | JWT | Estado del job de sincronización de emails |
| POST | `/api/mensajes/enviar-masivo` | JWT | Crea y encola envío masivo (canal: email\|zajuna) |
| GET | `/api/mensajes/enviar-masivo/:jobId` | JWT | Estado del job de envío masivo |
| GET | `/api/ajustes/correo` | JWT | Lee configuración SMTP del usuario |
| POST | `/api/ajustes/correo` | JWT | Guarda/actualiza configuración SMTP (upsert) |
| POST | `/api/ajustes/correo/probar` | JWT | Verifica conexión SMTP con nodemailer |
| DELETE | `/api/ajustes/correo` | JWT | Elimina configuración SMTP |

---

## Contexto de Zajuna (LEER SIEMPRE)
- LMS Moodle del SENA Colombia
- URL base: `https://zajuna.sena.edu.co/zajuna`
- Login: tipo documento CC + número + contraseña
- Siempre hay un modal `#connection-guard-modal` — cerrarlo antes de actuar
- Nombres de curso tienen formato: `P_[codPrograma]_V_[codFicha]_R_68_C_9545`
  - `V_NNNNNNN` = código de ficha (7 dígitos, empieza en 2 o 3)
  - `P_NNNNNN` = código de programa (no tiene nombre en el DOM — ver nota abajo)
- Calificación: **A** (Aprobado) / **D** (Desaprobado)
- Evidencias de inglés tienen código **240202501** en el nombre de la actividad
- Ignorar: cuestionarios y borradores
- El campo `programa` queda como `P_NNNNNN` porque Zajuna no expone el nombre en ninguna página scrapeable — pendiente mapeo en UI

---

## Flujo de datos del scraper fichas
```
POST /api/fichas/scan
  → crea Job en DB (status: queued)
  → agrega a BullMQ
     → fichasWorker recibe job
     → descifra credenciales Zajuna (AES-256-GCM)
     → lanza Playwright headless
     → login() en Zajuna
     → descubrirFichas(page, competenciaCodigo)
        → navega a /my/courses.php (URL real post-login)
        → extrae cursos con selectores en cascada
        → construirMapaPrograma() desde /course/index.php (0 cursos en Zajuna — no expone categorías)
        → identifica fichas por regex V_([23]\d{6})
     → upsert fichas en DB
     → actualiza Job (status: done, resultado: {fichas})
```

---

## Lo que ya funciona (probado en producción local)
- [x] Login + registro UI con JWT en localStorage
- [x] Credenciales Zajuna cifradas AES-256-GCM en DB
- [x] Worker fichas: descubre y persiste 15 fichas del instructor
- [x] Worker evidencias: scrapea entregas + estados + moodleId del aprendiz
- [x] Dashboard fichas con badges (Sin escanear / Al día / N pendientes)
- [x] **Archivar/restaurar fichas** con toggle "Ver archivadas" + conteo
- [x] Modal evidencias con cache instantáneo desde DB
- [x] Botón **Refrescar** (re-scrape on demand) + indicador "Actualizado hace X"
- [x] **Cerrar/reabrir evidencias manualmente** (worker NO toca cerradaAt)
- [x] **Panel "▸ Aprendices"** expandible por evidencia con filtros (Todos/Pendientes/Calificados/Sin entregar)
- [x] Botón **"Abrir entrega"** → URL directa al grader Zajuna por aprendiz
- [x] CLI `zajuna-evidencias.js` funcional como respaldo
- [x] `scraper/mensajes.js`: enviar mensaje interno Moodle (NO conectado a UI)

## Pendiente — orden actualizado mayo 2026

### ✅ Sprint 1 — Frontend React + bulk evidencias (COMPLETO — mayo 2026)
- [x] Migrar `public/` → `web/` con Vite + React 18 + Tailwind + shadcn/ui
- [x] Paridad funcional: Login, Dashboard, Modal evidencias, Panel aprendices
- [x] Servir `web/dist` desde Fastify (`@fastify/static`) — sin flag de entorno
- [x] Selección múltiple de evidencias + toolbar acciones masivas
- [x] Endpoint `PATCH /api/evidencias/bulk` (cerrar/reabrir N)
- [x] `public/` legacy eliminado — solo existe `web/`

### Sprint 2 — Bandeja de mensajes
- [ ] Scraper: leer conversaciones del instructor (`core_message_data_for_messagearea_*`)
- [ ] Schema: tabla `Conversacion` + `Mensaje`
- [ ] Worker `mensajesWorker.js` + endpoint sincronización
- [ ] UI: bandeja con badge "N sin leer"

### Sprint 3 — Foros
- [ ] `scraper/foros.js`: listar foros + discusiones + mensajes
- [ ] Schema: `Foro` + `Discusion` + `MensajeForo`
- [ ] UI: pestaña "Foros" en modal de ficha, drill-down

### Sprint 4 — Anuncios masivos
- [ ] Investigar `mod_forum_add_discussion` Moodle
- [ ] Editor + selector multi-ficha + dry-run
- [ ] Tabla `AnuncioPublicado` para auditoría

### Fase 2 (después)
- [ ] Agentes IA Claude: calificador, retroalimentador, foroResponder
- [ ] Reportes Excel (`exceljs`)
- [ ] Upload Sofía Plus
- [ ] WhatsApp masivo
- [ ] Deploy Railway

---

## Reglas de desarrollo
- **Plan mode siempre** antes de features que tocan más de 2 archivos
- **Subagentes / `code_search`** para explorar código sin quemar contexto
- **No hardcodear** nada — todo desde `.env`
- **Multitenant desde el inicio** — todo query a DB filtra por `userId`
- **`zajuna-evidencias.js` no se toca** — CLI de referencia y respaldo
- **Workers son stateless** — reciben job, ejecutan, cierran browser, retornan resultado
- **La IA no actúa sola** — siempre muestra al instructor antes de calificar o responder
- **Soft state** — `archivedAt` / `cerradaAt` son `DateTime?`, NO booleanos
- **Cierre de evidencias 100% manual** — el worker NUNCA setea `cerradaAt` automáticamente (decisión QA: fechas viejas ≠ revisado)
- **Nuevos campos `DateTime?`** siguen el mismo patrón: `archivedAt`, `cerradaAt`, `pinnedAt`, etc.
- **Smoke test obligatorio** antes de cada commit (con JWT real, no mocks)

## Convenciones de migración Prisma
- Una migración por feature lógico
- Nombres descriptivos en snake_case: `aprendiz_moodle_id`, `archivar_fichas`, `cerrar_evidencias`
- Verificar con `npx prisma studio` antes de commit

## Modelos de IA por tarea (cuando uses Cascade/Claude)
| Tarea | Modelo | Razón |
|---|---|---|
| Arquitectura, decisiones | Claude Sonnet 4.5 / Opus 4.1 | Razonamiento profundo |
| Implementación de features | Claude Sonnet 4.5 | Balance código/precio |
| Edits puntuales, smoke tests | Claude Haiku 4 | Barato y suficiente |
| Debug complejo | Claude Opus 4.1 / GPT-5 | Vale los tokens si algo se rompe raro |
| Auditoría codebase grande | Gemini 2.5 Pro | 2M context |
| QA exhaustivo | Claude Sonnet 4.5 | Investigación + reporte |

---

## Fases del proyecto
- **Fase 1 MVP** (en curso): Auth + scraping fichas + scraping evidencias + dashboard
- **Fase 2 IA**: Calificador + retroalimentador + responder foros
- **Fase 3 Notificaciones**: WhatsApp por instructor (Twilio o Meta API)
