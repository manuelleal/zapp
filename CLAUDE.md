# CLAUDE.md — Zajuna App

## Qué es este proyecto
SaaS multitenant para instructores del SENA que automatiza la gestión de Zajuna (Moodle).
Permite revisar evidencias pendientes, calificar, responder foros y mensajes con ayuda de IA.
Desarrollador: instructor SENA Bucaramanga — inglés y otras competencias.

---

## Stack real (implementado, mayo 2026)
- **Backend:** Node.js + Fastify 5 + BullMQ + Redis + PostgreSQL + Prisma 6
- **Frontend actual:** HTML/CSS/JS vanilla en `public/` (~800 LOC) — **a migrar a React+Vite+Tailwind+shadcn en Sprint 1**
- **Scraping:** Playwright 1.59 (workers BullMQ, concurrency 3)
- **IA:** Claude API — fase 2 (no implementado)
- **Deploy objetivo:** Railway (Postgres + Redis nativos)
- **Dev local:** Docker Compose (Postgres 16 + Redis 7)
- **Rama activa:** `feature/archivar-fichas-evidencias` (HEAD: 7141f87, 6 commits sobre master)

---

## Estructura de carpetas REAL (estado actual)
```
C:\zajuna\
├── api/
│   └── src/
│       ├── server.js              ← Fastify, puerto 3000
│       ├── routes/
│       │   ├── auth.js            ← POST /api/auth/register | POST /api/auth/login
│       │   ├── fichas.js          ← POST /api/fichas/scan | GET /api/fichas
│       │   └── jobs.js            ← GET /api/jobs/:id
│       ├── workers/
│       │   └── fichasWorker.js    ← BullMQ worker: login → descubrirFichas → upsert DB
│       ├── db/
│       │   └── client.js          ← singleton PrismaClient
│       └── lib/
│           ├── crypto.js          ← AES-256-GCM encrypt/decrypt credenciales Zajuna
│           └── queue.js           ← BullMQ Queue + Redis connection (ioredis)
├── prisma/
│   └── schema.prisma              ← 8 tablas: User Ficha Job Evidencia Aprendiz Entrega Historial AIFeedback
├── scraper/
│   ├── auth.js                    ← login(), cerrarModal(), BASE_URL, TIMEOUT, log
│   └── fichas.js                  ← descubrirFichas(page, competenciaCodigo) → {fichas, otrosCursos}
├── public/
│   ├── index.html                 ← UI responsiva con datos mock
│   ├── style.css                  ← colores SENA (#00A650)
│   └── app.js                     ← fetch comentado, listo para conectar al backend
├── zajuna-evidencias.js           ← CLI original FUNCIONAL — NO TOCAR
├── ARCHITECTURE.md                ← diseño completo del sistema (leer antes de cualquier feature)
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

# 4. Arrancar servidor (puerto 3000)
node api/src/server.js

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
| GET | `/api/evidencias/:id/entregas?estado=...` | JWT | Aprendices con estado + moodleId + actId para URL grader |
| GET | `/api/jobs/:id` | JWT | Polling de job: queued → running → done/error |

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

### Sprint 1 — Frontend React + bulk evidencias (en progreso)
- [ ] Migrar `public/` → `web/` con Vite + React 18 + Tailwind + shadcn/ui
- [ ] Paridad funcional: Login, Dashboard, Modal evidencias, Panel aprendices
- [ ] Servir `web/dist` desde Fastify (`@fastify/static`)
- [ ] Selección múltiple de evidencias + toolbar acciones masivas
- [ ] Endpoint `PATCH /api/evidencias/bulk` (cerrar/reabrir N)
- [ ] Borrar `public/` legacy cuando QA pase

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
