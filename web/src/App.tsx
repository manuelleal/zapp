import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom"
import Login from "@/pages/Login"
import Dashboard from "@/pages/Dashboard"
import Fichas from "@/pages/Fichas"
import EvidenciasConfig from "@/pages/EvidenciasConfig"
import RapsPage from "@/pages/RapsPage"

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login"             element={<Login />} />
        <Route path="/dashboard"         element={<Dashboard />} />
        <Route path="/fichas"            element={<Fichas />} />
        <Route path="/evidencias/config" element={<EvidenciasConfig />} />
        <Route path="/raps"              element={<RapsPage />} />
        <Route path="*"                  element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App
