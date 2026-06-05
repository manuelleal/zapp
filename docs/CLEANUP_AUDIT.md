# CLEANUP_AUDIT.md — Inventario de limpieza verificado

> **Fecha:** 2 junio 2026 · **Rama:** `feature/gradebook-scan-v2`
> **Método:** 3 agentes Sonnet (backend / scraper+scripts+raíz / frontend) + **verificación manual** contra `git ls-files`, `git status` y grep. Cada ítem va etiquetado:
> - ✅ **VERIFICADO** — confirmado a mano en el árbol principal.
> - 🟡 **REPORTADO** — hallazgo de agente, plausible, *spot-check antes de borrar*.
> - ❌ **ALUCINADO** — el agente lo inventó; NO existe. Descartar.

---

## ❌ Descartar — alucinaciones de agentes (NO actuar)

Dos agentes reportaron estos archivos como existentes. **No existen** (confirmado: `git status` limpio, glob vacío en main y en worktrees). Fueron sembrados por el CLAUDE.md §9.3.2, que los *recomienda crear* — el agente leyó la recomendación y la reportó como hecha.

- `api/src/worker-entry.js` — NO existe. (El "bug de doble carga de workers" es ficción.)
- `api/src/lib/playwrightSession.js` — NO existe. (No hay factory; sigue siendo un *pendiente*, no algo a migrar.)

> ⚠️ El problema que esos archivos *resolverían* sí es real: proceso único (CLAUDE.md §11.1) y boilerplate duplicado. Lo falso es que ya estén resueltos.

---

## 🔴 Limpieza segura inmediata (verificada con git)

### A. Purgar del índice git binarios/logs tracked (~7 MB) — ✅ VERIFICADO
Aparecen en `git ls-files` pese a estar en `.gitignore` (commiteados antes de las reglas). `git rm --cached` los saca del índice y, como `.gitignore` ya los cubre, **no reaparecen**. Quedan en disco.

- [ ] `root.PiOpq-8m.js` (568 KB — chunk de la Extensión Z, pertenece a `web/dist/assets/`)
- [ ] `vendor.H14vcryl.js` (140 KB — chunk Vite)
- [ ] `server.log`, `server.err`, `server-err.log` (logs de runtime)
- [ ] `probe-*.png` (~30 capturas), `probe-*.json` (3), `probe-recurso-ga0*.pdf` (7 PDFs, ~3.7 MB)

```powershell
git rm --cached --quiet root.PiOpq-8m.js vendor.H14vcryl.js server.log server.err server-err.log
git rm --cached --quiet 'probe-*.png' 'probe-*.json' 'probe-*.pdf'
git commit -m "chore: purgar binarios/logs del indice (ya cubiertos por .gitignore)"
```

### B. Borrar del disco ~39 scripts de debug de la raíz — ✅ VERIFICADO (no tracked)
Ninguno está en `git ls-files`; `.gitignore` los ancla con `/` (líneas 20-36). Borrarlos del disco **no toca git**. Son one-shots de debug (`test-*`, `debug-*`, `check-*`, `dump-*`, `diag-anim*`, `scan*`, `rescan-*`, `list-*`, `get-*`, `smoke-test*`, `inject`, `enqueue`, `find`) + `walkthrough.md`, `PROJECT_STATUS.md`, `Guia_aprendizaje_3.pdf`, `*.xlsx`.

```powershell
Remove-Item -Force .\test-*.js, .\debug-*.js, .\debug-*.html, .\check-*.js, .\dump-*.js, `
  .\diag-anim.js, .\diag-index-page.js, .\scan.js, .\scan-anim.js, .\rescan-*.js, `
  .\list-*.js, .\get-*.js, .\smoke-test*.js, .\inject.js, .\enqueue.js, .\find.js, `
  .\walkthrough.md, .\PROJECT_STATUS.md, .\Guia_aprendizaje_3.pdf, '.\*.xlsx'
```
> ⚠️ Anclado a la raíz (`.\`). NO afecta `scripts/diag-ficha.js`, `scripts/diag-competencias.js` ni `api/src/.../scan.js`.

### C. Worktrees clutter — 🟡 REPORTADO (investigar antes de borrar)
`.claude/worktrees/agent-a58e3042986579dd3` y `agent-a8d680b04bf983123` — dos copias completas del repo (~3.3 MB), aparecen como `m` (modified content) en `git status`. Son scratch de agentes pasados. **Antes de `git worktree remove --force`**, revisar que no tengan trabajo sin commitear que valga la pena (el `m` indica cambios locales dentro).

---

## 🟠 Código muerto / duplicación — ✅ VERIFICADO

| Ítem | Ubicación | Acción |
|---|---|---|
| `EvidenciasModal` (656 líneas, sin importar) | `web/src/components/EvidenciasModal.tsx` | BORRAR |
| `apiFetchWithRetry` + `configCache` (sin consumidores) | `web/src/api/client.ts:56,78` | BORRAR exports |
| `fetchWithRetry` (sin importar en ningún worker) | `api/src/lib/fetchWithRetry.js` | BORRAR (o cablear en migración fetch, §11.2) |
| `fichasQueueEvents` (abre conexión Redis que nadie usa) | `api/src/lib/queue.js:14` | BORRAR |
| `usePollJob` duplicado ×4 | EvidenciasConfig, ConfigTabla, ConfigEvidenciaDialog, MatchingIaPage | EXTRAER a `web/src/hooks/usePollJob.ts` |
| `actIdFromHref` triplicado ×3 | batchConfig, configEvidencias, foroRating | EXTRAER a `api/src/lib/` |
| Boilerplate login Playwright ×~9-12 workers | `api/src/workers/*` | FACTORY (= P1 #6 / §9.3.2) |
| Ramas `else` de `modoPerRap` (código muerto) | `api/src/routes/actas.js` | BORRAR (corroborado por §Paso 0) |

---

## 🟡 Reportado — plausible, sin verificar (spot-check antes de actuar)

- `useAuthGuard` boilerplate ×8 páginas → extraer hook.
- `gaNum` / `tiempoRelativo` duplicados en Dashboard/EvidenciasConfig (ya existe versión en `web/src/lib/utils.ts`).
- Assets huérfanos: `web/src/assets/react.svg`, `web/public/vite.svg` (scaffolding Vite).
- Imports muertos: `Sparkles` (Layout.tsx), `Filter` (EvidenciasConfig.tsx), `Settings` (ActasPage.tsx).
- `MatchingIaPage` con nav comentada en `Layout.tsx` — ruta viva pero inalcanzable. Decidir: exponer o sacar del router.
- `SUPERADMIN = "ddiddimmo@gmail.com"` hardcodeado en `api/src/routes/ajustes.js:6` → mover a env.
- `emailMasivoWorker` marca estado `"enviado"` en envíos parciales con errores → considerar estado `"parcial"`.
- `syncParticipantesWorker` no usa `loadSession`/`saveSession` (login fresco cada job) — inconsistente con los demás.
- **Probes rotos** (`scraper/probes/`): 9 hacen `require("./auth")` → resuelve a `scraper/probes/auth.js` (no existe; el real es `scraper/auth.js`). ✅ requires verificados. Son one-shots cumplidos → **archivar/borrar es mejor que arreglar imports**.
- `scripts/inspect-foro.js`, `scripts/smoke-foro.js` — comentario propio dice "TEMPORAL: borrar tras validar"; Sprint 2.5 ya validado → BORRAR.
- Dos `ARCHITECTURE.md` (raíz tracked + `docs/`) → INVESTIGAR cuál es canónico; CLAUDE.md §4 apunta a `docs/`.

---

## Notas de reconciliación

- El ítem de §9.2 "AIPI ACTA….docx + acta_03….pdf borrados sin commit" está **resuelto**: `git status` no muestra deletions pendientes (`D`).
- `docs/ARCHITECTURE.md` **sí existe** (§9.2 lo daba por inexistente — nota desactualizada).
- Confianza por agente en este barrido: **frontend** 100% en spot-check · **backend** fiable salvo sus 2 titulares alucinados · **scraper/raíz** correcto en lo verificado (binarios tracked, probes rotos, scripts ignorados).
