"use strict";

// ─── ESTADO GLOBAL ───────────────────────────────────────────────────────────
const _ui = {
  verArchivadas: false,
  verCerradas:   false,
};

// ─── JWT ─────────────────────────────────────────────────────────────────────
const JWT_KEY  = "zajuna_jwt";
const getJwt   = ()  => localStorage.getItem(JWT_KEY);
const setJwt   = (t) => localStorage.setItem(JWT_KEY, t);
const clearJwt = ()  => localStorage.removeItem(JWT_KEY);

// ─── FETCH AUTENTICADO ────────────────────────────────────────────────────────
async function authFetch(url, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.body != null && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  const jwt = getJwt();
  if (jwt) headers["Authorization"] = `Bearer ${jwt}`;

  const res = await fetch(url, { ...opts, headers });

  if (res.status === 401) {
    clearJwt();
    showAuth();
    throw new Error("Sesión expirada. Inicia sesión de nuevo.");
  }
  return res;
}

// ─── ESCAPE HTML ──────────────────────────────────────────────────────────────
function escHtml(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ─── VISTAS ───────────────────────────────────────────────────────────────────
function showAuth() {
  document.getElementById("auth-view").style.display       = "";
  document.getElementById("dashboard-view").style.display  = "none";
}

function showDashboard(user) {
  document.getElementById("auth-view").style.display       = "none";
  document.getElementById("dashboard-view").style.display  = "";

  const initials = (user.nombre || "?")
    .split(" ")
    .filter(Boolean)
    .map(w => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  document.getElementById("header-avatar").textContent        = initials;
  document.getElementById("header-nombre").textContent        = user.nombre    || "";
  document.getElementById("header-competencia").textContent   = user.competenciaNombre || "";
}

// ─── TABS DE AUTH ─────────────────────────────────────────────────────────────
function showTab(tab) {
  const isLogin = tab === "login";
  document.getElementById("form-login").style.display    = isLogin ? "" : "none";
  document.getElementById("form-register").style.display = isLogin ? "none" : "";
  document.getElementById("tab-login").classList.toggle("active",  isLogin);
  document.getElementById("tab-register").classList.toggle("active", !isLogin);
  setError("login-error",    "");
  setError("register-error", "");
}

// ─── ERROR HELPER ─────────────────────────────────────────────────────────────
function setError(id, msg) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent    = msg;
  el.style.display  = msg ? "" : "none";
}

// ─── ESTADO DEL BOTÓN ────────────────────────────────────────────────────────
function setBtnLoading(btn, loading, labelIdle) {
  btn.disabled     = loading;
  btn.textContent  = loading ? "..." : labelIdle;
}

// ─── LOGIN ────────────────────────────────────────────────────────────────────
async function handleLogin(e) {
  e.preventDefault();
  setError("login-error", "");

  const email    = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-pass").value;

  const btn = e.target.querySelector("button[type=submit]");
  setBtnLoading(btn, true, "Entrar");

  try {
    const res = await fetch("/api/auth/login", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ email, password }),
    });

    const data = await res.json();

    if (!res.ok) {
      setError("login-error", data.error || "Error al iniciar sesión.");
      return;
    }

    setJwt(data.token);
    document.getElementById("login-pass").value = "";
    showDashboard(data.user);
    await cargarFichas();

  } catch {
    setError("login-error", "No se pudo conectar al servidor.");
  } finally {
    setBtnLoading(btn, false, "Entrar");
  }
}

// ─── REGISTRO ────────────────────────────────────────────────────────────────
async function handleRegister(e) {
  e.preventDefault();
  setError("register-error", "");

  const nombre   = document.getElementById("reg-nombre").value.trim();
  const email    = document.getElementById("reg-email").value.trim();
  const password = document.getElementById("reg-pass").value;
  const zajunaUser = document.getElementById("reg-zajuna-user").value.trim();
  const zajunaPass = document.getElementById("reg-zajuna-pass").value;

  const select            = document.getElementById("reg-competencia");
  const competenciaCodigo = select.value;
  const competenciaNombre = select.options[select.selectedIndex]?.dataset?.nombre || "";

  const btn = e.target.querySelector("button[type=submit]");
  setBtnLoading(btn, true, "Crear cuenta");

  try {
    const res = await fetch("/api/auth/register", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        nombre,
        email,
        password,
        zajunaUser,
        zajunaPass,
        competenciaCodigo,
        competenciaNombre,
      }),
    });

    const data = await res.json();

    if (!res.ok) {
      setError("register-error", data.error || "Error al crear la cuenta.");
      return;
    }

    setJwt(data.token);
    // Limpiar campos sensibles inmediatamente — no quedan en memoria JS
    document.getElementById("reg-pass").value        = "";
    document.getElementById("reg-zajuna-pass").value = "";
    showDashboard(data.user);
    await cargarFichas();

  } catch {
    setError("register-error", "No se pudo conectar al servidor.");
  } finally {
    setBtnLoading(btn, false, "Crear cuenta");
  }
}

// ─── LOGOUT ───────────────────────────────────────────────────────────────────
function logout() {
  clearJwt();
  document.getElementById("fichas-section").classList.remove("visible");
  document.getElementById("empty-section").style.display  = "none";
  document.getElementById("fichas-tbody").innerHTML        = "";
  setScanStatus("", false);
  showAuth();
}

// ─── ESCANEAR FICHAS ──────────────────────────────────────────────────────────
async function scanFichas() {
  const btn = document.getElementById("btn-scan-fichas");
  btn.disabled = true;
  setScanStatus("Iniciando escaneo...", true);

  try {
    const res  = await authFetch("/api/fichas/scan", { method: "POST", body: "{}" });
    const data = await res.json();

    if (!res.ok) {
      setScanStatus(data.error || "Error al iniciar el escaneo.", false);
      return;
    }

    await pollJob(data.jobId);

  } catch (err) {
    if (!getJwt()) return; // 401 ya manejado en authFetch
    setScanStatus(err.message || "Error inesperado.", false);
  } finally {
    btn.disabled = false;
  }
}

// ─── POLLING JOB ─────────────────────────────────────────────────────────────
function pollJob(jobId) {
  return new Promise((resolve, reject) => {
    const timer = setInterval(async () => {
      try {
        const res  = await authFetch(`/api/jobs/${jobId}`);
        const data = await res.json();

        if (!res.ok) {
          clearInterval(timer);
          setScanStatus(data.error || "Error al consultar el job.", false);
          return reject(new Error(data.error));
        }

        const { status, progreso, errorMsg } = data;

        if (status === "done") {
          clearInterval(timer);
          setScanStatus("Escaneo completo.", false);
          await cargarFichas();
          resolve();

        } else if (status === "error") {
          clearInterval(timer);
          setScanStatus(errorMsg || "El escaneo falló.", false);
          reject(new Error(errorMsg));

        } else {
          setScanStatus(`Escaneando... ${progreso || 0}%`, true);
        }

      } catch (err) {
        clearInterval(timer);
        reject(err);
      }
    }, 3000);
  });
}

// ─── CARGAR FICHAS DESDE DB ───────────────────────────────────────────────────
async function cargarFichas() {
  try {
    const qs  = _ui.verArchivadas ? "?incluirArchivadas=1" : "";
    const res = await authFetch(`/api/fichas${qs}`);
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      setScanStatus(`Error al cargar fichas (${res.status}): ${txt.slice(0,200)}`, false);
      return;
    }
    const data = await res.json();
    renderFichas(data.fichas || [], data.archivadasCount || 0);
  } catch (err) {
    if (!getJwt()) return;
    setScanStatus(`Error de red: ${err.message}`, false);
  }
}

// Toggle "Ver archivadas"
async function toggleVerArchivadas(checked) {
  _ui.verArchivadas = !!checked;
  await cargarFichas();
}

// Archivar / desarchivar ficha
async function archivarFicha(fichaId, archivada) {
  try {
    const res = await authFetch(`/api/fichas/${encodeURIComponent(fichaId)}`, {
      method: "PATCH",
      body:   JSON.stringify({ archivada: !!archivada }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      setScanStatus(`No se pudo ${archivada ? "archivar" : "restaurar"} (${res.status}): ${txt.slice(0,150)}`, false);
      return;
    }
    await cargarFichas();
  } catch (err) {
    if (!getJwt()) return;
    setScanStatus(`Error de red: ${err.message}`, false);
  }
}

// ─── RENDER FICHAS ────────────────────────────────────────────────────────────
function renderFichas(fichas, archivadasCount = 0) {
  try {
    const section = document.getElementById("fichas-section");
    const empty   = document.getElementById("empty-section");
    const tbody   = document.getElementById("fichas-tbody");
    const count   = document.getElementById("fichas-count");

    if (!Array.isArray(fichas)) fichas = [];

    if (fichas.length === 0) {
      section.classList.remove("visible");
      section.style.display = "none";
      empty.style.display   = "";
      // Mensaje contextual segun haya o no archivadas
      const msg = empty.querySelector("p");
      if (msg) {
        if (!_ui.verArchivadas && archivadasCount > 0) {
          msg.innerHTML = `No hay fichas activas. Tienes <strong>${archivadasCount} archivada${archivadasCount !== 1 ? "s" : ""}</strong>. Activa <strong>Ver archivadas</strong> arriba para verlas.`;
        } else {
          msg.innerHTML = `Aún no tienes fichas escaneadas.<br>Haz clic en <strong>Escanear fichas</strong> para empezar.`;
        }
      }
      return;
    }

    empty.style.display   = "none";
    section.style.display = "";
    section.classList.add("visible");

    const activas = fichas.filter(f => !f.archivedAt).length;
    const arch    = fichas.length - activas;
    count.textContent = arch
      ? `${activas} activa${activas !== 1 ? "s" : ""} · ${arch} archivada${arch !== 1 ? "s" : ""}`
      : `${activas} ficha${activas !== 1 ? "s" : ""}`;

    tbody.innerHTML = "";

    for (const f of fichas) {
      const tr = document.createElement("tr");
      if (f.archivedAt) tr.classList.add("ficha-archivada");

      // Código
      const tdCod  = document.createElement("td");
      const spanCod = document.createElement("span");
      spanCod.className   = "ficha-code";
      spanCod.textContent = f.codigo ?? "—";
      tdCod.appendChild(spanCod);

      // Programa
      const tdProg  = document.createElement("td");
      const spanProg = document.createElement("span");
      spanProg.className   = f.programa ? "badge badge-green" : "badge badge-gray";
      spanProg.textContent = f.programa || "—";
      tdProg.appendChild(spanProg);

      // Nombre del curso
      const tdNombre  = document.createElement("td");
      tdNombre.textContent = f.nombre;

      // Pendientes (badge)
      const tdEv = document.createElement("td");
      const pend = typeof f.pendientes === "number" ? f.pendientes : null;
      if (pend === null) {
        const s = document.createElement("span");
        s.className = "badge badge-gray";
        s.textContent = "Sin escanear";
        tdEv.appendChild(s);
      } else if (pend === 0) {
        const s = document.createElement("span");
        s.className = "badge badge-green";
        s.textContent = "Al día";
        tdEv.appendChild(s);
      } else {
        const s = document.createElement("span");
        s.className = "badge badge-yellow";
        s.textContent = `${pend} pendiente${pend !== 1 ? "s" : ""}`;
        tdEv.appendChild(s);
      }

      // Acciones
      const tdBtn = document.createElement("td");
      tdBtn.style.whiteSpace = "nowrap";

      const btnEv = document.createElement("button");
      btnEv.className   = "btn btn-ghost btn-sm";
      btnEv.textContent = "Ver evidencias";
      btnEv.addEventListener("click", () => verEvidencias(f.id, f.codigo, f.nombre));
      btnEv.disabled = !!f.archivedAt;
      tdBtn.appendChild(btnEv);

      const btnArch = document.createElement("button");
      btnArch.className = "btn btn-ghost btn-sm btn-icon";
      btnArch.style.marginLeft = ".4rem";
      btnArch.textContent = f.archivedAt ? "Restaurar" : "Archivar";
      btnArch.title = f.archivedAt ? "Restaurar ficha" : "Archivar ficha";
      btnArch.addEventListener("click", () => archivarFicha(f.id, !f.archivedAt));
      tdBtn.appendChild(btnArch);

      tr.append(tdCod, tdProg, tdNombre, tdEv, tdBtn);
      tbody.appendChild(tr);
    }
  } catch (err) {
    setScanStatus(`Error al renderizar: ${err.message}`, false);
  }
}

// ─── VER EVIDENCIAS (modal) ──────────────────────────────────────────────────
let _evidenciasState = { fichaId: null, pollTimer: null };

function verEvidencias(fichaId, codigo, nombre) {
  closeEvidenciasModal();
  _evidenciasState = { fichaId, pollTimer: null };

  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.id = "evidencias-modal";
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) closeEvidenciasModal();
  });

  const modal = document.createElement("div");
  modal.className = "modal";

  // Header
  const header = document.createElement("div");
  header.className = "modal-header";
  const titleWrap = document.createElement("div");
  const title = document.createElement("h3");
  title.className = "modal-title";
  title.textContent = `Evidencias · ${codigo || ""}`;
  const subtitle = document.createElement("div");
  subtitle.className = "modal-subtitle";
  subtitle.textContent = nombre || "";
  const updated = document.createElement("div");
  updated.id = "evidencias-updated";
  updated.className = "modal-updated";
  titleWrap.append(title, subtitle, updated);
  const closeBtn = document.createElement("button");
  closeBtn.className = "modal-close";
  closeBtn.setAttribute("aria-label", "Cerrar");
  closeBtn.textContent = "✕";
  closeBtn.addEventListener("click", closeEvidenciasModal);
  header.append(titleWrap, closeBtn);

  // Body
  const body = document.createElement("div");
  body.className = "modal-body";
  body.id = "evidencias-body";
  const loading = document.createElement("p");
  loading.className = "evidencia-empty";
  loading.textContent = "Cargando evidencias...";
  body.appendChild(loading);

  // Footer
  const footer = document.createElement("div");
  footer.className = "modal-footer";

  const status = document.createElement("span");
  status.id = "evidencias-status";
  status.className = "job-status";

  const toggleWrap = document.createElement("label");
  toggleWrap.style.cssText = "display:flex;align-items:center;gap:.4rem;font-size:.8rem;color:var(--gray-600);cursor:pointer;margin-right:auto;";
  const toggleCb = document.createElement("input");
  toggleCb.type = "checkbox";
  toggleCb.id = "toggle-ver-cerradas";
  toggleCb.checked = _ui.verCerradas;
  toggleCb.addEventListener("change", async () => {
    _ui.verCerradas = toggleCb.checked;
    await cargarEvidencias(fichaId);
  });
  const toggleLbl = document.createElement("span");
  toggleLbl.id = "toggle-ver-cerradas-label";
  toggleLbl.textContent = "Ver cerradas";
  toggleWrap.append(toggleCb, toggleLbl);

  const scanBtn = document.createElement("button");
  scanBtn.id = "btn-scan-evidencias";
  scanBtn.className = "btn btn-primary btn-sm";
  scanBtn.textContent = "Refrescar";
  scanBtn.title = "Volver a consultar Zajuna y actualizar el cache local";
  scanBtn.addEventListener("click", () => scanEvidencias(fichaId));

  footer.append(toggleWrap, status, scanBtn);

  modal.append(header, body, footer);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  cargarEvidencias(fichaId);
}

function closeEvidenciasModal() {
  if (_evidenciasState.pollTimer) {
    clearInterval(_evidenciasState.pollTimer);
    _evidenciasState.pollTimer = null;
  }
  const m = document.getElementById("evidencias-modal");
  if (m) m.remove();
  _evidenciasState.fichaId = null;
}

function setEvidenciasStatus(msg, loading) {
  const el = document.getElementById("evidencias-status");
  if (!el) return;
  el.textContent = msg || "";
  el.className = loading ? "job-status job-status--loading" : "job-status";
}

async function cargarEvidencias(fichaId) {
  const body = document.getElementById("evidencias-body");
  if (!body) return;
  try {
    const qs  = _ui.verCerradas ? "?incluirCerradas=1" : "";
    const res = await authFetch(`/api/fichas/${encodeURIComponent(fichaId)}/evidencias${qs}`);
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      body.innerHTML = "";
      const p = document.createElement("p");
      p.className = "evidencia-empty";
      p.textContent = `Error (${res.status}): ${txt.slice(0, 200)}`;
      body.appendChild(p);
      return;
    }
    const data = await res.json();
    renderEvidencias(data.evidencias || [], data.cerradasCount || 0, fichaId);
  } catch (err) {
    if (!getJwt()) return;
    body.innerHTML = "";
    const p = document.createElement("p");
    p.className = "evidencia-empty";
    p.textContent = `Error de red: ${err.message}`;
    body.appendChild(p);
  }
}

function renderEvidencias(evidencias, cerradasCount, fichaId) {
  const body = document.getElementById("evidencias-body");
  if (!body) return;
  body.innerHTML = "";

  // Actualizar etiqueta del toggle con contador
  const lbl = document.getElementById("toggle-ver-cerradas-label");
  if (lbl) lbl.textContent = `Ver cerradas (${cerradasCount || 0})`;

  // Actualizar "Actualizado hace X" en el header
  const upd = document.getElementById("evidencias-updated");
  if (upd) {
    const fechas = evidencias.map(e => e.ultimoScan).filter(Boolean).map(s => new Date(s).getTime());
    if (fechas.length) {
      const maxMs = Math.max(...fechas);
      upd.textContent = `Actualizado ${tiempoRelativo(maxMs)} · datos en cache`;
      upd.classList.toggle("modal-updated--stale", (Date.now() - maxMs) > 24 * 60 * 60 * 1000);
    } else {
      upd.textContent = "Sin escaneos previos · pulsa Refrescar";
      upd.classList.add("modal-updated--stale");
    }
  }

  if (!evidencias.length) {
    const p = document.createElement("p");
    p.className = "evidencia-empty";
    p.textContent = _ui.verCerradas
      ? "No hay evidencias en esta ficha. Pulsa “Refrescar”."
      : (cerradasCount > 0
          ? `Todas las evidencias están cerradas (${cerradasCount}). Activa “Ver cerradas” para revisarlas.`
          : "Aún no hay evidencias escaneadas para esta ficha. Pulsa “Refrescar”.");
    body.appendChild(p);
    return;
  }

  for (const ev of evidencias) {
    const row = document.createElement("div");
    row.className = "evidencia-row";
    if (ev.cerradaAt) row.classList.add("evidencia-cerrada");

    const left = document.createElement("div");
    const name = document.createElement("div");
    name.className = "evidencia-name";
    name.textContent = ev.nombre || "—";
    const meta = document.createElement("div");
    meta.style.fontSize = ".75rem";
    meta.style.color = "var(--gray-600)";
    const fecha = ev.ultimoScan ? new Date(ev.ultimoScan).toLocaleString("es-CO") : "sin escaneo";
    const cerradaTxt = ev.cerradaAt ? ` · cerrada ${new Date(ev.cerradaAt).toLocaleDateString("es-CO")}` : "";
    meta.textContent = `Total: ${ev.total} · último: ${fecha}${cerradaTxt}`;
    left.append(name, meta);

    const right = document.createElement("div");
    right.style.display = "flex";
    right.style.flexDirection = "column";
    right.style.gap = ".4rem";
    right.style.alignItems = "flex-end";

    const counts = document.createElement("div");
    counts.className = "evidencia-counts";
    counts.append(
      makeBadge(`Pendientes ${ev.pendientes}`, "badge-yellow"),
      makeBadge(`Calificados ${ev.calificados}`, "badge-green"),
      makeBadge(`Sin entregar ${ev.sinEntregar}`, "badge-gray"),
    );

    const actions = document.createElement("div");
    actions.style.display = "flex";
    actions.style.gap = ".4rem";

    if (ev.href) {
      const open = document.createElement("a");
      open.href = ev.href;
      open.target = "_blank";
      open.rel = "noopener";
      open.className = "btn btn-ghost btn-sm";
      open.textContent = "Abrir en Zajuna";
      actions.appendChild(open);
    }

    const toggleBtn = document.createElement("button");
    toggleBtn.className = "btn btn-ghost btn-sm";
    toggleBtn.textContent = ev.cerradaAt ? "Reabrir" : "Cerrar";
    toggleBtn.title = ev.cerradaAt ? "Reabrir evidencia" : "Marcar como cerrada (ocultar)";
    toggleBtn.addEventListener("click", () => cerrarEvidencia(ev.id, !ev.cerradaAt, fichaId));
    actions.appendChild(toggleBtn);

    right.append(counts, actions);
    row.append(left, right);
    body.appendChild(row);
  }
}

async function cerrarEvidencia(evidenciaId, cerrada, fichaId) {
  try {
    const res = await authFetch(`/api/evidencias/${encodeURIComponent(evidenciaId)}`, {
      method: "PATCH",
      body:   JSON.stringify({ cerrada: !!cerrada }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      setEvidenciasStatus(`No se pudo ${cerrada ? "cerrar" : "reabrir"} (${res.status}): ${txt.slice(0,150)}`, false);
      return;
    }
    await cargarEvidencias(fichaId);
  } catch (err) {
    if (!getJwt()) return;
    setEvidenciasStatus(`Error de red: ${err.message}`, false);
  }
}

function makeBadge(text, cls) {
  const s = document.createElement("span");
  s.className = `badge ${cls || ""}`;
  s.textContent = text;
  return s;
}

// "hace 5 min" / "hace 2 h" / "hace 3 d" / "el 2026-05-01"
function tiempoRelativo(ms) {
  const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (diffSec < 60)         return `hace ${diffSec} s`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60)         return `hace ${diffMin} min`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24)           return `hace ${diffH} h`;
  const diffD = Math.floor(diffH / 24);
  if (diffD < 30)           return `hace ${diffD} d`;
  return `el ${new Date(ms).toLocaleDateString("es-CO")}`;
}

async function scanEvidencias(fichaId) {
  const btn = document.getElementById("btn-scan-evidencias");
  if (btn) btn.disabled = true;
  setEvidenciasStatus("Iniciando escaneo...", true);

  try {
    const res = await authFetch(`/api/fichas/${encodeURIComponent(fichaId)}/evidencias/scan`, { method: "POST", body: "{}" });
    const data = await res.json();
    if (!res.ok) {
      setEvidenciasStatus(data.error || "Error al iniciar el escaneo.", false);
      if (btn) btn.disabled = false;
      return;
    }
    pollEvidenciasJob(data.jobId, fichaId, btn);
  } catch (err) {
    if (!getJwt()) return;
    setEvidenciasStatus(`Error de red: ${err.message}`, false);
    if (btn) btn.disabled = false;
  }
}

function pollEvidenciasJob(jobId, fichaId, btn) {
  if (_evidenciasState.pollTimer) clearInterval(_evidenciasState.pollTimer);

  _evidenciasState.pollTimer = setInterval(async () => {
    if (_evidenciasState.fichaId !== fichaId) {
      clearInterval(_evidenciasState.pollTimer);
      _evidenciasState.pollTimer = null;
      return;
    }
    try {
      const res = await authFetch(`/api/jobs/${encodeURIComponent(jobId)}`);
      const data = await res.json();
      if (!res.ok) {
        clearInterval(_evidenciasState.pollTimer);
        _evidenciasState.pollTimer = null;
        setEvidenciasStatus(data.error || "Error consultando job.", false);
        if (btn) btn.disabled = false;
        return;
      }

      if (data.status === "done") {
        clearInterval(_evidenciasState.pollTimer);
        _evidenciasState.pollTimer = null;
        setEvidenciasStatus("Escaneo completo.", false);
        if (btn) btn.disabled = false;
        await cargarEvidencias(fichaId);
      } else if (data.status === "error") {
        clearInterval(_evidenciasState.pollTimer);
        _evidenciasState.pollTimer = null;
        setEvidenciasStatus(data.errorMsg || "El escaneo falló.", false);
        if (btn) btn.disabled = false;
      } else {
        setEvidenciasStatus(`Escaneando... ${data.progreso || 0}%`, true);
      }
    } catch (err) {
      clearInterval(_evidenciasState.pollTimer);
      _evidenciasState.pollTimer = null;
      if (!getJwt()) return;
      setEvidenciasStatus(`Error de red: ${err.message}`, false);
      if (btn) btn.disabled = false;
    }
  }, 3000);
}

// ─── SCAN STATUS ─────────────────────────────────────────────────────────────
function setScanStatus(msg, loading) {
  const el     = document.getElementById("scan-fichas-status");
  el.textContent = msg;
  el.className   = loading ? "job-status job-status--loading" : "job-status";
}

// ─── INIT ────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  const jwt = getJwt();

  if (!jwt) {
    showAuth();
    return;
  }

  // JWT presente — verificar sesión y cargar fichas
  try {
    const res = await fetch("/api/fichas", {
      headers: { "Authorization": `Bearer ${jwt}` },
    });

    if (res.status === 401) {
      clearJwt();
      showAuth();
      return;
    }

    // Token válido — decodificar payload para nombre/competencia
    const payload = JSON.parse(atob(jwt.split(".")[1]));
    showDashboard({
      nombre:           payload.nombre || "",
      competenciaNombre: "",
    });

    const data = await res.json();
    renderFichas(data.fichas || []);

  } catch {
    clearJwt();
    showAuth();
  }
});
