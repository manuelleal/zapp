import { useState, useEffect, useRef } from "react"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Settings, Loader2, CheckCircle, AlertCircle } from "lucide-react"
import { apiFetch, authFetch, ApiError } from "@/api/client"

// ─── Types ───────────────────────────────────────────────────────────────────

interface Config {
  abrirFecha:   string | null
  abrirHora:    string | null
  entregaFecha: string | null
  entregaHora:  string | null
  limiteFecha:  string | null
  limiteHora:   string | null
  intentos:     number | "Ilimitado" | null
}

interface ConfigEvidenciaDialogProps {
  open:            boolean
  onClose:         () => void
  evidenciaIds:    string[]
  evidenciaNombre?: string
}

type Phase = "idle" | "loading" | "ready" | "saving" | "success" | "error"

// ─── Helpers ─────────────────────────────────────────────────────────────────

function emptyConfig(): Config {
  return {
    abrirFecha: null, abrirHora: null,
    entregaFecha: null, entregaHora: null,
    limiteFecha: null, limiteHora: null,
    intentos: null,
  }
}

function configToForm(c: Config) {
  return {
    abrirFecha:   c.abrirFecha   ?? "",
    abrirHora:    c.abrirHora    ?? "",
    entregaFecha: c.entregaFecha ?? "",
    entregaHora:  c.entregaHora  ?? "",
    limiteFecha:  c.limiteFecha  ?? "",
    limiteHora:   c.limiteHora   ?? "",
    intentos:     c.intentos === "Ilimitado" ? "-1" : c.intentos !== null ? String(c.intentos) : "",
  }
}

// ─── Polling hook ─────────────────────────────────────────────────────────────

function usePollJob() {
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  function stop() {
    if (intervalRef.current) {
      clearInterval(intervalRef.current)
      intervalRef.current = null
    }
  }

  function start(jobId: string, onDone: (resultado: unknown) => void, onError: (msg: string) => void, onProgress?: (p: number) => void) {
    stop()
    intervalRef.current = setInterval(async () => {
      try {
        const res  = await authFetch(`/api/jobs/${encodeURIComponent(jobId)}`)
        const data = await res.json()
        if (!res.ok) { stop(); onError(data?.errorMsg || `Error ${res.status}`); return }
        if (data.status === "done")  { stop(); onDone(data.resultado) }
        else if (data.status === "error") { stop(); onError(data.errorMsg || "El job falló.") }
        else onProgress?.(data.progreso || 0)
      } catch (e) {
        stop()
        onError(e instanceof Error ? e.message : "Error de red.")
      }
    }, 3000)
  }

  useEffect(() => () => stop(), [])

  return { start, stop }
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function ConfigEvidenciaDialog({
  open,
  onClose,
  evidenciaIds,
  evidenciaNombre,
}: ConfigEvidenciaDialogProps) {
  const isBulk = evidenciaIds.length > 1
  const [phase, setPhase]   = useState<Phase>("idle")
  const [statusMsg, setStatusMsg] = useState("")
  const [form, setForm]     = useState(configToForm(emptyConfig()))
  const pollLoad = usePollJob()
  const pollSave = usePollJob()

  // Load config when single evidencia opens
  useEffect(() => {
    if (!open) {
      setPhase("idle")
      setStatusMsg("")
      setForm(configToForm(emptyConfig()))
      pollLoad.stop()
      pollSave.stop()
      return
    }
    if (isBulk) {
      setPhase("ready")
      return
    }
    loadConfig(evidenciaIds[0])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  async function loadConfig(evidenciaId: string) {
    setPhase("loading")
    setStatusMsg("Leyendo configuración desde Moodle...")
    try {
      const { jobId } = await apiFetch<{ jobId: string }>(
        `/api/evidencias/${encodeURIComponent(evidenciaId)}/config`
      )
      pollLoad.start(
        jobId,
        (resultado: unknown) => {
          const r = resultado as { config: Config }
          setForm(configToForm(r.config))
          setPhase("ready")
          setStatusMsg("")
        },
        (msg) => {
          setPhase("error")
          setStatusMsg(msg)
        },
        (p) => setStatusMsg(`Leyendo... ${p}%`)
      )
    } catch (e) {
      setPhase("error")
      setStatusMsg(e instanceof ApiError ? e.message : "Error al iniciar lectura.")
    }
  }

  function setField(key: keyof typeof form, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  function buildConfigBody(): Partial<Config & { intentos: number | "Ilimitado" | null }> {
    const body: Record<string, unknown> = {}
    if (form.abrirFecha)   body.abrirFecha   = form.abrirFecha
    if (form.abrirHora)    body.abrirHora    = form.abrirHora
    if (form.entregaFecha) body.entregaFecha = form.entregaFecha
    if (form.entregaHora)  body.entregaHora  = form.entregaHora
    if (form.limiteFecha)  body.limiteFecha  = form.limiteFecha
    if (form.limiteHora)   body.limiteHora   = form.limiteHora
    if (form.intentos !== "") {
      body.intentos = form.intentos === "-1" ? "Ilimitado" : parseInt(form.intentos, 10)
    }
    return body as Partial<Config>
  }

  async function handleSave() {
    const config = buildConfigBody()
    if (Object.keys(config).length === 0) {
      setStatusMsg("No hay campos para guardar.")
      return
    }

    setPhase("saving")
    setStatusMsg("Guardando en Moodle...")

    try {
      if (isBulk) {
        const { jobIds } = await apiFetch<{ jobIds: string[] }>(
          "/api/evidencias/config/bulk",
          { method: "PATCH", body: JSON.stringify({ ids: evidenciaIds, config }) }
        )
        // Poll first job as representative
        pollSave.start(
          jobIds[0],
          () => { setPhase("success"); setStatusMsg(`Configuración aplicada a ${evidenciaIds.length} evidencias.`) },
          (msg) => { setPhase("error"); setStatusMsg(msg) },
          (p)   => setStatusMsg(`Guardando... ${p}% (1 de ${jobIds.length} jobs)`)
        )
      } else {
        const { jobId } = await apiFetch<{ jobId: string }>(
          `/api/evidencias/${encodeURIComponent(evidenciaIds[0])}/config`,
          { method: "PATCH", body: JSON.stringify(config) }
        )
        pollSave.start(
          jobId,
          () => { setPhase("success"); setStatusMsg("Configuración guardada correctamente.") },
          (msg) => { setPhase("error"); setStatusMsg(msg) },
          (p)   => setStatusMsg(`Guardando... ${p}%`)
        )
      }
    } catch (e) {
      setPhase("error")
      setStatusMsg(e instanceof ApiError ? e.message : "Error al guardar.")
    }
  }

  const busy = phase === "loading" || phase === "saving"

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        {/* Header */}
        <div className="flex items-center gap-2 mb-1">
          <Settings className="w-4 h-4 text-gray-500 shrink-0" />
          <DialogTitle className="text-base font-semibold">
            {isBulk
              ? `Configurar ${evidenciaIds.length} evidencias`
              : "Configurar evidencia"}
          </DialogTitle>
        </div>
        <DialogDescription className="text-xs text-gray-500 -mt-1 mb-3 truncate">
          {isBulk
            ? `Se aplicará la misma configuración a las ${evidenciaIds.length} evidencias seleccionadas.`
            : (evidenciaNombre ?? "Modifica fechas e intentos en Moodle.")}
        </DialogDescription>

        {/* Status bar */}
        {phase === "loading" && (
          <div className="flex items-center gap-2 text-sm text-blue-600 bg-blue-50 rounded px-3 py-2 mb-3">
            <Loader2 className="w-4 h-4 animate-spin shrink-0" />
            <span>{statusMsg}</span>
          </div>
        )}
        {phase === "saving" && (
          <div className="flex items-center gap-2 text-sm text-amber-700 bg-amber-50 rounded px-3 py-2 mb-3">
            <Loader2 className="w-4 h-4 animate-spin shrink-0" />
            <span>{statusMsg}</span>
          </div>
        )}
        {phase === "success" && (
          <div className="flex items-center gap-2 text-sm text-green-700 bg-green-50 rounded px-3 py-2 mb-3">
            <CheckCircle className="w-4 h-4 shrink-0" />
            <span>{statusMsg}</span>
          </div>
        )}
        {phase === "error" && (
          <div className="flex items-center gap-2 text-sm text-red-700 bg-red-50 rounded px-3 py-2 mb-3">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span className="break-words">{statusMsg}</span>
          </div>
        )}

        {/* Form */}
        <div className="space-y-4">
          {/* Apertura */}
          <fieldset className="border border-gray-200 rounded-md p-3">
            <legend className="text-xs font-medium text-gray-600 px-1">Fecha apertura</legend>
            <div className="flex gap-2">
              <div className="flex-1">
                <Label className="text-xs text-gray-500">Fecha</Label>
                <Input
                  type="date"
                  value={form.abrirFecha}
                  onChange={(e) => setField("abrirFecha", e.target.value)}
                  disabled={busy}
                  className="mt-1 h-8 text-sm"
                />
              </div>
              <div className="w-28">
                <Label className="text-xs text-gray-500">Hora</Label>
                <Input
                  type="time"
                  value={form.abrirHora}
                  onChange={(e) => setField("abrirHora", e.target.value)}
                  disabled={busy}
                  className="mt-1 h-8 text-sm"
                />
              </div>
            </div>
          </fieldset>

          {/* Entrega */}
          <fieldset className="border border-gray-200 rounded-md p-3">
            <legend className="text-xs font-medium text-gray-600 px-1">Fecha entrega</legend>
            <div className="flex gap-2">
              <div className="flex-1">
                <Label className="text-xs text-gray-500">Fecha</Label>
                <Input
                  type="date"
                  value={form.entregaFecha}
                  onChange={(e) => setField("entregaFecha", e.target.value)}
                  disabled={busy}
                  className="mt-1 h-8 text-sm"
                />
              </div>
              <div className="w-28">
                <Label className="text-xs text-gray-500">Hora</Label>
                <Input
                  type="time"
                  value={form.entregaHora}
                  onChange={(e) => setField("entregaHora", e.target.value)}
                  disabled={busy}
                  className="mt-1 h-8 text-sm"
                />
              </div>
            </div>
          </fieldset>

          {/* Límite */}
          <fieldset className="border border-gray-200 rounded-md p-3">
            <legend className="text-xs font-medium text-gray-600 px-1">Fecha límite (cutoff)</legend>
            <div className="flex gap-2">
              <div className="flex-1">
                <Label className="text-xs text-gray-500">Fecha</Label>
                <Input
                  type="date"
                  value={form.limiteFecha}
                  onChange={(e) => setField("limiteFecha", e.target.value)}
                  disabled={busy}
                  className="mt-1 h-8 text-sm"
                />
              </div>
              <div className="w-28">
                <Label className="text-xs text-gray-500">Hora</Label>
                <Input
                  type="time"
                  value={form.limiteHora}
                  onChange={(e) => setField("limiteHora", e.target.value)}
                  disabled={busy}
                  className="mt-1 h-8 text-sm"
                />
              </div>
            </div>
          </fieldset>

          {/* Intentos */}
          <div>
            <Label htmlFor="cfg-intentos" className="text-xs text-gray-600">
              Intentos permitidos
            </Label>
            <select
              id="cfg-intentos"
              value={form.intentos}
              onChange={(e) => setField("intentos", e.target.value)}
              disabled={busy}
              className="mt-1 w-full h-8 rounded-md border border-input bg-background px-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
            >
              <option value="">— sin cambio —</option>
              <option value="-1">Ilimitado</option>
              {[1,2,3,4,5,6,7,8,9,10].map((n) => (
                <option key={n} value={String(n)}>{n}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2 mt-5">
          <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>
            Cerrar
          </Button>
          {phase === "error" && !isBulk && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => loadConfig(evidenciaIds[0])}
              disabled={busy}
            >
              Reintentar lectura
            </Button>
          )}
          <Button
            size="sm"
            className="bg-sena-green hover:bg-sena-green/90"
            onClick={handleSave}
            disabled={busy || phase === "success"}
          >
            {phase === "saving" ? (
              <><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />Guardando…</>
            ) : (
              "Guardar"
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
