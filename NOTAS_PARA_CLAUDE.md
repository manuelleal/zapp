# NOTAS DEL USUARIO PARA CLAUDE (Reporte de Bug)

**Fecha:** 3 de Junio de 2026

## Problema en la pantalla de Configurar Evidencias
El usuario reportó un bug visual y funcional en la pantalla de configuración de evidencias (`EvidenciasConfig.tsx`).

**Descripción del usuario:** 
> "El problema de configurar las evidencias es este: así se ve [la lista agrupada por guías], pero cuando le doy cargar no me sale nada."

**Contexto basado en la captura de pantalla compartida:**
- Se ve la interfaz agrupada por "GUÍA 3", "GUÍA 4", "GUÍA 5".
- Se muestran varias evidencias con sus switches (algunas activas), botones de "Ver config" y badges de "Tarea", "Quiz", "Foro".
- Probablemente se refiere al botón **"Cargar fechas de todas"** (lector en lote B1) o al intentar abrir la tabla de configuración. Al pulsarlo, el proceso parece quedarse en silencio y "no sale nada" en pantalla (ni la barra de progreso, ni los datos en la tabla).

**Pistas para revisar:**
1. Revisa el endpoint `POST /api/fichas/:id/config/leer-todo` o el hook en el frontend que lo llama, podría estar fallando silenciosamente o no disparando la UI de carga.
2. Revisa el componente de la tabla de configuración (donde deben mostrarse los datos tras cargarlos) por si no se está re-renderizando o si la caché `EvidenciaConfig` no está llegando al front.
3. Chequea que el worker `leerConfigLoteWorker` no esté fallando en background sin notificar al frontend.
