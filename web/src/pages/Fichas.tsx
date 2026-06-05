import { useState } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { Plus, Search, Pencil, Archive, ArchiveRestore, Trash2, ChevronDown, ChevronRight, Download, FileSpreadsheet, CheckSquare, Square, Loader2 } from "lucide-react"
import Layout from "@/components/Layout"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { apiFetch, ApiError } from "@/api/client"
import { useAuthStore } from "@/store/auth"
import { useNavigate } from "react-router-dom"
import { useEffect, useMemo } from "react"
import { toast } from "sonner"

interface Ficha {
  id: string
  codigo: string
  programa: string
  nombre: string
  archivedAt: string | null
  pendientes: number | null
}

interface FichasResponse {
  fichas: Ficha[]
  archivadasCount: number
}

type ModalMode = "nueva" | "editar" | null

export default function Fichas() {
  const navigate        = useNavigate()
  const { jwt, user, clearAuth, setAuth } = useAuthStore()
  const queryClient     = useQueryClient()
  const [mostrarArchivadas, setMostrarArchivadas] = useState(false)
  const [modal, setModal]   = useState<ModalMode>(null)
  const [editTarget, setEditTarget] = useState<Ficha | null>(null)
  const [form, setForm] = useState({ codigo: "", courseId: "", nombre: "", programa: "" })
  const [scanStatus, setScanStatus] = useState("")
  const [scanLoading, setScanLoading] = useState(false)
  const [error, setError] = useState("")
  const [excelTarget, setExcelTarget] = useState<{ id: string; codigo: string } | null>(null) // ficha cuyo Excel se está configurando

  useEffect(() => {
    const storedJwt = localStorage.getItem("zajuna_jwt")
    if (!storedJwt) { navigate("/login"); return }
    if (!user && storedJwt) {
      try {
        const payload = JSON.parse(atob(storedJwt.split(".")[1]))
        setAuth(storedJwt, { id: payload.id || "", nombre: payload.nombre || "", email: payload.email || "", competenciaNombre: payload.competenciaNombre || "", competenciaCodigo: payload.competenciaCodigo || "" })
      } catch { clearAuth(); navigate("/login") }
    }
  }, [])

  // Siempre traemos todas (incluidas archivadas) y separamos client-side
  const { data, isLoading } = useQuery<FichasResponse>({
    queryKey: ["fichas-all"],
    queryFn:  () => apiFetch<FichasResponse>("/api/fichas?incluirArchivadas=1"),
    enabled:  !!jwt,
    retry:    false,
  })

  const crearMutation = useMutation({
    mutationFn: (body: object) => apiFetch("/api/fichas", { method: "POST", body: JSON.stringify(body) }),
    onSuccess:  () => { queryClient.invalidateQueries({ queryKey: ["fichas-all"] }); closeModal() },
    onError:    (err: ApiError) => setError(err.message),
  })

  const editarMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: object }) =>
      apiFetch(`/api/fichas/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(body) }),
    onSuccess:  () => { queryClient.invalidateQueries({ queryKey: ["fichas-all"] }); closeModal() },
    onError:    (err: ApiError) => setError(err.message),
  })

  const archivarMutation = useMutation({
    mutationFn: ({ id, archivada }: { id: string; archivada: boolean }) =>
      apiFetch(`/api/fichas/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ archivada }) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["fichas-all"] }),
  })

  const eliminarMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/fichas/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess:  () => queryClient.invalidateQueries({ queryKey: ["fichas-all"] }),
    onError:    (err: ApiError) => setError(err.message),
  })

  async function handleScanFichas() {
    setScanLoading(true)
    setScanStatus("Buscando fichas en Zajuna...")
    try {
      const res = await apiFetch<{ jobId: string }>("/api/fichas/scan", { method: "POST", body: "{}" })
      pollJob(res.jobId)
    } catch (err) {
      setScanStatus(err instanceof ApiError ? err.message : "Error inesperado.")
      setScanLoading(false)
    }
  }

  function pollJob(jobId: string) {
    const timer = setInterval(async () => {
      try {
        const job = await apiFetch<{ status: string; progreso: number; errorMsg?: string }>(`/api/jobs/${jobId}`)
        if (job.status === "done") {
          clearInterval(timer)
          setScanStatus("Fichas actualizadas.")
          setScanLoading(false)
          queryClient.invalidateQueries({ queryKey: ["fichas-all"] })
        } else if (job.status === "error") {
          clearInterval(timer)
          setScanStatus(job.errorMsg || "Error en el escaneo.")
          setScanLoading(false)
        } else {
          setScanStatus(`Escaneando... ${job.progreso || 0}%`)
        }
      } catch { clearInterval(timer); setScanLoading(false) }
    }, 3000)
  }

  function openNueva() { setForm({ codigo: "", courseId: "", nombre: "", programa: "" }); setError(""); setModal("nueva") }
  function openEditar(f: Ficha) {
    setForm({ codigo: f.codigo, courseId: "", nombre: f.nombre, programa: f.programa })
    setEditTarget(f); setError(""); setModal("editar")
  }
  function closeModal() { setModal(null); setEditTarget(null); setError("") }

  function handleSubmit() {
    if (modal === "nueva") {
      crearMutation.mutate({ codigo: form.codigo, courseId: form.courseId, nombre: form.nombre, programa: form.programa })
    } else if (modal === "editar" && editTarget) {
      editarMutation.mutate({ id: editTarget.id, body: { codigo: form.codigo, nombre: form.nombre, programa: form.programa } })
    }
  }

  // Descarga el Excel con las evidencias exactas seleccionadas (evidenciaIds).
  // Vacío = todas. Se usa id exacto (no nº de GA) porque el nº de guía se repite
  // entre competencias y sería ambiguo.
  async function descargarReporte(fichaId: string, codigo: string, evidenciaIds: string[] = []) {
    try {
      const qs = evidenciaIds.length ? `?evidenciaIds=${evidenciaIds.join(",")}` : ""
      const res = await fetch(`/api/fichas/${fichaId}/reporte-excel${qs}`, {
        headers: { Authorization: `Bearer ${jwt}` }
      })
      if (!res.ok) throw new Error("No se pudo generar el reporte Excel.")
      
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `Reporte_Zajuna_${codigo}_${new Date().toISOString().slice(0,10)}.xlsx`
      a.click()
      URL.revokeObjectURL(url)
      toast.success("Excel descargado con éxito")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error al descargar el Excel")
    }
  }

  const todasFichas = data?.fichas ?? []
  const activas     = todasFichas.filter(f => !f.archivedAt).sort((a, b) => a.codigo.localeCompare(b.codigo))
  const archivadas  = todasFichas.filter(f =>  f.archivedAt).sort((a, b) => a.codigo.localeCompare(b.codigo))

  function FichaRow({ f }: { f: Ficha }) {
    return (
      <tr className="border-b border-gray-100 last:border-0 hover:bg-gray-50">
        <td className="px-5 py-3"><span className="font-mono text-sm font-medium">{f.codigo}</span></td>
        <td className="px-5 py-3">
          {f.programa ? <Badge variant="green" className="font-mono text-xs">{f.programa}</Badge> : <span className="text-gray-400">—</span>}
        </td>
        <td className="px-5 py-3 text-gray-700 max-w-xs truncate" title={f.nombre}>{f.nombre || <span className="text-gray-400">Sin nombre</span>}</td>
        <td className="px-5 py-3">
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => setExcelTarget({ id: f.id, codigo: f.codigo })} title="Descargar Excel (elegir guías)">
              <FileSpreadsheet className="w-3.5 h-3.5 text-green-600" />
            </Button>
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => openEditar(f)} title="Editar">
              <Pencil className="w-3.5 h-3.5" />
            </Button>
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => archivarMutation.mutate({ id: f.id, archivada: !f.archivedAt })} title={f.archivedAt ? "Restaurar" : "Archivar"}>
              {f.archivedAt ? <ArchiveRestore className="w-3.5 h-3.5 text-sena-green" /> : <Archive className="w-3.5 h-3.5" />}
            </Button>
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-red-500 hover:text-red-700 hover:bg-red-50" onClick={() => { if (confirm(`¿Eliminar ficha ${f.codigo}?`)) eliminarMutation.mutate(f.id) }} title="Eliminar">
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          </div>
        </td>
      </tr>
    )
  }

  function TablaFichas({ rows, titulo }: { rows: Ficha[]; titulo: string }) {
    return (
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-100">
          <h2 className="font-semibold text-gray-800 text-sm">{titulo}</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50">
                <th className="text-left px-5 py-2.5 font-medium text-gray-600">Código</th>
                <th className="text-left px-5 py-2.5 font-medium text-gray-600">Programa</th>
                <th className="text-left px-5 py-2.5 font-medium text-gray-600">Nombre del curso</th>
                <th className="text-left px-5 py-2.5 font-medium text-gray-600">Acciones</th>
              </tr>
            </thead>
            <tbody>{rows.map(f => <FichaRow key={f.id} f={f} />)}</tbody>
          </table>
        </div>
      </div>
    )
  }

  // Modal para elegir qué guías incluir en el Excel (muestra sus evidencias).
  function ExcelModal({ target, onClose }: { target: { id: string; codigo: string }; onClose: () => void }) {
    const { data, isLoading } = useQuery<{ evidencias: { id: string; nombre: string; tipo: string }[] }>({
      queryKey: ["ficha-evidencias", target.id],
      queryFn:  () => apiFetch(`/api/fichas/${encodeURIComponent(target.id)}/evidencias`),
    })
    const gaDe   = (n: string) => parseInt((n.match(/GA\s*(\d+)/i) || [])[1] || "0", 10)
    const aaDe   = (n: string) => parseInt((n.match(/AA\s*(\d+)/i) || [])[1] || "99", 10)
    const evDe   = (n: string) => parseInt((n.match(/EV\s*(\d+)/i) || [])[1] || "99", 10)
    const compDe = (n: string) => (n.match(/GA\s*\d+\s*-\s*(\d{6,9})/i) || [])[1] || ""
    const miComp = user?.competenciaCodigo || ""
    const todas  = data?.evidencias ?? []

    // Agrupar por "competencia · Guía N". La selección es por EVIDENCIA (id), así
    // puedes marcar cualquiera, sea de tu competencia o no.
    const grupos = useMemo(() => {
      const m = new Map<string, { comp: string; ga: number; evs: { id: string; nombre: string; tipo: string }[] }>()
      for (const ev of todas) {
        const comp = compDe(ev.nombre) || "—";
        const ga = gaDe(ev.nombre);
        const key = `${comp}|${ga}`;
        if (!m.has(key)) m.set(key, { comp, ga, evs: [] });
        m.get(key)!.evs.push(ev);
      }
      const arr = [...m.values()];
      arr.forEach(g => g.evs.sort((a, b) => aaDe(a.nombre) - aaDe(b.nombre) || evDe(a.nombre) - evDe(b.nombre)));
      // mi competencia primero, luego por código y nº de guía
      return arr.sort((a, b) =>
        (a.comp === miComp ? -1 : 0) - (b.comp === miComp ? -1 : 0) ||
        a.comp.localeCompare(b.comp) || a.ga - b.ga);
    }, [data])

    const [sel, setSel] = useState<Set<string>>(new Set())   // evidenciaIds
    const [downloading, setDownloading] = useState(false)
    // Por defecto pre-marca TU competencia (si la hay); si no, todas.
    useEffect(() => {
      const mias = miComp ? todas.filter(e => compDe(e.nombre) === miComp) : [];
      setSel(new Set((mias.length ? mias : todas).map(e => e.id)));
    }, [data])

    const toggleEv = (id: string) => setSel(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n })
    const grupoAll = (g: typeof grupos[number]) => g.evs.every(e => sel.has(e.id))
    const grupoSome = (g: typeof grupos[number]) => g.evs.some(e => sel.has(e.id))
    const toggleGrupo = (g: typeof grupos[number]) => setSel(p => {
      const n = new Set(p); const all = g.evs.every(e => n.has(e.id));
      g.evs.forEach(e => all ? n.delete(e.id) : n.add(e.id)); return n;
    })
    const allIds = todas.map(e => e.id)
    const allSel = allIds.length > 0 && sel.size === allIds.length
    const toggleAll = () => setSel(allSel ? new Set() : new Set(allIds))

    async function descargar() {
      setDownloading(true)
      await descargarReporte(target.id, target.codigo, [...sel])
      setDownloading(false)
      onClose()
    }

    return (
      <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>Descargar Excel — Ficha {target.codigo}</DialogTitle></DialogHeader>
          {isLoading ? (
            <div className="py-8 text-center text-sm text-gray-500"><Loader2 className="w-5 h-5 animate-spin inline" /> Cargando evidencias…</div>
          ) : grupos.length === 0 ? (
            <div className="py-8 text-center text-sm text-gray-500">Esta ficha no tiene evidencias escaneadas todavía.</div>
          ) : (
            <div className="max-h-[55vh] overflow-y-auto space-y-2 pr-1">
              <button onClick={toggleAll} className="flex items-center gap-2 text-sm font-medium text-sena-green mb-1">
                {allSel ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />} Seleccionar todas
              </button>
              <p className="text-xs text-gray-400 mb-1">Marca las evidencias que quieras incluir (las de tu competencia vienen premarcadas).</p>
              {grupos.map((g) => (
                <div key={`${g.comp}-${g.ga}`} className="border border-gray-200 rounded-md overflow-hidden">
                  <button onClick={() => toggleGrupo(g)} className={`w-full px-3 py-2 flex items-center gap-2 text-sm font-medium ${grupoAll(g) ? "bg-green-50" : grupoSome(g) ? "bg-green-50/40" : ""}`}>
                    {grupoAll(g) ? <CheckSquare className="w-4 h-4 text-sena-green" /> : <Square className={`w-4 h-4 ${grupoSome(g) ? "text-sena-green/60" : "text-gray-300"}`} />}
                    {g.ga > 0 ? `Guía ${g.ga}` : "Sin guía"}
                    <span className="text-gray-400 font-normal">· comp. {g.comp}{g.comp === miComp ? " (tuya)" : ""} · {g.evs.length}</span>
                  </button>
                  <ul className="pb-1">
                    {g.evs.map(ev => (
                      <li key={ev.id}>
                        <button onClick={() => toggleEv(ev.id)} className="w-full px-3 pl-9 py-1 flex items-center gap-2 text-xs text-left hover:bg-gray-50">
                          {sel.has(ev.id) ? <CheckSquare className="w-3.5 h-3.5 text-sena-green shrink-0" /> : <Square className="w-3.5 h-3.5 text-gray-300 shrink-0" />}
                          <span className="truncate" title={ev.nombre}>{ev.nombre}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>Cancelar</Button>
            <Button className="bg-sena-green hover:bg-sena-green/90 gap-2" disabled={downloading || sel.size === 0} onClick={descargar}>
              {downloading ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileSpreadsheet className="w-4 h-4" />}
              Descargar ({sel.size} evid.)
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <Layout>
      {excelTarget && <ExcelModal target={excelTarget} onClose={() => setExcelTarget(null)} />}
      <div className="space-y-4">
        {/* Actions */}
        <div className="bg-white rounded-lg border border-gray-200 p-4 flex flex-wrap items-center gap-3">
          <Button onClick={openNueva} className="bg-sena-green hover:bg-sena-green/90 gap-2">
            <Plus className="w-4 h-4" /> Nueva ficha
          </Button>
          <Button onClick={handleScanFichas} disabled={scanLoading} variant="outline" className="gap-2">
            <Search className="w-4 h-4" />
            {scanLoading ? "Buscando..." : "Buscar en Zajuna"}
          </Button>
          {scanStatus && <span className="text-sm text-gray-600">{scanStatus}</span>}
        </div>

        {/* Fichas activas */}
        {isLoading ? (
          <div className="bg-white rounded-lg border p-8 text-center text-gray-500 text-sm">Cargando fichas...</div>
        ) : activas.length === 0 && archivadas.length === 0 ? (
          <div className="bg-white rounded-lg border p-12 text-center">
            <div className="text-4xl mb-3">📭</div>
            <p className="text-gray-600 text-sm">No hay fichas. Crea una o búscalas en Zajuna.</p>
          </div>
        ) : (
          <>
            {activas.length > 0 && <TablaFichas rows={activas} titulo={`📋 Fichas activas (${activas.length})`} />}

            {/* Archivadas — colapsadas por defecto al fondo */}
            {archivadas.length > 0 && (
              <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
                <button
                  className="w-full px-5 py-3 flex items-center gap-2 text-sm font-medium text-gray-500 hover:bg-gray-50 transition-colors"
                  onClick={() => setMostrarArchivadas(v => !v)}
                >
                  {mostrarArchivadas ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                  <Archive className="w-3.5 h-3.5" />
                  Archivadas ({archivadas.length})
                </button>
                {mostrarArchivadas && (
                  <div className="border-t border-gray-100 overflow-x-auto opacity-70">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-gray-100 bg-gray-50">
                          <th className="text-left px-5 py-2.5 font-medium text-gray-500">Código</th>
                          <th className="text-left px-5 py-2.5 font-medium text-gray-500">Programa</th>
                          <th className="text-left px-5 py-2.5 font-medium text-gray-500">Nombre del curso</th>
                          <th className="text-left px-5 py-2.5 font-medium text-gray-500">Acciones</th>
                        </tr>
                      </thead>
                      <tbody>{archivadas.map(f => <FichaRow key={f.id} f={f} />)}</tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* Modal crear / editar */}
      <Dialog open={!!modal} onOpenChange={open => !open && closeModal()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{modal === "nueva" ? "Nueva ficha" : "Editar ficha"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Código ficha *</Label>
                <Input placeholder="3186683" value={form.codigo} onChange={e => setForm(f => ({ ...f, codigo: e.target.value }))} />
              </div>
              {modal === "nueva" && (
                <div>
                  <Label>Course ID (Moodle) *</Label>
                  <Input placeholder="50283" value={form.courseId} onChange={e => setForm(f => ({ ...f, courseId: e.target.value }))} />
                </div>
              )}
            </div>
            <div>
              <Label>Nombre del curso</Label>
              <Input placeholder="Ej: Desarrollo de Software" value={form.nombre} onChange={e => setForm(f => ({ ...f, nombre: e.target.value }))} />
            </div>
            <div>
              <Label>Programa</Label>
              <Input placeholder="P_228106" value={form.programa} onChange={e => setForm(f => ({ ...f, programa: e.target.value }))} />
            </div>
            {error && <p className="text-sm text-red-600">{error}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeModal}>Cancelar</Button>
            <Button className="bg-sena-green hover:bg-sena-green/90" onClick={handleSubmit} disabled={crearMutation.isPending || editarMutation.isPending}>
              {modal === "nueva" ? "Crear" : "Guardar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Layout>
  )
}
