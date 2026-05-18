# Handoff — Mensajería masiva por correo + Fixes UX Actas

## Estado: ✅ Implementado y compila (tsc OK, server boot OK)

## Migración aplicada

```
20260518211133_mensajes_email_smtp
```

- `Aprendiz`: + `email String?`, + `ultimoAcceso DateTime?`
- Nuevo modelo `ConfigCorreo` (1:1 con `User`, smtpPassEnc cifrado AES-256-GCM)

## Cambios — Backend

| Archivo | Qué hace |
|---|---|
| `prisma/schema.prisma` | Campos email/ultimoAcceso + modelo ConfigCorreo |
| `scraper/mensajes.js` | + `sincronizarParticipantes(page, courseId)` — scrapea `/user/index.php?id=X&roleid=5&perpage=500` y devuelve `[{moodleId, nombre, email, documento, ultimoAcceso}]`. **NUNCA explota — retorna `[]` ante error.** |
| `api/src/lib/queue.js` | + `syncParticipantesQueue` y `emailMasivoQueue` |
| `api/src/workers/syncParticipantesWorker.js` | NUEVO — abre Playwright, login, scrape, `aprendiz.updateMany` por moodleId |
| `api/src/workers/emailMasivoWorker.js` | NUEVO — usa `nodemailer`, descifra SMTP del user, envía 1 a 1 con delay 800ms, plantillas con `{{nombre}}`, `{{ficha}}`, `{{evidencias}}`, `{{instructor}}` |
| `api/src/routes/ajustes.js` | NUEVO — GET/POST/DELETE `/api/ajustes/correo`, POST `/api/ajustes/correo/probar` (verify SMTP). La pass se guarda cifrada con `lib/crypto.encrypt`. |
| `api/src/routes/mensajes.js` | + GET `/api/mensajes/aprendices?fichaId=...` (lista aprendices con email + ultimoAcceso, filtra nombres ≤4 chars o 1-3 mayúsculas) <br>+ POST `/api/mensajes/sync-emails` → encola job + GET `…/sync-emails/:jobId` (polling) <br>+ POST `/api/mensajes/enviar-masivo` (canal: `email`/`zajuna`) + GET `…/enviar-masivo/:jobId` <br>+ GET `/api/mensajes/historial` (últimos 100) |
| `api/src/routes/actas.js` | Filtro `NOMBRE_INVALIDO = /^[A-Z]{1,3}$\|^.{1,4}$/` en `auto-poblar` (omite "AA", "AG", etc.); response incluye `filtrados` |
| `api/src/server.js` | Registra `routes/ajustes` + workers nuevos |
| `api/package.json` | + `nodemailer` |

## Cambios — Frontend

| Archivo | Qué hace |
|---|---|
| `web/src/pages/AjustesPage.tsx` | NUEVO — UI para configurar SMTP (host, port, user, pass, fromNombre), botón *Probar conexión*, ayuda Gmail/Outlook |
| `web/src/pages/MensajesPage.tsx` | NUEVO — Compositor 2 columnas (destinatarios + mensaje), tab Historial, polling de jobs sync/enviar, plantillas (inactividad / pendientes / recordatorio), pre-filtro `?actaId=...&filtro=pendientes\|inactivos` |
| `web/src/pages/ActasPage.tsx` | A) banner azul de pasos con toggle <br>B) toast usa `result.filtrados` <br>C) botones de descarga DENTRO del editor (con auth via `fetch + JWT + blob`) <br>D) hint "Al guardar los RAPs, la tabla mostrará una columna…" + columna "Quitar" en tabla <br>E) botón *Notificar pendientes* → `/mensajes/nuevo?actaId=…&filtro=pendientes` |
| `web/src/App.tsx` | + rutas `/mensajes`, `/mensajes/nuevo`, `/ajustes` |
| `web/src/components/Layout.tsx` | + nav items "Mensajes" y "Ajustes" |

## Endpoints nuevos

```
GET    /api/ajustes/correo
POST   /api/ajustes/correo                       { smtpHost, smtpPort, smtpUser, smtpPass?, fromNombre? }
POST   /api/ajustes/correo/probar
DELETE /api/ajustes/correo

GET    /api/mensajes/aprendices?fichaId=...
POST   /api/mensajes/sync-emails                 { fichaId } → { jobId }
GET    /api/mensajes/sync-emails/:jobId
POST   /api/mensajes/enviar-masivo               { fichaId, canal:"email"|"zajuna", asunto, cuerpo, destinatarios:[{aprendizId,...}], templateTipo?, actaId? }
GET    /api/mensajes/enviar-masivo/:jobId
GET    /api/mensajes/historial?fichaId=...
```

## Verificación realizada

- ✅ `prisma migrate dev` aplicó la migración
- ✅ `prisma generate` regeneró cliente
- ✅ `web > tsc --noEmit` sin errores
- ✅ `api > node src/server.js` arranca, registra repeatable autoScan, escucha :3000

## TODO / verificación pendiente del usuario

1. **Selectores de Moodle**: `sincronizarParticipantes` usa `tr[data-userid]` + `.col-fullname/.col-username/.col-email/.col-lastaccess`. Si falla en Zajuna real, alternativos en el código (`td.c1, td.c2…`). Probar con un curso real y ajustar selectors si hace falta.
2. **Parseo "Último acceso"**: usa `Date.parse` permisivo. Moodle es-CO suele devolver `"hace X días"` que NO parsea — quedará null y la columna mostrará "—". Si se requiere, parsear manualmente en el worker.
3. **Probar flujo completo end-to-end** con una cuenta SMTP real (Gmail con app password recomendado: `smtp.gmail.com:587`).
4. **Endpoint `mensajes/aprendices`** está antes de `/mensajes/:id` en routes — Fastify lo enruta bien por orden de declaración. Si llegan a chocar, mover.
5. **El worker `mensajeFormativoWorker` existente** (canal=zajuna) recibe ahora `mensajeId` en el job — verificar que su firma actual sea compatible con `{ mensajeId, userId, destinatarios, cuerpo, zajunaUserEnc, zajunaPassEnc }`. Si no, ajustar el `mensajesQueue.add()` de `enviar-masivo`.
