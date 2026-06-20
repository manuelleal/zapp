# Registro de Cambios y Progreso de la Sesión

---

## Sesión 19 junio 2026 — Auditoría de release + acta GOR-F-084 pulida

### Implementado y verificado

**1. Acta DOCX — formato oficial GOR-F-084 V02 ✅**
- `api/src/lib/actaSaneado.js` — saneo de textos (tildes, ñ, caracteres Moodle) antes de generar el Word.
- Logo SENA real incrustado (`api/assets/sena-logo.png`).
- Nota de revisión y vocera/vocero de formación siempre visibles.
- Smoke test en 5 fichas/competencias con 1, 2 y 3 RAPs — todos generaron Word limpio.

**2. Auditoría de release con 6 agentes ✅**
- Informes en `docs/auditoria-release/` (00-consolidado + 01–06 por área).
- 1 bug P0 cerrado: IDOR cross-tenant en `confirm-native`.
- 4 P1 cerrados: IDOR matching, errorHandler global, foroRating `attempts→1`, modal mapeo `isError`.
- 5 fixes mobile: nav hamburguesa, tablas mensaje con scroll, modal nueva acta responsive.
- Veredicto: GO para push, NO-GO de despliegue (falta infra: rotar key, `ALLOWED_ORIGIN`, VPS, TLS).

**3. `docs/DEPLOY.md` creado — runbook completo de despliegue**

---

## Sesión 10 junio 2026 — Mensajes programados + selector evidencias

**1. Selector de evidencias en MensajesPage ✅**
- Modal agrupado por competencia + Guía N; competencia del instructor premarcada.
- `POST /api/mensajes/enviar-masivo` acepta `evidenciaIds` e `incluirDesaprobadas`.

**2. Filtros rápidos de destinatarios ✅**
- Filtros de 1 click: todos / con pendientes / con desaprobadas / inactivos >7d / nunca entraron.
- `GET /api/mensajes/aprendices` incluye resumen de entregas por aprendiz.

**3. Mensajes programados/recurrentes ✅**
- Modelo `MensajeProgramado` (filtro + alcance; `pausadoAt` soft-state).
- Worker `mensajesProgramadosWorker`, tick cada 10 min, claim idempotente.
- Tope anti-spam: intervalo 1–60 días, máx 1 corrida/día.
- E2E: 17/17 verdes.

---

## Sesión 9 junio 2026 — MVP: 11 commits + matching IA + pruebas E2E

**Matching IA automático — `scripts/matchearCompetenciaIA.js` ✅**
- `api/src/lib/aiClient.js` — cliente IA agnóstico (OpenRouter/Kimi/Anthropic por env).
- Run `--todas`: 17 competencias, `RapEvidenciaRel`: 477 → **2147**.
- Fix de registro: `POST /api/auth/register` ahora vincula `User.competenciaId` por código.
- Pruebas E2E: `test-multitenant.js` 36/36, flujo real técnico/tecnólogo OK.

**Actas desbloqueadas ✅**
- `vincularEvidenciasRAPs.js` → 307 vínculos; `auto-poblar` en vivo con 51 aprendices.

**Commits noche (acc2f3f..7f686b7):**
- Fix calificar (nota + estado juntos), fix config fechas, `{{evidencias}}` en mensajes, perf grader + índices, JWT rotado.

---

## Sesión 3 junio 2026 — Nota cualitativa A/D (Fases 1–4)

- `Entrega.notaCualitativa String?` y `Evidencia.itemid Int?` en DB.
- `obtenerNotasGrader()` en scraper: captura número Y letra A/D desde grader report.
- Worker cablea nota real por `itemid`; override CSV queda como fallback.
- Fases 5–6 (UI badge A/D, subestados) pendientes.

---

## Sesión 2 junio 2026 — Refactor P0 (process-split)

**5 fixes P0 mergeados a `master`:**
1. `api/src/worker-entry.js` (nuevo) — 16 workers en proceso separado. OOM no tumba la API.
2. `api/src/lib/browserPool.js` (nuevo) — Chromium compartido + context-por-job.
3. Bloqueo de recursos (imagen/CSS/fuente) en `acquireContext`. Kill-switch `BROWSER_BLOCK_RESOURCES=0`.
4. Semáforo `BROWSER_MAX_CONTEXTS` (default 10).
5. Rate-limit real: `RATE_MAX = process.env.RATE_MAX || 10`.
6. `ecosystem.config.js` — PM2 `api` + `workers` (workers `instances:1` fork).

---

## Sesión 31 mayo 2026 — Scan CAPA 1+2 AJAX

- CAPA 1: escrituras DB en lote (`findMany` + `createMany + $transaction`). De ~4500 queries seriales a decenas.
- CAPA 2: `mod_assign_list_participants` via sesskey. 1 POST batch por ficha = 2,7 s para 147 participantes.
- `Evidencia.assignId/contextId` — cache del instance id para el batch AJAX.
- Fallback DOM intacto.

---

## Sesión 25 mayo 2026 — Claude Code

### Implementado y verificado en esta sesión

**1. Gradebook Tree (`feature/gradebook-scan-v2`) — ✅ IMPLEMENTADO Y TESTEADO**
- `scraper/evidencias.js`: `obtenerEvidencias()` reemplaza las 3 Index Pages por `/grade/edit/tree/index.php?id={courseId}`. Selector: `tr[data-grademax].item a.gradeitemheader`.
- Resultado verificado con `node test-gradebook-tree.js 50283`: **199 evidencias** (vs 48 anteriores), **18 competencias** detectadas incluyendo GA4–GA11 con `220501095`, `220501096`, `220501097`, `220501098`.
- `autoScanWorker.js`: `full=true` procesa fichas con 0 evidencias en DB.
- **RAMA LISTA — pendiente merge a main.**

**2. Extracción completa de Guías desde Zajuna — ✅ EJECUTADO EN PRODUCCIÓN**
- `scripts/extraerGuiasDesdeZajuna.js`: crawler Playwright que descubre todos los `mod/page` del curso (guías son páginas con botón `window.open(urlPDF)`, NO archivos `mod/resource`).
- Corrido sin dry-run contra courseId=50283: **15/15 guías procesadas, 19 competencias y 75 RAPs persistidos en DB**.
- Mismo mecanismo de descarga que el ya existente `scraper/probes/probeGuiaRecurso.js`.

**3. Bug actas.js rapPorSufijo — ✅ CORREGIDO (`feature/strict-rap-mapping`)**
- Eliminado bloque que infería `GA{N} → RAP sufijo N` matemáticamente. Solo `RapEvidenciaRel` + `MatchingPropuesta(aceptado)`. Sin vínculos → `global-fallback`.

**4. Modo Dios / Simulador de Competencias — ✅ IMPLEMENTADO Y SMOKE-TESTEADO**
- 3 endpoints en `api/src/routes/ajustes.js`: `POST /descubrir-competencias`, `POST /simular-competencia`, `GET /api/competencias`.
- Worker `descubrirCompetenciasWorker.js`, card en `AjustesPage.tsx`.
- Smoke test 11/11 ✅ (`scripts/smoke-test-simulador.js`).

### Estado de DB post-sesión

| Tabla | Valor |
|---|---|
| Competencias | 19 |
| RAPs | 75 |
| Evidencias ficha 3186683 | 48 (worker pendiente) |
| RapEvidenciaRel | 0 (pendiente vincular) |

### Próximos 3 pasos para mañana

1. `git merge feature/strict-rap-mapping && git merge feature/gradebook-scan-v2` → reiniciar servidor
2. Escanear ficha 3186683 desde la UI → 199 evidencias en DB
3. `node scripts/vincularEvidenciasRAPs.js` → RapEvidenciaRel poblado → actas en modo `per-rap`

---

## Sesión anterior (Antigravity) — Descubrimiento Gradebook Tree

Durante esa sesión se realizó ingeniería inversa a la Extensión Zajuna (archivo `root.PiOpq-8m.js`) y se descubrió que la ruta `/grade/edit/tree/index.php` expone el 100% de los ítems calificables del curso incluyendo los ocultos. Se delegó la implementación a Claude Code, quien la completó y verificó en esta sesión.
