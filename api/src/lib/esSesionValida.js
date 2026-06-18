/**
 * api/src/lib/esSesionValida.js
 *
 * Función PURA (sin dependencias) para decidir si una sesión SSO de SENA sigue
 * viva, a partir de la URL final tras navegar a /my/.
 *
 * Gotcha clave: el login de SENA es SSO/portal federado, NO el login nativo de
 * Moodle. Cuando la sesión expira, SENA NO redirige a /login — rebota al PORTAL
 * RAÍZ (https://zajuna.sena.edu.co/), que igual contiene "zajuna.sena.edu.co".
 * Por eso el chequeo correcto es "¿seguí en /my/?", no "¿no estoy en /login?".
 * (Ver memoria del fix del 18-jun en los workers.)
 */
function esSesionValidaUrl(url) {
  const u = url || "";
  return u.includes("/my") && !u.includes("/login");
}

module.exports = { esSesionValidaUrl };
