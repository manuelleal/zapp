import { useState, useEffect } from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  Sparkles, Upload, Loader2, FileText, AlertCircle,
  CheckCircle, RotateCcw, Plus, X,
} from "lucide-react"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
  DialogDescription, DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Badge } from "@/components/ui/badge"
import { apiFetch, ApiError } from "@/api/client"
import { usePollJob } from "@/hooks/usePollJob"
import { toast } from "sonner"

/**
 * Modal multi-paso "Cargar mis RAPs con IA" (Fase 1).
 *
 * Flujo:
 *   1. subir      → el instructor elige el PDF de su guía de aprendizaje.
 *   2. procesando → POST /api/raps/extraer-ia (multipart) → usePollJob sondea el job.
 *   3. revisar    → lista editable de los RAPs propuestos por la IA. El instructor
 *                   incluye/excluye, edita descripción y criterios, y confirma.
 *   4. guardar    → POST /api/raps/import → invalida ["raps"] y cierra.
 *
 * Regla #8 del proyecto: la IA PROPONE, el instructor DECIDE. El copy lo deja claro.
 *
 * GOTCHA del multipart: `apiFetch`/`authFetch` fijan Content-Type: application/json
 * cuando hay body, lo que rompe el boundary de multipart. Para la subida usamos
 * `fetch` directo con el JWT a mano y SIN fijar Content-Type (el navegador pone el
 * boundary). El resto de llamadas (import) sí usan `apiFetch` (JSON normal).
 */

// ─── Types ──────────────────────────────────────────────────────────────────

interface RapPropuesto {
  codigo:      string
  descripcion: string
  criterios:   string[]
}

interface PropuestaIA {
  competenciaCodigo: string
  competenciaNombre: string
  raps:              RapPropuesto[]
}

// Estado editable local de cada RAP (incluido + ediciones del instructor).
interface RapEditable {
  codigo:      string
  descripcion: string
  criterios:   string[]
  incluido:    boolean
}

type Paso = "subir" | "procesando" | "revisar"

const JWT_KEY = "zajuna_jwt"
const MAX_PDF_MB = 15

// ─── Componente ───────────────────────────────────────────────────────────────

export default function CargarRapsIaModal({
  open,
  onOpenChange,
  rapsExistentes = 0,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  // Nº de RAPs que la competencia del instructor YA tiene cargados. Sirve para
  // avisar que la IA solo AGREGA los que falten (el backend protege los existentes:
  // un instructor no los sobrescribe, solo el superadmin los cura). Default 0.
  rapsExistentes?: number
}) {
  const queryClient = useQueryClient()
  const poll = usePollJob()

  const [paso, setPaso]       = useState<Paso>("subir")
  const [archivo, setArchivo] = useState<File | null>(null)
  const [jobMsg, setJobMsg]   = useState("")
  const [error, setError]     = useState<string | null>(null)
  const [subiendo, setSubiendo] = useState(false)
  const [guardando, setGuardando] = useState(false)

  const [competencia, setCompetencia] = useState<{ codigo: string; nombre: string }>({ codigo: "", nombre: "" })
  const [raps, setRaps] = useState<RapEditable[]>([])

  // Reset completo del modal (al cerrar o al reintentar).
  function resetTodo() {
    poll.stop()
    setPaso("subir")
    setArchivo(null)
    setJobMsg("")
    setError(null)
    setSubiendo(false)
    setGuardando(false)
    setCompetencia({ codigo: "", nombre: "" })
    setRaps([])
  }

  // Al cerrar el modal limpiamos el estado para que la próxima apertura arranque limpia.
  useEffect(() => {
    if (!open) {
      // pequeño delay no hace falta; el Dialog ya hace fade-out
      resetTodo()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // ── Paso 1 → 2: subir PDF y disparar extracción IA ───────────────────────────

  function elegirArchivo(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null
    setError(null)
    if (!f) { setArchivo(null); return }
    if (!f.name.toLowerCase().endsWith(".pdf") && f.type !== "application/pdf") {
      setError("El archivo debe ser un PDF.")
      setArchivo(null)
      return
    }
    if (f.size > MAX_PDF_MB * 1024 * 1024) {
      setError(`El PDF supera el máximo de ${MAX_PDF_MB} MB.`)
      setArchivo(null)
      return
    }
    setArchivo(f)
  }

  async function extraerConIA() {
    if (!archivo) return
    setSubiendo(true)
    setError(null)

    const form = new FormData()
    form.append("guia", archivo)

    try {
      // multipart: fetch directo, JWT a mano, SIN Content-Type (boundary automático).
      const jwt = localStorage.getItem(JWT_KEY)
      const res = await fetch("/api/raps/extraer-ia", {
        method:  "POST",
        headers: jwt ? { Authorization: `Bearer ${jwt}` } : {},
        body:    form,
      })

      if (res.status === 401) {
        localStorage.removeItem(JWT_KEY)
        window.location.href = "/login"
        return
      }

      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new ApiError(res.status, data?.error || `Error ${res.status}`, data)
      }

      const jobId: string = data.jobId
      setPaso("procesando")
      setJobMsg("La IA está leyendo tu guía…")
      setSubiendo(false)

      poll.start(
        jobId,
        (resultado) => {
          const r = resultado as { propuesta?: PropuestaIA; stats?: { rapsPropuestos: number } }
          const propuesta = r?.propuesta
          if (!propuesta || !Array.isArray(propuesta.raps) || propuesta.raps.length === 0) {
            setPaso("subir")
            setError("La IA no encontró RAPs en este PDF. Verifica que sea la guía de aprendizaje correcta.")
            return
          }
          setCompetencia({
            codigo: propuesta.competenciaCodigo || "",
            nombre: propuesta.competenciaNombre || "",
          })
          setRaps(propuesta.raps.map(rp => ({
            codigo:      rp.codigo,
            descripcion: rp.descripcion ?? "",
            criterios:   Array.isArray(rp.criterios) ? rp.criterios : [],
            incluido:    true,
          })))
          setPaso("revisar")
        },
        (msg) => {
          setPaso("subir")
          setError(msg || "La extracción con IA falló. Intenta de nuevo.")
        },
        () => {
          // sin progreso numérico fiable: mantenemos el mensaje del spinner
        },
      )
    } catch (e) {
      setSubiendo(false)
      setPaso("subir")
      // 429 = rate-limit (5 extracciones / 15 min). El body trae `{ error }` con el
      // mensaje exacto; lo mostramos en toast (además del aviso inline) para que el
      // instructor entienda que debe esperar, no que el PDF esté mal.
      if (e instanceof ApiError && e.status === 429) {
        toast.error(e.message)
        setError(e.message)
        return
      }
      setError(e instanceof ApiError ? e.message : "No se pudo iniciar la extracción con IA.")
    }
  }

  // ── Paso 3: edición de los RAPs propuestos ───────────────────────────────────

  function toggleIncluido(i: number) {
    setRaps(prev => prev.map((r, idx) => idx === i ? { ...r, incluido: !r.incluido } : r))
  }

  function editarDescripcion(i: number, valor: string) {
    setRaps(prev => prev.map((r, idx) => idx === i ? { ...r, descripcion: valor } : r))
  }

  function editarCriterio(i: number, j: number, valor: string) {
    setRaps(prev => prev.map((r, idx) =>
      idx === i ? { ...r, criterios: r.criterios.map((c, k) => k === j ? valor : c) } : r))
  }

  function borrarCriterio(i: number, j: number) {
    setRaps(prev => prev.map((r, idx) =>
      idx === i ? { ...r, criterios: r.criterios.filter((_, k) => k !== j) } : r))
  }

  function agregarCriterio(i: number) {
    setRaps(prev => prev.map((r, idx) =>
      idx === i ? { ...r, criterios: [...r.criterios, ""] } : r))
  }

  const seleccionados = raps.filter(r => r.incluido)

  // ── Confirmar: guardar en DB ─────────────────────────────────────────────────

  async function guardar() {
    const aGuardar = raps
      .filter(r => r.incluido)
      .map(r => ({
        codigo:      r.codigo,
        descripcion: r.descripcion.trim(),
        // criterios: string[] → { descripcion, orden }[], descartando vacíos.
        criterios:   r.criterios
          .map(c => c.trim())
          .filter(Boolean)
          .map((descripcion, orden) => ({ descripcion, orden })),
      }))

    if (aGuardar.length === 0) {
      toast.error("Selecciona al menos un RAP para guardar.")
      return
    }
    if (aGuardar.some(r => !r.descripcion)) {
      toast.error("Cada RAP incluido necesita una descripción.")
      return
    }

    setGuardando(true)
    try {
      // El backend BLINDA los RAPs compartidos: solo AGREGA los que falten.
      //   created    = RAPs nuevos agregados.
      //   protegidos = ya existían y NO se tocaron (el instructor no los pisa).
      //   updated    = > 0 solo si el usuario es superadmin (curó existentes).
      const r = await apiFetch<{
        created:    number
        updated:    number
        protegidos: number
        skipped:    unknown[]
      }>(
        "/api/raps/import",
        { method: "POST", body: JSON.stringify({ raps: aGuardar }) },
      )

      const created    = r.created    ?? 0
      const updated    = r.updated    ?? 0
      const protegidos = r.protegidos ?? 0

      // Nada nuevo y había existentes → no es error, es que ya estaban cargados.
      if (created === 0 && updated === 0 && protegidos > 0) {
        toast.success("Tus RAPs ya estaban cargados — no había nada nuevo que agregar.")
      } else {
        const partes: string[] = []
        if (created) partes.push(`✓ ${created} RAP${created !== 1 ? "s" : ""} agregado${created !== 1 ? "s" : ""}`)
        if (updated) partes.push(`${updated} actualizado${updated !== 1 ? "s" : ""}`)
        if (protegidos) partes.push(`· ${protegidos} ya existía${protegidos !== 1 ? "n" : ""} (protegido${protegidos !== 1 ? "s" : ""})`)
        toast.success(partes.length ? partes.join(" ") : "RAPs guardados.")
      }

      queryClient.invalidateQueries({ queryKey: ["raps"] })
      onOpenChange(false)
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "No se pudieron guardar los RAPs.")
    } finally {
      setGuardando(false)
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────────
  // El usuario puede cerrar en cualquier paso; el effect de `open` detiene el poll
  // y limpia el estado, así que no quedan jobs colgados.

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-sena-green" />
            Cargar mis RAPs con IA
          </DialogTitle>
          <DialogDescription>
            {paso === "subir" &&
              "Sube tu guía de aprendizaje (PDF) y la IA extraerá tus RAPs. Tú revisas y confirmas antes de guardar."}
            {paso === "procesando" &&
              "Estamos analizando tu guía con inteligencia artificial."}
            {paso === "revisar" &&
              "La IA propone estos RAPs. Revísalos, edítalos si hace falta y confirma cuáles guardar."}
          </DialogDescription>
        </DialogHeader>

        {/* ── Paso 1: subir ───────────────────────────────────────────────── */}
        {paso === "subir" && (
          <div className="space-y-4">
            <label
              htmlFor="guia-pdf"
              className="flex flex-col items-center justify-center gap-2 border-2 border-dashed border-gray-200 rounded-lg px-6 py-10 cursor-pointer hover:border-sena-green/50 hover:bg-sena-green/5 transition-colors text-center"
            >
              {archivo ? (
                <>
                  <FileText className="w-8 h-8 text-sena-green" />
                  <span className="text-sm font-medium text-gray-800">{archivo.name}</span>
                  <span className="text-xs text-gray-400">
                    {(archivo.size / 1024 / 1024).toFixed(2)} MB · Haz clic para cambiar
                  </span>
                </>
              ) : (
                <>
                  <Upload className="w-8 h-8 text-gray-300" />
                  <span className="text-sm font-medium text-gray-700">Selecciona el PDF de tu guía</span>
                  <span className="text-xs text-gray-400">Solo archivos PDF · máx. {MAX_PDF_MB} MB</span>
                </>
              )}
              <input
                id="guia-pdf"
                type="file"
                accept="application/pdf,.pdf"
                className="hidden"
                onChange={elegirArchivo}
              />
            </label>

            {/* Aviso de RAPs compartidos: si la competencia ya tiene RAPs, la IA solo
                agrega los que falten; los existentes están protegidos (no se pisan). */}
            {rapsExistentes > 0 && (
              <div className="flex items-start gap-2 text-sm text-blue-800 bg-blue-50 border border-blue-200 rounded-md px-3 py-2">
                <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5 text-blue-500" />
                <span>
                  Tu programa ya tiene <strong>{rapsExistentes}</strong> RAP{rapsExistentes !== 1 ? "s" : ""} cargado{rapsExistentes !== 1 ? "s" : ""}.
                  {" "}La IA solo agregará los que falten; los existentes no se sobrescriben
                  {" "}(solo el administrador puede actualizarlos).
                </span>
              </div>
            )}

            {error && (
              <div className="flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
                <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            <DialogFooter className="gap-2">
              <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={subiendo}>
                Cancelar
              </Button>
              <Button
                size="sm"
                className="bg-sena-green hover:bg-sena-green/90 gap-1.5"
                onClick={extraerConIA}
                disabled={!archivo || subiendo}
              >
                {subiendo
                  ? <Loader2 className="w-4 h-4 animate-spin" />
                  : <Sparkles className="w-4 h-4" />}
                {subiendo ? "Subiendo…" : "Extraer con IA"}
              </Button>
            </DialogFooter>
          </div>
        )}

        {/* ── Paso 2: procesando ──────────────────────────────────────────── */}
        {paso === "procesando" && (
          <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
            <Loader2 className="w-10 h-10 text-sena-green animate-spin" />
            <p className="text-sm font-medium text-gray-800">{jobMsg || "Procesando…"}</p>
            <p className="text-xs text-gray-400 max-w-sm">
              Esto puede tardar unos segundos mientras la IA lee tu guía y extrae los RAPs.
            </p>
          </div>
        )}

        {/* ── Paso 3: revisar ─────────────────────────────────────────────── */}
        {paso === "revisar" && (
          <div className="space-y-4">
            <div className="flex items-start gap-2 text-sm text-gray-600 bg-gray-50 border border-gray-200 rounded-md px-3 py-2">
              <CheckCircle className="w-4 h-4 text-sena-green flex-shrink-0 mt-0.5" />
              <span>
                La IA propone <strong>{raps.length}</strong> RAP{raps.length !== 1 ? "s" : ""} para la competencia{" "}
                <strong>{competencia.nombre || competencia.codigo || "tu competencia"}</strong>
                {competencia.nombre && competencia.codigo ? <span className="text-gray-400"> · {competencia.codigo}</span> : null}.
                {" "}Revísalos y confirma cuáles guardar.
              </span>
            </div>

            <div className="space-y-3 max-h-[50vh] overflow-y-auto pr-1">
              {raps.map((rap, i) => (
                <div
                  key={rap.codigo + i}
                  className={`rounded-lg border p-3 space-y-2.5 transition-colors ${
                    rap.incluido ? "border-gray-200 bg-white" : "border-gray-100 bg-gray-50/60 opacity-70"
                  }`}
                >
                  {/* Cabecera: incluir + código */}
                  <div className="flex items-center gap-2.5">
                    <Checkbox
                      checked={rap.incluido}
                      onCheckedChange={() => toggleIncluido(i)}
                      id={`incluir-${i}`}
                    />
                    <label htmlFor={`incluir-${i}`} className="flex items-center gap-2 cursor-pointer select-none">
                      <span className="font-mono text-sm font-bold text-gray-900">{rap.codigo}</span>
                      {!rap.incluido && <Badge variant="gray" className="text-xs">No se guardará</Badge>}
                    </label>
                  </div>

                  {/* Descripción editable */}
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-gray-500">Descripción</label>
                    <textarea
                      value={rap.descripcion}
                      onChange={e => editarDescripcion(i, e.target.value)}
                      rows={2}
                      disabled={!rap.incluido}
                      placeholder="Descripción del resultado de aprendizaje…"
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring resize-none disabled:opacity-60 disabled:cursor-not-allowed"
                    />
                  </div>

                  {/* Criterios editables */}
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <label className="text-xs font-medium text-gray-500">
                        Criterios de evaluación ({rap.criterios.length})
                      </label>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 gap-1 text-xs text-sena-green hover:text-sena-green hover:bg-sena-green/10"
                        disabled={!rap.incluido}
                        onClick={() => agregarCriterio(i)}
                      >
                        <Plus className="w-3.5 h-3.5" />
                        Añadir
                      </Button>
                    </div>

                    {rap.criterios.length === 0 ? (
                      <p className="text-xs text-gray-400 italic px-1">
                        Sin criterios. Puedes añadirlos manualmente.
                      </p>
                    ) : (
                      <div className="space-y-1.5">
                        {rap.criterios.map((c, j) => (
                          <div key={j} className="flex items-start gap-1.5">
                            <span className="text-xs text-gray-400 mt-2 flex-shrink-0 w-4 text-right">{j + 1}.</span>
                            <textarea
                              value={c}
                              onChange={e => editarCriterio(i, j, e.target.value)}
                              rows={1}
                              disabled={!rap.incluido}
                              placeholder="Criterio…"
                              className="flex-1 rounded-md border border-input bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring resize-none disabled:opacity-60 disabled:cursor-not-allowed"
                            />
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-7 w-7 p-0 text-gray-400 hover:text-red-500 flex-shrink-0 mt-0.5"
                              disabled={!rap.incluido}
                              onClick={() => borrarCriterio(i, j)}
                              title="Quitar criterio"
                            >
                              <X className="w-3.5 h-3.5" />
                            </Button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <DialogFooter className="gap-2">
              <Button variant="outline" size="sm" onClick={resetTodo} disabled={guardando} className="gap-1.5">
                <RotateCcw className="w-3.5 h-3.5" />
                Subir otro PDF
              </Button>
              <Button
                size="sm"
                className="bg-sena-green hover:bg-sena-green/90 gap-1.5"
                onClick={guardar}
                disabled={guardando || seleccionados.length === 0}
              >
                {guardando
                  ? <Loader2 className="w-4 h-4 animate-spin" />
                  : <CheckCircle className="w-4 h-4" />}
                {guardando
                  ? "Guardando…"
                  : `Guardar ${seleccionados.length} RAP${seleccionados.length !== 1 ? "s" : ""}`}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
