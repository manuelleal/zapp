# Auditoría de release "Helper" — Informe consolidado (19 jun 2026)

Barrido completo con 6 agentes (read-only). Informes detallados: `01`–`06` en esta carpeta.

## Veredicto global
- **Código:** apto para piloto controlado **una vez cerrado 1 bug P0 + unos P1**.
- **Push a git:** ✅ GO.
- **Despliegue accesible a instructores HOY:** 🔴 NO-GO por **ops/infra** (deploy en VPS, rotar key, dominio/TLS), no por seguridad de código.

---

## 🔴 P0 — BLOQUEANTE (arreglar sí o sí antes de subir)
| ID | Área | Archivo:línea | Problema | Fix |
|----|------|---------------|----------|-----|
| P0-1 | Backend | `api/src/routes/actas.js:1455-1463` (sin commitear) | **IDOR cross-tenant** en `POST /api/actas/confirm-native`: `aprendizId` del body sin validar contra `acta.fichaId` → se cuelan aprendices de otra ficha/instructor al acta y salen sus nombres+cédulas en el Word (fuga datos, Ley 1581) | Validar el set de `aprendizId` contra `fichaId` antes del `createMany` (~5 líneas) |

## 🟠 P1 — antes de exponer a varios instructores (hoy, son baratos)
| ID | Área | Ubicación | Problema | Fix |
|----|------|-----------|----------|-----|
| P1-1 | Workers | `foroRatingQueue` (`attempts:3`) + `scraper/foroRating.js:138` | Doble calificación de foros en retry | Bajar a `attempts:1` (ideal: saltar POST si ya tiene la nota) |
| P1-2 | Backend | `api/src/routes/matchingIa.js:41` | IDOR parcial: `evidenciaIds` del cliente sin filtrar por `userId` | Filtrar evidencias por userId antes de encolar |
| P1-3 | Backend | `api/src/server.js` | Sin `setErrorHandler` global → fuga de stack/Prisma en 500 | Añadir handler global que oculte detalles |
| P1-4 | Datos | Mensajes masivos | **2 de 3 envíos en `estado=error`** | Investigar `errorMsg` (probable sesión SSO / moodleId) |
| P1-5 | Frontend | `MapeoAlVueloModal.tsx:27-31` | No maneja `isError` → "Cargando…" infinito | Añadir estado de error |

## 📱 Mobile — fixes de 1 línea (aplicar hoy, riesgo bajo)
| ID | Archivo:línea | Problema |
|----|---------------|----------|
| M-1 | `Layout.tsx:103` | Nav de 7 iconos sin hamburguesa (afecta todas las páginas) |
| M-2 | Mensajes `:643` y `:783` | Tablas sin scroll horizontal → desbordan |
| M-3 | `ActasPage.tsx:291,302,320` | Modal Nueva Acta con `grid-cols-2` fijo sin breakpoint |

> Diseño: **NO está feo, está sobrio y consistente.** Recomendación: retoque mínimo (mobile + opcional `shadow-sm`), **NO rediseño**. Barridos grandes (emojis, colores) → post-release.

## 🧹 Limpieza antes de producción
- Borrar 3 usuarios `instructor*.test@zajuna.local` y actas de prueba `SMK-*`.
- Crear `.env.example` (no existe).
- Quitar fallback hardcodeado de `SUPERADMIN_EMAIL` (`ajustes.js:7`).
- `git add` selectivo (no `-A`): hay `logo zajuna..png` y PDFs sueltos sin gitignore.

## 🚀 Bloqueantes de DESPLIEGUE (ops, no código)
1. 🔴 Rotar `OPENROUTER_API_KEY` (estuvo en chats/worktrees).
2. ⚠️ Setear `ALLOWED_ORIGIN` al dominio real.
3. 🔴 Deploy en VPS (push ≠ accesible).
4. ⚠️ TLS/HSTS en el reverse proxy.

## ✅ Lo que está sólido (no tocar)
- Multi-tenant consistente en casi todo; helpers de verificación; JWT bien cableado.
- Workers/scraping: candado por-usuario (`userLock.js`), browser compartido, validación SSO `/my` corregida.
- Schema/migraciones up-to-date, 0 huérfanos, 0 cruces multi-tenant, índices críticos ya aplicados.
- Reglas SENA fieles (umbral 70, A/D), regla #8 (IA solo limpia texto en actas).
- Crypto AES-256-GCM correcto; `.env` nunca commiteado; 0 high/critical en npm audit prod.
- Frontend sano: 0 endpoints fantasma, build compila limpio (3.4s), marca "Helper" consistente.

## ⚠️ A confirmar contigo
- Matching IA escribe directo en `RapEvidenciaRel` dejando `MatchingPropuesta=0` → **bypassa regla #8** (IA propone, instructor decide). ¿Intencional o querías aprobación previa?
