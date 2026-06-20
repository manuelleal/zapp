# Plan unificado para subir HOY (18 jun 2026)

> ✅ **EJECUTADO** — Release pusheado a master el 18 jun (commit `f1e2042`). Merges 001/002/004/007
> completados. Trabajo de sesión (fix sesión 9 workers, UI fechas) commiteado. Ver `CLAUDE.md §7`
> y `CHANGELOG.md` para el estado post-release.

> Fusiona los 7 planes del skill `improve` (10-jun, `plans/00X-*.md`) + el `plans/POSTMORTEM_FALLOS.md` (18-jun) + el trabajo de hoy. Objetivo: dejar la app **subible hoy** para que otros instructores la prueben, sin corromper datos ni subir trabajo a medias.

## 1. Qué ya está HECHO (en worktrees, SIN mergear a master)

| Plan | Qué | Rama/commit | Por qué importa para multi-instructor |
|---|---|---|---|
| **001** | Subir `@fastify/jwt` v10 + `@fastify/static` v9 + `tar` (CVEs críticos) | `worktree-agent-ad77e6914e8d1db01` (`62dff38`) | 🔴 **Crítico**: fast-jwt viejo permite *cache confusion* → un instructor podría ver claims de OTRO. Indispensable antes de varios instructores. master TODAVÍA tiene v9. |
| **007** | `esAprobada` lee la cualitativa A/D | `worktree-agent-a4b8e9bebc17478cb` (`5a0c0ce`) | 60 entregas reales salían PENDIENTE en actas. Correctitud. |
| **002** | CI (node-check + tests + build) + tests de actas | `worktree-agent-a8bcdcab7f5d674f3` (`b6b96bf`) | Red de seguridad; 46/46 tests. |
| **004** | Idempotencia del envío masivo en retry (no doble mensaje) | `worktree-agent-ae9f964c661738e19` (`f91940b`) | = mi P1.4 del post-mortem. Ya resuelto. |

> ⚠️ Estos 4 están en **worktrees anidados** (uno dentro de otro) y master **movió** desde su base (`762970a` → `bf82d71`). Mergearlos limpio requiere cuidado (posibles conflictos + el anidamiento es feo).

## 2. Trabajo de HOY sin commitear en master (mío, probado en vivo)

- **Fix de sesión en 9 workers** (`cambiarConfig/cambiarFecha/config/fichas/foroDescubrir/foroRating/leerConfigEvidencia/leerConfigLote/mensajeFormativo`): validar `/my` en vez del falso positivo del portal raíz. **Validado en vivo: 199 evidencias leídas, 0 fallos.**
- **`scraper/configEvidenciasFetch.js`**: detección de rebote de sesión + mensaje de error claro.
- **`web/src/components/ConfigTabla.tsx`**: orden por guía (GA1→GA6) + botón ↓ "aplicar fecha a todas" con coherencia de límite. Build OK.

## 3. ⚠️ Trabajo de OTRA sesión, también sin commitear (NO es mío — decidir)

- `api/src/routes/actas.js`, `web/src/pages/ActasPage.tsx`, `prisma/schema.prisma` modificados + **migración nueva** `prisma/migrations/20260618160218_acta_gor_f_084_campos/`.
- Parece trabajo de actas (campos GOR-F-084). **No sé si está terminado.** Subirlo a ciegas podría romper. → Hay que revisarlo o aislarlo antes de commitear lo demás.

## 4. Reconciliación con el post-mortem (qué cambia)

- **P0.3 foroRating doble calificación** → **DESCARTADO** (el README del 10-jun lo verificó: el rating es un *set absoluto*, re-postear el mismo valor es inocuo). No es P0. ✅ menos trabajo.
- **P1.4 mensajes idempotencia** → ya está (plan **004** hecho). ✅
- **P0.1 candado por-usuario (mutex Redis)** → **NUEVO**, no estaba en los planes del 10-jun. Sigue siendo la pieza clave anti-corrupción cuando un instructor hace 2 cosas a la vez. Encaja DENTRO del plan **003** (factory de sesión).
- **P1.1 seguimiento de jobs que sobrevive a navegación** → **NUEVO**. Lo que reportó el usuario. Copiar el patrón del scan (`/api/scan/progress`).
- **Mi fix de sesión de hoy** se solapa con el plan **003** (que también quería unificar el chequeo de sesión). Al hacer 003, la factory absorbe mi fix (yo usé `/my`; el plan proponía `/zajuna/` — ambos rechazan el rebote; unificar uno solo en la factory).

## 5. SHIP HOY — alcance recomendado (mínimo seguro para que prueben instructores)

**Fase A (subir hoy):**
1. **Aclarar el trabajo de actas no commiteado (§3)** — ¿se sube o se aísla? (decisión del operador).
2. **Commitear mi trabajo de hoy** (§2) en master — fix de sesión + UI fechas. Bajo riesgo, probado.
3. **Mergear los 4 planes hechos (§1)** a master — sobre todo **001 (seguridad)**. Con cuidado por el anidamiento.
4. `npm install` + `npm audit` (0 críticas) + `npm test` (verde) + `cd web && npm run build`.
5. Push a `origin/master`.
6. Levantar con PM2 (`pm2 start ecosystem.config.js`) para que no se caiga al cerrar terminal.

> Con esto los instructores prueben con: seguridad parcheada, actas correctas (esAprobada), mensajes sin doble envío, lectura/guardado de fechas estable, UI de fechas mejorada. **Regla para el test:** "haz una cosa a la vez y espera a que termine" (mitiga P0.1 hasta tener el mutex).

**Fase B (robustez — "arranca todo", puede no caber 100% hoy):**
7. **Plan 003 (factory de sesión) + P0.1 (mutex por-usuario)** — en rama `fix/session-lock`. Elimina la corrupción silenciosa por sesiones que se pisan.
8. **P1.1 (seguimiento global de jobs)** — rama `feat/job-tracking`, casi todo frontend, en paralelo sin chocar.
9. Plan 005 (higiene: `.env.example`, guard de `JWT_SECRET`, fallback superadmin, deps muertas) — rápido.

**Diferido:** Plan 006 (spike scan→fetch+cheerio, P3), P2 del post-mortem (jobs zombis, autoScan fail-safe, limpieza tabla Job, micro-fuga sync-emails).

## 6. Decisiones que necesito del operador antes de tocar git

1. **El trabajo de actas no commiteado (§3): ¿lo subimos hoy, lo dejo aparte, o lo reviso primero?**
2. **Los merges de worktrees (§1): ¿procedo yo a consolidarlos a master + push, o prefieres que primero suba SOLO lo de hoy (§2) y los worktrees los consolidamos como paso aparte y vigilado?**
