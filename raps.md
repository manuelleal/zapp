# Mapeo Técnico de Estructuras - Guía de Aprendizaje 01

[cite_start]Este archivo contiene la extracción estructurada de las relaciones político-pedagógicas de la **Guía de Aprendizaje 01 (GFPI-F-135 V01)**[cite: 33]. Está diseñado para servir como semilla (*seed*) o regla de negocio en el backend de la aplicación para la automatización de actas y juicios evaluativos.

---

## 1. Tabla de Relaciones: RAPs vs. Evidencias

| codigo_evidencia | nombre_evidencia | tipo | RAP_asociado | confianza |
| :--- | :--- | :--- | :--- | :--- |
| `GA1-220501092-AA1-EV01` | [cite_start]Infografía sobre la teoría General de Sistemas [cite: 69] | Conocimiento | [cite_start]`220501092-01` [cite: 18] | Alta |
| `GA1-220501092-AA1-EV02` | [cite_start]Identificación de procesos organizacionales [cite: 90] | Conocimiento | [cite_start]`220501092-01` [cite: 18] | Alta |
| `GA1-220501092-AA1-EV03` | [cite_start]Mapa de procesos del software a construir [cite: 91] | Producto | [cite_start]`220501092-01` [cite: 18] | Alta |
| `GA1-220501092-AA2-EV01` | [cite_start]Mapa mental sobre ingeniería de requisitos [cite: 107] | Conocimiento | [cite_start]`220501092-02` [cite: 19] | Alta |
| `GA1-220501092-AA2-EV02` | Foro temático. [cite_start]Fuentes de requisitos [cite: 116] | Desempeño | [cite_start]`220501092-02` [cite: 19] | Alta |
| `GA1-220501092-AA3-EV01` | [cite_start]Diseño del instrumento de recolección de información [cite: 136] | Desempeño | [cite_start]`220501092-02` [cite: 19] | Alta |
| `GA1-220501092-AA3-EV02` | [cite_start]Formulación del proyecto de software [cite: 145] | Desempeño | [cite_start]`220501092-02` [cite: 19] | Alta |
| `GA1-220501092-AA3-EV03` | [cite_start]Formulario de recolección de información [cite: 160] | Producto | [cite_start]`220501092-02` [cite: 19] | Alta |
| `GA1-220501092-AA4-EV01` | [cite_start]Especificación de los requerimientos funcionales y no funcionales del software [cite: 182] | Desempeño | [cite_start]`220501092-03` [cite: 21] | Alta |
| `GA1-220501092-AA4-EV02` | [cite_start]Documento con especificación de requerimientos [cite: 195] | Producto | [cite_start]`220501092-03` [cite: 21] | Alta |
| `GA1-220501092-AA5-EV01` | [cite_start]Taller para la determinación de las especificaciones funcionales del software y metodología a utilizar [cite: 226] | Conocimiento | [cite_start]`220501092-04` [cite: 22] | Alta |
| `GA1-220501092-AA5-EV02` | [cite_start]Informe de evaluación de los requerimientos [cite: 236] | Producto | [cite_start]`220501092-04` [cite: 22] | Alta |
| `GA1-220501093-AA1-EV01` | [cite_start]Taller sobre metodologías de desarrollo de software [cite: 264] | Conocimiento | [cite_start]`220501093-01` [cite: 23] | Alta |
| `GA1-220501093-AA1-EV02` | [cite_start]Infografía sobre metodologías de desarrollo de software [cite: 264] | Conocimiento | [cite_start]`220501093-01` [cite: 23] | Alta |
| `GA1-220501093-AA1-EV03` | Foro. [cite_start]Especificación de la metodología a aplicar [cite: 290] | Desempeño | [cite_start]`220501093-01` [cite: 23] | Alta |
| `GA1-220501093-AA1-EV04` | [cite_start]Documento identificando la metodología para el proyecto de desarrollo de software [cite: 304] | Producto | [cite_start]`220501093-01` [cite: 23] | Alta |

---

## 2. Definición de Criterios de Evaluación por RAP (Población de la DB)

Estos textos han sido extraídos de las matrices de evaluación de la guía y deben ser insertados en el campo `criterios_evaluacion` de la tabla de Resultados de Aprendizaje:

### [cite_start]Competencia `220501092` [cite: 11]
* [cite_start]**RAP `220501092-01` (Actividad AA1)[cite: 18, 63]:**
  > [cite_start]"Identifica procesos de la organización de acuerdo con la estructura organizacional de la empresa y los requerimientos del cliente. Aplica técnicas de análisis de procesos, siguiendo la metodología establecida. Elabora diagrama de procesos identificando áreas de incidencia directa con el sistema de información a construir. Reconoce las fronteras y el contexto del sistema de acuerdo con el alcance." [cite: 431]
* [cite_start]**RAP `220501092-02` (Actividades AA2 y AA3)[cite: 19, 102, 130]:**
  > [cite_start]"Reconoce las fuentes de requisitos de acuerdo con el proyecto. Diferencia los tipos de requisitos según sus características particulares. Identifica requisitos. Diseña instrumentos para recolección de información siguiendo normas y procedimientos técnicos. Utiliza las técnicas de captura de requisitos de acuerdo con las fuentes identificadas. Organiza la información recolectada para analizarla." [cite: 431, 434]
* [cite_start]**RAP `220501092-03` (Actividad AA4)[cite: 21, 172]:**
  > [cite_start]"Genera la documentación de la especificación de requisitos de acuerdo con normatividad y estándares relacionados. Presenta el informe de requisitos de acuerdo con estándares establecidos." [cite: 434]
* [cite_start]**RAP `220501092-04` (Actividad AA5)[cite: 22, 220]:**
  > [cite_start]"Evalúa el informe de requisitos con el cliente según las necesidades establecidas. Realiza cambios a la documentación de especificación de requisitos a partir de los hallazgos encontrados." [cite: 434]

### [cite_start]Competencia `220501093` [cite: 13]
* [cite_start]**RAP `220501093-01` (Actividad AA1)[cite: 23, 258]:**
  > [cite_start]"Identifica metodologías de desarrollo de software de acuerdo con las características del software a desarrollar. Establece las actividades de análisis de acuerdo con la metodología seleccionada." [cite: 437]

---

## 3. Respuestas Conceptuales para Reglas del Sistema

### 1. Grano de Mapeo por Competencia
La lógica de parsing del agente debe cambiar según el código de la competencia técnica detectada:
* [cite_start]**Competencia `220501092` (Requisitos):** Mapeo estricto **por actividad AA**[cite: 59]. [cite_start]Cada actividad ataca un RAP secuencial del programa[cite: 63, 102, 130, 172, 220].
* [cite_start]**Competencia `220501093` (Evaluación):** Mapeo **por guía**[cite: 254]. [cite_start]Toda la actividad AA1 de esta guía se agrupa para responder únicamente al RAP 01 (`220501093-01`)[cite: 23, 258].

### 2. Comportamiento de Evidencias de Conocimiento
[cite_start]Las evidencias de tipo conocimiento (como el mapa mental `AA2-EV01` [cite: 107] [cite_start]o foros temáticos `AA2-EV02` [cite: 116]) **sí se asocian al mismo RAP** que las evidencias de desempeño y producto de su misma actividad o ciclo instruccional. [cite_start]En la arquitectura de software del SENA, validan los fundamentos cognitivos requeridos antes de la ejecución procedimental de la misma competencia[cite: 108, 117].

### 3. Diagnóstico de Alcance de la Guía
[cite_start]Esta guía **desarrolla varios RAPs en paralelo**[cite: 18, 23, 24, 28]. No sigue la regla mono-RAP. [cite_start]El backend debe mapear un total de 5 RAPs técnicos principales [cite: 18, 23][cite_start], además de los correspondientes a competencias claves de TIC [cite: 24] [cite_start]e Inglés[cite: 28].

---
**Resultado General del Agente:** Mapeo Completado con Éxito. Nivel de Confianza Global: **Alta**.