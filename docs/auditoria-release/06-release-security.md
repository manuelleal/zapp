# 06 — Auditoría de Release: Seguridad + Readiness + Documentación

> Agente 6 del barrido de release de "Helper" (antes Zajuna). Solo lectura.
> Fecha: 2026-06-19 · Rama: `master` · Working dir: `C:\zajuna`
> **VEREDICTO: GO para PUSH a git · NO-GO para DESPLIEGUE accesible a instructores hoy** (faltan pasos de despliegue/ops, no de seguridad de código).

---

## 1. Auditoría de secretos

**Método:** se inspeccionaron nombres de claves (no valores), `.gitignore`, `server.js`, `ajustes.js`, `crypto.js`, y se hizo grep de patrones de secretos sobre todo el repo + historial git. **No se imprimió ningún valor de secreto.**

| Hallazgo | Severidad | Estado |
|---|---|---|
| `.env` está en `.gitignore` (línea 2) y **nunca fue commiteado** (verificado con `git log --all --diff-filter=A`) | — | ✅ OK |
| `.env` **NO está tracked** (`git ls-files` no lo lista) | — | ✅ OK |
| Sin secretos hardcodeados en código fuente. Grep de `sk-ant-`/`sk-or-`/`AKIA`/`-----BEGIN`/`jwt_secret_cambiar`/passwords → solo aparecen en **placeholders de docs** (`CLAUDE.md`) y en **comentarios de nombres de env** (`aiClient.js:16`). | — | ✅ OK |
| `JWT_SECRET` sin fallback débil en código (`server.js:20` usa `process.env.JWT_SECRET` directo; si falta, el plugin falla al boot — default seguro). El valor débil viejo (`..._cambiar_en_prod`) solo vive como nota histórica en `CLAUDE.md:619`. Memoria confirma **rotado 9-jun noche**. | Baja | ✅ Rotado (confiar en memoria; no verificable sin leer valor) |
| `ENCRYPTION_KEY` sin fallback (`crypto.js:3`). Cripto = **AES-256-GCM con IV aleatorio + authTag** — correcto. | — | ✅ OK |
| `SUPERADMIN_EMAIL` con fallback hardcodeado `ddiddimmo@gmail.com` (`ajustes.js:7`) | 🟡 Baja | ⚠️ No es un secreto (es un email de admin), pero expone identidad del superadmin en código. Idealmente solo por env. No bloqueante. |
| `OPENROUTER_API_KEY` presente en `.env` (clave 13). Memoria dice "pendiente de rotar antes de producción". | 🟠 Media | ⚠️ **Acción del usuario:** rotar antes de exponer a terceros. No verificable desde aquí. |
| **No existe `.env.example`** (glob `**/.env*` → solo `.env` reales) | 🟡 Baja | ⚠️ Falta plantilla de onboarding. Las 11 claves requeridas están en `.env` real: `ZAJUNA_USER/PASS`, `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `ENCRYPTION_KEY`, `ALLOWED_ORIGIN`, `ANTHROPIC_API_KEY`, `SUPERADMIN_EMAIL`, `OPENROUTER_API_KEY`. |
| 2 `.env` reales en disco dentro de `.claude/worktrees/agent-*` (copias para worktrees de agentes) | 🟡 Baja | ⚠️ No tracked (gitignore `.env` los cubre). Hygiene local: contienen credenciales reales en disco fuera del root. No bloqueante para git. |

**Conclusión secretos:** sin fugas en git ni en código. Pendientes son operativos (rotar OPENROUTER, crear `.env.example`, quitar fallback del superadmin email).

---

## 2. Dependencias — `npm audit`

### Raíz (`npm audit --omit=dev`) — producción
```
critical: 0   high: 0   moderate: 2   low: 0   total: 2
```
Las 2 moderate: **`uuid` (vía `exceljs`)** — "Missing buffer bounds check in v3/v5/v6 when buf is provided". `exceljs` solo genera archivos de reporte server-side; no procesa input no confiable con `buf`. **Riesgo aceptado y documentado** en el commit `f1e2042`.

### Web (`web/`)
No fue posible ejecutar `npm audit` en `web/` por denegación de permisos del sandbox (varias formas de invocación rechazadas). **Evaluado vía lockfile** (`web/package-lock.json`):

| Paquete | Versión instalada | Riesgo |
|---|---|---|
| vite | 5.4.21 | Parcheado (resuelve advisories conocidos de Vite 5.x) |
| esbuild | 0.21.5 | ⚠️ GHSA-67mh-4wv8-2f99 (moderate, **solo dev-server**, no afecta build de producción) |
| nanoid | 3.3.12 | Parcheado |
| postcss | 8.5.14 | Parcheado |
| braces | 3.0.3 | Parcheado |
| rollup | 4.60.3 | Parcheado |

**Conclusión web:** sin HIGH/CRITICAL en artefactos enviados. La vuln de `esbuild` es **dev-only** (servidor de desarrollo Vite), no entra al `web/dist` servido en producción. No bloqueante.

### Verificación de CVEs cerrados (memoria)
✅ Confirmado en commit **`f1e2042`** ("fix(deps): cerrar CVEs high de nodemailer y undici"): `undici` por audit fix no-breaking, `nodemailer` v8→v9. Mensaje del commit declara explícitamente "0 critical, 0 high (quedan 2 moderate uuid/exceljs, riesgo aceptado)".

---

## 3. CORS / Headers de seguridad (`api/src/server.js`)

| Aspecto | Estado |
|---|---|
| CORS | ✅ **Restringido** vía `process.env.ALLOWED_ORIGIN \|\| "http://localhost:5173"` (no es `*`). Métodos limitados. ⚠️ Verificar que `ALLOWED_ORIGIN` esté seteado al dominio real en producción (default es localhost). |
| `X-Frame-Options: DENY` | ✅ presente (onSend hook) |
| `X-Content-Type-Options: nosniff` | ✅ presente |
| `Referrer-Policy: strict-origin-when-cross-origin` | ✅ presente |
| `Permissions-Policy` (camera/mic/geo off) | ✅ presente |
| JWT | ✅ secreto desde env, sin fallback |
| `/api/health` | ✅ existe (ping DB + Redis, 200/503) |
| Falta `Strict-Transport-Security` (HSTS) | 🟡 Baja — se suele poner en el reverse-proxy (nginx/Caddy) frente a la app, no aquí. Nota para despliegue. |
| Falta `Content-Security-Policy` | 🟡 Baja — nice-to-have, no bloqueante para un panel autenticado interno. |

**Conclusión:** postura de headers **buena para v1**. CORS correctamente restringido. Único recordatorio operativo: setear `ALLOWED_ORIGIN` real y poner HSTS en el proxy.

---

## 4. Estado git / higiene de release

- **Rama:** `master`, up-to-date con `origin/master`.
- **Binarios/basura tracked:** ✅ **CERO** (`git ls-files` de `.png/.pdf/.docx/.xlsx/.log/...` → 0 resultados). El `.gitignore` es agresivo y cubre probes, logs, docx, scripts de debug en root.
- **Trabajo sin commitear (NO TOCADO, solo reportado):**
  - `M api/src/routes/actas.js` — trabajo de actas en curso.
  - `M .claude/settings.local.json`, submódulos/worktrees modificados.
  - Untracked: `.agents/`, `.claude/skills/`, `api/assets/`, `api/src/lib/actaSaneado.js`, `scripts/verify-acta-docx-tmp.js`, `skills-lock.json`, `ACTA AP6 ... .pdf`, `logo zajuna..png`, 2 worktrees de agente.
  - ⚠️ Estos archivos sueltos (`logo zajuna..png`, el PDF de acta) NO deben commitearse accidentalmente — el `.gitignore` cubre `acta_*.pdf` pero NO `"ACTA AP6 ...pdf"` ni `logo zajuna..png` (sin patrón). Si se hace `git add -A` se colarían. **Usar `git add` selectivo.**
- **Últimos commits** coherentes con el plan de release (renombre a Helper, candado por-usuario P0.1, factory de sesión, fix CVEs, aviso de tareas en curso).

---

## 5. Checklist GO / NO-GO

### Bloqueantes (deben estar antes de exponer a instructores reales)
| # | Ítem | Estado |
|---|---|---|
| B1 | `ALLOWED_ORIGIN` seteado al dominio de producción (hoy default localhost) | ⚠️ Verificar en despliegue |
| B2 | `JWT_SECRET` fuerte y rotado | ✅ (memoria: rotado 9-jun) |
| B3 | `OPENROUTER_API_KEY` rotada (estuvo en chats/worktrees) | 🔴 **Pendiente usuario** |
| B4 | Sin HIGH/CRITICAL en deps de producción | ✅ (0/0) |
| B5 | App realmente desplegada y accesible (push a git ≠ deploy) | 🔴 **Pendiente** — memoria recalca esto explícitamente |
| B6 | HTTPS/TLS + HSTS en el reverse proxy | ⚠️ Tarea de infra (VPS Hetzner + Caddy/nginx) |

### Nice-to-have (no bloquean)
- Crear `.env.example` (onboarding).
- Quitar fallback hardcodeado de `SUPERADMIN_EMAIL`.
- Limpiar `.env` reales de los worktrees de agentes en disco.
- Añadir CSP.
- Resolver las 2 moderate de `uuid/exceljs` (cuando exceljs publique fix) — riesgo aceptado.
- `git add` selectivo del trabajo de actas en curso (no `-A`).

### Veredicto: ¿se sube hoy?
- **PUSH a git: SÍ (GO).** El código en `master` es seguro: 0 high/critical en producción, CORS restringido, headers OK, cripto correcta, sin secretos en repo/historial, CVEs cerrados. El trabajo de actas sin commitear no bloquea (se commitea aparte y selectivo).
- **DESPLIEGUE accesible a instructores: NO HOY (NO-GO)** hasta cerrar B1 (ALLOWED_ORIGIN real), B3 (rotar OPENROUTER_API_KEY), B5 (deploy real en VPS) y B6 (TLS/HSTS en proxy). Son pasos de **ops/infra**, no de seguridad de código — ninguno requiere cambios de código profundos.

---

## 6. Documentación

> No se editó `CLAUDE.md` (lo actualiza el orquestador).

### Borrador de entrada de changelog para CLAUDE.md
```
> (19 jun 2026 — auditoría de release, Agente 6 seguridad/readiness):
> SEGURIDAD OK PARA PUSH. npm audit prod: 0 critical / 0 high / 2 moderate
> (uuid vía exceljs, riesgo aceptado, commit f1e2042). Web: sin high/critical
> en artefactos servidos (esbuild 0.21.5 moderate es dev-only). CORS restringido
> por ALLOWED_ORIGIN, security headers (X-Frame/nosniff/Referrer/Permissions-Policy)
> presentes, cripto AES-256-GCM correcta, .env nunca commiteado, sin secretos
> hardcodeados (solo placeholders en docs). VEREDICTO: GO push / NO-GO deploy hoy.
> Bloqueantes de DESPLIEGUE (no de código): setear ALLOWED_ORIGIN real, rotar
> OPENROUTER_API_KEY, deploy en VPS + TLS/HSTS en proxy. Nice-to-have: crear
> .env.example, quitar fallback de SUPERADMIN_EMAIL, CSP.
```

### Docs desactualizadas detectadas
- `docs/CLEANUP_AUDIT.md` — **obsoleto** (escrito antes del refactor P0; afirma que `worker-entry.js` no existe cuando sí existe). Confirmado por memoria y CLAUDE.md §12.
- `CLAUDE.md` §13.5 menciona `JWT_SECRET` débil y `OPENROUTER_API_KEY` pendiente — el JWT ya se rotó; conviene reflejarlo (memoria lo marca, CLAUDE.md no del todo).
- No existe `.env.example` referenciable en onboarding.

---

## Resumen ejecutivo
Código **seguro para subir a git hoy**: sin vulnerabilidades high/critical en producción, CORS y headers correctos, criptografía sólida, sin secretos en el repositorio o su historial, CVEs de nodemailer/undici ya cerrados. Lo que impide *desplegar* hoy de cara a instructores no es seguridad de código sino **ops**: setear `ALLOWED_ORIGIN` al dominio real, **rotar `OPENROUTER_API_KEY`**, levantar el deploy en VPS y poner TLS/HSTS en el proxy.
