require("dotenv").config({ path: require("path").resolve(__dirname, "../../.env") });

// ─── ENTRYPOINT DE WORKERS ────────────────────────────────────────────────────
// Proceso SEPARADO de la API (ver CLAUDE.md §11.1 / §11.3 P0 #1).
// Antes los 15 workers se hacían require() dentro de server.js, en el MISMO
// proceso que el HTTP server: un OOM de cualquier scraper tumbaba también la API.
// Ahora la API (api/src/server.js) y los workers (este archivo) corren en
// procesos PM2 distintos (ver ecosystem.config.js).
//
// CRÍTICO: este proceso debe correr SIEMPRE con instances:1 (exec_mode fork).
// Si se corren 2 instancias, se duplican los browsers por usuario y Zajuna
// (Moodle) invalida la sesión paralela de la misma cuenta.

require("./workers/fichasWorker");
require("./workers/evidenciasWorker");
require("./workers/configWorker");
require("./workers/leerConfigEvidenciaWorker");
require("./workers/leerConfigLoteWorker");
require("./workers/cambiarFechaWorker");
require("./workers/cambiarConfigWorker");
require("./workers/foroRatingWorker");
require("./workers/foroDescubrirWorker");
require("./workers/autoScanWorker");
require("./workers/matchingIaWorker");
require("./workers/extraerRapsIaWorker");
require("./workers/mensajeFormativoWorker");
require("./workers/syncParticipantesWorker");
require("./workers/emailMasivoWorker");
require("./workers/descubrirCompetenciasWorker");
require("./workers/mensajesProgramadosWorker");

console.log("[worker-entry] 17 workers BullMQ registrados y escuchando colas.");

// Sin server HTTP: este proceso solo procesa jobs. Mantenerlo vivo lo hacen
// los Workers de BullMQ (tienen listeners de Redis abiertos).
