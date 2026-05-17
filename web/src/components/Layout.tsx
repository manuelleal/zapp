import { NavLink, useNavigate } from "react-router-dom"
import { LogOut, LayoutDashboard, FolderOpen, Settings2, BookOpen, Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useAuthStore } from "@/store/auth"

function getUserInitials(nombre: string): string {
  return nombre.split(" ").filter(Boolean).map(w => w[0]).slice(0, 2).join("").toUpperCase()
}

const navItems = [
  { to: "/dashboard",        label: "Dashboard",      icon: LayoutDashboard },
  { to: "/fichas",           label: "Fichas",          icon: FolderOpen },
  { to: "/evidencias/config",label: "Mis Evidencias",  icon: Settings2 },
  { to: "/raps",             label: "RAPs",            icon: BookOpen },
  { to: "/matching",         label: "IA Matching",     icon: Sparkles },
]

export default function Layout({ children }: { children: React.ReactNode }) {
  const navigate  = useNavigate()
  const { user, clearAuth } = useAuthStore()

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
              <span className="font-semibold text-sm text-gray-900 hidden sm:inline">Zajuna</span>
            </div>

            <nav className="flex items-center gap-1">
              {navItems.map(({ to, label, icon: Icon }) => (
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

      <main className="max-w-6xl mx-auto px-4 sm:px-6 py-6">
        {children}
      </main>
    </div>
  )
}
