# Estado extracción RAPs — ✅ COMPLETADO

> **Completado en sesión 24 may 2026.** La extracción está hecha:
> - `scripts/extraerGuiasDesdeZajuna.js` procesó 15/15 guías del courseId 50283.
> - **19 Competencias y 75 RAPs** persistidos en DB.
> - Matching IA automático (`scripts/matchearCompetenciaIA.js`) generó
>   **2147 vínculos `RapEvidenciaRel`** en la sesión del 9 jun 2026.
>
> Lo que sigue a continuación es el registro histórico de la sesión pausada.

## Hallazgo clave
El link "**Clic aquí para acceder al recurso educativo**" en cada página
`mod/page` de la Guía abre el PDF real en una nueva pestaña del browser.
ESE PDF contiene el bloque "Resultados de aprendizaje a alcanzar:" con
los códigos SENA `\d{9}-\d{2}`.

## Curso activo
- ficha: 3186683  courseId: **50283**
- IDs de las páginas guía (mod/page):
  - GA01 → id=3515204
  - GA02 → id=3515253
  - GA03 → id=3515283
  - GA04 → id=3515313
  - GA05 → id=3515339
  - GA06 → id=3515360  (el que el usuario describió con formato estándar SENA)
  - GA07 → id=3515396

## Script listo para correr
`scraper/probeGuiaRecurso.js` ya:
- Hace login
- Navega a cada guía
- Busca el link "Clic aquí para acceder al recurso educativo"
- Sigue el link (el PDF abre en nueva pestaña → capturado por ctx.on("page"))
- Descarga el PDF con cookies de sesión
- Parsea "Resultados de aprendizaje a alcanzar:" buscando `\d{9}-\d{2}`

## Próximo paso (al recargar tokens)
1. Modificar `probeGuiaRecurso.js` para procesar **SOLO GA01** primero
2. Correrlo: `node scraper/probeGuiaRecurso.js`
3. Ver si captura la URL del PDF en nueva pestaña
4. Si captura → descarga y parsea → confirma formato SENA
5. Si no captura → inspeccionar la URL del resource viewer y buscar pluginfile

## Estructura esperada del PDF (según usuario)
```
Resultados de aprendizaje a alcanzar:
240202501-01 [descripción del RAP 1 de inglés GA01]
```
Código SENA: 9-dígitos (competencia) + "-" + 2-dígitos (número RAP)

## Matriz 12 slots (GA, AA) a llenar con descripciones
GA01-AA1, GA01-AA2*, GA02-AA1, GA02-AA2, GA03-AA1, GA03-AA2,
GA04-AA1, GA04-AA2*, GA05-AA1, GA05-AA2*, GA06-AA1, GA07-AA1
(* = solo 1 ficha tiene este slot; podría ser dato parcial)
