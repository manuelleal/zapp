/**
 * Zajuna Manager — app.js
 * Lógica del frontend. Funciona con datos mock sin backend.
 * Para conectar al backend real, descomentar la sección "FETCH REAL".
 */

"use strict";

// ─── COMPETENCIAS (espejo de scraper/fichas.js) ───────────────────────────────

const COMPETENCIAS = [
  { nombre: "Inglés",                    codigo: "240202501" },
  { nombre: "Bases de datos",            codigo: "220501046" },
  { nombre: "Programación de software",  codigo: "220501046" },
  { nombre: "Análisis y desarrollo",     codigo: "220501040" },
];

// ─── DATOS MOCK ───────────────────────────────────────────────────────────────
// Estructura exacta que retorna descubrirFichas() en scraper/fichas.js

const MOCK_DATA = {
  fichas: [
    {
      codigo: "3186683",
      nombre: "ADSO - Análisis y Desarrollo de Software 3186683",
      courseId: 51083,
      programa: "ADSO",
      tieneCodigoFicha: true,
    },
    {
      codigo: "2758941",
      nombre: "ADSO - Análisis y Desarrollo de Software 2758941",
      courseId: 48210,
      programa: "ADSO",
      tieneCodigoFicha: true,
    },
    {
      codigo: "3042217",
      nombre: "Inglés B1 - Ficha 3042217",
      courseId: 49905,
      programa: "",
      tieneCodigoFicha: true,
    },
    {
      codigo: "2994530",
      nombre: "Programación de Software - Ficha 2994530",
      courseId: 47341,
      programa: "PROG. SOFTWARE",
      tieneCodigoFicha: true,
    },
  ],
  otrosCursos: [
    {
      courseId: 12345,
      nombre: "Inducción SENA 2025",
      programa: "",
      tieneCodigoFicha: false,
    },
    {
      courseId: 99001,
      nombre: "Comunidad de Práctica Instructores",
      programa: "",
      tieneCodigoFicha: false,
    },
    {
      courseId: 99002,
      nombre: "Bienestar y Salud Ocupacional",
      programa: "",
      tieneCodigoFicha: false,
    },
  ],
};

// ─── ESTADO GLOBAL ────────────────────────────────────────────────────────────

const state = {
  competenciaSeleccionada: null,
  cargando: false,
  datos: null,
};

// ─── REFERENCIAS AL DOM ───────────────────────────────────────────────────────

const dom = {
  scanBtn:         () => document.getElementById("btn-escanear"),
  loadingBanner:   () => document.getElementById("loading-banner"),
  progressFill:    () => document.getElementById("progress-fill"),
  resultsSection:  () => document.getElementById("results-section"),
  tablaBody:       () => document.getElementById("tabla-fichas-body"),
  statsRow:        () => document.getElementById("stats-row"),
  otrosSection:    () => document.getElementById("otros-section"),
  otrosList:       () => document.getElementById("otros-list"),
  otrosBadge:      () => document.getElementById("otros-badge"),
  alertInfo:       () => document.getElementById("alert-info"),
  compBtns:        () => document.querySelectorAll(".comp-btn"),
};

// ─── RENDER FICHAS ─────────────────────────────────────────────────────────────
/**
 * renderFichas(data)
 * Recibe el objeto exacto que retorna descubrirFichas() y pinta la UI.
 *
 * @param {{ fichas: Array, otrosCursos: Array }} data
 */
function renderFichas(data) {
  const { fichas, otrosCursos } = data;

  // ── Stats chips ──────────────────────────────────────────────
  const statsRow = dom.statsRow();
  statsRow.innerHTML = `
    <div class="stat-chip">
      <span>📋</span>
      <span>${fichas.length} ficha${fichas.length !== 1 ? "s" : ""} encontrada${fichas.length !== 1 ? "s" : ""}</span>
    </div>
    ${state.competenciaSeleccionada
      ? `<div class="stat-chip">
           <span>🎓</span>
           <span>${state.competenciaSeleccionada.nombre}</span>
         </div>`
      : ""}
  `.trim();

  // ── Tabla de fichas ──────────────────────────────────────────
  const tbody = dom.tablaBody();

  if (fichas.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="5">
          <div class="empty-state">
            <div class="empty-icon">🔍</div>
            <p>No se encontraron fichas con código de 7 dígitos.<br>
               Prueba con otra competencia o revisa en Zajuna.</p>
          </div>
        </td>
      </tr>
    `;
  } else {
    tbody.innerHTML = fichas.map(f => `
      <tr>
        <td>
          <span class="ficha-code">${escHtml(f.codigo ?? "—")}</span>
        </td>
        <td>
          ${f.programa
            ? `<span class="badge badge-green">${escHtml(f.programa)}</span>`
            : `<span class="badge badge-gray">—</span>`}
        </td>
        <td>${escHtml(f.nombre)}</td>
        <td class="col-courseid">
          <span class="course-id">${f.courseId}</span>
        </td>
        <td>
          <button
            class="btn btn-ghost btn-sm"
            onclick="verEvidencias(${f.courseId}, '${escHtml(f.codigo ?? "")}', '${escHtml(f.nombre)}')"
            title="Ver evidencias de la ficha ${escHtml(f.codigo ?? f.courseId.toString())}"
          >
            Ver evidencias
          </button>
        </td>
      </tr>
    `).join("");
  }

  // ── Sección "Otros cursos" ───────────────────────────────────
  const otrosSec = dom.otrosSection();
  if (otrosCursos && otrosCursos.length > 0) {
    dom.otrosBadge().textContent = otrosCursos.length;
    const lista = dom.otrosList();
    lista.innerHTML = otrosCursos.map(c => `
      <div class="otro-item">
        <span class="course-id">[ID:${c.courseId}]</span>
        <span>${escHtml(c.nombre)}</span>
      </div>
    `).join("");
    otrosSec.classList.add("visible");
  } else {
    otrosSec.classList.remove("visible");
  }

  // ── Mostrar la sección de resultados ─────────────────────────
  dom.resultsSection().classList.add("visible");
}

// ─── ESCANEAR FICHAS ──────────────────────────────────────────────────────────

async function escanearFichas() {
  if (state.cargando) return;

  state.cargando = true;
  actualizarBotonEscaneo(true);
  mostrarCargando(true);
  dom.resultsSection().classList.remove("visible");

  try {
    // ── FETCH REAL (descomentar cuando el backend esté listo) ──────────────
    //
    // const codigoComp = state.competenciaSeleccionada?.codigo ?? "";
    // const resp = await fetch(`/api/fichas?competencia=${codigoComp}`, {
    //   method: "GET",
    //   headers: {
    //     "Content-Type": "application/json",
    //     // "Authorization": `Bearer ${getToken()}`,  // JWT cuando haya auth
    //   },
    // });
    // if (!resp.ok) throw new Error(`Error del servidor: ${resp.status}`);
    // const data = await resp.json();
    // renderFichas(data);
    //
    // ── FIN FETCH REAL ─────────────────────────────────────────────────────

    // Simular 2 segundos de scraping con datos mock
    await delay(2000);
    state.datos = MOCK_DATA;
    renderFichas(state.datos);

  } catch (err) {
    mostrarError(err.message);
  } finally {
    state.cargando = false;
    actualizarBotonEscaneo(false);
    mostrarCargando(false);
  }
}

// ─── VER EVIDENCIAS ───────────────────────────────────────────────────────────
// Placeholder — cuando exista la ruta /evidencias/:courseId
function verEvidencias(courseId, codigo, nombre) {
  alert(`Pronto disponible:\n\nFicha ${codigo || courseId}\n${nombre}\n\nEsta sección mostrará el estado de entregas de cada aprendiz.`);
  // TODO: navegar a /evidencias?ficha=${courseId}
}

// ─── INICIALIZAR SELECTOR DE COMPETENCIAS ─────────────────────────────────────

function initCompetencias() {
  const grid = document.getElementById("competencia-grid");
  grid.innerHTML = COMPETENCIAS.map((c, i) => `
    <button
      class="comp-btn"
      data-index="${i}"
      onclick="seleccionarCompetencia(${i})"
      title="Código: ${c.codigo}"
    >
      <span class="comp-btn-name">${escHtml(c.nombre)}</span>
      <span class="comp-btn-code">${c.codigo}</span>
    </button>
  `).join("");
}

function seleccionarCompetencia(index) {
  const comp = COMPETENCIAS[index];
  if (!comp) return;

  state.competenciaSeleccionada = comp;

  // Actualizar clases de los botones
  document.querySelectorAll(".comp-btn").forEach((btn, i) => {
    btn.classList.toggle("active", i === index);
  });

  // Habilitar botón de escaneo
  dom.scanBtn().disabled = false;

  // Ocultar alerta de info
  const alert = dom.alertInfo();
  if (alert) alert.style.display = "none";
}

// ─── UI HELPERS ───────────────────────────────────────────────────────────────

function actualizarBotonEscaneo(cargando) {
  const btn = dom.scanBtn();
  if (cargando) {
    btn.disabled = true;
    btn.innerHTML = `
      <div class="spinner"></div>
      Escaneando...
    `;
  } else {
    btn.disabled = !state.competenciaSeleccionada;
    btn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
      </svg>
      Escanear mis fichas
    `;
  }
}

function mostrarCargando(visible) {
  dom.loadingBanner().classList.toggle("visible", visible);
}

function mostrarError(msg) {
  const tbody = dom.tablaBody();
  tbody.innerHTML = `
    <tr>
      <td colspan="5">
        <div class="empty-state">
          <div class="empty-icon">⚠️</div>
          <p>Error al cargar fichas: ${escHtml(msg)}</p>
        </div>
      </td>
    </tr>
  `;
  dom.resultsSection().classList.add("visible");
}

function escHtml(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── INIT ─────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  initCompetencias();

  // El botón empieza deshabilitado hasta elegir competencia
  dom.scanBtn().disabled = true;
  dom.scanBtn().addEventListener("click", escanearFichas);
});
