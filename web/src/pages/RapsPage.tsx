import { useState, useRef, useEffect, useCallback } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import {
  Plus, Pencil, Trash2, ChevronDown, ChevronRight, Link2, Unlink,
  Upload, Download, Search, X, Loader2, AlertCircle, CheckCircle,
  BookOpen,
} from "lucide-react"
import Layout from "@/components/Layout"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog"
import { apiFetch, ApiError } from "@/api/client"
import { useAuthStore } from "@/store/auth"
import { useNavigate } from "react-router-dom"

// ─── Types ────────────────────────────────────────────────────────────────────

interface Criterio {
  id?:         string
  descripcion: string
  orden:       number
}

interface RapSummary {
  id:              string
  codigo:          string
  descripcion:     string
  criteriosCount:  number
  evidenciasCount: number
  criterios:       Criterio[]
}

interface FichaInfo {
  id:     string
  codigo: string
  nombre: string
}

interface EvidenciaAsociada {
  relId:  string
  id:     string
  nombre: string
  tipo:   string
  href?:  string
  ficha:  FichaInfo
}

interface RapDetalle extends RapSummary {
  evidencias: EvidenciaAsociada[]
}

interface EvidenciaTodas {
  id:     string
  nombre: string
  tipo:   string
}

interface FichaConEvidencias {
  id:        string
  codigo:    string
  nombre:    string
  evidencias: EvidenciaTodas[]
}

interface ImportPayload {
  competenciaCodigo?: string
  exportedAt?:        string
  raps: { codigo: string; descripcion: string; criterios?: Criterio[] }[]
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function tipoBadgeVariant(tipo: string): "blue" | "purple" | "yellow" | "gray" {
  const map: Record<string, "blue" | "purple" | "yellow" | "gray"> = {
    assign: "blue", forum: "purple", quiz: "yellow",
  }
  return map[tipo] ?? "gray"
}

function tipoBadgeLabel(tipo: string): string {
  const map: Record<string, string> = { assign: "Tarea", forum: "Foro", quiz: "Quiz" }
  return map[tipo] ?? tipo
}

// ─── Sub-componente: fila de criterio editable ────────────────────────────────

interface CriterioRowProps {
  index:    number
  value:    string
  onChange: (val: string) => void
  onRemove: () => void
}

function CriterioRow({ index, value, onChange, onRemove }: CriterioRowProps) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-gray-400 w-5 text-right flex-shrink-0">{index + 1}.</span>
      <Input
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={`Criterio ${index + 1}`}
        className="h-8 text-sm flex-1"
      />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-8 w-8 p-0 text-gray-400 hover:text-red-500 flex-shrink-0"
        onClick={onRemove}
      >
        <X className="w-3.5 h-3.5" />
      </Button>
    </div>
  )
}

// ─── Sub-componente: modal de crear/editar RAP ────────────────────────────────

interface RapFormModalProps {
  open:    boolean
  rap?:    RapSummary | null
  onClose: () => void
  onSave:  (data: { codigo: string; descripcion: string; criterios: Criterio[] }) => void
  busy:    boolean
  error:   string
}

function RapFormModal({ open, rap, onClose, onSave, busy, error }: RapFormModalProps) {
  const [codigo, setCodigo]           = useState("")
  const [descripcion, setDescripcion] = useState("")
  const [criterios, setCriterios]     = useState<string[]>([""])

  // Sincronizar cuando se abre para edición
  useEffect(() => {
    if (open) {
      setCodigo(rap?.codigo ?? "")
      setDescripcion(rap?.descripcion ?? "")
      setCriterios(
        rap?.criterios?.length
          ? rap.criterios.map(c => c.descripcion)
          : [""]
      )
    }
  }, [open, rap])

  function addCriterio() { setCriterios(prev => [...prev, ""]) }

  function updateCriterio(i: number, val: string) {
    setCriterios(prev => prev.map((c, idx) => idx === i ? val : c))
  }

  function removeCriterio(i: number) {
    setCriterios(prev => prev.length > 1 ? prev.filter((_, idx) => idx !== i) : prev)
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    onSave({
      codigo:      codigo.trim(),
      descripcion: descripcion.trim(),
      criterios:   criterios
        .map((d, i) => ({ descripcion: d.trim(), orden: i }))
        .filter(c => c.descripcion),
    })
  }

  return (
    <Dialog open={open} onOpenChange={v => { if (!v && !busy) onClose() }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{rap ? "Editar RAP" : "Nuevo RAP"}</DialogTitle>
          <DialogDescription>
            {rap ? "Modifica los datos del RAP y sus criterios de evaluación." : "Define el código, descripción y criterios del nuevo RAP."}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="rap-codigo">Código</Label>
            <Input
              id="rap-codigo"
              value={codigo}
              onChange={e => setCodigo(e.target.value)}
              placeholder="Ej: RAP1"
              required
              disabled={busy}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="rap-descripcion">Descripción</Label>
            <textarea
              id="rap-descripcion"
              value={descripcion}
              onChange={e => setDescripcion(e.target.value)}
              placeholder="Descripción del resultado de aprendizaje..."
              required
              disabled={busy}
              rows={3}
              className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 resize-none"
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Criterios de evaluación</Label>
              <Button type="button" variant="outline" size="sm" className="h-7 text-xs gap-1" onClick={addCriterio} disabled={busy}>
                <Plus className="w-3 h-3" />
                Agregar
              </Button>
            </div>
            <div className="space-y-2 max-h-52 overflow-y-auto pr-1">
              {criterios.map((c, i) => (
                <CriterioRow
                  key={i}
                  index={i}
                  value={c}
                  onChange={val => updateCriterio(i, val)}
                  onRemove={() => removeCriterio(i)}
                />
              ))}
            </div>
          </div>

          {error && (
            <div className="flex items-center gap-2 text-sm text-red-600">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              Cancelar
            </Button>
            <Button type="submit" className="bg-sena-green hover:bg-sena-green/90" disabled={busy}>
              {busy && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              {rap ? "Guardar cambios" : "Crear RAP"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ─── Sub-componente: modal de importación ─────────────────────────────────────

interface ImportModalProps {
  open:    boolean
  onClose: () => void
  onConfirm: (payload: ImportPayload) => void
  busy:    boolean
  error:   string
  result:  { created: number; updated: number; skipped: { codigo: string; error: string }[] } | null
}

function ImportModal({ open, onClose, onConfirm, busy, error, result }: ImportModalProps) {
  const [parsed, setParsed]     = useState<ImportPayload | null>(null)
  const [parseErr, setParseErr] = useState("")
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) {
      setParsed(null)
      setParseErr("")
      if (fileRef.current) fileRef.current.value = ""
    }
  }, [open])

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = ev => {
      try {
        const data = JSON.parse(ev.target?.result as string) as ImportPayload
        if (!Array.isArray(data.raps)) throw new Error("El JSON no tiene la propiedad 'raps' como array.")
        setParsed(data)
        setParseErr("")
      } catch (err) {
        setParsed(null)
        setParseErr(err instanceof Error ? err.message : "Archivo JSON inválido.")
      }
    }
    reader.readAsText(file)
  }

  return (
    <Dialog open={open} onOpenChange={v => { if (!v && !busy) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Importar RAPs desde JSON</DialogTitle>
          <DialogDescription>
            Selecciona un archivo JSON exportado desde esta misma herramienta. Los RAPs existentes se actualizarán; los nuevos se crearán.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label htmlFor="import-file">Archivo JSON</Label>
            <input
              id="import-file"
              ref={fileRef}
              type="file"
              accept=".json,application/json"
              onChange={handleFile}
              disabled={busy}
              className="mt-1.5 block w-full text-sm text-gray-600 file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border file:border-gray-300 file:text-sm file:font-medium file:bg-white hover:file:bg-gray-50 cursor-pointer disabled:opacity-50"
            />
          </div>

          {parseErr && (
            <div className="flex items-center gap-2 text-sm text-red-600">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{parseErr}</span>
            </div>
          )}

          {parsed && !result && (
            <div className="rounded-md bg-blue-50 border border-blue-200 p-3 text-sm space-y-1">
              <p className="font-medium text-blue-800">Vista previa</p>
              {parsed.competenciaCodigo && (
                <p className="text-blue-700">Competencia: <strong>{parsed.competenciaCodigo}</strong></p>
              )}
              <p className="text-blue-700">
                <strong>{parsed.raps.length}</strong> RAP{parsed.raps.length !== 1 ? "s" : ""} a importar
              </p>
              <ul className="text-blue-600 text-xs mt-1 space-y-0.5 max-h-32 overflow-y-auto">
                {parsed.raps.map((r, i) => (
                  <li key={i} className="flex gap-1.5">
                    <span className="font-mono font-semibold">{r.codigo}</span>
                    <span className="text-blue-500 truncate">{r.descripcion}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {result && (
            <div className="rounded-md bg-green-50 border border-green-200 p-3 text-sm space-y-1">
              <p className="font-medium text-green-800 flex items-center gap-1.5">
                <CheckCircle className="w-4 h-4" />
                Importación completada
              </p>
              <p className="text-green-700">{result.created} creados · {result.updated} actualizados</p>
              {result.skipped.length > 0 && (
                <div className="text-red-600 mt-1">
                  <p className="font-medium">Omitidos con error ({result.skipped.length}):</p>
                  <ul className="text-xs list-disc pl-4 mt-0.5">
                    {result.skipped.map((s, i) => (
                      <li key={i}><strong>{s.codigo}</strong>: {s.error}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {error && (
            <div className="flex items-center gap-2 text-sm text-red-600">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {result ? "Cerrar" : "Cancelar"}
          </Button>
          {!result && (
            <Button
              className="bg-sena-green hover:bg-sena-green/90"
              disabled={!parsed || !!parseErr || busy}
              onClick={() => parsed && onConfirm(parsed)}
            >
              {busy && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Confirmar importación
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Sub-componente: panel de detalle de un RAP ───────────────────────────────

interface RapDetailPanelProps {
  rapId:    string
  onClose?: () => void
}

function RapDetailPanel({ rapId }: RapDetailPanelProps) {
  const queryClient   = useQueryClient()
  const [evSearch, setEvSearch] = useState("")

  const { data: detalle, isLoading } = useQuery<RapDetalle>({
    queryKey: ["rap-detalle", rapId],
    queryFn:  () => apiFetch<RapDetalle>(`/api/raps/${encodeURIComponent(rapId)}`),
    staleTime: 30_000,
  })

  const { data: todasData } = useQuery<{ fichas: FichaConEvidencias[] }>({
    queryKey: ["evidencias-todas"],
    queryFn:  () => apiFetch<{ fichas: FichaConEvidencias[] }>("/api/evidencias/todas"),
    staleTime: 60_000,
  })

  const asociarMutation = useMutation({
    mutationFn: (evidenciaId: string) =>
      apiFetch(`/api/raps/${encodeURIComponent(rapId)}/evidencias/${encodeURIComponent(evidenciaId)}`, { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["rap-detalle", rapId] })
      queryClient.invalidateQueries({ queryKey: ["raps"] })
    },
  })

  const desasociarMutation = useMutation({
    mutationFn: (evidenciaId: string) =>
      apiFetch(`/api/raps/${encodeURIComponent(rapId)}/evidencias/${encodeURIComponent(evidenciaId)}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["rap-detalle", rapId] })
      queryClient.invalidateQueries({ queryKey: ["raps"] })
    },
  })

  // Todas las evidencias planas
  const todasEvidencias = (todasData?.fichas ?? []).flatMap(f =>
    f.evidencias.map(ev => ({ ...ev, ficha: { id: f.id, codigo: f.codigo, nombre: f.nombre } }))
  )

  // IDs de evidencias ya asociadas
  const asociadasIds = new Set((detalle?.evidencias ?? []).map(e => e.id))

  // Filtrar por búsqueda y excluir ya asociadas
  const disponibles = todasEvidencias
    .filter(ev => !asociadasIds.has(ev.id))
    .filter(ev => {
      if (!evSearch.trim()) return false
      const q = evSearch.toLowerCase()
      return ev.nombre.toLowerCase().includes(q)
    })
    .slice(0, 10)

  if (isLoading) {
    return (
      <div className="px-5 py-6 flex items-center gap-2 text-sm text-gray-500">
        <Loader2 className="w-4 h-4 animate-spin" />
        Cargando detalle...
      </div>
    )
  }

  if (!detalle) return null

  return (
    <div className="border-t border-gray-100 bg-gray-50/50 px-5 py-4 space-y-4">
      {/* Criterios */}
      <div>
        <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
          Criterios de evaluación ({detalle.criterios.length})
        </h4>
        {detalle.criterios.length === 0 ? (
          <p className="text-sm text-gray-400 italic">Sin criterios definidos.</p>
        ) : (
          <ol className="space-y-1 list-none">
            {detalle.criterios.map((c, i) => (
              <li key={c.id ?? i} className="flex gap-2 text-sm text-gray-700">
                <span className="text-xs text-gray-400 mt-0.5 flex-shrink-0 w-5 text-right">{i + 1}.</span>
                <span>{c.descripcion}</span>
              </li>
            ))}
          </ol>
        )}
      </div>

      {/* Evidencias asociadas */}
      <div>
        <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
          Evidencias asociadas ({detalle.evidencias.length})
        </h4>
        {detalle.evidencias.length > 0 && (
          <div className="space-y-1.5 mb-3">
            {detalle.evidencias.map(ev => (
              <div key={ev.relId} className="flex items-center gap-2 bg-white border border-gray-200 rounded-md px-3 py-1.5">
                <Badge variant={tipoBadgeVariant(ev.tipo)} className="text-xs flex-shrink-0">
                  {tipoBadgeLabel(ev.tipo)}
                </Badge>
                <span className="text-xs font-mono text-gray-500 flex-shrink-0">{ev.ficha.codigo}</span>
                <span className="text-sm text-gray-700 flex-1 truncate">{ev.nombre}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0 text-gray-400 hover:text-red-500 flex-shrink-0"
                  title="Quitar asociación"
                  disabled={desasociarMutation.isPending}
                  onClick={() => desasociarMutation.mutate(ev.id)}
                >
                  <Unlink className="w-3.5 h-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}

        {/* Buscador para agregar evidencias */}
        <div className="space-y-1.5">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" />
            <Input
              value={evSearch}
              onChange={e => setEvSearch(e.target.value)}
              placeholder="Buscar evidencia para asociar..."
              className="h-8 text-sm pl-8"
            />
            {evSearch && (
              <button
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                onClick={() => setEvSearch("")}
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {evSearch.trim() && disponibles.length === 0 && (
            <p className="text-xs text-gray-400 px-1">No hay evidencias disponibles con ese nombre.</p>
          )}

          {disponibles.length > 0 && (
            <div className="space-y-1 max-h-40 overflow-y-auto">
              {disponibles.map(ev => (
                <div
                  key={ev.id}
                  className="flex items-center gap-2 bg-white border border-gray-200 rounded-md px-3 py-1.5 hover:border-sena-green/50 hover:bg-sena-green/5 transition-colors"
                >
                  <Badge variant={tipoBadgeVariant(ev.tipo)} className="text-xs flex-shrink-0">
                    {tipoBadgeLabel(ev.tipo)}
                  </Badge>
                  <span className="text-xs font-mono text-gray-500 flex-shrink-0">
                    {(ev as typeof ev & { ficha: FichaInfo }).ficha.codigo}
                  </span>
                  <span className="text-sm text-gray-700 flex-1 truncate">{ev.nombre}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 p-0 text-gray-400 hover:text-sena-green flex-shrink-0"
                    title="Asociar evidencia"
                    disabled={asociarMutation.isPending}
                    onClick={() => { asociarMutation.mutate(ev.id); setEvSearch("") }}
                  >
                    <Link2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Componente principal ─────────────────────────────────────────────────────

export default function RapsPage() {
  const navigate    = useNavigate()
  const { jwt, user, clearAuth, setAuth } = useAuthStore()
  const queryClient = useQueryClient()

  // Auth bootstrap (mismo patrón que EvidenciasConfig)
  useEffect(() => {
    const storedJwt = localStorage.getItem("zajuna_jwt")
    if (!storedJwt) { navigate("/login"); return }
    if (!user && storedJwt) {
      try {
        const payload = JSON.parse(atob(storedJwt.split(".")[1]))
        setAuth(storedJwt, {
          id:                payload.id || "",
          nombre:            payload.nombre || "",
          email:             payload.email || "",
          competenciaNombre: payload.competenciaNombre || "",
          competenciaCodigo: payload.competenciaCodigo || "",
        })
      } catch { clearAuth(); navigate("/login") }
    }
  }, [])

  // ── State ──────────────────────────────────────────────────────────────────
  const [expanded, setExpanded]           = useState<Set<string>>(new Set())
  const [formOpen, setFormOpen]           = useState(false)
  const [editingRap, setEditingRap]       = useState<RapSummary | null>(null)
  const [formBusy, setFormBusy]           = useState(false)
  const [formError, setFormError]         = useState("")
  const [deleteTarget, setDeleteTarget]   = useState<RapSummary | null>(null)
  const [deleteBusy, setDeleteBusy]       = useState(false)
  const [importOpen, setImportOpen]       = useState(false)
  const [importBusy, setImportBusy]       = useState(false)
  const [importError, setImportError]     = useState("")
  const [importResult, setImportResult]   = useState<{ created: number; updated: number; skipped: { codigo: string; error: string }[] } | null>(null)

  // ── Query: lista de RAPs ───────────────────────────────────────────────────
  const { data: raps, isLoading } = useQuery<RapSummary[]>({
    queryKey: ["raps"],
    queryFn:  () => apiFetch<RapSummary[]>("/api/raps"),
    enabled:  !!jwt,
    retry:    false,
  })

  // ── Toggle expand ─────────────────────────────────────────────────────────
  function toggleExpand(rapId: string) {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(rapId)) next.delete(rapId)
      else next.add(rapId)
      return next
    })
  }

  // ── Crear / Editar ─────────────────────────────────────────────────────────
  function openCreate() {
    setEditingRap(null)
    setFormError("")
    setFormOpen(true)
  }

  function openEdit(rap: RapSummary) {
    setEditingRap(rap)
    setFormError("")
    setFormOpen(true)
  }

  async function handleSave(data: { codigo: string; descripcion: string; criterios: Criterio[] }) {
    setFormBusy(true)
    setFormError("")
    try {
      if (editingRap) {
        await apiFetch(`/api/raps/${encodeURIComponent(editingRap.id)}`, {
          method: "PUT",
          body:   JSON.stringify(data),
        })
      } else {
        await apiFetch("/api/raps", { method: "POST", body: JSON.stringify(data) })
      }
      queryClient.invalidateQueries({ queryKey: ["raps"] })
      setFormOpen(false)
    } catch (e) {
      setFormError(e instanceof ApiError ? e.message : "Error al guardar el RAP.")
    } finally {
      setFormBusy(false)
    }
  }

  // ── Eliminar ───────────────────────────────────────────────────────────────
  async function handleDelete() {
    if (!deleteTarget) return
    setDeleteBusy(true)
    try {
      await apiFetch(`/api/raps/${encodeURIComponent(deleteTarget.id)}`, { method: "DELETE" })
      queryClient.invalidateQueries({ queryKey: ["raps"] })
      setDeleteTarget(null)
    } catch (e) {
      alert(e instanceof ApiError ? e.message : "Error al eliminar el RAP.")
    } finally {
      setDeleteBusy(false)
    }
  }

  // ── Exportar ───────────────────────────────────────────────────────────────
  async function handleExport() {
    try {
      const res = await fetch("/api/raps/export", {
        headers: { Authorization: `Bearer ${localStorage.getItem("zajuna_jwt")}` },
      })
      if (!res.ok) throw new Error("Error al exportar.")
      const blob = await res.blob()
      const cd   = res.headers.get("Content-Disposition") ?? ""
      const match = cd.match(/filename="([^"]+)"/)
      const filename = match?.[1] ?? "raps-export.json"
      const url = URL.createObjectURL(blob)
      const a   = document.createElement("a")
      a.href = url; a.download = filename; a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      alert(e instanceof Error ? e.message : "Error al exportar.")
    }
  }

  // ── Importar ───────────────────────────────────────────────────────────────
  async function handleImport(payload: ImportPayload) {
    setImportBusy(true)
    setImportError("")
    try {
      const result = await apiFetch<{ created: number; updated: number; skipped: { codigo: string; error: string }[] }>(
        "/api/raps/import",
        { method: "POST", body: JSON.stringify(payload) }
      )
      setImportResult(result)
      queryClient.invalidateQueries({ queryKey: ["raps"] })
    } catch (e) {
      setImportError(e instanceof ApiError ? e.message : "Error al importar.")
    } finally {
      setImportBusy(false)
    }
  }

  const rapsList = raps ?? []

  return (
    <Layout>
      <div className="space-y-4">

        {/* Cabecera */}
        <div className="bg-white rounded-lg border border-gray-200 p-4 flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <BookOpen className="w-4 h-4 text-sena-green" />
            <div>
              <h1 className="text-sm font-semibold text-gray-900">Resultados de Aprendizaje (RAPs)</h1>
              {user?.competenciaNombre && (
                <p className="text-xs text-gray-500 truncate">{user.competenciaNombre} · {user.competenciaCodigo}</p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <Button variant="outline" size="sm" className="gap-1.5 text-xs" onClick={handleExport} disabled={rapsList.length === 0}>
              <Download className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Exportar JSON</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 text-xs"
              onClick={() => { setImportResult(null); setImportError(""); setImportOpen(true) }}
            >
              <Upload className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Importar JSON</span>
            </Button>
            <Button
              size="sm"
              className="bg-sena-green hover:bg-sena-green/90 gap-1.5 text-xs"
              onClick={openCreate}
            >
              <Plus className="w-3.5 h-3.5" />
              Nuevo RAP
            </Button>
          </div>
        </div>

        {/* Lista */}
        {isLoading ? (
          <div className="bg-white rounded-lg border p-8 text-center text-gray-500 text-sm flex items-center justify-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" />
            Cargando RAPs...
          </div>
        ) : rapsList.length === 0 ? (
          <div className="bg-white rounded-lg border p-12 text-center space-y-3">
            <BookOpen className="w-10 h-10 text-gray-300 mx-auto" />
            <p className="text-gray-600 text-sm font-medium">No hay RAPs definidos aún.</p>
            <p className="text-gray-400 text-xs">Crea el primer RAP para tu competencia o importa desde un archivo JSON.</p>
            <Button
              size="sm"
              className="bg-sena-green hover:bg-sena-green/90 gap-1.5 mt-2"
              onClick={openCreate}
            >
              <Plus className="w-3.5 h-3.5" />
              Crear primer RAP
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            {rapsList.map(rap => {
              const isExpanded = expanded.has(rap.id)
              return (
                <div key={rap.id} className="bg-white rounded-lg border border-gray-200 overflow-hidden">
                  {/* Fila principal */}
                  <div
                    className="px-4 py-3 flex items-start gap-3 cursor-pointer hover:bg-gray-50 select-none"
                    onClick={() => toggleExpand(rap.id)}
                  >
                    {isExpanded
                      ? <ChevronDown  className="w-4 h-4 text-gray-400 flex-shrink-0 mt-0.5" />
                      : <ChevronRight className="w-4 h-4 text-gray-400 flex-shrink-0 mt-0.5" />}

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono text-sm font-bold text-gray-900">{rap.codigo}</span>
                        <Badge variant="gray" className="text-xs">
                          {rap.criteriosCount} criterio{rap.criteriosCount !== 1 ? "s" : ""}
                        </Badge>
                        {rap.evidenciasCount > 0 && (
                          <Badge variant="green" className="text-xs">
                            {rap.evidenciasCount} evidencia{rap.evidenciasCount !== 1 ? "s" : ""}
                          </Badge>
                        )}
                      </div>
                      <p className="text-sm text-gray-600 mt-0.5 line-clamp-2">{rap.descripcion}</p>
                    </div>

                    {/* Acciones — stopPropagation para no colapsar el card */}
                    <div className="flex items-center gap-1 flex-shrink-0" onClick={e => e.stopPropagation()}>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 text-gray-400 hover:text-gray-700"
                        title="Editar RAP"
                        onClick={() => openEdit(rap)}
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 text-gray-400 hover:text-red-500"
                        title="Eliminar RAP"
                        onClick={() => setDeleteTarget(rap)}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </div>

                  {/* Panel de detalle expandido */}
                  {isExpanded && <RapDetailPanel rapId={rap.id} />}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Modal crear/editar */}
      <RapFormModal
        open={formOpen}
        rap={editingRap}
        onClose={() => setFormOpen(false)}
        onSave={handleSave}
        busy={formBusy}
        error={formError}
      />

      {/* Confirmación eliminar */}
      <Dialog open={!!deleteTarget} onOpenChange={v => { if (!v && !deleteBusy) setDeleteTarget(null) }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Eliminar RAP</DialogTitle>
            <DialogDescription>
              Esta acción eliminará el RAP <strong className="font-mono">{deleteTarget?.codigo}</strong> y todos sus criterios y asociaciones de evidencias. No se puede deshacer.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={deleteBusy}>
              Cancelar
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleteBusy}>
              {deleteBusy && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Eliminar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Modal importar */}
      <ImportModal
        open={importOpen}
        onClose={() => { setImportOpen(false); setImportResult(null) }}
        onConfirm={handleImport}
        busy={importBusy}
        error={importError}
        result={importResult}
      />
    </Layout>
  )
}
