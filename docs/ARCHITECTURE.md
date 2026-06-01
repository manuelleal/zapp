# Zajuna App — Arquitectura del Sistema

## Visión general

Plataforma web multitenant para instructores del SENA que combina scraping
de Zajuna/Moodle con agentes IA para gestión de evidencias, calificación
asistida y seguimiento de aprendices.

---

## Stack tecnológico

| Capa | Tecnología | Justificación |
|---|---|---|
| API | Node.js + Fastify | Más rápido que Express; maneja 200 concurrentes sin clustering manual |
| Cola de tareas | BullMQ + Redis | Playwright corre async; no bloquea requests HTTP |
| Base de datos | PostgreSQL | Relacional, historial, multitenant nativo |
| ORM | Prisma | Migraciones, type-safety, DX excelente |
| Frontend | React + Vite + Tailwind | Responsive, componentes, build rápido |
| Auth | JWT + bcrypt | Stateless, escala horizontal |
| Credenciales Zajuna | AES-256 cifrado en DB | Cada instructor guarda las suyas, nunca en plano |
| Scraping | Playwright (worker pool) | Ya instalado, funciona en el servidor |
| Agentes IA | Claude API (Anthropic) | Calificación, retroalimentación, foros |
| Deployment | Railway | Postgres + Redis + deploy desde Git, 24/7 |

---

## Estructura de carpetas

```
zajuna-app/
├── api/                        ← Fastify backend
│   ├── src/
│   │   ├── routes/
│   │   │   ├── auth.js         # register, login, me
│   │   │   ├── fichas.js       # GET /fichas, POST /fichas/scan
│   │   │   ├── evidencias.js   # GET /evidencias, POST /evidencias/scan
│   │   │   ├── aprendices.js   # GET /aprendices/:id/historial
│   │   │   └── jobs.js         # GET /jobs/:id (status de scraping)
│   │   ├── workers/
│   │   │   ├── fichasWorker.js      # BullMQ: descubre fichas
│   │   │   └── evidenciasWorker.js  # BullMQ: revisa entregas
│   │   ├── agents/
│   │   │   ├── calificador.js       # Claude: sugiere calificación
│   │   │   ├── retroalimentador.js  # Claude: genera feedback aprendiz
│   │   │   └── foroResponder.js     # Claude: responde mensajes foros
│   │   ├── db/
│   │   │   ├── schema.prisma
│   │   │   └── client.js
│   │   ├── lib/
│   │   │   ├── crypto.js       # encrypt/decrypt credenciales Zajuna
│   │   │   └── queue.js        # instancia BullMQ
│   │   └── server.js
│   └── package.json
│
├── scraper/                    ← Módulos Playwright reutilizables
│   ├── auth.js                 # login(), cerrarModal()
│   ├── fichas.js               # descubrirFichas(page, competencia)
│   └── evidencias.js           # revisarEvidencias(page, ficha, codigo)
│
├── web/                        ← React + Vite frontend
│   ├── src/
│   │   ├── pages/
│   │   │   ├── Login.jsx
│   │   │   ├── Dashboard.jsx   # resumen de fichas y pendientes
│   │   │   ├── Ficha.jsx       # detalle ficha + evidencias
│   │   │   └── Aprendiz.jsx    # historial individual
│   │   ├── components/
│   │   │   ├── FichaCard.jsx
│   │   │   ├── EvidenciaTable.jsx
│   │   │   ├── JobStatus.jsx   # progreso de scraping en tiempo real
│   │   │   └── AIPanel.jsx     # panel de agentes IA
│   │   ├── hooks/
│   │   │   └── useJob.js       # polling/websocket de job status
│   │   └── api/
│   │       └── client.js       # fetch wrapper con JWT
│   └── package.json
│
├── zajuna-evidencias.js        ← CLI original (no se toca)
├── docker-compose.yml          ← local dev: Postgres + Redis
├── .env.example
└── package.json                ← scripts raíz
```

---

## Diagrama de flujo del sistema

```
┌─────────────────────────────────────────────────────────────┐
│                    BROWSER (instructor)                      │
│  Login → Dashboard → [Scan Fichas] → [Scan Evidencias]      │
└──────────────────┬──────────────────────────────────────────┘
                   │ HTTP + JWT
┌──────────────────▼──────────────────────────────────────────┐
│                  FASTIFY API  (:3000)                        │
│  • Valida JWT                                                │
│  • Desencripta credenciales Zajuna del usuario               │
│  • Encola job en BullMQ → responde job_id inmediato          │
└──────┬───────────────────────────────────────┬──────────────┘
       │                                       │
       ▼                                       ▼
┌──────────────┐                    ┌──────────────────────────┐
│    REDIS     │                    │   POSTGRESQL             │
│  Job queues  │                    │  users, fichas,          │
│  Job status  │                    │  evidencias, historial   │
└──────┬───────┘                    └──────────────────────────┘
       │
┌──────▼───────────────────────────────────────────────────────┐
│              BULLMQ WORKERS (pool Playwright)                 │
│                                                              │
│  fichasWorker:                                               │
│    1. login(user, pass)                                      │
│    2. descubrirFichas(page, competencia)                     │
│    3. Guarda fichas en PostgreSQL                            │
│    4. Actualiza job status → Redis                           │
│                                                              │
│  evidenciasWorker:                                           │
│    1. login(user, pass)                                      │
│    2. revisarEvidencias(page, ficha, codigo_competencia)     │
│    3. Guarda estados en PostgreSQL (historial)               │
│    4. Si hay pendientes → encola en agentQueue               │
│    5. Actualiza job status → Redis                           │
└──────────────────────────────┬───────────────────────────────┘
                               │
┌──────────────────────────────▼───────────────────────────────┐
│              AGENTES IA (Claude API)                          │
│                                                              │
│  calificador:       lee entrega → sugiere nota + criterios   │
│  retroalimentador:  genera feedback personalizado aprendiz   │
│  foroResponder:     lee mensaje foro → draft de respuesta    │
└──────────────────────────────────────────────────────────────┘
```

---

## Modelo de datos (PostgreSQL)

```prisma
model User {
  id               String   @id @default(cuid())
  nombre           String
  email            String   @unique
  passwordHash     String
  zajunaUserEnc    String   // AES-256
  zajunaPassEnc    String   // AES-256
  competenciaCodigo String  // ej: "240202501"
  competenciaNombre String  // ej: "Inglés"
  createdAt        DateTime @default(now())
  fichas           Ficha[]
  jobs             Job[]
}

model Ficha {
  id         String   @id @default(cuid())
  userId     String
  codigo     String   // "3186683"
  programa   String   // "ADSO"
  courseId   Int      // Moodle course ID
  guia       Int
  createdAt  DateTime @default(now())
  user       User     @relation(fields: [userId], references: [id])
  evidencias Evidencia[]
  aprendices Aprendiz[]

  @@unique([userId, codigo])
}

model Evidencia {
  id       String @id @default(cuid())
  fichaId  String
  nombre   String
  href     String
  tipo     String // "assign" | "otro"
  ficha    Ficha  @relation(fields: [fichaId], references: [id])
  entregas Entrega[]
}

model Aprendiz {
  id       String @id @default(cuid())
  fichaId  String
  nombre   String
  ficha    Ficha  @relation(fields: [fichaId], references: [id])
  entregas Entrega[]

  @@unique([fichaId, nombre])
}

model Entrega {
  id          String   @id @default(cuid())
  evidenciaId String
  aprendizId  String
  estado      String   // "pendiente" | "calificado" | "sin_entregar" | "desconocido"
  fechaScan   DateTime @default(now())
  evidencia   Evidencia @relation(fields: [evidenciaId], references: [id])
  aprendiz    Aprendiz  @relation(fields: [aprendizId], references: [id])
  historial   HistorialEstado[]
  aiFeedback  AIFeedback[]
}

model HistorialEstado {
  id              String   @id @default(cuid())
  entregaId       String
  estadoAnterior  String
  estadoNuevo     String
  fecha           DateTime @default(now())
  entrega         Entrega  @relation(fields: [entregaId], references: [id])
}

model AIFeedback {
  id          String   @id @default(cuid())
  entregaId   String
  tipo        String   // "calificacion" | "retroalimentacion" | "foro"
  contenido   String
  generadoAt  DateTime @default(now())
  entrega     Entrega  @relation(fields: [entregaId], references: [id])
}

model Job {
  id         String   @id @default(cuid())
  userId     String
  tipo       String   // "fichas" | "evidencias"
  fichaId    String?
  status     String   // "queued" | "running" | "done" | "error"
  progreso   Int      @default(0) // 0-100
  errorMsg   String?
  creadoAt   DateTime @default(now())
  user       User     @relation(fields: [userId], references: [id])
}
```

---

## Multitenant: aislamiento de datos

- Cada query a DB siempre filtra por `userId` — nunca hay datos cruzados
- Las credenciales Zajuna se cifran con `AES-256-GCM` usando `ENCRYPTION_KEY` del `.env` del servidor
- El instructor nunca ve las credenciales de otro instructor

---

## Concurrencia: 200 usuarios simultáneos

| Problema | Solución |
|---|---|
| Playwright bloquea el hilo | Corre en workers separados via BullMQ |
| 200 scrapers al mismo tiempo | Pool de workers limitado (ej: 20 concurrentes); el resto espera en cola |
| Estado del job | Redis con TTL; frontend hace polling al endpoint `/jobs/:id` |
| DB saturada | Prisma connection pool + PostgreSQL aguanta bien |

Configuración de concurrencia recomendada en Railway starter:
- Workers Playwright: **10-20 concurrentes** (Playwright es pesado en RAM)
- Redis: instancia compartida
- Postgres: pool de 20 conexiones

---

## Fases de desarrollo

### Fase 1 — MVP (estado mayo 2026)
- [x] Auth: registro, login, JWT
- [x] Cifrado AES-256-GCM de credenciales Zajuna por usuario
- [x] Scraping de fichas + evidencias + entregas + moodleId aprendiz
- [x] Dashboard con badges (Sin escanear / Al día / N pendientes)
- [x] Archivar/restaurar fichas
- [x] Cerrar/reabrir evidencias (100% manual, NO automático)
- [x] Cache instantáneo + botón Refrescar
- [x] Panel aprendices con filtros + URL grader directa
- [ ] **Sprint 1 actual:** migración React+Vite+Tailwind+shadcn + bulk close
- [ ] **Sprint 2:** bandeja de mensajes
- [ ] **Sprint 3:** foros
- [ ] **Sprint 4:** anuncios masivos

### Fase 2 — IA (después del Sprint 4)
- [ ] Agente calificador (sugiere nota con criterios)
- [ ] Agente retroalimentador (genera feedback aprendiz)
- [ ] Agente foros (draft de respuestas)

### Fase 3 — Notificaciones
- [ ] WhatsApp (Twilio o Meta API)
- [ ] Resumen diario automático

---

## Deployment en Railway

```
Railway Project
├── Service: api          (Node.js — Fastify + BullMQ workers)
├── Service: web          (Vite build estático o Node serve)
├── Plugin: PostgreSQL    (Railway managed)
└── Plugin: Redis         (Railway managed)
```

Variables de entorno en Railway:
```
DATABASE_URL=postgresql://...
REDIS_URL=redis://...
JWT_SECRET=...
ENCRYPTION_KEY=...   # 32 bytes para AES-256
ANTHROPIC_API_KEY=...
```

---

## Lo que se reutiliza del CLI actual

| Código actual | Destino en nueva arquitectura |
|---|---|
| `login()` + `cerrarModal()` | `scraper/auth.js` — sin cambios |
| lógica de `obtenerEvidencias()` | `scraper/evidencias.js` — refactor a función exportable |
| lógica de `revisarEntregas()` | `scraper/evidencias.js` — ídem |
| `zajuna-evidencias.js` completo | Se conserva como CLI de respaldo |

---

## Próximo paso inmediato (mayo 2026)

**Sprint 1.1** — Setup `web/` con Vite + React 18 + Tailwind + shadcn/ui.
Ver `HANDOFF.md` para los prompts listos del día.

Rama de trabajo: `feature/archivar-fichas-evidencias` (HEAD: 7141f87).
Próxima rama: `feature/frontend-react` (se abrirá al iniciar 1.1).
