# Plan 005: Higiene de configuración y dependencias (.env.example, fallback de superadmin, deps muertas)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 762970a..HEAD -- api/src/routes/ajustes.js api/src/server.js api/src/lib/fetchWithRetry.js web/package.json DEVELOPER_ONBOARDING.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `762970a`, 2026-06-10

## Why this matters

Cuatro asperezas pequeñas pero con costo concreto antes de poner la app frente a más instructores:
1. **No hay `.env.example`** — un dev nuevo no puede arrancar sin pedir el `.env` o leer CLAUDE.md §6 con lupa, y el riesgo de inventar nombres de variables es real (hay ~10 variables activas).
2. **`SUPERADMIN_EMAIL` tiene un fallback hardcodeado con el email personal del dueño** en `api/src/routes/ajustes.js:6` — identifica públicamente la cuenta más privilegiada del sistema en el código fuente.
3. **El server arranca con `JWT_SECRET` undefined** sin quejarse (`server.js:20`) — con fast-jwt viejo eso era bypass de auth; aún con el fix del plan 001, arrancar sin secreto debe ser un error fatal, no un footgun.
4. **Deps/código muerto**: `api/src/lib/fetchWithRetry.js` no lo importa nadie (confirmado por grep — solo se menciona a sí mismo), y `@anthropic-ai/sdk` está en `web/package.json` dependencies sin un solo import en `web/src` (confirmado por grep).

## Current state

- `.env` existe y **NO está trackeado** (`git ls-files .env` vacío; `.gitignore` lo cubre). `.env.example` no existe.
- Variables documentadas en CLAUDE.md §6: `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `ENCRYPTION_KEY` (64 hex), `ANTHROPIC_API_KEY`, `ZAJUNA_USER`, `ZAJUNA_PASS`. Además, en código: `SUPERADMIN_EMAIL` (`ajustes.js:6`), `ALLOWED_ORIGIN` (`server.js:16`), `OPENROUTER_API_KEY` / `OPENROUTER_MODEL` / `AI_PROVIDER` / `AI_JSON_MODE` (`api/src/lib/aiClient.js`, CLAUDE.md §14.1), `BROWSER_BLOCK_RESOURCES` / `BROWSER_MAX_CONTEXTS` (`api/src/lib/browserPool.js`), `RATE_MAX` (`scraper/auth.js`). **Verificar la lista con un grep antes de escribir el example** (`git grep -h "process\.env\." -- api/ scraper/ | sort -u`).
- `api/src/routes/ajustes.js:6`:
  ```js
  const SUPERADMIN = process.env.SUPERADMIN_EMAIL ?? "ddiddimmo@gmail.com";
  ```
- `api/src/server.js:20`:
  ```js
  fastify.register(require("@fastify/jwt"), { secret: process.env.JWT_SECRET });
  ```
- `api/src/lib/fetchWithRetry.js` — helper de retry modelado en la Extensión Z, nunca cableado (CLAUDE.md §11.2 lo confirma: "NO se importa en ningún worker").
- `web/package.json` — `"@anthropic-ai/sdk": "^0.96.0"` en dependencies; `grep -ri anthropic web/src` → 0 archivos.
- **REGLA DE SEGURIDAD**: al crear `.env.example` usar SOLO placeholders (`JWT_SECRET=generar-con-openssl-rand-hex-32`). JAMÁS copiar un valor real del `.env` — ni siquiera leerlo.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Sintaxis | `node --check <archivo.js>` | exit 0 |
| Tests | `npm test` | todos pasan |
| Build web | `cd web; npm run build` | exit 0 |
| Imports muertos | `git grep -l "fetchWithRetry" -- api/ scraper/` | solo el propio archivo (antes de borrar) / vacío (después) |

## Scope

**In scope**:
- `.env.example` (crear)
- `api/src/routes/ajustes.js` (quitar fallback)
- `api/src/server.js` (guard de JWT_SECRET)
- `api/src/lib/fetchWithRetry.js` (borrar)
- `web/package.json` + `web/package-lock.json` (quitar @anthropic-ai/sdk)
- `DEVELOPER_ONBOARDING.md` (referenciar el .env.example en la sección de setup)

**Out of scope** (NO tocar):
- `.env` — ni leerlo ni modificarlo.
- `CLAUDE.md` — el operador lo mantiene a mano (regla §8.4).
- `scripts/setup-instructor-real.js` y demás scripts de prueba con el email/credenciales de test — son drivers de dev conocidos, su limpieza es decisión del operador pre-producción (CLAUDE.md §14.5).
- El `@anthropic-ai/sdk` del `package.json` RAÍZ — ese SÍ se usa (backend).

## Git workflow

- Branch: `advisor/005-higiene-env-deps` (desde `master`).
- Commits estilo repo: `chore(dx): .env.example + guard de JWT_SECRET`, `chore(deps): quitar fetchWithRetry muerto y @anthropic-ai/sdk del front`.
- NO push ni PR salvo instrucción del operador.

## Steps

### Step 1: Crear `.env.example`

Generar la lista real con `git grep -h "process\.env\." -- api/ scraper/ | sort -u`, cruzarla con la lista de "Current state", y escribir `.env.example` con UNA línea por variable + comentario corto en español de qué es y cómo generarla. Placeholders, nunca valores. Ejemplo de formato:

```env
# PostgreSQL local de docker-compose (ver CLAUDE.md §3)
DATABASE_URL=postgresql://zajuna:zajuna@localhost:5432/zajuna
# Generar: openssl rand -hex 32
JWT_SECRET=
# AES-256-GCM para credenciales Zajuna. Generar: openssl rand -hex 32 (64 chars hex)
ENCRYPTION_KEY=
```

**Verify**: el archivo lista todas las variables que aparecen en el grep; `git diff --stat` no muestra `.env`.

### Step 2: Quitar el fallback de SUPERADMIN_EMAIL y agregar el guard de JWT_SECRET

1. `api/src/routes/ajustes.js:6` → `const SUPERADMIN = process.env.SUPERADMIN_EMAIL || null;` y en cada uso, si `SUPERADMIN` es null, el chequeo de superadmin simplemente no matchea (leer el archivo: si hay un `if (user.email === SUPERADMIN)`, null nunca matchea — comportamiento seguro por defecto). Si el archivo usa SUPERADMIN de una forma donde null rompe (p.ej. `.toLowerCase()`), proteger con el null-check.
2. `api/src/server.js`, antes del register de jwt:
   ```js
   if (!process.env.JWT_SECRET) {
     console.error("FATAL: JWT_SECRET no está definido en .env — el server no puede arrancar sin él.");
     process.exit(1);
   }
   ```

**Verify**: `node --check` en ambos; arrancar `node api/src/server.js` CON el .env actual → arranca normal; (no probar el caso sin secreto tocando el .env — basta el code review del guard).

### Step 3: Borrar código y deps muertas

1. `git rm api/src/lib/fetchWithRetry.js` (antes: `git grep -l "fetchWithRetry" -- api/ scraper/` debe devolver SOLO ese archivo; si aparece otro consumidor, STOP).
2. En `web/package.json` quitar `"@anthropic-ai/sdk"` de dependencies; `cd web && npm install` para regenerar el lock.

**Verify**: `npm test` → verde; `cd web; npm run build` → exit 0 (si el build falla por el SDK, alguien lo importaba — STOP y restaurar).

### Step 4: Actualizar DEVELOPER_ONBOARDING.md

En la sección de setup, agregar: "Copia `.env.example` a `.env` y llena los valores" con el comando `Copy-Item .env.example .env`. No reescribir el resto del documento.

**Verify**: el doc menciona `.env.example`; `git diff DEVELOPER_ONBOARDING.md` muestra solo esa adición.

## Test plan

Sin tests nuevos (cambios de configuración y borrado). Gate: suite existente verde + build web verde + server arranca.

## Done criteria

- [ ] `.env.example` existe, cubre todas las variables del grep, y NO contiene ningún valor real (revisión manual línea por línea).
- [ ] `git grep -n "ddiddimmo" -- api/src/` → 0 resultados.
- [ ] `server.js` tiene el guard fatal de JWT_SECRET.
- [ ] `api/src/lib/fetchWithRetry.js` no existe; `git grep -l "fetchWithRetry" -- api/ scraper/` → vacío.
- [ ] `web/package.json` sin `@anthropic-ai/sdk`; `cd web; npm run build` exit 0.
- [ ] `npm test` exit 0.
- [ ] Fila actualizada en `plans/README.md`.

## STOP conditions

Stop and report back (do not improvise) if:

- Aparece un consumidor real de `fetchWithRetry` o de `@anthropic-ai/sdk` en web (el grep de verificación lo detecta).
- `ajustes.js` usa SUPERADMIN de una forma donde quitar el fallback cambia el comportamiento para usuarios normales (p.ej. rutas que dependen de que SIEMPRE haya un superadmin).
- Para escribir `.env.example` sientes que necesitas abrir `.env` — no lo hagas; usa el grep + CLAUDE.md §6 y deja `TODO(doc): confirmar` en las dudosas.

## Maintenance notes

- Cada variable de entorno nueva debe agregarse a `.env.example` en el mismo PR que la introduce — el reviewer debe pedirlo.
- Si más adelante se setea `SUPERADMIN_EMAIL` por entorno, considerar moverlo a una columna `role` en `User` (multi-superadmin) — fuera de scope aquí.
- El guard de JWT_SECRET complementa el plan 001 (fast-jwt nuevo rechaza secretos vacíos en HMAC, pero el guard da un error claro en el arranque en vez de 401s misteriosos).
