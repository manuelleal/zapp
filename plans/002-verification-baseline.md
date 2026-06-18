# Plan 002: Establecer el baseline de verificación (CI mínimo + tests de rutas de actas + e2e ejecutable)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 762970a..HEAD -- api/src/routes/actas.js api/src/lib/calificacion.js api/src/lib/calificacion.test.js package.json web/package.json`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none (recomendado después de 001 para que el CI nazca con deps limpias)
- **Category**: tests
- **Planned at**: commit `762970a`, 2026-06-10

## Why this matters

El repo NO tiene CI (`.github/workflows/` no existe) y solo 2 archivos de test backend (`api/src/lib/calificacion.test.js`, `api/src/workers/evidenciasWorker.estado.test.js`). El motor de calificación tiene tests, pero **la capa de rutas de actas — la función estrella del producto — tiene cero**: `auto-poblar`, `preview-native` y el armado del mapa RAP→evidencias en `api/src/routes/actas.js` solo se verifican a mano contra Moodle real. Además existe un spec E2E de Playwright (`web/tests/e2e/actas-flow.spec.ts`) sin ningún script que lo ejecute. Cualquier regresión en actas o mensajes llega a producción sin red. Este plan crea la red: helpers puros testeables, tests de la lógica de actas, y un workflow de CI que corre sintaxis+tests+build en cada push.

## Current state

- **Test runner**: `package.json:9` → `"test": "node --test \"api/**/*.test.js\""`. Node v24 local (soporta globs en `--test`). Sin frameworks: `node:test` + `node:assert/strict`.
- **Patrón de test existente** — `api/src/lib/calificacion.test.js:1-27`:
  ```js
  // Tests del motor de calificación SENA — `node --test`.
  // Sin dependencias externas: usa node:test + node:assert nativos.
  const { test } = require("node:test");
  const assert = require("node:assert/strict");
  const { UMBRAL_SENA, esAprobada, ... } = require("./calificacion");

  test("esAprobada: umbral universal = 70", () => {
    assert.equal(UMBRAL_SENA, 70);
  });
  ```
  **Imitar este estilo exactamente** (cabecera en español, secciones con `// ─── nombre ───`).
- **`api/src/routes/actas.js`** — rutas de actas. La lógica crítica vive dentro de los handlers de `POST /api/actas/:id/auto-poblar` y `POST /api/actas/preview-native`: armado del mapa RAP→evidencias desde `RapEvidenciaRel` + `MatchingPropuesta(aceptado)`, detección `rapsSinEvidencias` (→ 422 `RAP_SIN_EVIDENCIAS`), inyección de evidencias virtuales `sin_entregar`, y cálculo de juicio por participante. Las funciones puras (`esAprobada`, `calcularEstado`, `calcularJuicio`) ya están extraídas en `api/src/lib/calificacion.js` y SÍ tienen tests.
- **E2E**: `web/tests/e2e/actas-flow.spec.ts` existe; `@playwright/test ^1.60.0` está en `web/package.json` devDependencies; pero `web/package.json` scripts = solo `dev/build/lint/preview` — no hay script de test. No hay `playwright.config.ts` confirmado en `web/` (verificar: si no existe, crearlo mínimo).
- **CI**: no existe `.github/workflows/`. Remote: `origin = https://github.com/manuelleal/zapp.git`, rama default `master`.
- **Comandos de verificación del repo** (CLAUDE.md §3/§5.1): `node --check <archivo>` por archivo tocado, `npm test`, `cd web && npm run build` (corre `tsc -b`).

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Tests backend | `npm test` | todos pasan |
| Sintaxis | `node --check <archivo.js>` | exit 0 |
| Build web (typecheck) | `cd web; npm run build` | exit 0 |
| Lint web | `cd web; npm run lint` | exit 0 (si falla por código preexistente, NO arreglarlo aquí — no incluir lint en CI) |
| E2E (al final) | `cd web; npx playwright test --list` | lista los tests del spec sin error |

## Scope

**In scope**:
- `.github/workflows/ci.yml` (crear)
- `api/src/routes/actas.helpers.js` (crear — extracción de funciones puras de actas.js)
- `api/src/routes/actas.js` (SOLO mover lógica a helpers e importarla; cero cambios de comportamiento)
- `api/src/routes/actas.helpers.test.js` (crear)
- `web/package.json` (agregar script `test:e2e`)
- `web/playwright.config.ts` (crear solo si no existe)

**Out of scope** (NO tocar):
- `api/src/lib/calificacion.js` y su test — ya están bien.
- Cualquier worker, el scraper, `prisma/schema.prisma`.
- NO arreglar errores de lint preexistentes del front.
- NO cambiar el comportamiento de los endpoints de actas (ni el 422, ni el formato de respuesta) — este plan solo agrega red de seguridad.

## Git workflow

- Branch: `advisor/002-verification-baseline` (desde `master`).
- Commits estilo repo: `test(actas): extraer helpers puros + tests de auto-poblar`, `ci: workflow minimo node-check + tests + build web`.
- NO push ni PR salvo instrucción del operador (el CI se valida al pushear — coordinarlo con el operador).

## Steps

### Step 1: Extraer las funciones puras de actas.js a un módulo testeable

Leer `api/src/routes/actas.js` completo. Identificar la lógica **pura** (sin Prisma, sin reply) dentro de los handlers de `auto-poblar` y `preview-native` — típicamente:
- construcción del mapa `rapId → Set<evidenciaId>` a partir de las filas de `RapEvidenciaRel` y `MatchingPropuesta` aceptadas,
- cálculo de `rapsSinEvidencias` (los rapIds del acta sin ninguna evidencia vinculada),
- inyección de evidencias virtuales `sin_entregar` para las evidencias del RAP sin entrega del aprendiz.

Crear `api/src/routes/actas.helpers.js` con esas funciones exportadas, cabecera docstring en español (qué hace, de dónde se extrajo, regla SENA aplicable — ver CLAUDE.md §5.1), y reemplazar el código inline de `actas.js` por imports. **El diff de actas.js debe ser solo mover código, no cambiarlo.**

Si la lógica está tan entrelazada con los queries que extraerla obliga a cambiar comportamiento → extraer solo lo que salga limpio y reportar el resto en las notas finales (no forzar).

**Verify**: `node --check api/src/routes/actas.js` y `node --check api/src/routes/actas.helpers.js` → exit 0. `npm test` → los tests existentes siguen verdes.

### Step 2: Tests de los helpers de actas

Crear `api/src/routes/actas.helpers.test.js` siguiendo el patrón de `api/src/lib/calificacion.test.js`. Casos mínimos:
1. **Mapa RAP→evidencias**: con filas de RapEvidenciaRel para 2 RAPs, el mapa agrupa bien; una MatchingPropuesta aceptada agrega su evidencia; una rechazada no.
2. **rapsSinEvidencias**: acta con 3 rapIds y vínculos solo para 2 → devuelve el tercero (este es el caso que dispara el 422 `RAP_SIN_EVIDENCIAS` — la regresión histórica del producto, ver CLAUDE.md §7 Paso 0).
3. **Tablas vacías** (RapEvidenciaRel=0 y 0 propuestas): TODOS los rapIds quedan sin evidencias.
4. **Evidencias virtuales**: aprendiz con entregas solo para 1 de 3 evidencias del RAP → se inyectan 2 virtuales `sin_entregar`, y `calcularEstado` (importado de `../lib/calificacion`) da NO aprobado aunque la entrega real esté aprobada.

**Verify**: `npm test` → pasan todos, incluidos los ≥4 nuevos.

### Step 3: Workflow de CI mínimo

Crear `.github/workflows/ci.yml`:

```yaml
name: CI
on:
  push:
    branches: [master]
  pull_request:

jobs:
  backend:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - name: Sintaxis api/ y scraper/
        run: |
          find api/src scraper scripts -name "*.js" -print0 | xargs -0 -n1 node --check
      - run: npm test

  web:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm, cache-dependency-path: web/package-lock.json }
      - run: npm ci
        working-directory: web
      - run: npm run build
        working-directory: web
```

Notas: `npm test` no necesita Postgres/Redis (los tests actuales y los nuevos son puros — si alguno requiriera DB, es un STOP). No incluir lint del front (puede tener deuda preexistente).

**Verify**: localmente, simular cada paso: `npm ci` (¡ojo: borra node_modules y reinstala — avisar al operador si hay procesos corriendo!) o en su defecto `npm install`; el `find ... node --check` equivalente en PowerShell: `Get-ChildItem api/src,scraper,scripts -Recurse -Filter *.js | ForEach-Object { node --check $_.FullName; if ($LASTEXITCODE -ne 0) { throw $_.FullName } }` → sin errores; `npm test` → verde; `cd web; npm run build` → exit 0.

### Step 4: Hacer ejecutable el spec E2E

1. En `web/package.json` agregar a scripts: `"test:e2e": "playwright test"`.
2. Si no existe `web/playwright.config.ts`, crearlo mínimo: `testDir: "./tests/e2e"`, `use: { baseURL: process.env.E2E_BASE_URL || "http://localhost:3000" }`.
3. NO agregar el e2e al CI (requiere DB+Moodle vivos); es para correr local con la app levantada.

**Verify**: `cd web; npx playwright test --list` → lista los tests de `actas-flow.spec.ts` sin error de config. (No hace falta que PASEN — requieren la app corriendo; listarlos prueba que están cableados.)

## Test plan

Cubierto en los Steps 2 y 4. Patrón estructural: `api/src/lib/calificacion.test.js`. Verificación global: `npm test` → suite previa + ≥4 tests nuevos, todos verdes.

## Done criteria

- [ ] `npm test` exit 0 con ≥4 tests nuevos de `actas.helpers.test.js`.
- [ ] `node --check` exit 0 sobre `actas.js` y `actas.helpers.js`.
- [ ] `git diff` de `actas.js` muestra solo extracción (mismas expresiones, ahora importadas) — sin cambios de lógica.
- [ ] `.github/workflows/ci.yml` existe y sus comandos pasan en local.
- [ ] `cd web; npx playwright test --list` lista los specs sin error.
- [ ] `cd web; npm run build` exit 0.
- [ ] Fila actualizada en `plans/README.md`.

## STOP conditions

Stop and report back (do not improvise) if:

- La lógica de auto-poblar/preview-native en `actas.js` no coincide con la descripción de "Current state" (el archivo pudo evolucionar — re-evaluar qué extraer).
- Extraer una función obliga a cambiar su comportamiento o su firma de datos (p.ej. la lógica depende de lazy-loading de Prisma).
- Algún test nuevo requiere conexión a Postgres/Redis para pasar — los tests de este plan deben ser puros.
- `npm test` con el glob falla en el runner de CI (diferencias de glob entre versiones de Node) y no se resuelve listando los archivos explícitamente.

## Maintenance notes

- Todo handler nuevo de actas debería apoyarse en `actas.helpers.js` y sumar casos a su test — el reviewer debe rechazar lógica de negocio nueva inline en el handler.
- Cuando exista un entorno de staging con DB, agregar un job de CI con Postgres de servicio y tests de integración de rutas (diferido: hoy no hay fixtures de DB).
- El e2e queda manual a propósito; si más adelante se automatiza, necesitará seed de DB + mock de Moodle.
- Plan 003 (factory de sesión) y 004 (idempotencia mensajes) asumen que este CI ya corre — sus regresiones se detectan aquí.
