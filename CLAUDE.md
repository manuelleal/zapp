# CLAUDE.md — Zajuna App

## Qué es este proyecto
SaaS multitenant para instructores del SENA que automatiza la gestión de Zajuna (Moodle).
Permite revisar evidencias pendientes, calificar, responder foros y mensajes con ayuda de IA.
Desarrollador: instructor SENA Bucaramanga — inglés y otras competencias.

---

## Stack real (implementado)
- **Backend:** Node.js + Fastify 5 + BullMQ + Redis + PostgreSQL + Prisma
- **Frontend:** HTML/CSS/JS vanilla (en `public/`) — sin build tools por ahora
- **Scraping:** Playwright (workers BullMQ)
- **IA:** Claude API — fase 2
- **Deploy objetivo:** Railway (Postgres + Redis nativos)
- **Dev local:** Docker Compose (Postgres 16 + Redis 7)

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
| GET | `/api/fichas` | JWT | Fichas guardadas en DB del usuario |
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

## Lo que ya funciona (probado)
- [x] Login en Zajuna con Playwright
- [x] Descubrimiento de 15 fichas del instructor
- [x] Backend Fastify con auth JWT + bcrypt
- [x] Credenciales Zajuna cifradas AES-256-GCM en DB
- [x] Worker BullMQ: job queued → running → done
- [x] Upsert de fichas en PostgreSQL
- [x] UI mock en `public/index.html` (sin conectar aún al backend)
- [x] CLI `zajuna-evidencias.js` funcional para revisar entregas

## Pendiente (en orden)
- [ ] Conectar `public/app.js` al backend (descomentar fetch, agregar login UI)
- [ ] Worker de evidencias (`scraper/evidencias.js` ya existe en `zajuna-evidencias.js`, extraer como módulo)
- [ ] Rutas `/api/evidencias/scan` y `/api/evidencias`
- [ ] Dashboard con datos reales de DB
- [ ] Agentes IA (Claude API): calificador, retroalimentador, foros
- [ ] Deploy en Railway

---

## Reglas de desarrollo
- **Plan mode siempre** antes de features que tocan más de 2 archivos
- **Subagentes** para explorar código sin quemar contexto del chat principal
- **No hardcodear** nada — todo desde `.env`
- **Multitenant desde el inicio** — todo query a DB filtra por `userId`
- **`zajuna-evidencias.js` no se toca** — es el CLI de referencia y respaldo
- **Workers son stateless** — reciben job, ejecutan, cierran browser, retornan resultado
- **La IA no actúa sola** — siempre muestra al instructor antes de calificar o responder

---

## Fases del proyecto
- **Fase 1 MVP** (en curso): Auth + scraping fichas + scraping evidencias + dashboard
- **Fase 2 IA**: Calificador + retroalimentador + responder foros
- **Fase 3 Notificaciones**: WhatsApp por instructor (Twilio o Meta API)
