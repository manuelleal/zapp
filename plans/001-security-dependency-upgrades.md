# Plan 001: Eliminar las vulnerabilidades críticas de dependencias (fast-jwt, @fastify/static, tar)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 762970a..HEAD -- package.json package-lock.json api/src/server.js api/src/routes/auth.js`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: MED
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `762970a`, 2026-06-10

## Why this matters

`npm audit` reporta 2 advisories CRÍTICAS y 2 HIGH en dependencias directas/transitivas de este SaaS **multi-tenant**:

- **fast-jwt ≤6.2.3** (transitiva de `@fastify/jwt ≤9.1.0`): 6 advisories, incluyendo *bypass de autenticación con secreto HMAC vacío* (GHSA-gmvf-9v4p-v8jc) y *cache confusion que puede devolver claims de OTRO token* (GHSA-rp9m-7r4c-75qg) — en una app multi-tenant esto es mezcla de identidades entre instructores.
- **@fastify/static 8.0.0–9.1.0**: path traversal en directory listing (GHSA-pr96-94w5-mx2h) y bypass del route guard con separadores codificados (GHSA-x428-ghpx-8j92). Este server sirve `web/dist` con ese plugin.
- **tar ≤7.5.10** (transitiva vía `@mapbox/node-pre-gyp`, dependencia de `bcrypt`): escritura arbitraria de archivos en extracción. Fix disponible sin breaking change.
- **brace-expansion** (moderate, fix sin breaking change).

El JWT es la única barrera entre los datos de un instructor y otro. Tras este plan, `npm audit --omit=dev` queda sin críticas ni altas.

## Current state

- `package.json:17-18` — `"@fastify/jwt": "^9.0.4"` y `"@fastify/static": "^8.1.0"` (dependencias directas).
- `api/src/server.js:20-25` — registro de ambos plugins:
  ```js
  fastify.register(require("@fastify/jwt"), { secret: process.env.JWT_SECRET });

  fastify.register(require("@fastify/static"), {
    root:   path.join(__dirname, "../../web/dist"),
    prefix: "/",
  });
  ```
- `api/src/server.js:31-36` — SPA fallback usa `reply.sendFile("index.html")` en `setNotFoundHandler`.
- `api/src/server.js:49-55` — decorador `authenticate` usa `req.jwtVerify()`.
- Usos de firma de tokens (los 3 únicos): `api/src/routes/auth.js:67` y `:85` (`fastify.jwt.sign({ id, email, nombre }, { expiresIn: "7d" })`), `api/src/routes/ajustes.js:165` (impersonación superadmin).
- `npm audit fix` (sin `--force`) arregla `tar` y `brace-expansion`; `@fastify/jwt@10.1.0` y `@fastify/static@9.1.3` son majors (requieren cambio manual de versión).
- **NO tocar** el advisory de `uuid` vía `exceljs`: el "fix" de npm haría DOWNGRADE de exceljs a 3.4.0 (rompería los reportes Excel). Es moderate y exceljs solo genera archivos internamente — riesgo aceptado, queda documentado en `plans/README.md`.

Convenciones del repo: commits en español con prefijo (`fix:`, `feat:`, ...); comentarios en español; `node --check` a todo `.js` tocado (CLAUDE.md §5.1).

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Instalar | `npm install` | exit 0 |
| Audit | `npm audit --omit=dev` | 0 critical, 0 high al final del plan |
| Tests backend | `npm test` | todos pasan (suites de `api/src/lib/calificacion.test.js` y `api/src/workers/evidenciasWorker.estado.test.js`) |
| Sintaxis | `node --check api/src/server.js` | exit 0, sin output |
| Levantar API (manual) | `node api/src/server.js` | escucha en puerto 3000 (requiere Postgres+Redis de docker-compose corriendo) |

## Scope

**In scope** (únicos archivos a modificar):
- `package.json`
- `package-lock.json`
- `api/src/server.js` (SOLO si el upgrade de un plugin exige un cambio de API de registro)

**Out of scope** (NO tocar aunque parezcan relacionados):
- `web/package.json` / `web/package-lock.json` — el advisory de uuid/exceljs del root NO se arregla aquí (ver arriba).
- `api/src/routes/auth.js`, `api/src/routes/ajustes.js` — la API `fastify.jwt.sign()` no cambia entre v9 y v10; si crees que sí, es un STOP condition.
- `.env` — nunca leer ni copiar valores de secretos a ningún archivo.

## Git workflow

- Branch: `advisor/001-security-dep-upgrades` (desde `master`).
- Un commit por paso lógico; estilo del repo, p.ej. `fix(deps): subir @fastify/jwt a v10 — CVEs criticas de fast-jwt`.
- NO push ni PR salvo instrucción del operador.

## Steps

### Step 1: Fixes no-breaking (tar, brace-expansion)

Ejecutar `npm audit fix` (SIN `--force`).

**Verify**: `npm audit --omit=dev` → ya no aparecen los advisories de `tar` ni `brace-expansion`. Siguen apareciendo fast-jwt y @fastify/static (se arreglan en los pasos 2-3).

### Step 2: Subir @fastify/jwt a v10

En `package.json` cambiar `"@fastify/jwt": "^9.0.4"` → `"@fastify/jwt": "^10.1.0"` y correr `npm install`.

La API usada por este repo (`fastify.register(..., { secret })`, `req.jwtVerify()`, `fastify.jwt.sign(payload, { expiresIn })`) es idéntica en v10; el cambio interno es fast-jwt v7. No debería requerir cambios de código.

**Verify**:
1. `node --check api/src/server.js` → exit 0.
2. `npm test` → todos pasan.
3. `npm audit --omit=dev` → fast-jwt ya no aparece.

### Step 3: Subir @fastify/static a v9

En `package.json` cambiar `"@fastify/static": "^8.1.0"` → `"@fastify/static": "^9.1.3"` y correr `npm install`. El uso (root + prefix + `sendFile`) es básico y compatible.

**Verify**: `npm audit --omit=dev` → **0 critical, 0 high** (puede quedar el moderate de uuid/exceljs — esperado y aceptado).

### Step 4: Smoke test de auth y estáticos en vivo

Requiere Postgres+Redis corriendo (`docker-compose up -d`) y el build del front existente (`web/dist/index.html` debe existir; si no: `cd web && npm run build`).

1. Arrancar la API: `node api/src/server.js` (en background).
2. Login con el usuario de prueba que existe en la DB de dev (creado por `scripts/test-multitenant.js`):
   ```powershell
   $r = Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/auth/login -ContentType "application/json" -Body '{"email":"instructor1.test@zajuna.local","password":"Test1234!"}'
   $r.token
   ```
   → devuelve un token JWT no vacío. *(Si ese usuario no existe en esta DB, usar cualquier credencial válida que indique el operador — o registrar uno vía `POST /api/auth/register`.)*
3. Ruta protegida CON token:
   ```powershell
   Invoke-RestMethod -Uri http://localhost:3000/api/fichas -Headers @{ Authorization = "Bearer $($r.token)" }
   ```
   → HTTP 200 (lista, puede ser vacía).
4. Ruta protegida SIN token: `Invoke-WebRequest http://localhost:3000/api/fichas` → **HTTP 401**.
5. Estáticos: `Invoke-WebRequest http://localhost:3000/` → HTTP 200 con HTML (index.html). Y `/assets/` no debe devolver listado de directorio.
6. Matar el proceso node arrancado en (1) — **solo ese PID**, NO `taskkill /IM node.exe` (puede haber otros procesos del operador corriendo).

**Verify**: los 4 checks HTTP anteriores con los códigos esperados.

## Test plan

No se escriben tests nuevos en este plan (la cobertura de rutas llega en el plan 002). La verificación es: suite existente verde (`npm test`) + smoke manual del Step 4.

## Done criteria

- [ ] `npm audit --omit=dev` → 0 critical, 0 high (el moderate uuid/exceljs puede quedar).
- [ ] `npm test` exit 0.
- [ ] `node --check api/src/server.js` exit 0.
- [ ] Smoke del Step 4: login 200 con token, protegida 200 con token, 401 sin token, `/` sirve index.html.
- [ ] `git status` no muestra modificados fuera de `package.json`, `package-lock.json` (y `api/src/server.js` solo si fue imprescindible).
- [ ] Fila de este plan actualizada en `plans/README.md`.

## STOP conditions

Stop and report back (do not improvise) if:

- `npm install` con `@fastify/jwt@10` falla por incompatibilidad de peer dependencies con `fastify@5`.
- Tras el paso 2 ó 3 el server no arranca o el smoke de auth devuelve 500/401 con token válido — NO parchear `auth.js`/`ajustes.js` para "hacerlo pasar"; reportar el error exacto.
- `npm audit fix` del Step 1 modifica versiones de `playwright`, `prisma`, `@prisma/client`, `bullmq` o `exceljs` (revisar el diff de package-lock antes de commitear).
- Descubres que `fastify.jwt.sign()` cambió de firma en v10 (el plan asume que no).

## Maintenance notes

- `JWT_SECRET` vacío + fast-jwt viejo era bypass total; tras el upgrade igual conviene un guard de arranque (`if (!process.env.JWT_SECRET) throw`) — diferido al plan 005.
- Los tokens existentes (expiresIn 7d) siguen siendo válidos tras el upgrade (mismo secreto y algoritmo HS256 por defecto). Si el reviewer ve usuarios deslogueados masivamente, investigar antes de mergear.
- El advisory moderate de `uuid` vía `exceljs` queda abierto a propósito: re-evaluar cuando exceljs publique una versión con uuid ≥11.1.1.
