# Handoff — Ingeniería inversa Extension Z + Plan de implementación

## Estado: ✅ Análisis completo | 🔧 Implementación en curso

---

## Qué encontramos (resumen ejecutivo)

Extension Z tiene su propio backend SaaS en `https://extensiont.tuyweb.com`.
Si ese servidor cae, la extensión deja de funcionar. **Nuestro proyecto no tiene esa dependencia.**

Reportes completos en `output/`:
- `output/agent1/FEATURE_MAP.md` — 11 features mapeadas al código fuente
- `output/agent2/REPORTE_V2_FLOW.md` — flujo completo del reporte V2 (9 pasos)
- `output/agent2/DATA_STRUCTURES.md` — esquemas de datos exactos
- `output/agent3/GAP_TABLE.md` — comparación feature × feature vs nuestro proyecto
- `output/agent3/SPRINT_BACKLOG.md` — backlog priorizado
- `output/agent3/REUSE.md` — selectores DOM + payloads AJAX listos para copiar

---

## Estado de ramas (Windsurf, 2026-05-18)

| Rama | Commit | Estado |
|---|---|---|
| `fix/hide-ia-matching` | 6169fe6 | ✅ OK — IA Matching comentado en Layout.tsx |
| `fix/mensajes-bugs` | 46de0dd | ⚠️ Parcial — Bug 1 (subject) OK; Bug 2 (email) usa `/user/index.php` en vez del grade report |
| `fix/actas-autopoblar` | 897f11c | ✅ OK — dual mode per-RAP / global-fallback, lógica correcta |

**Pendiente de merge a `feat/frontend-resilience-e2e`:** las 3 ramas de Windsurf.
**Pendiente de commit:** `web/src/pages/AjustesPage.tsx` (PROVEEDORES dropdown — working tree).

---

## El bug crítico que Windsurf NO resolvió

`sincronizarParticipantes` sigue usando `/user/index.php` con selectores que no existen en Zajuna.

**Fix confirmado por ingeniería inversa (REUSE.md):**
```
URL: GET /grade/report/grader/index.php?id={courseId}&perpage=0&sifirst&silast
Selector email:     tr[data-uid].userrow > td[data-col="email"]
Selector cédula:    tr[data-uid].userrow > td[data-col="username"]
Selector nombre:    tr[data-uid].userrow  a.username (textContent)
Selector moodleId:  tr[data-uid] → atributo data-uid
```
Archivo a modificar: `scraper/evidencias.js` función `obtenerMatriculados`.
Worker a actualizar: `api/src/workers/syncParticipantesWorker.js`.

---

## Plan de implementación

### Fase 1 — Quick wins (esta semana)

**P1-4 — Fix email scraper** | Esfuerzo: S | Modelo Windsurf: Sonnet
- Rama: `fix/email-grade-report`
- Extiende `obtenerMatriculados` con el selector confirmado arriba
- Desbloquea TODO el módulo de mensajería masiva

**P1-1 — Distinguir A vs D en entregas** | Esfuerzo: S | Modelo: Sonnet
- Rama: `fix/grade-avsd`
- `revisarEntregas` en `scraper/evidencias.js`: leer cols[6], guardar "A"/"D" en estado
- `esAprobada()` en `actas.js`: notaActual===100 o estado==="A" → APROBÓ
- `esDesaprobada()` nuevo: notaActual===0 o estado==="D" → NO PARTICIPÓ (no PENDIENTE)

**P2-2 — Parser "hace X días"** | Esfuerzo: S | Modelo: Haiku
- Rama: `fix/lastaccess-parser`
- `syncParticipantesWorker.js`: regex para "hace N días/horas/minutos"

### Fase 2 — AJAX Moodle (próxima semana)

**P1-2 — mod_assign_list_participants** | Esfuerzo: M | Modelo: Sonnet
- Detectar BR (borrador) / SN (sin nota) / RV (revisión) por aprendiz
- Payload en `output/agent3/REUSE.md` sección "Moodle AJAX Calls"
- Requiere extraer sesskey: `window.M?.cfg?.sesskey` vía page.evaluate()

**P1-3 — lastaccess desde AJAX** | Esfuerzo: M | Modelo: Sonnet
- `core_grades_get_enrolled_users_for_selector` → `Aprendiz.ultimoAcceso`
- Payload en REUSE.md

### Fase 3 — Reporte Excel (cuando actas esté estable)

**P1-5 — Excel con exceljs** | Esfuerzo: M | Modelo: Sonnet
- `GET /api/actas/:id/download/excel`
- Verde=APROBÓ / Amarillo=PENDIENTE / Rojo=NO PARTICIPÓ
- Sin SaaS — 100% server-side

---

## Ventajas del proyecto sobre Extension Z

1. Sin dependencia SaaS — todo self-hosted
2. PostgreSQL vs IndexedDB — multidispositivo, persistente
3. Word GOR-F-084 institucional — la extensión solo hace Excel
4. Workers BullMQ — async, la extensión bloquea el navegador 5-10 min
5. Multitenant — múltiples instructores en el mismo deploy
6. Auditoría e historial — la extensión no tiene logs
7. `mod_assign_list_participants` sin dirty state — la extensión V1 deja Moodle sucio

---

## Orden de trabajo acordado

1. Windsurf implementa P1-4 y P1-1 (en ramas separadas)
2. Claude audita ambas ramas
3. Si pasan → merge a feat/frontend-resilience-e2e
4. Seguir con P1-2 (AJAX) + P1-5 (Excel)
