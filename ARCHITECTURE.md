# Zajuna App — Arquitectura del Sistema

> **Última actualización:** 19 mayo 2026.

---

## 1. Visión General

Plataforma web multitenant para instructores SENA que automatiza la gestión de Zajuna/Moodle. Integra scraping robusto, API modular, interfaz SPA y automatización mediante IA para matching de resultados de aprendizaje (RAPs) y calificación.

---

## 2. Stack Tecnológico

| Capa | Tecnología |
|------|-----------|
| API | Node.js + Fastify 5 |
| Colas asíncronas | BullMQ + Redis 7 |
| Base de datos | PostgreSQL 16 + Prisma 6 |
| Frontend | React 18 + Vite 5 + Tailwind 3 + shadcn/ui |
| Autenticación | JWT (`@fastify/jwt`) + bcrypt |
| Criptografía | AES-256-GCM para credenciales Moodle |
| Scraping | Playwright 1.59 (Estrategia "Index Pages" y Filtro de Matriculados) |
| Modelos IA | Anthropic Claude |

---

## 3. Modelo de Datos (Prisma)

El sistema cuenta con **18 modelos** en total, distribuidos en estos flujos clave:

**Entidades Core:**
- `User`: Usuario instructor.
- `Ficha`: Grupo de estudiantes.
- `Evidencia`: Tarea, foro o actividad Moodle.
- `Entrega`: Estado individual de la evidencia por estudiante.
- `Aprendiz`: Estudiante SENA.
- `EvidenciaConfig` y `ConfigAudit`: Caché y auditoría de configuraciones (fechas, intentos).

**Colas y Trabajos:**
- `Job`: Trabajos genéricos BullMQ.
- `ConfigChangeJob`: Trabajos batch (ej. cambios masivos de fechas).

**Evaluación y RAPs:**
- `Competencia`: Módulo global.
- `RAP`: Resultado de Aprendizaje.
- `Criterio`: Criterios asociados al RAP.
- `RapEvidenciaRel`: Relación N:M entre evidencias y RAPs.
- `MatchingPropuesta`: Sugerencias generadas por la IA para enlazar Evidencias ↔ RAPs.

**Actas y Seguimiento:**
- `ActaSeguimiento`: Documento institucional de evaluación de la ficha.
- `ActaParticipante`: Vínculo entre acta y aprendiz con sus notas/juicios.

**Comunicaciones:**
- `MensajeFormativo`: Mensajes encolados para envío a estudiantes (Moodle o Correo).
- `ConfigCorreo`: Configuración SMTP del usuario instructor.

---

## 4. Directorio de Archivos Core

### Backend (API Routes) - `api/src/routes/`
1. `actas.js`: CRUD y auto-poblar actas de evaluación.
2. `actasImport.js`: Importación CSV para actas.
3. `ajustes.js`: Configuración SMTP (email).
4. `archivar.js`: Archivar/desarchivar fichas.
5. `auth.js`: Autenticación y registro.
6. `batchConfig.js`: Modificaciones masivas de evidencias.
7. `configEvidencias.js`: Lectura y actualización de ajustes puntuales.
8. `evidencias.js`: Listado de evidencias.
9. `fichas.js`: Listado de cursos.
10. `foroRating.js`: Endpoint para calificar foros vía UI.
11. `jobs.js`: Estado de la cola BullMQ.
12. `matchingIa.js`: Endpoint para aceptar/rechazar propuestas de la IA.
13. `mensajes.js`: Envío masivo de mensajes Moodle/Correo.
14. `raps.js`: Resultados de aprendizaje.
15. `scan.js`: Lanzar scraping on-demand.

### Backend (Workers BullMQ) - `api/src/workers/`
| Cola (`Queue`) | Worker (`Archivo`) | Concurrency | Propósito |
|----------------|--------------------|-------------|-----------|
| `fichas` | `fichasWorker.js` | 3 | Extraer cursos del dashboard Moodle |
| `evidencias` | `evidenciasWorker.js` | 3 | Scrapear entregas de estudiantes |
| `leerConfig` | `leerConfigEvidenciaWorker.js` | 1 | Guardar configuración de evidencia en caché |
| `config` | `configWorker.js` | 1 | Actualizar 1 evidencia en Moodle |
| `cambiarFecha` | `cambiarFechaWorker.js` | 1 | Bulk update (duedates) |
| `cambiarConfig`| `cambiarConfigWorker.js` | 1 | Bulk update general |
| `foroRating` | `foroRatingWorker.js` | 1 | Calificar posts en foros |
| `autoScan` | `autoScanWorker.js` | 1 | Re-scraping automático cron (3h) y silencioso (Dashboard >2h) |
| `matchingIa` | `matchingIaWorker.js` | 2 | Llamar a API Claude para RAPs |
| `mensajeFormativo`| `mensajeFormativoWorker.js`| 1 | Enviar DM interno en Moodle |
| `emailMasivo` | `emailMasivoWorker.js` | 2 | Enviar correos por SMTP |
| `syncParticipantes`| `syncParticipantesWorker.js` | 1 | Extraer correos de estudiantes de Moodle |

> **Nota técnica:** Los workers de configuración/modificación en Moodle tienen `Concurrency: 1` obligatorio porque Zajuna/Moodle invalida las cookies de sesión si detecta logins o envíos de formulario paralelos concurrentes intensivos desde el mismo usuario.

### Frontend (Páginas) - `web/src/pages/`
1. `Login.tsx`: Acceso.
2. `Dashboard.tsx`: Vista general del instructor.
3. `Fichas.tsx`: Listado completo de fichas asignadas.
4. `EvidenciasConfig.tsx`: Operaciones bulk.
5. `ActasPage.tsx`: Administrador de comités y notas.
6. `MatchingIaPage.tsx`: Revisión de la IA (tinder de RAPs).
7. `RapsPage.tsx`: Gestión curricular.
8. `MensajesPage.tsx`: Panel de comunicación masiva.
9. `AjustesPage.tsx`: Configuración de credenciales de mensajería externa (SMTP).

---

## 5. Diseño y Reglas

Ver `CLAUDE.md` para las políticas de escritura de código, migraciones y reglas de negocio obligatorias.
