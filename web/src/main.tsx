import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import * as Sentry from '@sentry/react'
import './index.css'
import App from './App.tsx'

// Sentry se activa solo si se define VITE_SENTRY_DSN en .env.
// En dev local sin la variable, no hace nada — no rompe ni loguea basura.
if (import.meta.env.VITE_SENTRY_DSN) {
  Sentry.init({
    dsn:              import.meta.env.VITE_SENTRY_DSN as string,
    environment:      import.meta.env.MODE,
    // Captura el 10% de sesiones para performance. Ajustar si hay muchos instructores.
    tracesSampleRate: 0.1,
    replaysOnErrorSampleRate: 0,
  })
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 30,
      retry: false,
    },
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
)
