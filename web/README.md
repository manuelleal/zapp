# Zajuna App — Frontend

Frontend React 18 + Vite 5 + Tailwind 3 + shadcn/ui.

Para documentación del proyecto, instrucciones de desarrollo y arquitectura, ver:
- `DEVELOPER_ONBOARDING.md` — guía para desarrolladores nuevos
- `CLAUDE.md` — fuente de verdad del proyecto (estado actual, reglas, pendientes)
- `docs/ARCHITECTURE.md` — arquitectura del sistema

## Comandos

```bash
# Desarrollo con HMR (proxy a API en :3000)
npm run dev       # inicia en http://localhost:5173

# Build de producción (sirve desde Fastify en :3000)
npm run build     # genera web/dist/

# Verificación de tipos
npx tsc --noEmit
```

## Páginas

| Ruta | Componente | Descripción |
|---|---|---|
| `/login` | `Login.tsx` | Acceso |
| `/dashboard` | `Dashboard.tsx` | Vista general del instructor |
| `/fichas` | `Fichas.tsx` | Listado completo + modal evidencias + Excel |
| `/evidencias-config` | `EvidenciasConfig.tsx` | Tabla de fechas y config masiva |
| `/raps` | `RapsPage.tsx` | Gestión curricular RAPs |
| `/matching-ia` | `MatchingIaPage.tsx` | Revisar propuestas IA de matching |
| `/actas` | `ActasPage.tsx` | Actas GOR-F-084 + descarga Word |
| `/mensajes` | `MensajesPage.tsx` | Mensajes masivos + programados |
| `/ajustes` | `AjustesPage.tsx` | Config SMTP + competencias |
| `/admin` | `AdminPage.tsx` | Panel superadmin (solo rol superadmin) |
