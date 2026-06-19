import { NavLink, useNavigate } from "react-router-dom"
import { LogOut, LayoutDashboard, FolderOpen, Settings2, BookOpen, ClipboardList, Mail, Settings, KeyRound, Loader2, ShieldCheck } from "lucide-react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Button } from "@/components/ui/button"
import { useAuthStore } from "@/store/auth"
import { apiFetch } from "@/api/client"
import LegalFooter from "@/components/LegalFooter"
import WelcomeModal from "@/components/WelcomeModal"

function getUserInitials(nombre: string): string {
  return nombre.split(" ").filter(Boolean).map(w => w[0]).slice(0, 2).join("").toUpperCase()
}

// Aviso global de "tareas en curso": etiquetas legibles por tipo de job. El
// trabajo corre en los workers del backend, así que el instructor puede navegar
// libremente; este aviso solo lo refleja consultando /api/jobs/activos.
interface JobActivo { id: string; tipo: string; status: string; progreso: number; fichaId: string | null }
const TIPO_LABELS: Record<string, string> = {
  evidencias:            "Escaneando evidencias",
  fichas:                "Descubriendo fichas",
  "config-leer":         "Leyendo fechas",
  "config-leer-lote":    "Leyendo fechas",
  "config-guardar":      "Guardando fechas",
  config:                "Guardando fechas",
  "cambiar-fecha":       "Cambiando fechas",
  "cambiar-config":      "Cambiando configuración",
  "batch-duedate":       "Cambiando fechas (lote)",
  "batch-config":        "Cambiando configuración (lote)",
  "foro-rating":         "Calificando foro",
  "foro-descubrir":      "Revisando foro",
  "matching-ia":         "Emparejando con IA",
  descubrirCompetencias: "Descubriendo competencias",
  mensajes:              "Enviando mensajes",
}
function labelTipo(tipo: string): string {
  return TIPO_LABELS[tipo] || tipo.replace(/[-_]/g, " ").replace(/\b\w/g, c => c.toUpperCase())
}

const navItems = [
  { to: "/dashboard",        label: "Dashboard",      icon: LayoutDashboard },
  { to: "/fichas",           label: "Fichas",          icon: FolderOpen },
  { to: "/evidencias/config",label: "Mis Evidencias",  icon: Settings2 },
  { to: "/raps",             label: "RAPs",            icon: BookOpen },
  // IA Matching oculto: los RAPs ya vienen vinculados a guías desde el scraper
  // de PDFs, así que esta sección no está lista para mostrarse. Ruta /matching
  // sigue accesible por URL para QA.
  // { to: "/matching",         label: "IA Matching",     icon: Sparkles },
  { to: "/actas",            label: "Actas",           icon: ClipboardList },
  { to: "/mensajes",         label: "Mensajes",        icon: Mail },
  { to: "/ajustes",          label: "Ajustes",         icon: Settings },
]

interface Me { id: string; nombre: string; email: string; rol: string; competenciaNombre: string; aceptoTerminosAt: string | null }

export default function Layout({ children }: { children: React.ReactNode }) {
  const navigate  = useNavigate()
  const qc = useQueryClient()
  const { user, jwt, clearAuth } = useAuthStore()

  // Usuario actual desde el backend (sobrevive reloads y refleja rol/aceptación
  // actuales — el store solo guarda el user en memoria, se pierde al recargar).
  const { data: meData } = useQuery<{ user: Me }>({
    queryKey: ["me"],
    queryFn:  () => apiFetch("/api/auth/me"),
    enabled:  !!jwt,
    staleTime: 60_000,
  })
  const esSuperadmin = meData?.user?.rol === "superadmin"
  const mostrarBienvenida = !!meData?.user && !meData.user.aceptoTerminosAt

  // El item de Admin solo se agrega para el superadmin (el backend igual exige rol).
  const items = esSuperadmin
    ? [...navItems, { to: "/admin", label: "Admin", icon: ShieldCheck }]
    : navItems

  // Estado de las credenciales de Zajuna. Si quedaron inválidas (el instructor
  // cambió la clave en Zajuna y la app sigue con la vieja), mostramos un banner
  // global pidiendo actualizarla. Se refresca cada 60 s para que el aviso aparezca
  // sin recargar tras un scan fallido.
  const { data: zajunaEstado } = useQuery<{ zajunaUser: string; credsInvalidasAt: string | null }>({
    queryKey: ["zajuna-estado"],
    queryFn:  () => apiFetch("/api/ajustes/zajuna"),
    enabled:  !!jwt,
    refetchInterval: 60_000,
  })
  const credsInvalidas = !!zajunaEstado?.credsInvalidasAt

  // Jobs en curso del usuario para el aviso global. Pollea rápido (3 s) cuando
  // hay algo corriendo y lento (12 s) cuando no, para no machacar la API.
  const { data: colasData } = useQuery<{ jobs: JobActivo[] }>({
    queryKey: ["jobs-activos"],
    queryFn:  () => apiFetch("/api/jobs/activos"),
    enabled:  !!jwt,
    refetchInterval: (query) => {
      const jobs = (query.state.data as { jobs: JobActivo[] } | undefined)?.jobs ?? []
      return jobs.length > 0 ? 3000 : 12000
    },
  })
  const jobsActivos = colasData?.jobs ?? []

  function handleLogout() {
    clearAuth()
    navigate("/login")
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
          {/* Logo + nav */}
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2 flex-shrink-0">
              <div className="w-7 h-7 bg-sena-green rounded-lg flex items-center justify-center">
                <svg viewBox="0 0 24 24" className="w-4 h-4 fill-white">
                  <rect x="3" y="3" width="7" height="7" rx="1.5" />
                  <rect x="14" y="3" width="7" height="7" rx="1.5" />
                  <rect x="3" y="14" width="7" height="7" rx="1.5" />
                  <rect x="14" y="14" width="7" height="7" rx="1.5" />
                </svg>
              </div>
              <span className="font-semibold text-sm text-gray-900 hidden sm:inline">Helper</span>
            </div>

            <nav className="flex items-center gap-1 overflow-x-auto max-w-[55vw] sm:max-w-none scrollbar-hide">
              {items.map(({ to, label, icon: Icon }) => (
                <NavLink
                  key={to}
                  to={to}
                  className={({ isActive }) =>
                    `flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                      isActive
                        ? "bg-sena-green/10 text-sena-green"
                        : "text-gray-600 hover:text-gray-900 hover:bg-gray-100"
                    }`
                  }
                >
                  <Icon className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">{label}</span>
                </NavLink>
              ))}
            </nav>
          </div>

          {/* User + logout */}
          <div className="flex items-center gap-2">
            {user?.nombre && (
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-full bg-sena-green text-white text-xs font-bold flex items-center justify-center">
                  {getUserInitials(user.nombre)}
                </div>
                <span className="text-sm text-gray-700 hidden md:inline">{user.nombre}</span>
              </div>
            )}
            <Button variant="ghost" size="sm" onClick={handleLogout} className="gap-1.5">
              <LogOut className="w-4 h-4" />
              <span className="hidden sm:inline">Salir</span>
            </Button>
          </div>
        </div>
      </header>

      {jobsActivos.length > 0 && (
        <div className="bg-sena-green/10 border-b border-sena-green/20">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 py-2 flex items-center gap-3">
            <Loader2 className="w-4 h-4 text-sena-green animate-spin flex-shrink-0" />
            <p className="text-sm text-gray-800 flex-1 truncate">
              <span className="font-semibold">
                {jobsActivos.length} {jobsActivos.length === 1 ? "tarea en curso" : "tareas en curso"}:
              </span>{" "}
              {jobsActivos.slice(0, 4).map((j, i) => (
                <span key={j.id}>
                  {i > 0 && " · "}
                  {labelTipo(j.tipo)}{j.status === "running" ? ` (${j.progreso}%)` : " (en cola)"}
                </span>
              ))}
              {jobsActivos.length > 4 && ` · +${jobsActivos.length - 4} más`}
            </p>
            <span className="text-xs text-gray-500 hidden md:inline flex-shrink-0">
              Puedes seguir navegando · no cierres la pestaña
            </span>
          </div>
        </div>
      )}

      {credsInvalidas && (
        <div className="bg-red-50 border-b border-red-200">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 py-2.5 flex items-center gap-3">
            <KeyRound className="w-4 h-4 text-red-600 flex-shrink-0" />
            <p className="text-sm text-red-800 flex-1">
              <span className="font-semibold">Tu contraseña de Zajuna cambió.</span>{" "}
              Las consultas a Zajuna están fallando con la clave guardada. Actualízala para reanudar los escaneos.
            </p>
            <Button
              size="sm"
              className="bg-red-600 hover:bg-red-700 text-white text-xs flex-shrink-0"
              onClick={() => navigate("/ajustes")}
            >
              Actualizar contraseña
            </Button>
          </div>
        </div>
      )}

      <main className="max-w-6xl mx-auto px-4 sm:px-6 py-6">
        {children}
      </main>

      <LegalFooter />

      {/* Aviso de bienvenida / tratamiento de datos (1ª vez). Al aceptar, refresca
          /me para que aceptoTerminosAt deje de ser null y no se vuelva a mostrar. */}
      <WelcomeModal open={mostrarBienvenida} onAccepted={() => qc.invalidateQueries({ queryKey: ["me"] })} />
    </div>
  )
}
