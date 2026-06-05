// PM2 process manifest — separa la API de los workers en procesos distintos.
// Ver CLAUDE.md §11.1 / §11.3 (P0 #1) y §11.4 (infra recomendada).
//
//   pm2 start ecosystem.config.js
//   pm2 logs api        # solo la API
//   pm2 logs workers    # solo los scrapers/workers
//
// CRÍTICO: "workers" SIEMPRE instances:1 (fork). Correr 2+ instancias duplica
// los browsers por usuario y Moodle/Zajuna invalida la sesión paralela de la
// misma cuenta. La API sí es HTTP stateless y podría ir en cluster a futuro.

module.exports = {
  apps: [
    {
      name: 'api',
      script: './api/src/server.js',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
    },
    {
      name: 'workers',
      script: './api/src/worker-entry.js',
      instances: 1,            // NUNCA subir — duplicaría browsers/sesión Moodle
      exec_mode: 'fork',
      watch: false,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
