# Investigación — Anuncios programados por ficha

> **Estado:** investigación / diseño (NO implementado). 21 jun 2026 (noche).
> Disparado por el dueño: *"poder hacer una ficha y que se programen los anuncios
> que se van a realizar y cuándo se deben realizar."*

## 1. La idea (lo que pidió el dueño)
Por cada **ficha**, el instructor define una lista de **anuncios** y **cuándo** deben
publicarse (fecha/hora, o recurrencia). El sistema los publica solo en el momento
indicado. Ej.: "el lunes a las 7am: bienvenida"; "cada viernes: recordatorio de
evidencias"; "el 15: cierre de trimestre".

## 2. Qué es un "anuncio" en Zajuna (Moodle)
En Moodle los **Anuncios** son un **foro especial de tipo `news`** (Foro de Novedades)
que cada curso tiene por defecto. Publicar un anuncio = **crear una discusión** en ese
foro. A diferencia de un mensaje directo, el anuncio:
- Lo ven TODOS los aprendices del curso/ficha.
- Suele enviarse por correo a los suscritos (suscripción forzada en `news`).

⚠️ **Por verificar (no confirmado en el repo):** cómo crear la discusión en Zajuna.
Dos caminos (igual que el resto del scraping, ver regla #7 del CLAUDE.md):
- **AJAX:** `mod_forum_add_discussion` vía `/lib/ajax/service.php?sesskey=...` (lo
  más limpio, estilo Capa 2). Hay que probar si SENA lo tiene habilitado (varias WS
  están capadas — ver docs/MOODLE_REFERENCE.md).
- **DOM/POST:** `/mod/forum/post.php` con el form de "Añadir nuevo tema". Fallback
  si la WS está capada.
- Falta **localizar el foro de novedades** de cada ficha (su `cmid`), igual que se
  descubren las evidencias.

## 3. Prior art en Helper que se REUSA (clave — no reinventar)
Ya existe TODA la maquinaria de "programar y disparar en el momento justo", hecha
para mensajes. Los anuncios deberían copiar este patrón:

- **Modelo `MensajeProgramado`** (`prisma/schema.prisma:406`): guarda `fichaId`,
  `canal`, `asunto`, `cuerpo`, filtro de destinatarios, **`intervaloDias`**, **`hora`**,
  **`proximaEjecucion`**, `lastRunAt`, `pausadoAt` (soft-state). Índice en
  `proximaEjecucion`.
- **Worker de tick** `api/src/workers/mensajesProgramadosWorker.js`: cola
  `mensajesProgramados` con un **tick repetible cada 10 min**; busca los vencidos
  (`pausadoAt null` + `proximaEjecucion <= now`), los dispara con **claim idempotente**
  (`updateMany` condicionado, evita doble envío en reintentos), **re-agenda** la
  próxima corrida y registra historial.
- **Cola/registro** en `api/src/lib/queue.js` y `api/src/worker-entry.js`.
- **Lógica compartida** `api/src/lib/mensajesMasivos.js` (la usan ruta y worker).
- **UI** pestaña "Programados" en `web/src/pages/MensajesPage.tsx` (crear/pausar/borrar).

> Conclusión: el 80% del trabajo de "programación" ya está resuelto. Lo nuevo de
> anuncios es: (a) el modelo propio, (b) **publicar en el foro de novedades** (scraper
> nuevo), (c) UI por ficha.

## 4. Diseño propuesto
1. **Modelo `AnuncioProgramado`** (clonar `MensajeProgramado`, simplificado): `userId`,
   `fichaId`, `titulo`, `cuerpo`, y la programación. Dos modos de agenda:
   - **Una sola vez:** `publicarEn DateTime` (fecha/hora exacta).
   - **Recurrente:** `intervaloDias` + `hora` + `proximaEjecucion` (igual que mensajes).
   - `pausadoAt`, `lastRunAt`, `publicadoAt` (para las de una sola vez).
2. **Worker `anunciosProgramadosWorker`** (clonar el de mensajes): tick cada 10 min,
   busca vencidos, **claim idempotente**, publica el anuncio, re-agenda o marca
   `publicadoAt`. 0 destinatarios no aplica (un anuncio va al curso entero).
3. **Scraper `publicarAnuncio(page, cmidForoNovedades, titulo, cuerpo)`**: crea la
   discusión (probar AJAX `mod_forum_add_discussion`; fallback DOM). + helper para
   **descubrir el foro `news`** de la ficha.
4. **UI:** dentro de la ficha (o sección "Anuncios"), lista de anuncios programados
   con su fecha/recurrencia, crear/editar/pausar/borrar. Plantillas sugeridas
   (bienvenida, recordatorio, cierre), igual que las plantillas de mensajes.
5. **Guardas (copiar de mensajes):** idempotencia (no doble publicación en reintentos),
   tope de frecuencia razonable, historial de cada publicación, multi-tenant por `userId`.

## 5. Lo que falta verificar antes de codear
- ✅ El patrón de programación (resuelto, reusar mensajes).
- ❓ **Cómo publica un anuncio en Zajuna** (AJAX `mod_forum_add_discussion` vs DOM) —
  hacer un probe en vivo, como se hizo con `mod_assign_list_participants`.
- ❓ **Cómo encontrar el `cmid` del foro de novedades** de cada ficha (descubrirlo en
  el scan, similar a las evidencias).
- ❓ ¿El anuncio debe ir también por **email** (como los mensajes) además del foro?
  (Decisión de producto.)

## 6. Próximos pasos sugeridos (mañana)
1. Probe en vivo: ¿`mod_forum_add_discussion` está habilitado en SENA? ¿dónde está el
   foro `news` de una ficha?
2. Si el probe va bien: modelo + migración `AnuncioProgramado` → worker (clonado) →
   scraper `publicarAnuncio` → UI por ficha.
3. Reusar `mensajesProgramadosWorker.js` como plantilla casi literal.

> Relacionado: la otra investigación de esta noche, cómo la Extensión evalúa en SOFIA
> (`docs/INVESTIGACION_EXTENSION_SOFIA.md`).
