# Plan 007: esAprobada debe leer la nota cualitativa A/D (60 entregas reales mal juzgadas en actas)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 762970a..HEAD -- api/src/lib/calificacion.js api/src/lib/calificacion.test.js api/src/routes/actas.js`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition. (Si el plan 002 ya corrió, los selects
> de actas.js pueden haberse movido de línea — buscarlos por contenido, no por número.)

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (recomendado ANTES del plan 002, para que sus tests nazcan contra el comportamiento corregido)
- **Category**: bug
- **Planned at**: commit `762970a`, 2026-06-10

## Why this matters

En el SENA muchas evidencias se califican SOLO con la escala cualitativa A/D, sin nota numérica (es el tema documentado en `docs/PLAN_NOTA_Y_PRODUCCION.md`). Verificado contra la DB de producción-dev el 2026-06-10:

- **60 entregas** tienen `notaCualitativa = "A"` y `notaActual = null` → son aprendices APROBADOS.
- Pero `esAprobada()` (`api/src/lib/calificacion.js`) solo mira `notaActual` y `estado`, y los `estado` reales en DB son únicamente `calificado | pendiente | sin_entregar` (verificado con groupBy). Resultado: esas 60 entregas evalúan como NO aprobadas → el RAP sale **PENDIENTE** en el acta cuando debería salir **APROBÓ**. Falso negativo en la función estrella del producto.
- Además los 4 queries de entregas en `actas.js` ni siquiera traen la columna `notaCualitativa`, así que el fix tiene dos mitades (lib + selects).
- Bug latente adicional en la misma función: el regex `/aprobad/` es substring match — `"desaprobado"` y `"no aprobado"` CONTIENEN `"aprobad"` y aprobarían en falso si algún scraper/CSV llegara a poblar `estado` con esos textos (hoy no ocurre, pero es una mina enterrada).

## Current state

- `api/src/lib/calificacion.js:18-24` — la función con el hueco:
  ```js
  function esAprobada(e) {
    if (e.notaActual !== null && e.notaActual !== undefined) {
      return e.notaActual >= UMBRAL_SENA;
    }
    const est = (e.estado ?? "").toLowerCase();
    return /aprobad/.test(est) || est === "a";
  }
  ```
  Nunca lee `e.notaCualitativa`. El `est === "a"` cubre un caso que en los datos reales no existe (la "A" vive en `notaCualitativa`, no en `estado`).
- `api/src/routes/actas.js:424, 432, 1284, 1289` — los 4 selects idénticos (auto-poblar ×2 y preview-native ×2):
  ```js
  select: { aprendizId: true, evidenciaId: true, estado: true, notaActual: true },
  ```
- `api/src/routes/actas.js:463-465` (y su gemelo ~1312-1314) — las evidencias virtuales inyectadas:
  ```js
  const entregasDelRap = [...evidIds].map(eid =>
    entregasMap.get(eid) ?? { evidenciaId: eid, estado: "sin_entregar", notaActual: null }
  );
  ```
  (No necesitan `notaCualitativa` — `esAprobada` debe tolerar que falte el campo.)
- **El patrón correcto ya existe en el repo** — `api/src/lib/mensajesMasivos.js:26-30` lee la cualitativa así:
  ```js
  function esEntregaDesaprobada(e) {
    if (e.estado === "sin_entregar") return false;
    if (/^d/i.test(String(e.notaCualitativa ?? "").trim())) return true;
    return e.notaActual != null && Number(e.notaActual) < 70;
  }
  ```
- Datos reales (DB 2026-06-10, query groupBy de solo lectura): `estado` ∈ {sin_entregar: 1408, pendiente: 11, calificado: 251}; `notaCualitativa` ∈ {A: 232 (60 sin notaActual), D: 19 (3 sin notaActual), null: 1419}.
- Reglas de negocio que NO cambian (CLAUDE.md §5.10/§5.11): umbral 70; la nota numérica manda sobre todo lo demás; `calificado` sin evidencia explícita de aprobación NO aprueba.
- Tests existentes: `api/src/lib/calificacion.test.js` (node:test) — varios casos dependen del comportamiento actual de `estado: "A"`; se conservan y se AGREGAN los de cualitativa.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Tests | `npm test` | todos pasan |
| Sintaxis | `node --check api/src/lib/calificacion.js` y `node --check api/src/routes/actas.js` | exit 0 |

## Scope

**In scope**:
- `api/src/lib/calificacion.js` (solo `esAprobada` y su comentario de cabecera)
- `api/src/lib/calificacion.test.js` (agregar casos)
- `api/src/routes/actas.js` (SOLO agregar `notaCualitativa: true` a los 4 selects)

**Out of scope** (NO tocar):
- `api/src/lib/mensajesMasivos.js` — su `esEntregaDesaprobada` ya es correcta; es el ejemplar, no el paciente.
- `calcularEstado`, `calcularJuicio`, `tieneParticipacion`, `esPendiente` — sin cambios.
- Los workers/scrapers que escriben `notaCualitativa` — la escritura ya funciona (hay 251 filas pobladas).
- El umbral 70 y cualquier regla SENA (CLAUDE.md §9.5).

## Git workflow

- Branch: `advisor/007-esaprobada-cualitativa` (desde `master`).
- Commit estilo repo: `fix(calificar): esAprobada lee la cualitativa A/D — 60 entregas reales salian PENDIENTE`.
- NO push ni PR salvo instrucción del operador.

## Steps

### Step 1: Corregir `esAprobada` en `api/src/lib/calificacion.js`

Reemplazar la función por:

```js
// ¿La entrega está aprobada?
// Prioridad de señales (regla SENA, CLAUDE.md §5.10/§5.11):
//   1. Nota numérica (manda sobre todo): >= 70 aprueba.
//   2. Cualitativa explícita: "A" aprueba, "D" no (muchas evidencias SENA
//      se califican SOLO con A/D, sin número — 60 casos reales en DB).
//   3. Estado textual: "aprobad..." aprueba, PERO "desaprobado"/"no aprobado"
//      NO (el regex viejo /aprobad/ los matcheaba por substring).
//   "calificado" sin ninguna señal explícita NO aprueba (§5.11).
function esAprobada(e) {
  if (e.notaActual !== null && e.notaActual !== undefined) {
    return e.notaActual >= UMBRAL_SENA;
  }
  const cual = String(e.notaCualitativa ?? "").trim().toLowerCase();
  if (cual === "a") return true;
  if (cual.startsWith("d")) return false;
  const est = (e.estado ?? "").toLowerCase();
  if (/desaprobad|no\s+aprobad/.test(est)) return false;
  return /aprobad/.test(est) || est === "a";
}
```

Notas: `e.notaCualitativa` puede venir `undefined` (evidencias virtuales y otros callers) — el `?? ""` lo cubre. El `est === "a"` se conserva por compatibilidad con los tests/datos legados.

**Verify**: `node --check api/src/lib/calificacion.js` → exit 0; `npm test` → los tests EXISTENTES siguen verdes (ninguno contradice el cambio: no hay ningún test actual con notaCualitativa ni con "desaprobado").

### Step 2: Tests de regresión

En `api/src/lib/calificacion.test.js`, sección nueva `// ─── esAprobada: cualitativa A/D ───`:

1. `esAprobada({ notaActual: null, estado: "calificado", notaCualitativa: "A" })` → **true** (el caso de las 60 filas reales).
2. `esAprobada({ notaActual: null, estado: "calificado", notaCualitativa: "D" })` → false.
3. `esAprobada({ notaActual: 50, notaCualitativa: "A" })` → false (la numérica manda — regla §5.10).
4. `esAprobada({ notaActual: null, estado: "calificado" })` → false (sin cualitativa, sin cambio — §5.11).
5. `esAprobada({ notaActual: null, estado: "Desaprobado" })` → **false** (regresión del regex substring).
6. `esAprobada({ notaActual: null, estado: "No aprobado" })` → false.
7. `esAprobada({ notaActual: null, estado: "sin_entregar", notaCualitativa: undefined })` → false (evidencia virtual no explota).

**Verify**: `npm test` → verde con los 7 nuevos.

### Step 3: Traer `notaCualitativa` en los 4 selects de actas.js

En `api/src/routes/actas.js`, en los 4 lugares (líneas 424, 432, 1284, 1289 al momento de escribir — si el plan 002 ya corrió, localizarlos buscando `select: { aprendizId: true, evidenciaId: true, estado: true, notaActual: true }`), agregar `notaCualitativa: true`. Son los únicos cambios en este archivo.

**Verify**: `node --check api/src/routes/actas.js` → exit 0; `git grep -c "notaCualitativa: true" api/src/routes/actas.js` → 4.

### Step 4: Validación con datos reales (si hay DB disponible)

Script efímero de solo lectura (NO commitearlo — correrlo con `node -e` o borrarlo después): tomar las entregas con `notaCualitativa: "A", notaActual: null`, pasarlas por la `esAprobada` nueva y confirmar que las 60 dan true. Opcional pero recomendado: pedir al operador regenerar el preview de un acta de la ficha afectada y confirmar que aprendices antes PENDIENTE ahora salen APROBÓ.

**Verify**: el conteo de aprobadas-cualitativas coincide con la DB (60 al día de escritura; puede crecer con nuevos scans).

## Test plan

Los 7 casos del Step 2 en `api/src/lib/calificacion.test.js` (mismo archivo y estilo de los tests existentes). `npm test` → todo verde.

## Done criteria

- [ ] `npm test` exit 0, con los 7 tests nuevos visibles en el output.
- [ ] `git grep -c "notaCualitativa: true" api/src/routes/actas.js` → 4.
- [ ] `esAprobada` lee `notaCualitativa` y rechaza `desaprobado`/`no aprobado` (visible en el diff).
- [ ] Ningún archivo fuera del scope modificado (`git status`).
- [ ] Ningún script temporal de validación quedó en el working tree.
- [ ] Fila actualizada en `plans/README.md`.

## STOP conditions

Stop and report back (do not improvise) if:

- Algún test EXISTENTE de `calificacion.test.js` falla con la función nueva — significa que un comportamiento documentado contradice este fix; reportar cuál antes de tocar el test.
- Encuentras un quinto select de entregas en actas.js (o en otro consumidor de `calcularEstado`) que también omita `notaCualitativa` — agregarlo está bien si es idéntico; si tiene otra forma, reportar.
- En la validación del Step 4, alguna entrega con cualitativa "A" sigue dando no-aprobada — hay otra señal en juego; no parchear a ciegas.
- Te ves tentado a "unificar" esAprobada con esEntregaDesaprobada de mensajesMasivos — son contratos distintos (aprobada ≠ ¬desaprobada: una `pendiente` no es ninguna de las dos); fuera de scope.

## Maintenance notes

- Cuando se implemente la lectura de notas del grader report (`docs/PLAN_NOTA_Y_PRODUCCION.md`), más entregas tendrán `notaActual` numérica y la rama cualitativa se usará menos — pero las evidencias solo-A/D existirán siempre; no eliminarla.
- Reviewer: verificar que el diff de actas.js sea SOLO los 4 selects (+nada de lógica).
- Si el plan 002 corre después de este, su extracción de helpers debe llevarse los nuevos comentarios de `esAprobada` tal cual.
- Las 3 entregas con "D" sin nota salían "no aprobada" por accidente (estado calificado → false); con el fix salen no-aprobadas por la razón correcta — sin cambio visible.
