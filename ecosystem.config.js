module.exports = {
  apps: [
    {
      name: 'zajuna-backend',
      script: './api/src/server.js',
      instances: 1, // Fork mode para Playwright
      exec_mode: 'fork',
      watch: false,
      env: {
        NODE_ENV: 'production',
        PORT: 3000
      }
    }
  ]
};
