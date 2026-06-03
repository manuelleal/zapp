# Plan por fases — Nota cualitativa (A/D) + Roadmap a producción

> Escrito 2026-06-03 tras diagnosticar el falso "pendiente" y la "nota que no aparece".
> Cada FASE es independiente y **se commitea sola** sin dejar la app rota. Si te quedas sin
> tiempo/tokens, paras al final de cualquier fase y todo sigue funcionando.

---

## Contexto del hallazgo (ya verificado en vivo)

- **Falso "pendiente" → YA ARREGLADO** (commit `fix(scan): falso "pendiente"...`). El AJAX
  `mod_assign_list_participants` de SENA **no trae `grade`/`gradingstatus`**; la señal real es
  `requiregrading`. Un assign reabierto y ya calificado quedaba pegado en pendiente.
- **"La nota numérica no aparece"**: porque en muchos cursos la nota es **cualitativa "A"/"D"**
  (escala SENA), NO un número. Hoy el override del CSV hace `parseFloat("A")` → `NaN` → `notaActual`
  queda `null`. La letra se pierde.
- **Cómo lo hace la Extensión Z** (confirmado leyendo `output/agent1/root.pretty.js`): raspa el
  **grader report** (`/grade/report/grader/index.php?id={courseId}&perpage=0`) y por cada celda
  toma `input.value || span.gradevalue.textContent` con regex `/(\d+|D|A)/` → captura **número O
  letra**, indexando por **`data-itemid`** (no por nombre de columna → nunca se le pierde).
- **Ventaja nuestra**: el worker **ya navega ese grader report** (en `obtenerMatriculados`) e
  **ya itera `tr[data-uid].userrow`**. Solo falta leer las celdas de nota.
- **DOM real confirmado** (curso 28221, VICTOR uid 601164): header `th[data-itemid]` (su `href` es
  solo un link de orden `?sortitemid=`, **no** trae el cmid), y celda `td[data-itemid]` con
  `span.gradevalue` = `"A"`. El texto del header SÍ trae el código de la evidencia (ej. "AA1-EV01",
  "GA5-...-EV01").

---

## FASE 1 — Campo en la DB para la nota cualitativa
**Objetivo:** tener dónde guardar "A"/"D". Sin cambio de comportamiento.
- `prisma/schema.prisma`: en `model Entrega` agregar `notaCualitativa String?`.
- Migración: `npx prisma migrate dev --name add_entrega_nota_cualitativa`.
- **Listo cuando:** `npx prisma generate` ok y la app arranca igual. Nada más lo usa todavía.
- **Commit:** `feat(db): Entrega.notaCualitativa para escala A/D`.

## FASE 2 — Cachear el `itemid` del libro por evidencia
**Objetivo:** poder casar nota↔evidencia por id (determinista), no por nombre.
- `prisma/schema.prisma`: `model Evidencia` → `itemid Int?` (+ migración `add_evidencia_itemid`).
- `scraper/evidencias.js` → `obtenerEvidencias` (gradebook tree): capturar el `data-itemid` de
  cada ítem y devolverlo junto a `nombre/href/tipo`.
- `evidenciasWorker.js` (Fase 1 discovery): persistir `itemid` en el upsert de la evidencia
  (como ya se hace con `assignId`).
- **Fallback** si el tree no expone itemid limpio: mapear por el **código** del header del grader
  (`AA#-EV##` / `GA#-...-EV##`) contra `Evidencia.nombre` — mucho más fiable que el fuzzy actual.
- **Listo cuando:** tras un scan, las evidencias tienen `itemid` poblado en DB. Comportamiento de
  nota/estado SIN cambios todavía.
- **Commit:** `feat(scan): cachear itemid del libro de calificaciones por evidencia`.

## FASE 3 — Lector de notas del grader report (función pura, sin cablear)
**Objetivo:** una función que devuelva las notas, sin tocar el flujo aún.
- `scraper/evidencias.js`: `async function obtenerNotasGrader(page, courseId)` que navega el grader
  report (reutilizar `perpage=5000`) y devuelve `Map<itemid, Map<moodleUserId, { numero:Number|null,
  letra:'A'|'D'|null }>>`. Regla extensión: `input.value || span.gradevalue.textContent` →
  `/(\d+(?:[.,]\d+)?|A|D)/`.
- Exportarla en `module.exports`. **No** se llama desde el worker todavía.
- **Listo cuando:** un test/probe muestra la nota "A" de VICTOR por su itemid. 27→28 tests verdes.
- **Commit:** `feat(scraper): obtenerNotasGrader (nota numerica y A/D por itemid)`.

## FASE 4 — Cablear la nota real en el worker (reemplaza el match fuzzy del CSV)
**Objetivo:** que el scan guarde número Y A/D de forma determinista.
- `evidenciasWorker.js`: llamar `obtenerNotasGrader` **una vez** por scan; al construir cada
  `entrega`, buscar por `(evidencia.itemid, aprendiz.moodleId)`:
  - número → `notaActual`;
  - letra → `notaCualitativa` (+ `notaActual` null o sin tocar);
  - sigue respetando: cierre manual, umbral 70, `fechaScan` al cambiar nota O estado.
- Mantener el override CSV como **fallback** (no borrarlo) por si el grader falla.
- **Listo cuando:** re-escanear ficha 3070432 → VICTOR muestra `notaCualitativa="A"`. Tests verdes.
- **Commit:** `fix(scan): nota numerica/cualitativa desde grader report por itemid`.

## FASE 5 — Mostrar A/D en la UI
**Objetivo:** que el instructor vea la letra.
- `web/src/components/AprendicesPanel.tsx` (y donde se liste la entrega): badge con
  `notaCualitativa` ('A' verde / 'D' rojo) además del número.
- `cd web && npm run build`.
- **Listo cuando:** la evidencia de VICTOR muestra "A" en la app.
- **Commit:** `feat(ui): badge de nota cualitativa A/D`.

---

## Roadmap a PRODUCCIÓN (lo que falta para que otros la prueben)

Orden recomendado (de mayor a menor impacto en el usuario):

1. **🔴 Desbloquear ACTAS — el bloqueador #1 real.** `RapEvidenciaRel=0` → generar/previsualizar
   actas devuelve **422 a todos**. Ver `project_actas_blocker` y CLAUDE.md §Paso 0. Correr
   `node scripts/vincularEvidenciasRAPs.js` (con `--dry-run` primero) o terminar
   `MapeoAlVueloModal`. **Esto importa más que la nota A/D.**
2. **🟢 Nota A/D** (Fases 1-5 de arriba) — calidad de datos visible.
3. **🟠 Test de carga del refactor P0**: 3-15 scans concurrentes con credenciales reales; vigilar
   `[browserPool] cap alcanzado`. Kill-switch `BROWSER_BLOCK_RESOURCES=0` si el SSO fallara.
4. **🟠 Commitear Fase 2 UI pendiente** (ActasPage/Dashboard/EvidenciasConfig — ver CLAUDE.md §7),
   probándola en browser antes.
5. **🟢 Deploy**: `pm2 start ecosystem.config.js` (api + workers). PM2 7.0.1 ya instalado.
6. **🟢 Merge** `refactor/p0-process-split` → `master` cuando 1-5 estén validados.

### Higiene opcional (no bloquea)
- Limpiar duplicados sucios de Aprendiz (ej. "VICTOR... HINCAPIE " con espacio final, y prefijos
  "VH"/"AC"). Ya documentado; el dedup de actas los maneja en memoria.
- P1/P2 de CLAUDE.md §11.3 (migrar lectura a Node fetch, rate-limit a Redis, idempotencia
  foroRating, etc.).
