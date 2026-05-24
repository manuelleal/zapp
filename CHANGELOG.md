# Registro de Cambios y Progreso de la Sesión

---

## Sesión 24 mayo 2026 — Claude Code

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
