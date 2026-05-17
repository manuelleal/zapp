import { useState, useEffect } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import {
  ClipboardList, Plus, Loader2, AlertCircle, Users,
  MessageSquare, ChevronDown, ChevronRight, Lock, Download,
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
  id:        string
  numero:    string
  fecha:     string
  hora:      string
  lugar:     string
  objetivo:  string
  estado:    "borrador" | "cerrada"
  creadoAt:  string
  ficha:     { codigo: string; nombre: string }
  _count:    { participantes: number; mensajes: number }
}

interface Compromiso {
  actividad:    string
  fecha:        string
  responsable:  string
}

interface ActaDetalle extends ActaSummary {
  fichaId:      string
  conclusiones: string | null
  compromisos:  Compromiso[] | null
  rapIds:       string[]
  rapsInfo:     RapSummary[]
  participantes: {
    id:        string
    aprendizId: string
    juicio:    "APROBÓ" | "NO ASISTIÓ" | "PENDIENTE"
    aprendiz:  { nombre: string; moodleId: string | null }
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
  if (juicio === "APROBÓ")    return "green"
  if (juicio === "PENDIENTE") return "yellow"
  return "gray"
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
  const [juiciosLocales, setJuiciosLocales] = useState<Record<string, "APROBÓ" | "NO ASISTIÓ" | "PENDIENTE">>({})
  const [conclusiones,   setConclusiones]   = useState("")
  const [compromisos,    setCompromisos]    = useState<Compromiso[]>([])
  const [rapIdsLocales,  setRapIdsLocales]  = useState<string[]>([])
  const [patchError,     setPatchError]     = useState("")
  const [cerrarConfirm,  setCerrarConfirm]  = useState(false)

  const { data: acta, isLoading } = useQuery<ActaDetalle>({
    queryKey: ["acta-detalle", actaId],
    queryFn:  () => apiFetch<ActaDetalle>(`/api/actas/${actaId}`),
    staleTime: 30_000,
  })

  useEffect(() => {
    if (!acta) return
    const mapa: Record<string, "APROBÓ" | "NO ASISTIÓ" | "PENDIENTE"> = {}
    acta.participantes.forEach(p => { mapa[p.aprendizId] = p.juicio })
    setJuiciosLocales(mapa)
    setConclusiones(acta.conclusiones ?? "")
    setCompromisos(acta.compromisos ?? [])
    setRapIdsLocales(acta.rapIds ?? [])
  }, [acta])

  const patchMutation = useMutation({
    mutationFn: (body: object) => apiFetch(`/api/actas/${actaId}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["acta-detalle", actaId] })
      queryClient.invalidateQueries({ queryKey: ["actas"] })
      setPatchError("")
    },
    onError: (e) => {
      const msg = e instanceof ApiError ? e.message : "Error al guardar."
      setPatchError(msg)
      toast.error(msg)
    },
  })

  const juiciosMutation = useMutation({
    mutationFn: (participantes: { aprendizId: string; juicio: string }[]) =>
      apiFetch(`/api/actas/${actaId}/participantes`, { method: "POST", body: JSON.stringify(participantes) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["acta-detalle", actaId] }),
    onError: (e) => {
      const msg = e instanceof ApiError ? e.message : "Error al guardar juicios."
      setPatchError(msg)
      toast.error(msg)
    },
  })

  const autoPoblarMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ poblados: number; aprobaron: number; pendientes: number; noAsistieron: number; evidenciasVinculadas: number }>(
        `/api/actas/${actaId}/auto-poblar`, { method: "POST" }
      ),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["acta-detalle", actaId] })
      if (result.poblados === 0) {
        toast.warning("No hay aprendices registrados en esta ficha. Escanea la ficha primero.")
      } else if (result.evidenciasVinculadas === 0) {
        toast.warning(
          "No se encontraron RAPs asociados. Asegúrate de haber unificado los reportes de Zajuna y Sofía para esta ficha."
        )
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
    patchMutation.mutate({ conclusiones, compromisos })
  }

  function guardarJuicios() {
    const payload = Object.entries(juiciosLocales).map(([aprendizId, juicio]) => ({ aprendizId, juicio }))
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
  const nAprobaron = acta.participantes.filter(p => p.juicio === "APROBÓ").length
  const nPendientes = acta.participantes.filter(p => p.juicio === "PENDIENTE").length
  const nNoAsistio  = acta.participantes.filter(p => p.juicio === "NO ASISTIÓ").length

  return (
    <div className="border-t border-gray-100 bg-gray-50/40 p-5 space-y-6">

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
              <Button
                size="sm"
                variant="outline"
                className="text-xs"
                onClick={guardarInfoGeneral}
                disabled={patchMutation.isPending}
              >
                {patchMutation.isPending && <Loader2 className="w-3 h-3 mr-1.5 animate-spin" />}
                Guardar RAPs
              </Button>
            )}
          </div>
        )}
      </section>

      {/* ── Participantes ── */}
      <section className="space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Participantes</h3>
          {esBorrador && (
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                className="text-xs gap-1.5"
                onClick={() => autoPoblarMutation.mutate()}
                disabled={autoPoblarMutation.isPending}
              >
                {autoPoblarMutation.isPending
                  ? <Loader2 className="w-3 h-3 animate-spin" />
                  : <Users className="w-3 h-3" />}
                Auto-poblar desde evidencias
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="text-xs"
                onClick={guardarJuicios}
                disabled={juiciosMutation.isPending || acta.participantes.length === 0}
              >
                {juiciosMutation.isPending && <Loader2 className="w-3 h-3 mr-1.5 animate-spin" />}
                Guardar juicios
              </Button>
            </div>
          )}
        </div>

        {acta.participantes.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2">
            <Badge variant="green" className="text-xs">{nAprobaron} aprobaron</Badge>
            <Badge variant="yellow" className="text-xs">{nPendientes} pendientes</Badge>
            <Badge variant="gray" className="text-xs">{nNoAsistio} no asistieron</Badge>
          </div>
        )}

        {acta.participantes.length === 0 ? (
          <p className="text-sm text-gray-400 italic">
            Sin participantes.
            {esBorrador && " Usa 'Auto-poblar' o agrega participantes manualmente."}
          </p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-gray-200">
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="text-left px-3 py-2 text-xs font-semibold text-gray-500">Aprendiz</th>
                  <th className="text-left px-3 py-2 text-xs font-semibold text-gray-500">Juicio</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {acta.participantes.map(p => (
                  <tr key={p.id} className="bg-white hover:bg-gray-50">
                    <td className="px-3 py-2 text-gray-700">{p.aprendiz.nombre}</td>
                    <td className="px-3 py-2">
                      {esBorrador ? (
                        <select
                          value={juiciosLocales[p.aprendizId] ?? p.juicio}
                          onChange={e => setJuiciosLocales(prev => ({
                            ...prev,
                            [p.aprendizId]: e.target.value as "APROBÓ" | "NO ASISTIÓ" | "PENDIENTE",
                          }))}
                          className="h-7 rounded border border-input bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                        >
                          <option value="APROBÓ">APROBÓ</option>
                          <option value="NO ASISTIÓ">NO ASISTIÓ</option>
                          <option value="PENDIENTE">PENDIENTE</option>
                        </select>
                      ) : (
                        <Badge variant={juicioBadgeVariant(p.juicio)} className="text-xs">{p.juicio}</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
                          <Input
                            value={c.actividad}
                            onChange={e => actualizarCompromiso(idx, "actividad", e.target.value)}
                            className="h-7 text-xs"
                            placeholder="Actividad..."
                          />
                        ) : c.actividad}
                      </td>
                      <td className="px-3 py-1.5">
                        {esBorrador ? (
                          <Input
                            type="date"
                            value={c.fecha}
                            onChange={e => actualizarCompromiso(idx, "fecha", e.target.value)}
                            className="h-7 text-xs"
                          />
                        ) : c.fecha}
                      </td>
                      <td className="px-3 py-1.5">
                        {esBorrador ? (
                          <Input
                            value={c.responsable}
                            onChange={e => actualizarCompromiso(idx, "responsable", e.target.value)}
                            className="h-7 text-xs"
                            placeholder="Responsable..."
                          />
                        ) : c.responsable}
                      </td>
                      {esBorrador && (
                        <td className="px-3 py-1.5 text-center">
                          <button
                            onClick={() => eliminarCompromiso(idx)}
                            className="text-gray-400 hover:text-red-500 text-xs"
                            title="Eliminar fila"
                          >
                            ✕
                          </button>
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
          <Button
            size="sm"
            variant="outline"
            className="text-xs"
            onClick={guardarConclusiones}
            disabled={patchMutation.isPending}
          >
            {patchMutation.isPending && <Loader2 className="w-3 h-3 mr-1.5 animate-spin" />}
            Guardar conclusiones y compromisos
          </Button>
        )}
      </section>

      {/* ── Errores globales de mutaciones ── */}
      {patchError && (
        <div className="flex items-center gap-2 text-sm text-red-600">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{patchError}</span>
        </div>
      )}

      {/* ── Cerrar acta ── */}
      {esBorrador && (
        <section className="pt-2 border-t border-gray-200">
          {!cerrarConfirm ? (
            <Button
              size="sm"
              variant="outline"
              className="text-xs gap-1.5 text-red-600 border-red-300 hover:bg-red-50"
              onClick={() => setCerrarConfirm(true)}
            >
              <Lock className="w-3 h-3" />
              Cerrar Acta
            </Button>
          ) : (
            <div className="flex items-center gap-3 flex-wrap">
              <p className="text-sm text-red-600 font-medium">
                Esta acción es irreversible. ¿Confirmas cerrar el acta?
              </p>
              <Button
                size="sm"
                className="bg-red-600 hover:bg-red-700 text-white text-xs"
                onClick={() => cerrarMutation.mutate()}
                disabled={cerrarMutation.isPending}
              >
                {cerrarMutation.isPending && <Loader2 className="w-3 h-3 mr-1.5 animate-spin" />}
                Sí, cerrar
              </Button>
              <Button size="sm" variant="outline" className="text-xs" onClick={() => setCerrarConfirm(false)}>
                Cancelar
              </Button>
            </div>
          )}
        </section>
      )}

    </div>
  )
}

// ─── Componente principal ─────────────────────────────────────────────────────

export default function ActasPage() {
  const navigate    = useNavigate()
  const { jwt, user, clearAuth, setAuth } = useAuthStore()
  const [fichaFiltro,   setFichaFiltro]   = useState("")
  const [expandedActa,  setExpandedActa]  = useState<string | null>(null)
  const [nuevaActaOpen, setNuevaActaOpen] = useState(false)
  const [downloadingId, setDownloadingId] = useState<string | null>(null)

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
    queryKey: ["actas", fichaFiltro],
    queryFn:  () => apiFetch<ActaSummary[]>(`/api/actas${fichaFiltro ? `?fichaId=${fichaFiltro}` : ""}`),
    enabled:  !!jwt,
    staleTime: 30_000,
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
      a.href = url
      a.download = match?.[1] ?? "acta.docx"
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error al descargar el documento.")
    } finally {
      setDownloadingId(null)
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

          <div className="flex items-center gap-2 flex-shrink-0">
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

            <Button
              size="sm"
              className="bg-sena-green hover:bg-sena-green/90 gap-1.5 text-xs"
              onClick={() => setNuevaActaOpen(true)}
            >
              <Plus className="w-3.5 h-3.5" />
              Nueva Acta
            </Button>
          </div>
        </div>

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
              Usa el botón <strong>Nueva Acta</strong> para crear el primer borrador. Después podrás auto-poblar los participantes, enviarles mensajes formales y cerrar el acta como evidencia legal.
            </p>
            <Button
              size="sm"
              className="bg-sena-green hover:bg-sena-green/90 gap-1.5 mt-2"
              onClick={() => setNuevaActaOpen(true)}
            >
              <Plus className="w-3.5 h-3.5" />
              Nueva Acta
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            {actas.map(acta => {
              const isExpanded = expandedActa === acta.id
              return (
                <div key={acta.id} className="bg-white rounded-lg border border-gray-200 overflow-hidden">
                  <div className="px-4 py-3 flex items-start gap-3">
                    <button
                      className="mt-0.5 text-gray-400 hover:text-gray-600 flex-shrink-0"
                      onClick={() => toggleActa(acta.id)}
                    >
                      {isExpanded
                        ? <ChevronDown className="w-4 h-4" />
                        : <ChevronRight className="w-4 h-4" />}
                    </button>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-sm text-gray-900">
                          Acta N° {acta.numero}
                        </span>
                        <span className="text-xs text-gray-500 font-mono">{acta.ficha.codigo}</span>
                        <Badge
                          variant={acta.estado === "borrador" ? "yellow" : "green"}
                          className="text-xs"
                        >
                          {acta.estado}
                        </Badge>
                      </div>
                      <p className="text-xs text-gray-500 mt-0.5 truncate">{acta.ficha.nombre}</p>
                      <div className="flex items-center gap-3 mt-1 text-xs text-gray-500">
                        <span>{formatFecha(acta.fecha)} · {acta.hora}</span>
                        <span className="flex items-center gap-1">
                          <Users className="w-3 h-3" />
                          {acta._count.participantes}
                        </span>
                        <span className="flex items-center gap-1">
                          <MessageSquare className="w-3 h-3" />
                          {acta._count.mensajes}
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 flex-shrink-0">
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-xs gap-1.5"
                        onClick={() => handleDescargar(acta.id, acta.numero)}
                        disabled={downloadingId === acta.id}
                      >
                        {downloadingId === acta.id
                          ? <Loader2 className="w-3 h-3 animate-spin" />
                          : <Download className="w-3 h-3" />}
                        Word
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-xs"
                        onClick={() => toggleActa(acta.id)}
                      >
                        {isExpanded ? "Ocultar" : "Ver detalle"}
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
