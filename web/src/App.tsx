import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom"
import { Toaster } from "sonner"
import Login from "@/pages/Login"
import Dashboard from "@/pages/Dashboard"
import Fichas from "@/pages/Fichas"
import EvidenciasConfig from "@/pages/EvidenciasConfig"
import RapsPage from "@/pages/RapsPage"
import MatchingIaPage from "@/pages/MatchingIaPage"
import ActasPage from "@/pages/ActasPage"
import MensajesPage from "@/pages/MensajesPage"
import AjustesPage from "@/pages/AjustesPage"
import ErrorBoundary from "@/components/ErrorBoundary"

function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <Toaster richColors position="top-right" />
        <Routes>
          <Route path="/login"             element={<Login />} />
          <Route path="/dashboard"         element={<Dashboard />} />
          <Route path="/fichas"            element={<Fichas />} />
          <Route path="/evidencias/config" element={<EvidenciasConfig />} />
          <Route path="/raps"              element={<RapsPage />} />
          <Route path="/matching"          element={<MatchingIaPage />} />
          <Route path="/actas"             element={<ActasPage />} />
          <Route path="/mensajes"          element={<MensajesPage />} />
          <Route path="/mensajes/nuevo"    element={<MensajesPage />} />
          <Route path="/ajustes"           element={<AjustesPage />} />
          <Route path="*"                  element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </BrowserRouter>
    </ErrorBoundary>
  )
}

export default App
