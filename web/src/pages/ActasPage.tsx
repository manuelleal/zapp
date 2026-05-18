import { useState, useEffect } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import {
  ClipboardList, Plus, Loader2, AlertCircle, Users,
  MessageSquare, ChevronDown, ChevronRight, ChevronUp, Lock, Download, FileText,
  Trash2, Archive, ArchiveRestore, AlertTriangle, Send,
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
import { toast } from "sonner"
import { useAuthStore } from "@/store/auth"
import { useNavigate } from "react-router-dom"

// ─── Types ────────────────────────────────────────────────────────────────────

interface Ficha {
  id:     string
  codigo: string
  nombre: string
}

interface RapSummary {
  id:          string
  codigo:      string
  descripcion: string
}

interface ActaSummary {
  id:          string
  numero:      string
  fecha:       string
  hora:        string
  lugar:       string
  objetivo:    string
  estado:      "borrador" | "cerrada"
  creadoAt:    string
  archivadaAt: string | null
  ficha:       { codigo: string; nombre: string }
  _count:      { participantes: number; mensajes: number }
}

interface Compromiso {
  actividad:    string
  fecha:        string
  responsable:  string
}

type Juicio = "APROBÓ" | "PENDIENTE" | "NO PARTICIPÓ"

interface ActaDetalle extends ActaSummary {
  fichaId:      string
  conclusiones: string | null
  compromisos:  Compromiso[] | null
  rapIds:       string[]
  rapsInfo:     RapSummary[]
  notas:        string | null
  participantes: {
    id:          string
    aprendizId:  string
    juicio:      Juicio
    rapStatus:   Record<string, Juicio> | null
    hasUngraded: boolean
    aprendiz:    { nombre: string; moodleId: string | null }
  }[]
  mensajes: {
    id:               string
    canal:            string
    asunto:           string
    estado:           string
    enviadoAt:        string | null
    creadoAt:         string
    destinatariosCount: number
  }[]
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatFecha(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("es-CO", { day: "2-digit", month: "short", year: "numeric" })
  } catch { return iso }
}

function juicioBadgeVariant(juicio: string): "green" | "yellow" | "gray" {
  if (juicio === "APROBÓ")       return "green"
  if (juicio === "PENDIENTE")    return "yellow"
  return "gray"
}

const JUICIOS: Juicio[] = ["APROBÓ", "PENDIENTE", "NO PARTICIPÓ"]

function calcularJuicioGlobal(rapStatus: Record<string, Juicio>): Juicio {
  const vals = Object.values(rapStatus)
  if (vals.length === 0)                        return "PENDIENTE"
  if (vals.every(v => v === "APROBÓ"))         return "APROBÓ"
  if (vals.every(v => v === "NO PARTICIPÓ")) return "NO PARTICIPÓ"
  return "PENDIENTE"
}

// ─── Modal Nueva Acta ─────────────────────────────────────────────────────────

interface NuevaActaModalProps {
  open:    boolean
  onClose: () => void
  fichas:  Ficha[]
  raps:    RapSummary[]
}

function NuevaActaModal({ open, onClose, fichas, raps }: NuevaActaModalProps) {
  const queryClient = useQueryClient()
  const [fichaId,    setFichaId]    = useState("")
  const [numero,     setNumero]     = useState("")
  const [fecha,      setFecha]      = useState("")
  const [hora,       setHora]       = useState("")
  const [lugar,      setLugar]      = useState("Videoconferencia / Plataforma Zajuna")
  const [objetivo,   setObjetivo]   = useState("")
  const [rapIds,     setRapIds]     = useState<string[]>([])
  const [errorMsg,   setErrorMsg]   = useState("")

  useEffect(() => {
    if (!open) {
      setFichaId(""); setNumero(""); setFecha(""); setHora("")
      setLugar("Videoconferencia / Plataforma Zajuna"); setObjetivo("")
      setRapIds([]); setErrorMsg("")
    }
  }, [open])

  const mutation = useMutation({
    mutationFn: (body: object) => apiFetch<ActaSummary>("/api/actas", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["actas"] })
      onClose()
    },
    onError: (e) => setErrorMsg(e instanceof ApiError ? e.message : "Error al crear el acta."),
  })

  function toggleRap(id: string) {
    setRapIds(prev => prev.includes(id) ? prev.filter(r => r !== id) : [...prev, id])
  }

  function handleSubmit() {
    setErrorMsg("")
    if (!fichaId || !numero.trim() || !fecha || !hora || !lugar.trim() || !objetivo.trim()) {
      setErrorMsg("Completa todos los campos obligatorios.")
      return
    }
    mutation.mutate({ fichaId, numero: numero.trim(), fecha, hora, lugar: lugar.trim(), objetivo: objetivo.trim(), rapIds })
  }

  return (
    <Dialog open={open} onOpenChange={v => { if (!v && !mutation.isPending) onClose() }}>
      <DialogContent className="max-w-lg max-h-[90vh] flex flex-col">
        <DialogHeader className="flex-shrink-0">
          <DialogTitle>Nueva Acta de Seguimiento</DialogTitle>
          <DialogDescription>Completa los datos para crear el borrador del acta.</DialogDescription>
        </DialogHeader>

        {errorMsg && (
          <div className="flex-shrink-0 flex items-center gap-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{errorMsg}</span>
          </div>
        )}

        <div className="space-y-4 overflow-y-auto flex-1 pr-1">
          <div className="space-y-1.5">
            <Label htmlFor="acta-ficha">Ficha *</Label>
            <select
              id="acta-ficha"
              value={fichaId}
              onChange={e => setFichaId(e.target.value)}
              disabled={mutation.isPending}
              className="w-full h-9 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
            >
              <option value="">Seleccionar ficha...</option>
              {fichas.map(f => (
                <option key={f.id} value={f.id}>{f.codigo} — {f.nombre}</option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="acta-numero">Número de acta *</Label>
              <Input
                id="acta-numero"
                value={numero}
                onChange={e => setNumero(e.target.value)}
                placeholder="ej. 01"
                disabled={mutation.isPending}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="acta-fecha">Fecha *</Label>
              <Input
                id="acta-fecha"
                type="date"
                value={fecha}
                onChange={e => setFecha(e.target.value)}
                disabled={mutation.isPending}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="acta-hora">Hora *</Label>
              <Input
                id="acta-hora"
                type="time"
                value={hora}
                onChange={e => setHora(e.target.value)}
                disabled={mutation.isPending}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="acta-lugar">Lugar *</Label>
              <Input
                id="acta-lugar"
                value={lugar}
                onChange={e => setLugar(e.target.value)}
                disabled={mutation.isPending}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="acta-objetivo">Objetivo *</Label>
            <textarea
              id="acta-objetivo"
              value={objetivo}
              onChange={e => setObjetivo(e.target.value)}
              rows={3}
              disabled={mutation.isPending}
              placeholder="Describir el objetivo de la sesión de seguimiento..."
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50 resize-none"
            />
          </div>

          {raps.length > 0 && (
            <div className="space-y-1.5">
              <Label>RAPs a evaluar</Label>
              <div className="border border-input rounded-md p-3 space-y-2 max-h-40 overflow-y-auto">
                {raps.map(r => (
                  <label key={r.id} className="flex items-start gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={rapIds.includes(r.id)}
                      onChange={() => toggleRap(r.id)}
                      disabled={mutation.isPending}
                      className="mt-0.5 h-4 w-4 rounded border-gray-300 text-sena-green focus:ring-sena-green"
                    />
                    <span className="text-sm text-gray-700">
                      <span className="font-mono font-semibold text-gray-900">{r.codigo}</span>
                      {" — "}
                      <span className="text-gray-600">{r.descripcion}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )}

        </div>

        <DialogFooter className="flex-shrink-0">
          <Button variant="outline" onClick={onClose} disabled={mutation.isPending}>Cancelar</Button>
          <Button
            className="bg-sena-green hover:bg-sena-green/90"
            onClick={handleSubmit}
            disabled={mutation.isPending}
          >
            {mutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            Crear Acta
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Panel de detalle del acta ────────────────────────────────────────────────

interface ActaDetailPanelProps {
  actaId:            string
  allRaps:           RapSummary[]
  userName:          string
  competenciaNombre: string
}

function ActaDetailPanel({ actaId, allRaps, userName, competenciaNombre }: ActaDetailPanelProps) {
  const queryClient = useQueryClient()
  const navigate    = useNavigate()
  const [juiciosLocales,    setJuiciosLocales]    = useState<Record<string, Juicio>>({})
  const [rapStatusLocales,  setRapStatusLocales]  = useState<Record<string, Record<string, Juicio>>>({})
  const [conclusiones,      setConclusiones]      = useState("")
  const [notas,             setNotas]             = useState("")
  const [compromisos,       setCompromisos]       = useState<Compromiso[]>([])
  const [rapIdsLocales,     setRapIdsLocales]     = useState<string[]>([])
  const [patchError,        setPatchError]        = useState("")
  const [cerrarConfirm,     setCerrarConfirm]     = useState(false)
  const [deletePartId,      setDeletePartId]      = useState<string | null>(null)
  const [guiaVisible,       setGuiaVisible]       = useState(true)

  const { data: acta, isLoading } = useQuery<ActaDetalle>({
    queryKey: ["acta-detalle", actaId],
    queryFn:  () => apiFetch<ActaDetalle>(`/api/actas/${actaId}`),
    staleTime: 30_000,
  })

  useEffect(() => {
    if (!acta) return
    const mapaJuicios: Record<string, Juicio> = {}
    const mapaRapStatus: Record<string, Record<string, Juicio>> = {}
    acta.participantes.forEach(p => {
      mapaJuicios[p.aprendizId] = p.juicio
      if (p.rapStatus) mapaRapStatus[p.aprendizId] = { ...p.rapStatus }
    })
    setJuiciosLocales(mapaJuicios)
    setRapStatusLocales(mapaRapStatus)
    setConclusiones(acta.conclusiones ?? "")
    setNotas(acta.notas ?? "")
    setCompromisos(acta.compromisos ?? [])
    setRapIdsLocales(acta.rapIds ?? [])
  }, [acta])

  const patchMutation = useMutation({
    mutationFn: (body: object) => apiFetch(`/api/actas/${actaId}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["acta-detalle", actaId] })
      queryClient.invalidateQueries({ queryKey: ["actas"] })
      setPatchError("")
      toast.success("Guardado correctamente.")
    },
    onError: (e) => {
      const msg = e instanceof ApiError ? e.message : "Error al guardar."
      setPatchError(msg)
      toast.error(msg)
    },
  })

  const juiciosMutation = useMutation({
    mutationFn: (participantes: { aprendizId: string; juicio: Juicio; rapStatus?: Record<string, Juicio> }[]) =>
      apiFetch(`/api/actas/${actaId}/participantes`, { method: "POST", body: JSON.stringify(participantes) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["acta-detalle", actaId] })
      toast.success("Juicios guardados correctamente.")
    },
    onError: (e) => {
      const msg = e instanceof ApiError ? e.message : "Error al guardar juicios."
      setPatchError(msg)
      toast.error(msg)
    },
  })

  const deleteParticipanteMutation = useMutation({
    mutationFn: (participanteId: string) =>
      apiFetch(`/api/actas/${actaId}/participantes/${participanteId}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["acta-detalle", actaId] })
      setDeletePartId(null)
      toast.success("Participante eliminado.")
    },
    onError: (e) => {
      const msg = e instanceof ApiError ? e.message : "Error al eliminar participante."
      toast.error(msg)
    },
  })

  const autoPoblarMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ poblados: number; aprobaron: number; pendientes: number; noParticiparon: number; warnings: number; evidenciasVinculadas: number; filtrados?: number }>(
        `/api/actas/${actaId}/auto-poblar`, { method: "POST" }
      ),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["acta-detalle", actaId] })
      if (result.poblados === 0) {
        toast.warning("No hay aprendices registrados en esta ficha. Escanea la ficha primero.")
      } else if (result.evidenciasVinculadas === 0) {
        toast.warning(
          "No se encontraron RAPs asociados. Asegúrate de haber vinculado evidencias a los RAPs del acta."
        )
      } else {
        const filtradosTxt = (result.filtrados ?? 0) > 0
          ? ` ⚠ ${result.filtrados} registros inválidos omitidos (AA, AG...). Elimínalos manualmente si aparecen.`
          : ""
        toast.success(`Poblado: ${result.poblados} aprendices. ${result.aprobaron} aprobaron, ${result.pendientes} pendientes, ${result.noParticiparon} no participaron.${ result.warnings > 0 ? ` ⚠ ${result.warnings} con entregas sin calificar.` : ""}${filtradosTxt}`)
      }
    },
    onError: (e) => {
      const msg = e instanceof ApiError ? e.message : "Error al auto-poblar."
      setPatchError(msg)
      toast.error(msg)
    },
  })

  const cerrarMutation = useMutation({
    mutationFn: () => apiFetch(`/api/actas/${actaId}/cerrar`, { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["acta-detalle", actaId] })
      queryClient.invalidateQueries({ queryKey: ["actas"] })
      setCerrarConfirm(false)
    },
    onError: (e) => {
      const msg = e instanceof ApiError ? e.message : "Error al cerrar el acta."
      setPatchError(msg)
      toast.error(msg)
    },
  })

  function toggleRap(id: string) {
    setRapIdsLocales(prev => prev.includes(id) ? prev.filter(r => r !== id) : [...prev, id])
  }

  function agregarCompromiso() {
    setCompromisos(prev => [...prev, { actividad: "", fecha: "", responsable: "" }])
  }

  function actualizarCompromiso(idx: number, field: keyof Compromiso, value: string) {
    setCompromisos(prev => prev.map((c, i) => i === idx ? { ...c, [field]: value } : c))
  }

  function eliminarCompromiso(idx: number) {
    setCompromisos(prev => prev.filter((_, i) => i !== idx))
  }

  function guardarInfoGeneral() {
    patchMutation.mutate({ rapIds: rapIdsLocales })
  }

  function guardarConclusiones() {
    patchMutation.mutate({ conclusiones, compromisos, notas })
  }

  async function descargarActaConAuth(id: string, numero: string, tipo: "borrador" | "gor-f-084") {
    try {
      const url = tipo === "borrador"
        ? `/api/actas/${encodeURIComponent(id)}/download`
        : `/api/actas/${encodeURIComponent(id)}/download/gor-f-084`
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${localStorage.getItem("zajuna_jwt")}` },
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(data.error || `Error ${res.status} al generar el documento.`)
      }
      const blob = await res.blob()
      const cd = res.headers.get("Content-Disposition") ?? ""
      const match = cd.match(/filename="([^"]+)"/)
      const filename = match?.[1] ?? (tipo === "borrador" ? `acta-${numero}.docx` : `acta-${numero}-gor-f-084.docx`)
      const blobUrl = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = blobUrl; a.download = filename; a.click()
      URL.revokeObjectURL(blobUrl)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error al descargar el documento.")
    }
  }

  function guardarJuicios() {
    if (!acta) return
    const payload = acta.participantes.map(p => {
      const rs = rapStatusLocales[p.aprendizId] ?? p.rapStatus ?? undefined
      const juicio: Juicio = rs ? calcularJuicioGlobal(rs) : (juiciosLocales[p.aprendizId] ?? p.juicio)
      return { aprendizId: p.aprendizId, juicio, rapStatus: rs }
    })
    juiciosMutation.mutate(payload)
  }

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-500 p-6">
        <Loader2 className="w-4 h-4 animate-spin" />
        Cargando detalle...
      </div>
    )
  }

  if (!acta) return null

  const esBorrador = acta.estado === "borrador"
  const nAprobaron   = acta.participantes.filter(p => p.juicio === "APROBÓ").length
  const nPendientes  = acta.participantes.filter(p => p.juicio === "PENDIENTE").length
  const nNoParticipo = acta.participantes.filter(p => p.juicio === "NO PARTICIPÓ").length

  // RAPs del acta (para columnas dinámicas)
  const rapsDelActa = acta.rapsInfo ?? []

  return (
    <div className="border-t border-gray-100 bg-gray-50/40 p-5 space-y-6">

      {/* ── Banner de pasos (solo borrador) ── */}
      {esBorrador && (
        <div className="rounded-md border border-blue-200 bg-blue-50 p-3 text-xs text-blue-800 space-y-1">
          <div className="flex items-center justify-between">
            <span className="font-semibold">Cómo completar esta acta:</span>
            <button onClick={() => setGuiaVisible(v => !v)} className="text-blue-700 hover:text-blue-900" aria-label="Mostrar/ocultar guía">
              {guiaVisible ? <ChevronUp className="w-3.5 h-3.5"/> : <ChevronDown className="w-3.5 h-3.5"/>}
            </button>
          </div>
          {guiaVisible && (
            <ol className="list-decimal list-inside space-y-0.5 ml-1">
              <li>Marca los RAPs trabajados en esta sesión → <strong>Guardar RAPs</strong></li>
              <li>Haz clic en <strong>Auto-poblar desde evidencias</strong> para cargar los aprendices</li>
              <li>Ajusta el estado de cada aprendiz por RAP si es necesario → <strong>Guardar juicios</strong></li>
              <li>Descarga el Word cuando el acta esté lista</li>
            </ol>
          )}
        </div>
      )}

      {/* ── Info general ── */}
      <section className="space-y-3">
        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Información general</h3>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
          <div><span className="text-gray-500">Fecha:</span> <span className="font-medium">{formatFecha(acta.fecha)}</span></div>
          <div><span className="text-gray-500">Hora:</span> <span className="font-medium">{acta.hora}</span></div>
          <div className="col-span-2"><span className="text-gray-500">Lugar:</span> <span className="font-medium">{acta.lugar}</span></div>
        </div>
        <div className="text-sm"><span className="text-gray-500">Objetivo:</span> <span className="ml-1">{acta.objetivo}</span></div>

        {allRaps.length > 0 && (
          <div className="space-y-1.5">
            <Label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">RAPs cubiertos</Label>
            <div className="grid grid-cols-1 gap-1.5">
              {allRaps.map(r => (
                <label key={r.id} className={`flex items-start gap-2 ${esBorrador ? "cursor-pointer" : "cursor-default"}`}>
                  <input
                    type="checkbox"
                    checked={rapIdsLocales.includes(r.id)}
                    onChange={() => esBorrador && toggleRap(r.id)}
                    disabled={!esBorrador || patchMutation.isPending}
                    className="mt-0.5 h-4 w-4 rounded border-gray-300"
                  />
                  <span className="text-sm text-gray-700">
                    <span className="font-mono font-semibold">{r.codigo}</span>
                    {" — "}
                    <span className="text-gray-600">{r.descripcion}</span>
                  </span>
                </label>
              ))}
            </div>
            {esBorrador && (
              <div>
                <Button size="sm" variant="outline" className="text-xs" onClick={guardarInfoGeneral} disabled={patchMutation.isPending}>
                  {patchMutation.isPending && <Loader2 className="w-3 h-3 mr-1.5 animate-spin" />}
                  Guardar RAPs
                </Button>
                <p className="text-xs text-gray-400 mt-0.5">
                  Al guardar los RAPs, la tabla mostrará una columna por cada RAP seleccionado.
                </p>
              </div>
            )}
          </div>
        )}
      </section>

      {/* ── Participantes ── */}
      <section className="space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Participantes</h3>
          {esBorrador && (
            <div className="flex items-center gap-2 flex-wrap">
              <Button size="sm" variant="outline" className="text-xs gap-1.5"
                onClick={() => autoPoblarMutation.mutate()} disabled={autoPoblarMutation.isPending}
                title="Carga automáticamente todos los aprendices de la ficha y calcula su estado según las evidencias vinculadas a los RAPs">
                {autoPoblarMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Users className="w-3 h-3" />}
                Auto-poblar desde evidencias
              </Button>
              <Button size="sm" variant="outline" className="text-xs"
                onClick={guardarJuicios} disabled={juiciosMutation.isPending || acta.participantes.length === 0}>
                {juiciosMutation.isPending && <Loader2 className="w-3 h-3 mr-1.5 animate-spin" />}
                Guardar juicios
              </Button>
              {acta.participantes.length > 0 && (
                <Button size="sm" variant="outline" className="text-xs gap-1.5 border-amber-300 text-amber-700 hover:bg-amber-50"
                  onClick={() => navigate(`/mensajes/nuevo?actaId=${actaId}&filtro=pendientes`)}>
                  <Send className="w-3 h-3" /> Notificar pendientes
                </Button>
              )}
            </div>
          )}
        </div>

        {acta.participantes.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2">
            <Badge variant="green"  className="text-xs">{nAprobaron} aprobaron</Badge>
            <Badge variant="yellow" className="text-xs">{nPendientes} pendientes</Badge>
            <Badge variant="gray"   className="text-xs">{nNoParticipo} no participaron</Badge>
          </div>
        )}

        {rapsDelActa.length === 0 && acta.participantes.length > 0 && (
          <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>
              Las columnas de RAP no aparecen porque el acta no tiene RAPs guardados.
              Selecciona los RAPs arriba, haz clic en <strong>Guardar RAPs</strong> y luego usa <strong>Auto-poblar desde evidencias</strong>.
            </span>
          </div>
        )}

        {/* Confirm eliminar participante */}
        {deletePartId && (
          <div className="flex items-center gap-3 bg-red-50 border border-red-200 rounded-md px-3 py-2 text-sm flex-wrap">
            <span className="text-red-700 font-medium">¿Eliminar este participante del acta?</span>
            <Button size="sm" className="bg-red-600 hover:bg-red-700 text-white text-xs"
              onClick={() => deleteParticipanteMutation.mutate(deletePartId)}
              disabled={deleteParticipanteMutation.isPending}>
              {deleteParticipanteMutation.isPending && <Loader2 className="w-3 h-3 mr-1 animate-spin" />}
              Sí, eliminar
            </Button>
            <Button size="sm" variant="outline" className="text-xs" onClick={() => setDeletePartId(null)}>Cancelar</Button>
          </div>
        )}

        {acta.participantes.length === 0 ? (
          <p className="text-sm text-gray-400 italic">
            Sin participantes.{esBorrador && " Usa 'Auto-poblar' para cargar desde evidencias."}
          </p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-gray-200">
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="text-left px-3 py-2 text-xs font-semibold text-gray-500 min-w-[180px]">Aprendiz</th>
                  {rapsDelActa.map(r => (
                    <th key={r.id} className="text-center px-2 py-2 text-xs font-semibold text-gray-500 whitespace-nowrap">
                      {r.codigo.match(/-?(\d+)$/)?.[1] ? `RAP ${r.codigo.match(/-?(\d+)$/)![1]}` : r.codigo}
                    </th>
                  ))}
                  <th className="text-center px-2 py-2 text-xs font-semibold text-gray-500">Juicio</th>
                  <th className="text-center px-2 py-2 text-xs font-semibold text-gray-500 w-6">⚠</th>
                  {esBorrador && <th className="w-10 px-2 py-2 text-xs text-gray-400 text-center">Quitar</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {acta.participantes.map(p => {
                  const rsLocal = rapStatusLocales[p.aprendizId] ?? p.rapStatus ?? {}
                  const juicioGlobal: Juicio = Object.keys(rsLocal).length > 0
                    ? calcularJuicioGlobal(rsLocal)
                    : (juiciosLocales[p.aprendizId] ?? p.juicio)
                  return (
                    <tr key={p.id} className="bg-white hover:bg-gray-50">
                      <td className="px-3 py-2 text-gray-700 text-xs">{p.aprendiz.nombre}</td>
                      {rapsDelActa.map(r => {
                        const estadoRap = (rsLocal as Record<string, Juicio>)[r.codigo] ?? "NO PARTICIPÓ"
                        return (
                          <td key={r.id} className="px-2 py-1 text-center">
                            {esBorrador ? (
                              <select
                                value={estadoRap}
                                onChange={e => setRapStatusLocales(prev => ({
                                  ...prev,
                                  [p.aprendizId]: { ...(prev[p.aprendizId] ?? rsLocal), [r.codigo]: e.target.value as Juicio },
                                }))}
                                className={`h-6 rounded border px-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring ${
                                  estadoRap === "APROBÓ"       ? "bg-green-50  border-green-300 text-green-800" :
                                  estadoRap === "PENDIENTE"    ? "bg-yellow-50 border-yellow-300 text-yellow-800" :
                                                                 "bg-gray-50   border-gray-300  text-gray-500"
                                }`}
                              >
                                {JUICIOS.map(j => <option key={j} value={j}>{j}</option>)}
                              </select>
                            ) : (
                              <span className={`inline-block px-1.5 py-0.5 rounded text-xs font-medium ${
                                estadoRap === "APROBÓ"    ? "bg-green-100 text-green-700" :
                                estadoRap === "PENDIENTE" ? "bg-yellow-100 text-yellow-700" :
                                                             "bg-gray-100 text-gray-500"
                              }`}>{estadoRap}</span>
                            )}
                          </td>
                        )
                      })}
                      <td className="px-2 py-2 text-center">
                        <Badge variant={juicioBadgeVariant(juicioGlobal)} className="text-xs whitespace-nowrap">{juicioGlobal}</Badge>
                      </td>
                      <td className="px-2 py-2 text-center">
                        {p.hasUngraded && (
                          <span title="Tiene entregas sin calificar — revisar en Dashboard">
                            <AlertTriangle className="w-3.5 h-3.5 text-orange-400" />
                          </span>
                        )}
                      </td>
                      {esBorrador && (
                        <td className="px-2 py-2 text-center">
                          <button
                            onClick={() => setDeletePartId(p.id)}
                            className="text-gray-400 hover:text-red-500 transition-colors"
                            title="Quitar este aprendiz del acta"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── Notas / Aclaraciones ── */}
      <section className="space-y-2">
        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Notas / Aclaraciones</h3>
        {esBorrador ? (
          <textarea
            value={notas}
            onChange={e => setNotas(e.target.value)}
            rows={3}
            placeholder="Notas adicionales (ej. aprendiz solicitó prórroga, grupo trasladado de jornada...)..."
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring resize-none"
          />
        ) : acta.notas ? (
          <p className="text-sm text-gray-700 whitespace-pre-wrap bg-white border border-gray-100 rounded-md p-3">{acta.notas}</p>
        ) : (
          <p className="text-sm text-gray-400 italic">Sin notas registradas.</p>
        )}
      </section>

      {/* ── Conclusiones y compromisos ── */}
      <section className="space-y-3">
        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Conclusiones y compromisos</h3>

        <div className="space-y-1.5">
          <Label htmlFor="conclusiones-txt" className="text-sm">Conclusiones</Label>
          {esBorrador ? (
            <textarea
              id="conclusiones-txt"
              value={conclusiones}
              onChange={e => setConclusiones(e.target.value)}
              rows={4}
              placeholder="Escribir las conclusiones de la sesión..."
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring resize-none"
            />
          ) : (
            <p className="text-sm text-gray-700 whitespace-pre-wrap bg-white border border-gray-100 rounded-md p-3">
              {acta.conclusiones || <span className="text-gray-400 italic">Sin conclusiones.</span>}
            </p>
          )}
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-sm">Compromisos</Label>
            {esBorrador && (
              <Button size="sm" variant="outline" className="text-xs" onClick={agregarCompromiso}>
                + Agregar fila
              </Button>
            )}
          </div>

          {compromisos.length === 0 ? (
            <p className="text-sm text-gray-400 italic">Sin compromisos registrados.</p>
          ) : (
            <div className="overflow-x-auto rounded-md border border-gray-200">
              <table className="w-full text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="text-left px-3 py-2 text-xs font-semibold text-gray-500">Actividad</th>
                    <th className="text-left px-3 py-2 text-xs font-semibold text-gray-500">Fecha</th>
                    <th className="text-left px-3 py-2 text-xs font-semibold text-gray-500">Responsable</th>
                    {esBorrador && <th className="px-3 py-2 w-8" />}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {compromisos.map((c, idx) => (
                    <tr key={idx} className="bg-white">
                      <td className="px-3 py-1.5">
                        {esBorrador ? (
                          <Input value={c.actividad} onChange={e => actualizarCompromiso(idx, "actividad", e.target.value)} className="h-7 text-xs" placeholder="Actividad..." />
                        ) : c.actividad}
                      </td>
                      <td className="px-3 py-1.5">
                        {esBorrador ? (
                          <Input type="date" value={c.fecha} onChange={e => actualizarCompromiso(idx, "fecha", e.target.value)} className="h-7 text-xs" />
                        ) : c.fecha}
                      </td>
                      <td className="px-3 py-1.5">
                        {esBorrador ? (
                          <Input value={c.responsable} onChange={e => actualizarCompromiso(idx, "responsable", e.target.value)} className="h-7 text-xs" placeholder="Responsable..." />
                        ) : c.responsable}
                      </td>
                      {esBorrador && (
                        <td className="px-3 py-1.5 text-center">
                          <button onClick={() => eliminarCompromiso(idx)} className="text-gray-400 hover:text-red-500 text-xs" title="Eliminar fila">✕</button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {esBorrador && (
          <Button size="sm" variant="outline" className="text-xs" onClick={guardarConclusiones} disabled={patchMutation.isPending}>
            {patchMutation.isPending && <Loader2 className="w-3 h-3 mr-1.5 animate-spin" />}
            Guardar conclusiones, compromisos y notas
          </Button>
        )}
      </section>

      {/* ── Errores globales ── */}
      {patchError && (
        <div className="flex items-center gap-2 text-sm text-red-600">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{patchError}</span>
        </div>
      )}

      {/* ── Descargar acta ── */}
      <section className="space-y-2 border-t border-gray-100 pt-4">
        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Descargar acta</h3>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" className="text-xs gap-1.5"
            onClick={() => descargarActaConAuth(actaId, acta.numero, "borrador")}>
            <Download className="w-3 h-3" /> Word (borrador)
          </Button>
          <Button size="sm" variant="outline" className="text-xs gap-1.5"
            onClick={() => descargarActaConAuth(actaId, acta.numero, "gor-f-084")}>
            <FileText className="w-3 h-3" /> GOR-F-084 (oficial SENA)
          </Button>
        </div>
        <p className="text-xs text-gray-400">El archivo se descarga directamente al computador.</p>
      </section>

      {/* ── Cerrar acta ── */}
      {esBorrador && (
        <section className="pt-2 border-t border-gray-200">
          {!cerrarConfirm ? (
            <Button size="sm" variant="outline" className="text-xs gap-1.5 text-red-600 border-red-300 hover:bg-red-50" onClick={() => setCerrarConfirm(true)}>
              <Lock className="w-3 h-3" />
              Cerrar Acta
            </Button>
          ) : (
            <div className="flex items-center gap-3 flex-wrap">
              <p className="text-sm text-red-600 font-medium">Esta acción es irreversible. ¿Confirmas cerrar el acta?</p>
              <Button size="sm" className="bg-red-600 hover:bg-red-700 text-white text-xs" onClick={() => cerrarMutation.mutate()} disabled={cerrarMutation.isPending}>
                {cerrarMutation.isPending && <Loader2 className="w-3 h-3 mr-1.5 animate-spin" />}
                Sí, cerrar
              </Button>
              <Button size="sm" variant="outline" className="text-xs" onClick={() => setCerrarConfirm(false)}>Cancelar</Button>
            </div>
          )}
        </section>
      )}

    </div>
  )
}

// ─── Componente principal ─────────────────────────────────────────────────────

export default function ActasPage() {
  const queryClient = useQueryClient()
  const navigate    = useNavigate()
  const { jwt, user, clearAuth, setAuth } = useAuthStore()
  const [fichaFiltro,       setFichaFiltro]       = useState("")
  const [incluirArchivadas, setIncluirArchivadas]  = useState(false)
  const [expandedActa,      setExpandedActa]       = useState<string | null>(null)
  const [nuevaActaOpen,     setNuevaActaOpen]      = useState(false)
  const [downloadingId,     setDownloadingId]      = useState<string | null>(null)
  const [downloadingGorId,  setDownloadingGorId]   = useState<string | null>(null)
  const [deleteActaId,      setDeleteActaId]       = useState<string | null>(null)

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

  const { data: fichasResp } = useQuery<{ fichas: Ficha[] }>({
    queryKey: ["fichas-simple"],
    queryFn:  () => apiFetch<{ fichas: Ficha[] }>("/api/fichas"),
    enabled:  !!jwt,
    staleTime: 60_000,
  })
  const fichas = fichasResp?.fichas ?? []

  const { data: raps = [] } = useQuery<RapSummary[]>({
    queryKey: ["raps"],
    queryFn:  () => apiFetch<RapSummary[]>("/api/raps"),
    enabled:  !!jwt,
    staleTime: 60_000,
  })

  const { data: actas = [], isLoading } = useQuery<ActaSummary[]>({
    queryKey: ["actas", fichaFiltro, incluirArchivadas],
    queryFn:  () => {
      const params = new URLSearchParams()
      if (fichaFiltro)       params.set("fichaId", fichaFiltro)
      if (incluirArchivadas) params.set("incluirArchivadas", "1")
      const qs = params.toString()
      return apiFetch<ActaSummary[]>(`/api/actas${qs ? `?${qs}` : ""}`)
    },
    enabled:  !!jwt,
    staleTime: 30_000,
  })

  const archivaMutation = useMutation({
    mutationFn: ({ id, archivada }: { id: string; archivada: boolean }) =>
      apiFetch(`/api/actas/${id}`, { method: "PATCH", body: JSON.stringify({ archivada }) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["actas"] })
      toast.success("Acta actualizada.")
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Error al archivar."),
  })

  const deleteActaMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/actas/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["actas"] })
      setDeleteActaId(null)
      setExpandedActa(null)
      toast.success("Acta eliminada.")
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Error al eliminar el acta."),
  })

  function toggleActa(id: string) {
    setExpandedActa(prev => prev === id ? null : id)
  }

  async function handleDescargar(actaId: string, _numero: string) {
    setDownloadingId(actaId)
    try {
      const res = await fetch(`/api/actas/${encodeURIComponent(actaId)}/download`, {
        headers: { Authorization: `Bearer ${localStorage.getItem("zajuna_jwt")}` },
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(data.error || `Error ${res.status} al generar el documento.`)
      }
      const blob = await res.blob()
      const cd = res.headers.get("Content-Disposition") ?? ""
      const match = cd.match(/filename="([^"]+)"/)
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url; a.download = match?.[1] ?? "acta.docx"; a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error al descargar el documento.")
    } finally {
      setDownloadingId(null)
    }
  }

  async function handleDescargarGOR(actaId: string, numero: string) {
    setDownloadingGorId(actaId)
    try {
      const res = await fetch(`/api/actas/${encodeURIComponent(actaId)}/download/gor-f-084`, {
        headers: { Authorization: `Bearer ${localStorage.getItem("zajuna_jwt")}` },
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(data.error || `Error ${res.status} al generar GOR-F-084.`)
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url; a.download = `acta-${numero}-gor-f-084.docx`; a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error al descargar GOR-F-084.")
    } finally {
      setDownloadingGorId(null)
    }
  }

  return (
    <Layout>
      <div className="space-y-4">

        {/* ── Header ── */}
        <div className="bg-white rounded-lg border border-gray-200 p-4 flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <ClipboardList className="w-4 h-4 text-sena-green flex-shrink-0" />
            <div>
              <h1 className="text-sm font-semibold text-gray-900">Actas de Seguimiento</h1>
              {user?.competenciaNombre && (
                <p className="text-xs text-gray-500 truncate">{user.competenciaNombre} · {user.competenciaCodigo}</p>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 flex-shrink-0 flex-wrap">
            <select
              value={fichaFiltro}
              onChange={e => { setFichaFiltro(e.target.value); setExpandedActa(null) }}
              className="h-8 rounded-md border border-input bg-background px-3 text-xs shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
            >
              <option value="">Todas las fichas</option>
              {fichas.map(f => (
                <option key={f.id} value={f.id}>{f.codigo} — {f.nombre}</option>
              ))}
            </select>

            <button
              onClick={() => setIncluirArchivadas(v => !v)}
              className={`flex items-center gap-1.5 h-8 px-3 rounded-md border text-xs transition-colors ${
                incluirArchivadas
                  ? "bg-gray-100 border-gray-400 text-gray-700"
                  : "border-input text-gray-400 hover:text-gray-600"
              }`}
            >
              <Archive className="w-3.5 h-3.5" />
              {incluirArchivadas ? "Ocultar archivadas" : "Ver archivadas"}
            </button>

            <Button size="sm" className="bg-sena-green hover:bg-sena-green/90 gap-1.5 text-xs" onClick={() => setNuevaActaOpen(true)}>
              <Plus className="w-3.5 h-3.5" />
              Nueva Acta
            </Button>
          </div>
        </div>

        {/* ── Confirm eliminar acta ── */}
        {deleteActaId && (
          <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 flex items-center gap-3 flex-wrap text-sm">
            <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0" />
            <span className="text-red-700 font-medium flex-1">¿Eliminar esta acta permanentemente? Se borrarán todos sus participantes.</span>
            <Button size="sm" className="bg-red-600 hover:bg-red-700 text-white text-xs"
              onClick={() => deleteActaMutation.mutate(deleteActaId)} disabled={deleteActaMutation.isPending}>
              {deleteActaMutation.isPending && <Loader2 className="w-3 h-3 mr-1 animate-spin" />}
              Sí, eliminar
            </Button>
            <Button size="sm" variant="outline" className="text-xs" onClick={() => setDeleteActaId(null)}>Cancelar</Button>
          </div>
        )}

        {/* ── Lista de actas ── */}
        {isLoading ? (
          <div className="bg-white rounded-lg border p-8 text-center text-gray-500 text-sm flex items-center justify-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" />
            Cargando actas...
          </div>
        ) : actas.length === 0 ? (
          <div className="bg-white rounded-lg border p-12 text-center space-y-3">
            <ClipboardList className="w-10 h-10 text-gray-300 mx-auto" />
            <p className="text-gray-600 text-sm font-medium">No hay actas registradas aún.</p>
            <p className="text-gray-400 text-xs max-w-sm mx-auto">
              Usa el botón <strong>Nueva Acta</strong> para crear el primer borrador.
            </p>
            <Button size="sm" className="bg-sena-green hover:bg-sena-green/90 gap-1.5 mt-2" onClick={() => setNuevaActaOpen(true)}>
              <Plus className="w-3.5 h-3.5" />
              Nueva Acta
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            {actas.map(acta => {
              const isExpanded  = expandedActa === acta.id
              const isArchivada = !!acta.archivadaAt
              return (
                <div key={acta.id} className={`bg-white rounded-lg border overflow-hidden ${isArchivada ? "border-gray-200 opacity-75" : "border-gray-200"}`}>
                  <div className="px-4 py-3 flex items-start gap-3">
                    <button className="mt-0.5 text-gray-400 hover:text-gray-600 flex-shrink-0" onClick={() => toggleActa(acta.id)}>
                      {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                    </button>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-sm text-gray-900">Acta N° {acta.numero}</span>
                        <span className="text-xs text-gray-500 font-mono">{acta.ficha.codigo}</span>
                        <Badge variant={acta.estado === "borrador" ? "yellow" : "green"} className="text-xs">{acta.estado}</Badge>
                        {isArchivada && <Badge variant="gray" className="text-xs">archivada</Badge>}
                      </div>
                      <p className="text-xs text-gray-500 mt-0.5 truncate">{acta.ficha.nombre}</p>
                      <div className="flex items-center gap-3 mt-1 text-xs text-gray-500">
                        <span>{formatFecha(acta.fecha)} · {acta.hora}</span>
                        <span className="flex items-center gap-1"><Users className="w-3 h-3" />{acta._count.participantes}</span>
                        <span className="flex items-center gap-1"><MessageSquare className="w-3 h-3" />{acta._count.mensajes}</span>
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5 flex-shrink-0 flex-wrap justify-end">
                      <Button size="sm" variant="outline" className="text-xs gap-1" onClick={() => handleDescargar(acta.id, acta.numero)} disabled={downloadingId === acta.id}>
                        {downloadingId === acta.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
                        Word
                      </Button>
                      <Button size="sm" variant="outline" className="text-xs gap-1" onClick={() => handleDescargarGOR(acta.id, acta.numero)} disabled={downloadingGorId === acta.id}>
                        {downloadingGorId === acta.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <FileText className="w-3 h-3" />}
                        GOR-F-084
                      </Button>
                      <Button size="sm" variant="outline" className="text-xs gap-1"
                        onClick={() => archivaMutation.mutate({ id: acta.id, archivada: !isArchivada })}
                        disabled={archivaMutation.isPending}
                        title={isArchivada ? "Restaurar acta" : "Archivar acta"}
                      >
                        {isArchivada ? <ArchiveRestore className="w-3 h-3" /> : <Archive className="w-3 h-3" />}
                        {isArchivada ? "Restaurar" : "Archivar"}
                      </Button>
                      <Button size="sm" variant="outline" className="text-xs gap-1 text-red-500 border-red-200 hover:bg-red-50"
                        onClick={() => setDeleteActaId(acta.id)} title="Eliminar acta">
                        <Trash2 className="w-3 h-3" />
                      </Button>
                      <Button size="sm" variant="outline" className="text-xs" onClick={() => toggleActa(acta.id)}>
                        {isExpanded ? "Ocultar" : "Detalle"}
                      </Button>
                    </div>
                  </div>

                  {isExpanded && (
                    <ActaDetailPanel
                      actaId={acta.id}
                      allRaps={raps}
                      userName={user?.nombre ?? ""}
                      competenciaNombre={user?.competenciaNombre ?? ""}
                    />
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      <NuevaActaModal
        open={nuevaActaOpen}
        onClose={() => setNuevaActaOpen(false)}
        fichas={fichas}
        raps={raps}
      />
    </Layout>
  )
}
