# Zajuna App — Arquitectura del Sistema

> **Última actualización:** 19 jun 2026. Fuente de verdad operacional: `CLAUDE.md`.

## Visión general

SaaS multitenant para instructores del SENA que automatiza la gestión de Zajuna (Moodle institucional): escanear evidencias, calificar, generar actas GOR-F-084 en Word, enviar mensajes masivos y configurar entregas, usando scraping Playwright + IA (Claude/Kimi).

---

## Stack tecnológico

| Capa | Tecnología | Notas |
|---|---|---|
| API HTTP | Node.js + Fastify 5 | Puerto 3000; sirve también `web/dist` |
| Cola de tareas | BullMQ + Redis 7 | 16 workers BullMQ en proceso separado |
| Base de datos | PostgreSQL 16 + Prisma 6 | 21 modelos; multitenant por `userId` |
| Frontend | React 18 + Vite 5 + Tailwind 3 + shadcn/ui | Build en `web/dist/` |
| Auth | JWT (`@fastify/jwt`) + bcrypt | Tokens de 7 días |
| Credenciales Zajuna | AES-256-GCM en DB | `zajunaUserEnc/PassEnc` cifrados con `ENCRYPTION_KEY` |
| Scraping DOM | Playwright 1.59 | Solo para login SSO + operaciones de escritura en Moodle |
| Scraping liviano | fetch + cheerio | Lectura de config (formularios modedit) sin abrir Chromium |
| AJAX Moodle | `mod_assign_list_participants` via sesskey | CAPA 2 — listar entregas sin DOM |
| IA matching | Claude API / OpenRouter (Kimi K2) | `aiClient.js` agnóstico por env `AI_PROVIDER` |
| IA actas | Anthropic (Claude Haiku/Sonnet) | Solo saneo de texto; nunca actúa sola (regla #8) |
| Deployment | VPS (Hetzner CPX31/41) + PM2 | Ver `docs/DEPLOY.md`; NO serverless (Chromium + SSO) |

---

## Procesos en producción

```
pm2 start ecosystem.config.js
  ├── app "api"      → node api/src/server.js     (API HTTP :3000; puede ir en cluster)
  └── app "workers"  → node api/src/worker-entry.js  (16 workers BullMQ; instances:1 fork OBLIGATORIO)
```

**Por qué dos procesos:** un OOM de cualquier scraper Playwright tumbaba antes la API entera (eran el mismo proceso Node). La separación es P0 #1 del refactor de junio 2026. Ver `CLAUDE.md §11.1`.

**Por qué `workers` debe ser 1 instancia:** Moodle/Zajuna invalida la sesión si detecta dos logins paralelos del mismo usuario. 2 instancias = 2 browsers por usuario = sesión inválida.

---

## Flujo de un request

```
Browser (React) ──HTTP + JWT──► Fastify :3000
                                    │
                          ┌─────────┴──────────┐
                          │  Route handler      │
                          │  1. Valida JWT      │
                          │  2. IDOR check      │
                          │  3. Prisma (userId) │
                          └─────────┬──────────┘
                                    │
               ┌────────────────────┼────────────────────┐
               │ Respuesta inmediata │ Tarea pesada       │
               │ (200/201/4xx)       │ → queue.add(...)   │
               │                    │   → 202 { jobId }  │
               └────────────────────┴────────────────────┘
                                             │
                                    ┌────────▼────────┐
                                    │  BullMQ / Redis  │
                                    └────────┬────────┘
                                             │
                                    ┌────────▼────────────────────┐
                                    │  worker-entry.js (proceso   │
                                    │  PM2 separado)              │
                                    │  Playwright / fetch+cheerio  │
                                    │  → actualiza Job en DB      │
                                    └─────────────────────────────┘
                                             │
                        Frontend polling: GET /api/jobs/:id cada 3s
```

---

## Estructura de carpetas

```
C:\zajuna\
│
├── api/src/
│   ├── server.js                ← Fastify + plugins + rutas + estáticos (SIN workers)
│   ├── worker-entry.js          ← Entrypoint de los 16 workers BullMQ (proceso separado)
│   │
│   ├── routes/                  ← Controladores HTTP (1 archivo = 1 dominio)
│   │   ├── auth.js              POST /api/auth/register|login|me|aceptar-terminos
│   │   ├── fichas.js            GET/POST/DELETE /api/fichas
│   │   ├── evidencias.js        GET/PATCH /api/evidencias/*
│   │   ├── archivar.js          PATCH bulk archivar/cerrar fichas y evidencias
│   │   ├── configEvidencias.js  GET/PATCH config de evidencia (fetch+cheerio o Playwright)
│   │   ├── batchConfig.js       POST batch duedate/config (M2+M3)
│   │   ├── scan.js              POST /api/scan/full + GET /api/scan/progress
│   │   ├── foroRating.js        PATCH calificar foro + descubrir pendientes
│   │   ├── raps.js              CRUD /api/raps + vincular/desvincular evidencias (M4+M5)
│   │   ├── matchingIa.js        POST iniciar matching + PATCH aprobar/rechazar (M6)
│   │   ├── actas.js             CRUD /api/actas + auto-poblar + preview + DOCX (M7)
│   │   ├── actasImport.js       POST importar CSV de participantes en acta
│   │   ├── mensajes.js          POST enviar-masivo + CRUD mensajes programados (M8)
│   │   ├── ajustes.js           GET/PATCH config SMTP + descubrir/simular competencias
│   │   ├── jobs.js              GET /api/jobs/:id (polling de estado BullMQ)
│   │   └── admin.js             /api/admin/* (solo rol superadmin)
│   │
│   ├── workers/                 ← Workers BullMQ (proceso worker-entry.js)
│   │   ├── fichasWorker.js              cola "fichas"            concurrency 3
│   │   ├── evidenciasWorker.js          cola "evidencias"        concurrency 3
│   │   ├── configWorker.js              cola "config"            concurrency 1
│   │   ├── leerConfigEvidenciaWorker.js cola "leerConfig"        concurrency 1
│   │   ├── leerConfigLoteWorker.js      cola "leerConfigLote"    concurrency 1
│   │   ├── cambiarFechaWorker.js        cola "cambiarFecha"      concurrency 1
│   │   ├── cambiarConfigWorker.js       cola "cambiarConfig"     concurrency 1
│   │   ├── foroRatingWorker.js          cola "foroRating"        concurrency 1
│   │   ├── foroDescubrirWorker.js       cola "foroDescubrir"     concurrency 2
│   │   ├── autoScanWorker.js            cola "autoScan" (cron 3h) concurrency 1
│   │   ├── matchingIaWorker.js          cola "matchingIa"        concurrency 2
│   │   ├── mensajeFormativoWorker.js    cola "mensajeFormativo"  concurrency 1
│   │   ├── syncParticipantesWorker.js   cola "syncParticipantes" concurrency 1
│   │   ├── emailMasivoWorker.js         cola "emailMasivo"       concurrency 2
│   │   ├── descubrirCompetenciasWorker.js cola "descubrirComp."  concurrency 1
│   │   └── mensajesProgramadosWorker.js cola "mensajesProgramados" (tick 10 min)
│   │
│   ├── lib/
│   │   ├── queue.js             Instancias BullMQ + conexión Redis
│   │   ├── browserPool.js       Singleton Chromium compartido + semáforo de contexts
│   │   ├── crypto.js            AES-256-GCM encrypt/decrypt (credenciales Zajuna)
│   │   ├── sessionStore.js      Caché Redis de sesiones Playwright (storageState, TTL 2h)
│   │   ├── fetchWithRetry.js    HTTP helper Node con reintentos exponenciales
│   │   ├── aiClient.js          Cliente IA agnóstico (OpenRouter/Kimi/Anthropic por env)
│   │   ├── actaSaneado.js       Saneo de textos para el Word (tildes, ñ, caracteres Moodle)
│   │   ├── mensajesMasivos.js   Lógica compartida de envío masivo (ruta + worker)
│   │   └── userLock.js          Mutex por userId — evita sesiones paralelas del mismo instructor
│   │
│   ├── assets/
│   │   └── sena-logo.png        Logo SENA embebido en el DOCX del acta
│   │
│   └── db/
│       └── client.js            Singleton PrismaClient
│
├── scraper/                     ← Módulos Playwright/fetch reutilizables (importados por workers)
│   ├── auth.js                  login() SSO federado, cerrarModal(), BASE_URL
│   ├── fichas.js                descubrirFichas(page, competenciaCodigo)
│   ├── evidencias.js            obtenerEvidencias(), revisarEntregas*(), CAPA 2 AJAX, grader report
│   ├── configEvidencias.js      [PLAYWRIGHT] leerConfigEvidencia(), guardarConfigEvidencia(), FIELD_MAPS
│   ├── configEvidenciasFetch.js [FETCH+CHEERIO] gemelo liviano — emula disabledIf de Moodle
│   ├── foroRating.js            calificarPostForo(), descubrirPendientesForo()
│   └── mensajes.js              enviarMensajeMoodle(), construirMensaje(), sincronizarParticipantes()
│
├── scripts/                     ← Utilidades CLI (no son workers BullMQ)
│   ├── extraerTodasLasGuias.js  Extrae Competencias+RAPs de un PDF local → DB
│   ├── extraerGuiasDesdeZajuna.js Crawler: descarga guías del curso y extrae RAPs → DB
│   ├── vincularEvidenciasRAPs.js  Crea RapEvidenciaRel (inglés auto, IA para el resto)
│   ├── matchearCompetenciaIA.js   Matching IA automático por competencia (usa aiClient.js)
│   └── importarMapeoRaps.js       Importa mapeo RAP↔evidencia desde .md curado por IA externa
│
├── prisma/
│   ├── schema.prisma            Fuente de verdad del modelo de datos (21 modelos)
│   └── migrations/              Historial de migraciones SQL (NO ignorar en git)
│
├── web/src/                     ← Frontend React 18 + Vite + Tailwind + shadcn/ui
│   ├── App.tsx                  Rutas React Router v6
│   ├── pages/
│   │   ├── Login.tsx            Acceso
│   │   ├── Dashboard.tsx        Vista general — fichas, badges, progreso de scan
│   │   ├── Fichas.tsx           Listado completo de fichas + modal de evidencias + Excel
│   │   ├── EvidenciasConfig.tsx Tabla de fechas y config masiva (M2+M3)
│   │   ├── RapsPage.tsx         Gestión curricular de RAPs (M4+M5)
│   │   ├── MatchingIaPage.tsx   Revisar propuestas IA de matching (M6)
│   │   ├── ActasPage.tsx        Actas de seguimiento GOR-F-084 + descarga Word (M7)
│   │   ├── MensajesPage.tsx     Mensajes masivos + programados (M8)
│   │   ├── AjustesPage.tsx      Config SMTP + descubrir/simular competencias
│   │   └── AdminPage.tsx        Panel de administración (solo superadmin)
│   ├── components/              Componentes reutilizables (shadcn/ui + propios)
│   ├── api/                     Hooks TanStack Query
│   ├── store/                   Zustand auth store (JWT en localStorage)
│   └── lib/                     Utilidades (cn, fetch wrapper)
│
├── ecosystem.config.js          Config PM2: apps "api" + "workers"
├── docs/
│   ├── ARCHITECTURE.md          Este archivo
│   ├── DEPLOY.md                Runbook de despliegue (VPS, PM2, TLS, secretos)
│   ├── MOODLE_REFERENCE.md      Endpoints Moodle confirmados, sesskey, ingeniería inversa Extensión Z
│   └── auditoria-release/       Informes de la auditoría de release (19 jun 2026)
└── CLAUDE.md                    Fuente de verdad operacional (estado, reglas, pendientes)
```

---

## Modelo de datos (21 modelos)

| Modelo | Propósito |
|---|---|
| `User` | Instructor. Credenciales Zajuna cifradas. `rol` instructor/superadmin. `suspendedAt` soft-state. |
| `Ficha` | Grupo de aprendices en Moodle. `archivedAt` soft-state. |
| `Evidencia` | Actividad (assign/foro/quiz). `cerradaAt` NUNCA la setea un worker (solo el instructor). `itemid`, `assignId`, `contextId` para CAPA 2 y grader. |
| `EvidenciaConfig` | Config leída de Moodle (raw HTML/JSON). TTL 4h. |
| `Aprendiz` | Estudiante de la ficha. `moodleId`, `documento`, `email`, `ultimoAcceso`. |
| `Entrega` | Estado de un aprendiz en una evidencia. `notaActual Float?`, `notaCualitativa String?` (A/D). |
| `HistorialEstado` | Timeline de cambios de estado por entrega. |
| `AIFeedback` | Feedback IA generado por entrega y tipo. |
| `Job` | Estado de cualquier job BullMQ (queued/running/done/error). |
| `ConfigAudit` | Auditoría de cambios de config (antes/después). |
| `ConfigChangeJob` | Job de cambio masivo de config (batch M2+M3). Progreso % en DB. |
| `Competencia` | Competencia SENA con código y nombre. Relaciona con RAP y User. |
| `RAP` | Resultado de Aprendizaje. Pertenece a Competencia. |
| `Criterio` | Criterio de evaluación de un RAP. |
| `RapEvidenciaRel` | Join M↔N entre RAP y Evidencia. Base de las actas. |
| `MatchingPropuesta` | Propuesta IA de qué RAP evalúa una evidencia (propuesto/aprobado/rechazado). |
| `ActaSeguimiento` | Acta GOR-F-084 V02. Campos del formato oficial opcionales. |
| `ActaParticipante` | Juicio (aprobó/no aprobó) de un aprendiz en un acta. |
| `ConfigCorreo` | Config SMTP por instructor para mensajería email. |
| `MensajeFormativo` | Registro de mensajes enviados (historial). |
| `MensajeProgramado` | Mensaje recurrente. Guarda el filtro, no los destinatarios. |

---

## Reglas de oro del proyecto

1. **Multi-tenant obligatorio:** todo query Prisma filtra por `userId`. Sin excepción.
2. **Workers stateless:** reciben job, ejecutan, retornan. No guardan estado en variables del módulo.
3. **`cerradaAt` 100% manual:** el worker NUNCA lo setea. Solo el instructor desde la UI.
4. **Soft-state para fechas:** `archivedAt`, `cerradaAt`, `archivadaAt`, `suspendedAt`, `pausadoAt` son `DateTime?`. `null` = activo.
5. **IA propone, instructor decide:** matching y actas nunca actúan sin confirmación (regla #8 de `CLAUDE.md`).
6. **Umbral SENA universal:** 70/100 + cualitativa `A` = aprobado. No configurable por instructor (estándar GOR-F-084).
7. **Hrefs canónicos:** `${BASE_URL}/mod/{tipo}/view.php?id=${actId}`. El scraper normaliza siempre.
8. **workers `instances:1`:** jamás escalar el proceso de workers horizontalmente.

---

## Login SSO de SENA — por qué Playwright es obligatorio para el login

SENA usa un SSO federado (portal `zajuna.sena.edu.co` con `typeDocument`/`document`/`form_login_user`), no el login nativo de Moodle. Por eso:
- `/login/token.php` siempre devuelve `invalidlogin` → no hay token WS posible.
- El login requiere Chromium para ejecutar el JS del portal SSO.
- Una vez logueado, las cookies se cachean en Redis (`sessionStore.js`) y las lecturas/escrituras posteriores pueden ir por `fetch` Node (más liviano).

---

## Fases completadas (jun 2026)

- [x] Auth JWT + credenciales cifradas
- [x] Scraping fichas + evidencias (Gradebook Tree, 199 evidencias vs 48 antes)
- [x] Dashboard con badges + scan automático cada 3h
- [x] Archivar/restaurar fichas; cerrar/reabrir evidencias (100% manual)
- [x] Config de evidencias (fechas/intentos) — Playwright + fetch+cheerio
- [x] Batch masivo de fechas y config (M2+M3)
- [x] RAPs locales + asociación a evidencias (M4+M5)
- [x] Matching IA automático — 2147 vínculos RapEvidenciaRel (M6)
- [x] Actas GOR-F-084 V02 en Word + descarga (M7)
- [x] Mensajes masivos Moodle/email + programados + filtros (M8)
- [x] Refactor P0: procesos separados, browserPool, bloqueo recursos, semáforo
- [x] CAPA 2 AJAX: `mod_assign_list_participants` — scan de assigns sin DOM
- [x] Nota cualitativa A/D desde grader report por itemid
- [x] Panel de administración (superadmin)
- [x] Auditoría de release con 6 agentes (19 jun 2026)

## Pendientes

- [ ] Nota A/D en la UI (badge en `AprendicesPanel.tsx`)
- [ ] Subestado de entrega: borrador/reabierto/enviado en la UI
- [ ] Migrar lectura DOM restante a Node fetch (P1 #7 de `CLAUDE.md §11.3`)
- [ ] Rate-limit a Redis (hoy en memoria, no sobrevive reinicios)
- [ ] `playwrightSession.js` factory — deduplica boilerplate de 9 workers (P1 #6)
- [ ] Deploy real en VPS (ver `docs/DEPLOY.md`)
