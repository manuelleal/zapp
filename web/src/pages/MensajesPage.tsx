import { useState, useEffect, useMemo } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import {
  Mail, Send, Loader2, RefreshCw, AlertCircle, CheckCircle2, Clock,
  Users, History, FileText, ChevronRight, ChevronDown, CheckSquare, Square,
  Pause, Play, Trash2,
} from "lucide-react"
import Layout from "@/components/Layout"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { apiFetch, ApiError } from "@/api/client"
import { toast } from "sonner"
import { useAuthStore } from "@/store/auth"
import { useNavigate, useSearchParams } from "react-router-dom"

// ─── Types ────────────────────────────────────────────────────────────────────

interface Ficha { id: string; codigo: string; nombre: string }
// Resumen de una entrega del aprendiz (lo manda GET /api/mensajes/aprendices)
// para calcular los filtros rápidos contra la selección de evidencias.
interface EntregaResumen {
  evidenciaId: string
  estado:      string   // sin_entregar | pendiente | calificado | ...
  desaprobada: boolean  // calificada que no aprueba (<70 o cualitativa D)
}
interface Aprendiz {
  id:           string
  nombre:       string
  email:        string | null
  moodleId:     string | null
  ultimoAcceso: string | null
  entregas:     EntregaResumen[]
}
interface EvidenciaFicha { id: string; nombre: string; tipo: string }
interface MensajeProgramado {
  id:                  string
  canal:               string
  asunto:              string
  filtroDestinatarios: string
  alcanceEvidencias:   string
  incluirDesaprobadas: boolean
  intervaloDias:       number
  hora:                string
  proximaEjecucion:    string
  lastRunAt:           string | null
  pausadoAt:           string | null
  ficha:               { codigo: string; nombre: string } | null
}

const FILTRO_LABELS: Record<string, string> = {
  todos:            "Todos",
  con_pendientes:   "Con pendientes",
  con_desaprobadas: "Con desaprobadas",
  inactivos:        "Inactivos >7d",
  nunca:            "Nunca entraron",
}
const ALCANCE_LABELS: Record<string, string> = {
  competencia: "Mi competencia",
  todas:       "Toda la ficha",
  ids:         "Selección manual",
}
interface MensajeHistorial {
  id:                 string
  canal:              string
  asunto:             string
  estado:             string
  enviadoAt:          string | null
  creadoAt:           string
  fichaId:            string
  ficha:              { codigo: string; nombre: string } | null
  actaId:             string | null
  errorMsg:           string | null
  destinatariosCount: number
}

// ─── Templates ────────────────────────────────────────────────────────────────

const TEMPLATES = {
  inactividad: {
    label: "Aprendices inactivos (>7 días)",
    asunto: "Aprendiz inactivo en Zajuna — {{nombre}}",
    cuerpo: `Hola {{nombre}},

Hemos notado que llevas varios días sin ingresar a la plataforma Zajuna. Te recordamos que tienes evidencias por entregar en la ficha {{ficha}}.

Por favor ingresa lo antes posible para revisar tu estado de formación.

Saludos,
{{instructor}}`,
  },
  pendientes: {
    label: "Evidencias pendientes",
    asunto: "Evidencias pendientes — {{nombre}}",
    cuerpo: `Hola {{nombre}},

Tienes las siguientes evidencias pendientes en la ficha {{ficha}}:

{{evidencias}}

Por favor entrega lo antes posible.

Saludos,
{{instructor}}`,
  },
  recordatorio: {
    label: "Recordatorio general",
    asunto: "Recordatorio formación — {{ficha}}",
    cuerpo: `Hola {{nombre}},

Te recordamos revisar tu progreso en la ficha {{ficha}}.

Saludos,
{{instructor}}`,
  },
} as const

type TemplateKey = keyof typeof TEMPLATES

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatFecha(iso: string | null): string {
  if (!iso) return "—"
  try { return new Date(iso).toLocaleString("es-CO", { dateStyle: "short", timeStyle: "short" }) }
  catch { return iso }
}

function diasSinAcceso(iso: string | null): number | null {
  if (!iso) return null
  const ms = Date.now() - new Date(iso).getTime()
  return Math.floor(ms / (1000 * 60 * 60 * 24))
}

function estadoBadge(estado: string): "green" | "yellow" | "gray" | "red" {
  if (estado === "enviado")    return "green"
  if (estado === "pendiente")  return "yellow"
  if (estado === "error")      return "red" as never
  return "gray"
}

// ─── Agrupación de evidencias (mismo criterio que el ExcelModal de Fichas) ────
// El nombre canónico es GA{n}-{competencia}-AA{m}-EV{nn}; de ahí salen guía,
// competencia y el orden natural dentro de cada grupo.
const gaDe   = (n: string) => parseInt((n.match(/GA\s*(\d+)/i) || [])[1] || "0", 10)
const aaDe   = (n: string) => parseInt((n.match(/AA\s*(\d+)/i) || [])[1] || "99", 10)
const evDe   = (n: string) => parseInt((n.match(/EV\s*(\d+)/i) || [])[1] || "99", 10)
const compDe = (n: string) => (n.match(/GA\s*\d+\s*-\s*(\d{6,9})/i) || [])[1] || ""

// ─── Componente principal ─────────────────────────────────────────────────────

export default function MensajesPage() {
  const queryClient = useQueryClient()
  const navigate    = useNavigate()
  const { jwt, user, clearAuth, setAuth } = useAuthStore()
  const [searchParams] = useSearchParams()

  const [tab, setTab]               = useState<"compositor" | "historial" | "programados">("compositor")
  const [fichaId, setFichaId]       = useState("")
  const [seleccionados, setSeleccionados] = useState<Set<string>>(new Set())
  const [selEvidencias, setSelEvidencias] = useState<Set<string>>(new Set())
  const [incluirDesaprobadas, setIncluirDesaprobadas] = useState(false)
  const [canal, setCanal]           = useState<"email" | "zajuna">("email")
  // Modal "Programar envío recurrente"
  const [showProgramar, setShowProgramar] = useState(false)
  const [progFiltro, setProgFiltro]       = useState("con_pendientes")
  const [progAlcance, setProgAlcance]     = useState<"competencia" | "todas" | "ids">("competencia")
  const [progIntervalo, setProgIntervalo] = useState("7")
  const [progHora, setProgHora]           = useState("07:00")
  const [asunto, setAsunto]         = useState("")
  const [cuerpo, setCuerpo]         = useState("")
  const [templateKey, setTemplateKey] = useState<TemplateKey | "">("")
  const [filtroPrev, setFiltroPrev] = useState<string>("")
  const [syncJobId, setSyncJobId]   = useState<string | null>(null)
  const [enviarJobId, setEnviarJobId] = useState<string | null>(null)

  // ── Auth guard ───────────────────────────────────────────────────────────────
  useEffect(() => {
    const storedJwt = localStorage.getItem("zajuna_jwt")
    if (!storedJwt) { navigate("/login"); return }
    if (!user && storedJwt) {
      try {
        const payload = JSON.parse(atob(storedJwt.split(".")[1]))
        setAuth(storedJwt, {
          id: payload.id || "", nombre: payload.nombre || "", email: payload.email || "",
          competenciaNombre: payload.competenciaNombre || "", competenciaCodigo: payload.competenciaCodigo || "",
        })
      } catch { clearAuth(); navigate("/login") }
    }
  }, [])

  // ── Pre-filtros desde URL (?actaId=...&filtro=pendientes) ────────────────────
  useEffect(() => {
    const filtro = searchParams.get("filtro")
    if (filtro) setFiltroPrev(filtro)
    const actaId = searchParams.get("actaId")
    if (actaId) {
      // Cargar ficha del acta para preseleccionar
      apiFetch<{ fichaId: string }>(`/api/actas/${actaId}`).then(a => {
        if (a?.fichaId) setFichaId(a.fichaId)
      }).catch(() => {})
    }
  }, [searchParams])

  // ── Queries ──────────────────────────────────────────────────────────────────
  const { data: fichasResp } = useQuery<{ fichas: Ficha[] }>({
    queryKey: ["fichas-simple"],
    queryFn:  () => apiFetch<{ fichas: Ficha[] }>("/api/fichas"),
    enabled:  !!jwt,
    staleTime: 60_000,
  })
  const fichas = fichasResp?.fichas ?? []

  const { data: aprendices = [], isLoading: loadingAprendices, refetch: refetchAprendices } =
    useQuery<Aprendiz[]>({
      queryKey: ["mensajes-aprendices", fichaId],
      queryFn:  () => apiFetch<Aprendiz[]>(`/api/mensajes/aprendices?fichaId=${fichaId}`),
      enabled:  !!jwt && !!fichaId,
    })

  // Evidencias de la ficha — alimentan el selector para {{evidencias}}.
  // Reutiliza el endpoint del ExcelModal de Fichas.
  const { data: evidenciasResp } = useQuery<{ evidencias: EvidenciaFicha[] }>({
    queryKey: ["mensajes-evidencias", fichaId],
    queryFn:  () => apiFetch(`/api/fichas/${encodeURIComponent(fichaId)}/evidencias`),
    enabled:  !!jwt && !!fichaId,
  })
  const evidencias = evidenciasResp?.evidencias ?? []
  const miComp = user?.competenciaCodigo || ""

  // Pre-marcar TU competencia al cargar (en una ficha dan clase varios
  // instructores; por defecto solo se reportan pendientes de la tuya).
  useEffect(() => {
    if (!evidencias.length) { setSelEvidencias(new Set()); return }
    const mias = miComp ? evidencias.filter(e => compDe(e.nombre) === miComp) : []
    setSelEvidencias(new Set((mias.length ? mias : evidencias).map(e => e.id)))
  }, [evidenciasResp])

  // Agrupar por "competencia · Guía N" (la tuya primero), igual que el ExcelModal.
  const gruposEvidencias = useMemo(() => {
    const m = new Map<string, { comp: string; ga: number; evs: EvidenciaFicha[] }>()
    for (const ev of evidencias) {
      const comp = compDe(ev.nombre) || "—"
      const ga = gaDe(ev.nombre)
      const key = `${comp}|${ga}`
      if (!m.has(key)) m.set(key, { comp, ga, evs: [] })
      m.get(key)!.evs.push(ev)
    }
    const arr = [...m.values()]
    arr.forEach(g => g.evs.sort((a, b) => aaDe(a.nombre) - aaDe(b.nombre) || evDe(a.nombre) - evDe(b.nombre)))
    return arr.sort((a, b) =>
      ((a.comp === miComp ? 0 : 1) - (b.comp === miComp ? 0 : 1)) ||
      a.comp.localeCompare(b.comp) ||
      a.ga - b.ga)
  }, [evidenciasResp, miComp])

  const { data: configCorreo } = useQuery<{ id: string } | null>({
    queryKey: ["ajustes-correo"],
    queryFn:  () => apiFetch<{ id: string } | null>("/api/ajustes/correo"),
    enabled:  !!jwt,
  })

  const { data: historial = [], refetch: refetchHistorial } = useQuery<MensajeHistorial[]>({
    queryKey: ["mensajes-historial"],
    queryFn:  () => apiFetch<MensajeHistorial[]>("/api/mensajes/historial"),
    enabled:  !!jwt && tab === "historial",
  })

  // ── Mensajes programados ─────────────────────────────────────────────────────
  const { data: programados = [] } = useQuery<MensajeProgramado[]>({
    queryKey: ["mensajes-programados"],
    queryFn:  () => apiFetch<MensajeProgramado[]>("/api/mensajes/programados"),
    enabled:  !!jwt && (tab === "programados" || showProgramar),
  })

  const crearProgramadoMutation = useMutation({
    mutationFn: (body: object) => apiFetch("/api/mensajes/programados", {
      method: "POST", body: JSON.stringify(body),
    }),
    onSuccess: () => {
      toast.success("Mensaje programado. Revísalo en la pestaña Programados.")
      setShowProgramar(false)
      queryClient.invalidateQueries({ queryKey: ["mensajes-programados"] })
      setTab("programados")
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Error al programar."),
  })

  const pausarProgramadoMutation = useMutation({
    mutationFn: ({ id, pausado }: { id: string; pausado: boolean }) =>
      apiFetch(`/api/mensajes/programados/${id}`, { method: "PATCH", body: JSON.stringify({ pausado }) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["mensajes-programados"] }),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Error al actualizar."),
  })

  const eliminarProgramadoMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/mensajes/programados/${id}`, { method: "DELETE" }),
    onSuccess: () => { toast.success("Programado eliminado."); queryClient.invalidateQueries({ queryKey: ["mensajes-programados"] }) },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Error al eliminar."),
  })

  function handleCrearProgramado() {
    if (!fichaId) { toast.error("Selecciona una ficha."); return }
    if (!asunto.trim() || !cuerpo.trim()) { toast.error("Asunto y cuerpo son obligatorios."); return }
    if (canal === "email" && !configCorreo) { toast.error("Configura el SMTP en Ajustes antes de programar correos."); return }
    if (progAlcance === "ids" && selEvidencias.size === 0) { toast.error("Con alcance 'Selección manual' marca al menos una evidencia."); return }
    crearProgramadoMutation.mutate({
      fichaId, canal, asunto, cuerpo,
      templateTipo:        templateKey || null,
      filtroDestinatarios: progFiltro,
      alcanceEvidencias:   progAlcance,
      evidenciaIds:        progAlcance === "ids" ? [...selEvidencias] : undefined,
      incluirDesaprobadas,
      intervaloDias:       parseInt(progIntervalo, 10) || 7,
      hora:                progHora,
    })
  }

  // ── Aplicar pre-filtro al cargar aprendices ──────────────────────────────────
  useEffect(() => {
    if (!aprendices.length) return
    if (filtroPrev === "inactivos") {
      const ids = aprendices
        .filter(a => { const d = diasSinAcceso(a.ultimoAcceso); return d === null || d > 7 })
        .map(a => a.id)
      setSeleccionados(new Set(ids))
      setTemplateKey("inactividad")
    } else if (filtroPrev === "pendientes") {
      // Selección no automática; el usuario puede marcar todos
      setTemplateKey("pendientes")
    }
  }, [aprendices, filtroPrev])

  // ── Aplicar template ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!templateKey) return
    const t = TEMPLATES[templateKey]
    setAsunto(t.asunto)
    setCuerpo(t.cuerpo)
  }, [templateKey])

  // ── Mutations ────────────────────────────────────────────────────────────────
  const syncMutation = useMutation({
    mutationFn: () => apiFetch<{ jobId: string }>("/api/mensajes/sync-emails", {
      method: "POST", body: JSON.stringify({ fichaId }),
    }),
    onSuccess: (r) => {
      setSyncJobId(r.jobId)
      toast.info("Sincronización en progreso (puede tardar 30-60s).")
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Error al sincronizar."),
  })

  // Polling sync job
  const { data: syncStatus } = useQuery<{ state: string; result: any; error: string | null }>({
    queryKey: ["sync-status", syncJobId],
    queryFn:  () => apiFetch(`/api/mensajes/sync-emails/${syncJobId}`),
    enabled:  !!syncJobId,
    refetchInterval: 3000,
  })

  useEffect(() => {
    if (!syncStatus) return
    if (syncStatus.state === "completed") {
      toast.success(`Sincronización OK: ${syncStatus.result?.actualizados ?? 0} aprendices actualizados.`)
      setSyncJobId(null)
      refetchAprendices()
    } else if (syncStatus.state === "failed") {
      toast.error(`Sincronización falló: ${syncStatus.error}`)
      setSyncJobId(null)
    }
  }, [syncStatus])

  const enviarMutation = useMutation({
    mutationFn: () => {
      const dest = aprendices
        .filter(a => seleccionados.has(a.id))
        .map(a => ({
          aprendizId: a.id,
          nombre:     a.nombre,
          email:      a.email,
          instructor: user?.nombre ?? "",
          ficha:      fichas.find(f => f.id === fichaId)?.codigo ?? "",
        }))
      return apiFetch<{ jobId: string; mensajeFormativoId: string }>("/api/mensajes/enviar-masivo", {
        method: "POST",
        body: JSON.stringify({
          fichaId, canal, asunto, cuerpo,
          destinatarios: dest,
          templateTipo:  templateKey || null,
          actaId:        searchParams.get("actaId") || null,
          // Alcance de {{evidencias}}: solo las seleccionadas. Vacío → el
          // backend cae a las de la competencia del instructor.
          evidenciaIds:  [...selEvidencias],
          incluirDesaprobadas,
        }),
      })
    },
    onSuccess: (r) => {
      setEnviarJobId(r.jobId)
      toast.info("Envío iniciado. Monitoreando estado...")
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Error al enviar."),
  })

  const { data: enviarStatus } = useQuery<{ state: string; result: any; error: string | null }>({
    queryKey: ["enviar-status", enviarJobId],
    queryFn:  () => apiFetch(`/api/mensajes/enviar-masivo/${enviarJobId}`),
    enabled:  !!enviarJobId,
    refetchInterval: 3000,
  })

  useEffect(() => {
    if (!enviarStatus) return
    if (enviarStatus.state === "completed") {
      const r = enviarStatus.result || {}
      toast.success(`Envío completado: ${r.enviados ?? 0}/${r.total ?? 0} entregados${r.errores ? `, ${r.errores} con error` : ""}.`)
      setEnviarJobId(null)
      queryClient.invalidateQueries({ queryKey: ["mensajes-historial"] })
    } else if (enviarStatus.state === "failed") {
      toast.error(`Envío falló: ${enviarStatus.error}`)
      setEnviarJobId(null)
    }
  }, [enviarStatus])

  // ── Helpers UI ───────────────────────────────────────────────────────────────
  function toggleAprendiz(id: string) {
    setSeleccionados(prev => {
      const n = new Set(prev)
      if (n.has(id)) n.delete(id); else n.add(id)
      return n
    })
  }

  function toggleAll() {
    if (seleccionados.size === aprendices.length) setSeleccionados(new Set())
    else setSeleccionados(new Set(aprendices.map(a => a.id)))
  }

  // Contadores por aprendiz RELATIVOS a las evidencias seleccionadas (si no hay
  // selección, contra todas las abiertas). Alimentan columnas y filtros rápidos.
  const enAlcance = (evidenciaId: string) => selEvidencias.size === 0 || selEvidencias.has(evidenciaId)
  const pendientesDe   = (a: Aprendiz) => (a.entregas ?? []).filter(e => enAlcance(e.evidenciaId) && e.estado === "sin_entregar").length
  const desaprobadasDe = (a: Aprendiz) => (a.entregas ?? []).filter(e => enAlcance(e.evidenciaId) && e.desaprobada).length

  // Filtros rápidos: un click marca los destinatarios que cumplen el criterio.
  function seleccionarFiltro(pred: (a: Aprendiz) => boolean) {
    setSeleccionados(new Set(aprendices.filter(pred).map(a => a.id)))
  }
  const filtroInactivo = (a: Aprendiz) => { const d = diasSinAcceso(a.ultimoAcceso); return d === null || d > 7 }
  const filtroNunca    = (a: Aprendiz) => a.ultimoAcceso === null
  const nConPendientes   = aprendices.filter(a => pendientesDe(a) > 0).length
  const nConDesaprobadas = aprendices.filter(a => desaprobadasDe(a) > 0).length
  const nInactivos       = aprendices.filter(filtroInactivo).length
  const nNunca           = aprendices.filter(filtroNunca).length

  const seleccionadosArr = useMemo(
    () => aprendices.filter(a => seleccionados.has(a.id)),
    [aprendices, seleccionados]
  )

  const sinEmail = canal === "email"
    ? seleccionadosArr.filter(a => !a.email).length
    : 0

  function previewMensaje(): string {
    const primero = seleccionadosArr[0]
    if (!primero) return cuerpo
    return cuerpo
      .replace(/\{\{nombre\}\}/gi,     primero.nombre)
      .replace(/\{\{ficha\}\}/gi,      fichas.find(f => f.id === fichaId)?.codigo ?? "")
      .replace(/\{\{instructor\}\}/gi, user?.nombre ?? "")
      .replace(/\{\{evidencias\}\}/gi, "(lista de evidencias del aprendiz)")
  }

  function handleEnviar() {
    if (!fichaId) { toast.error("Selecciona una ficha."); return }
    if (seleccionadosArr.length === 0) { toast.error("Selecciona al menos un destinatario."); return }
    if (!asunto.trim() || !cuerpo.trim()) { toast.error("Asunto y cuerpo son obligatorios."); return }
    if (canal === "email" && !configCorreo) {
      toast.error("Configura el SMTP en Ajustes antes de enviar correos.")
      return
    }
    if (canal === "email" && sinEmail > 0) {
      if (!confirm(`${sinEmail} aprendices no tienen email. Solo se enviará a los que sí tienen. ¿Continuar?`)) return
    }
    enviarMutation.mutate()
  }

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <Layout>
      <div className="space-y-4">
        {/* Header */}
        <div className="bg-white rounded-lg border border-gray-200 p-4 flex items-center gap-3 flex-wrap">
          <Mail className="w-4 h-4 text-sena-green" />
          <h1 className="text-sm font-semibold text-gray-900">Mensajería masiva</h1>
          <div className="ml-auto flex items-center gap-1 border border-gray-200 rounded-md p-0.5">
            <button onClick={() => setTab("compositor")}
              className={`flex items-center gap-1.5 text-xs px-3 py-1 rounded ${tab === "compositor" ? "bg-sena-green/10 text-sena-green" : "text-gray-600 hover:text-gray-900"}`}>
              <Send className="w-3 h-3" /> Compositor
            </button>
            <button onClick={() => { setTab("historial"); refetchHistorial() }}
              className={`flex items-center gap-1.5 text-xs px-3 py-1 rounded ${tab === "historial" ? "bg-sena-green/10 text-sena-green" : "text-gray-600 hover:text-gray-900"}`}>
              <History className="w-3 h-3" /> Historial
            </button>
            <button onClick={() => setTab("programados")}
              className={`flex items-center gap-1.5 text-xs px-3 py-1 rounded ${tab === "programados" ? "bg-sena-green/10 text-sena-green" : "text-gray-600 hover:text-gray-900"}`}>
              <Clock className="w-3 h-3" /> Programados
              {programados.filter(p => !p.pausadoAt).length > 0 && (
                <Badge variant="green" className="text-[10px] px-1">{programados.filter(p => !p.pausadoAt).length}</Badge>
              )}
            </button>
          </div>
        </div>

        {/* Aviso config SMTP */}
        {canal === "email" && !configCorreo && (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 flex items-start gap-2">
            <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <div>
              No tienes configurado el correo SMTP. <button className="underline font-semibold" onClick={() => navigate("/ajustes")}>Ir a Ajustes</button> para configurarlo antes de enviar correos.
            </div>
          </div>
        )}

        {tab === "compositor" ? (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Sección 1: Destinatarios */}
            <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
              <div className="flex items-center gap-2 border-b border-gray-100 pb-2">
                <Users className="w-4 h-4 text-sena-green" />
                <h2 className="text-sm font-semibold text-gray-900">Destinatarios</h2>
                <span className="ml-auto text-xs text-gray-500">{seleccionadosArr.length} seleccionados</span>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="ficha-msg">Ficha *</Label>
                <select id="ficha-msg" value={fichaId} onChange={e => { setFichaId(e.target.value); setSeleccionados(new Set()) }}
                  className="w-full h-9 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring">
                  <option value="">Seleccionar ficha...</option>
                  {fichas.map(f => <option key={f.id} value={f.id}>{f.codigo} — {f.nombre}</option>)}
                </select>
              </div>

              {fichaId && (
                <>
                  {/* Selector de evidencias para {{evidencias}} (estilo ExcelModal) */}
                  <details className="rounded-md border border-gray-200">
                    <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-gray-700 flex items-center gap-2 select-none">
                      <ChevronRight className="w-3 h-3 shrink-0" />
                      Evidencias para {"{{evidencias}}"}
                      <Badge variant="green" className="text-[10px]">{selEvidencias.size} seleccionadas</Badge>
                      <span className="font-normal text-gray-400">(las de tu competencia vienen premarcadas)</span>
                    </summary>
                    <div className="px-3 pb-3 max-h-72 overflow-y-auto space-y-2 border-t border-gray-100 pt-2">
                      <button
                        onClick={() => setSelEvidencias(selEvidencias.size === evidencias.length ? new Set() : new Set(evidencias.map(e => e.id)))}
                        className="flex items-center gap-2 text-xs font-medium text-sena-green">
                        {selEvidencias.size === evidencias.length && evidencias.length > 0
                          ? <CheckSquare className="w-3.5 h-3.5" /> : <Square className="w-3.5 h-3.5" />}
                        Seleccionar todas
                      </button>
                      {gruposEvidencias.map((g, i) => {
                        const grupoAll  = g.evs.every(e => selEvidencias.has(e.id))
                        const grupoSome = g.evs.some(e => selEvidencias.has(e.id))
                        return (
                          <div key={`${g.comp}-${g.ga}`}>
                            {(i === 0 || gruposEvidencias[i - 1].comp !== g.comp) && (
                              <div className="mt-2 mb-1 text-[10px] font-semibold text-gray-500 uppercase tracking-wide">
                                Competencia {g.comp}{g.comp === miComp ? " · tuya" : ""}
                              </div>
                            )}
                            <div className="border border-gray-200 rounded-md overflow-hidden">
                              <button
                                onClick={() => setSelEvidencias(prev => {
                                  const n = new Set(prev); const all = g.evs.every(e => n.has(e.id))
                                  g.evs.forEach(e => all ? n.delete(e.id) : n.add(e.id)); return n
                                })}
                                className={`w-full px-2 py-1.5 flex items-center gap-2 text-xs font-medium ${grupoAll ? "bg-green-50" : grupoSome ? "bg-green-50/40" : ""}`}>
                                {grupoAll ? <CheckSquare className="w-3.5 h-3.5 text-sena-green" /> : <Square className={`w-3.5 h-3.5 ${grupoSome ? "text-sena-green/60" : "text-gray-300"}`} />}
                                {g.ga > 0 ? `Guía ${g.ga}` : "Sin guía"}
                                <span className="text-gray-400 font-normal">· {g.evs.length} evid.</span>
                              </button>
                              <ul className="pb-1">
                                {g.evs.map(ev => (
                                  <li key={ev.id}>
                                    <button
                                      onClick={() => setSelEvidencias(prev => { const n = new Set(prev); n.has(ev.id) ? n.delete(ev.id) : n.add(ev.id); return n })}
                                      className="w-full px-2 pl-8 py-0.5 flex items-center gap-2 text-[11px] text-left hover:bg-gray-50">
                                      {selEvidencias.has(ev.id) ? <CheckSquare className="w-3 h-3 text-sena-green shrink-0" /> : <Square className="w-3 h-3 text-gray-300 shrink-0" />}
                                      <span className="truncate" title={ev.nombre}>{ev.nombre}</span>
                                    </button>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          </div>
                        )
                      })}
                      <label className="flex items-center gap-1.5 text-xs cursor-pointer pt-1 border-t border-gray-100">
                        <input type="checkbox" checked={incluirDesaprobadas} onChange={e => setIncluirDesaprobadas(e.target.checked)}
                          className="h-3.5 w-3.5 rounded border-gray-300 text-sena-green" />
                        Incluir también las <strong>desaprobadas</strong> (nota &lt;70 o D) en {"{{evidencias}}"}
                      </label>
                    </div>
                  </details>

                  {/* Filtros rápidos: un click marca los destinatarios que cumplen */}
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" className="text-xs gap-1.5"
                      onClick={() => syncMutation.mutate()} disabled={!!syncJobId || syncMutation.isPending}>
                      {syncJobId ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                      {syncJobId ? "Sincronizando..." : "Sincronizar emails desde Zajuna"}
                    </Button>
                    <Button size="sm" variant="outline" className="text-xs" onClick={toggleAll}>
                      {seleccionados.size === aprendices.length ? "Deseleccionar todos" : "Seleccionar todos"}
                    </Button>
                    <Button size="sm" variant="outline" className="text-xs"
                      onClick={() => seleccionarFiltro(a => pendientesDe(a) > 0)} disabled={nConPendientes === 0}>
                      Con pendientes ({nConPendientes})
                    </Button>
                    <Button size="sm" variant="outline" className="text-xs"
                      onClick={() => seleccionarFiltro(a => desaprobadasDe(a) > 0)} disabled={nConDesaprobadas === 0}>
                      Con desaprobadas ({nConDesaprobadas})
                    </Button>
                    <Button size="sm" variant="outline" className="text-xs"
                      onClick={() => seleccionarFiltro(filtroInactivo)} disabled={nInactivos === 0}>
                      Inactivos &gt;7d ({nInactivos})
                    </Button>
                    <Button size="sm" variant="outline" className="text-xs"
                      onClick={() => seleccionarFiltro(filtroNunca)} disabled={nNunca === 0}>
                      Nunca entraron ({nNunca})
                    </Button>
                  </div>

                  {loadingAprendices ? (
                    <div className="flex items-center gap-2 text-xs text-gray-500"><Loader2 className="w-3 h-3 animate-spin" /> Cargando...</div>
                  ) : aprendices.length === 0 ? (
                    <p className="text-xs text-gray-400 italic">Sin aprendices. Escanea la ficha en la página Fichas.</p>
                  ) : (
                    <div className="border border-gray-200 rounded-md max-h-96 overflow-y-auto">
                      <table className="w-full text-xs">
                        <thead className="bg-gray-50 sticky top-0">
                          <tr>
                            <th className="w-8 px-2 py-2"></th>
                            <th className="text-left px-2 py-2 font-semibold text-gray-500">Nombre</th>
                            <th className="text-left px-2 py-2 font-semibold text-gray-500">Email</th>
                            <th className="text-center px-2 py-2 font-semibold text-gray-500" title="Evidencias sin entregar (de las seleccionadas)">Pend.</th>
                            <th className="text-center px-2 py-2 font-semibold text-gray-500" title="Evidencias desaprobadas: nota <70 o D (de las seleccionadas)">Desap.</th>
                            <th className="text-center px-2 py-2 font-semibold text-gray-500">Último acceso</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                          {aprendices.map(a => {
                            const dias  = diasSinAcceso(a.ultimoAcceso)
                            const pend  = pendientesDe(a)
                            const desap = desaprobadasDe(a)
                            return (
                              <tr key={a.id} className="hover:bg-gray-50">
                                <td className="px-2 py-1.5 text-center">
                                  <input type="checkbox" checked={seleccionados.has(a.id)}
                                    onChange={() => toggleAprendiz(a.id)}
                                    className="h-3.5 w-3.5 rounded border-gray-300 text-sena-green" />
                                </td>
                                <td className="px-2 py-1.5 text-gray-700">{a.nombre}</td>
                                <td className="px-2 py-1.5 text-gray-600">
                                  {a.email || (
                                    <span className="text-amber-600 inline-flex items-center gap-1" title="Sin email — sincroniza desde Zajuna">
                                      <AlertCircle className="w-3 h-3" /> sin email
                                    </span>
                                  )}
                                </td>
                                <td className="px-2 py-1.5 text-center">
                                  {pend > 0
                                    ? <span className="text-amber-600 font-medium">{pend}</span>
                                    : <span className="text-gray-300">—</span>}
                                </td>
                                <td className="px-2 py-1.5 text-center">
                                  {desap > 0
                                    ? <span className="text-red-600 font-medium">{desap}</span>
                                    : <span className="text-gray-300">—</span>}
                                </td>
                                <td className="px-2 py-1.5 text-center">
                                  {dias === null ? (
                                    <span className="text-gray-400">—</span>
                                  ) : dias > 7 ? (
                                    <span className="text-red-600 font-medium">{dias}d</span>
                                  ) : (
                                    <span className="text-gray-500">{dias}d</span>
                                  )}
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Sección 2: Mensaje */}
            <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
              <div className="flex items-center gap-2 border-b border-gray-100 pb-2">
                <FileText className="w-4 h-4 text-sena-green" />
                <h2 className="text-sm font-semibold text-gray-900">Mensaje</h2>
              </div>

              <div className="space-y-1.5">
                <Label>Canal</Label>
                <div className="flex gap-3">
                  <label className="flex items-center gap-1.5 text-sm cursor-pointer">
                    <input type="radio" checked={canal === "email"} onChange={() => setCanal("email")} className="h-3.5 w-3.5" />
                    Correo electrónico
                  </label>
                  <label className="flex items-center gap-1.5 text-sm cursor-pointer">
                    <input type="radio" checked={canal === "zajuna"} onChange={() => setCanal("zajuna")} className="h-3.5 w-3.5" />
                    Mensaje interno Zajuna
                  </label>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="template">Plantilla (opcional)</Label>
                <select id="template" value={templateKey}
                  onChange={e => setTemplateKey(e.target.value as TemplateKey | "")}
                  className="w-full h-9 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring">
                  <option value="">— Sin plantilla —</option>
                  {Object.entries(TEMPLATES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                </select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="asunto">Asunto *</Label>
                <Input id="asunto" value={asunto} onChange={e => setAsunto(e.target.value)} />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="cuerpo">Cuerpo * <span className="text-gray-400 font-normal">(variables: {"{{nombre}}"}, {"{{ficha}}"}, {"{{instructor}}"}, {"{{evidencias}}"})</span></Label>
                <textarea id="cuerpo" value={cuerpo} onChange={e => setCuerpo(e.target.value)}
                  rows={8}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring resize-none font-mono" />
              </div>

              {seleccionadosArr.length > 0 && (
                <details className="rounded-md border border-gray-200 bg-gray-50 p-2 text-xs">
                  <summary className="cursor-pointer font-semibold text-gray-700">Vista previa (primer destinatario: {seleccionadosArr[0].nombre})</summary>
                  <pre className="mt-2 whitespace-pre-wrap text-gray-600">{previewMensaje()}</pre>
                </details>
              )}

              {sinEmail > 0 && canal === "email" && (
                <div className="text-xs text-amber-700 flex items-center gap-1">
                  <AlertCircle className="w-3 h-3" /> {sinEmail} de {seleccionadosArr.length} sin email — se omitirán.
                </div>
              )}

              <div className="pt-2 border-t border-gray-100 flex items-center gap-2">
                <Button size="sm" className="bg-sena-green hover:bg-sena-green/90 gap-1.5 text-xs"
                  onClick={handleEnviar} disabled={enviarMutation.isPending || !!enviarJobId}>
                  {(enviarMutation.isPending || enviarJobId) ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                  Enviar a {seleccionadosArr.length}
                </Button>
                <Button size="sm" variant="outline" className="gap-1.5 text-xs"
                  onClick={() => setShowProgramar(true)} disabled={!fichaId}>
                  <Clock className="w-3 h-3" /> Programar...
                </Button>
                {enviarJobId && enviarStatus && (
                  <span className="text-xs text-gray-500">Estado: {enviarStatus.state}</span>
                )}
              </div>
            </div>
          </div>
        ) : tab === "historial" ? (
          // ── Tab: Historial ─────────────────────────────────────────────────
          <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
            {historial.length === 0 ? (
              <p className="text-sm text-gray-500 p-8 text-center">Sin mensajes enviados aún.</p>
            ) : (
              <table className="w-full text-xs">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="text-left px-3 py-2 font-semibold text-gray-500">Fecha</th>
                    <th className="text-left px-3 py-2 font-semibold text-gray-500">Canal</th>
                    <th className="text-left px-3 py-2 font-semibold text-gray-500">Asunto</th>
                    <th className="text-left px-3 py-2 font-semibold text-gray-500">Ficha</th>
                    <th className="text-center px-3 py-2 font-semibold text-gray-500">Dest.</th>
                    <th className="text-center px-3 py-2 font-semibold text-gray-500">Estado</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {historial.map(m => (
                    <tr key={m.id}>
                      <td className="px-3 py-2 text-gray-600 whitespace-nowrap">{formatFecha(m.enviadoAt ?? m.creadoAt)}</td>
                      <td className="px-3 py-2 text-gray-600">{m.canal}</td>
                      <td className="px-3 py-2 text-gray-700">{m.asunto}</td>
                      <td className="px-3 py-2 text-gray-600">{m.ficha?.codigo ?? "—"}</td>
                      <td className="px-3 py-2 text-center text-gray-600">{m.destinatariosCount}</td>
                      <td className="px-3 py-2 text-center">
                        <Badge variant={estadoBadge(m.estado) as any} className="text-xs">{m.estado}</Badge>
                        {m.errorMsg && <p className="text-[10px] text-red-600 mt-0.5" title={m.errorMsg}>{m.errorMsg.substring(0, 40)}{m.errorMsg.length > 40 ? "..." : ""}</p>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ) : (
          // ── Tab: Programados ───────────────────────────────────────────────
          <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
            {programados.length === 0 ? (
              <div className="p-8 text-center text-sm text-gray-500 space-y-1">
                <p>Sin mensajes programados.</p>
                <p className="text-xs text-gray-400">Arma el mensaje en el Compositor y usa el botón "Programar..." — los destinatarios se recalculan en cada envío.</p>
              </div>
            ) : (
              <table className="w-full text-xs">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="text-left px-3 py-2 font-semibold text-gray-500">Ficha</th>
                    <th className="text-left px-3 py-2 font-semibold text-gray-500">Canal</th>
                    <th className="text-left px-3 py-2 font-semibold text-gray-500">Asunto</th>
                    <th className="text-left px-3 py-2 font-semibold text-gray-500">Destinatarios</th>
                    <th className="text-left px-3 py-2 font-semibold text-gray-500">Evidencias</th>
                    <th className="text-left px-3 py-2 font-semibold text-gray-500">Frecuencia</th>
                    <th className="text-left px-3 py-2 font-semibold text-gray-500">Próximo envío</th>
                    <th className="text-left px-3 py-2 font-semibold text-gray-500">Último</th>
                    <th className="text-center px-3 py-2 font-semibold text-gray-500">Estado</th>
                    <th className="text-center px-3 py-2 font-semibold text-gray-500">Acciones</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {programados.map(p => (
                    <tr key={p.id} className={p.pausadoAt ? "opacity-60" : ""}>
                      <td className="px-3 py-2 text-gray-700 font-mono">{p.ficha?.codigo ?? "—"}</td>
                      <td className="px-3 py-2 text-gray-600">{p.canal}</td>
                      <td className="px-3 py-2 text-gray-700 max-w-[200px] truncate" title={p.asunto}>{p.asunto}</td>
                      <td className="px-3 py-2 text-gray-600">{FILTRO_LABELS[p.filtroDestinatarios] ?? p.filtroDestinatarios}</td>
                      <td className="px-3 py-2 text-gray-600">
                        {ALCANCE_LABELS[p.alcanceEvidencias] ?? p.alcanceEvidencias}
                        {p.incluirDesaprobadas && <span className="text-red-500 ml-1" title="Incluye desaprobadas">+D</span>}
                      </td>
                      <td className="px-3 py-2 text-gray-600 whitespace-nowrap">cada {p.intervaloDias}d · {p.hora}</td>
                      <td className="px-3 py-2 text-gray-600 whitespace-nowrap">{p.pausadoAt ? "—" : formatFecha(p.proximaEjecucion)}</td>
                      <td className="px-3 py-2 text-gray-600 whitespace-nowrap">{formatFecha(p.lastRunAt)}</td>
                      <td className="px-3 py-2 text-center">
                        <Badge variant={p.pausadoAt ? "gray" : "green" as any} className="text-xs">
                          {p.pausadoAt ? "pausado" : "activo"}
                        </Badge>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center justify-center gap-1">
                          <Button variant="ghost" size="sm" className="h-6 w-6 p-0"
                            title={p.pausadoAt ? "Reanudar" : "Pausar"}
                            onClick={() => pausarProgramadoMutation.mutate({ id: p.id, pausado: !p.pausadoAt })}>
                            {p.pausadoAt ? <Play className="w-3 h-3 text-sena-green" /> : <Pause className="w-3 h-3" />}
                          </Button>
                          <Button variant="ghost" size="sm" className="h-6 w-6 p-0 text-red-500 hover:text-red-700"
                            title="Eliminar"
                            onClick={() => { if (confirm(`¿Eliminar el envío programado "${p.asunto}"?`)) eliminarProgramadoMutation.mutate(p.id) }}>
                            <Trash2 className="w-3 h-3" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {/* ── Modal: Programar envío recurrente ──────────────────────────────── */}
        <Dialog open={showProgramar} onOpenChange={(o) => { if (!o) setShowProgramar(false) }}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Programar envío recurrente</DialogTitle>
              <p className="text-xs text-gray-500 mt-0.5">
                Los destinatarios se recalculan <strong>en cada envío</strong> con el filtro elegido
                (los pendientes de ese día, no los de hoy).
              </p>
            </DialogHeader>
            <div className="space-y-3">
              <div className="rounded-md bg-gray-50 border border-gray-200 p-2 text-xs text-gray-600 space-y-0.5">
                <p><span className="font-semibold">Ficha:</span> {fichas.find(f => f.id === fichaId)?.codigo ?? "—"}</p>
                <p><span className="font-semibold">Canal:</span> {canal === "email" ? "Correo electrónico" : "Mensaje interno Zajuna"}</p>
                <p className="truncate"><span className="font-semibold">Asunto:</span> {asunto || <em className="text-gray-400">sin asunto</em>}</p>
              </div>

              <div className="space-y-1.5">
                <Label>Destinatarios (filtro automático)</Label>
                <select value={progFiltro} onChange={e => setProgFiltro(e.target.value)}
                  className="w-full h-9 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring">
                  {Object.entries(FILTRO_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </div>

              <div className="space-y-1.5">
                <Label>Evidencias para {"{{evidencias}}"} y filtros</Label>
                <select value={progAlcance} onChange={e => setProgAlcance(e.target.value as typeof progAlcance)}
                  className="w-full h-9 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring">
                  <option value="competencia">Mi competencia ({user?.competenciaCodigo || "sin asignar"})</option>
                  <option value="todas">Todas las de la ficha (instructor líder)</option>
                  <option value="ids">Las {selEvidencias.size} seleccionadas en el compositor</option>
                </select>
                <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                  <input type="checkbox" checked={incluirDesaprobadas} onChange={e => setIncluirDesaprobadas(e.target.checked)}
                    className="h-3.5 w-3.5 rounded border-gray-300 text-sena-green" />
                  Incluir también las desaprobadas (nota &lt;70 o D)
                </label>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="prog-dias">Cada cuántos días</Label>
                  <Input id="prog-dias" type="number" min={1} max={60} value={progIntervalo}
                    onChange={e => setProgIntervalo(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="prog-hora">Hora del envío</Label>
                  <Input id="prog-hora" type="time" value={progHora} onChange={e => setProgHora(e.target.value)} />
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowProgramar(false)}>Cancelar</Button>
              <Button className="bg-sena-green hover:bg-sena-green/90 gap-1.5"
                onClick={handleCrearProgramado} disabled={crearProgramadoMutation.isPending}>
                {crearProgramadoMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Clock className="w-4 h-4" />}
                Programar
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </Layout>
  )
}
