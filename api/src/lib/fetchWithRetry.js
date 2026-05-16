// Fetch-with-retries (patrón Extension Z `tn`).
// Solo reintenta errores de red; errores HTTP ≥400 se propagan inmediatamente.
async function fetchWithRetry(url, opts = {}, { retries = 3, delay = 2000 } = {}) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, opts);
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const err  = new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
        err.status = res.status;
        throw err;
      }
      return res;
    } catch (e) {
      if (e.status && e.status >= 400) throw e;  // errores HTTP no se reintentan
      lastErr = e;
      if (i < retries - 1) await new Promise((r) => setTimeout(r, delay * (i + 1)));
    }
  }
  throw lastErr;
}

module.exports = { fetchWithRetry };
