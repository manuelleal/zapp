import { Component, ErrorInfo, ReactNode } from "react"
import { AlertCircle } from "lucide-react"
import { Button } from "@/components/ui/button"

interface Props { children: ReactNode }
interface State { hasError: boolean; message: string }

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, message: "" }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, message: error.message }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("ErrorBoundary:", error, info.componentStack)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-gray-50 p-6">
          <div className="bg-white rounded-lg border border-red-200 p-8 max-w-md text-center space-y-4">
            <AlertCircle className="w-10 h-10 text-red-500 mx-auto" />
            <h1 className="text-lg font-semibold text-gray-900">Algo salió mal</h1>
            <p className="text-sm text-gray-500">
              {this.state.message || "Error inesperado en la aplicación."}
            </p>
            <Button
              className="bg-sena-green hover:bg-sena-green/90"
              onClick={() => { this.setState({ hasError: false, message: "" }); window.location.reload() }}
            >
              Recargar página
            </Button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
