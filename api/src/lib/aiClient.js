/**
 * aiClient.js — Cliente IA agnóstico de proveedor para las tareas de matching.
 *
 * POR QUÉ: el matching RAP↔evidencia corría solo en Anthropic (Haiku). El usuario
 * tiene créditos de Kimi (Moonshot), que expone una API **compatible con OpenAI**.
 * Esta capa permite cambiar de proveedor por variable de entorno SIN tocar la
 * lógica del worker, y sin agregar el SDK de OpenAI (se usa `fetch` directo).
 *
 * SELECCIÓN DE PROVEEDOR (env `AI_PROVIDER`, default "auto"):
 *   - "openrouter" → OpenRouter (requiere OPENROUTER_API_KEY). Compatible OpenAI.
 *   - "kimi"       → Moonshot/Kimi directo (requiere MOONSHOT_API_KEY).
 *   - "anthropic"  → Claude (requiere ANTHROPIC_API_KEY).
 *   - "auto"       → OpenRouter si hay OPENROUTER_API_KEY; si no Kimi; si no Anthropic.
 *
 * VARIABLES:
 *   OPENROUTER_API_KEY   clave de OpenRouter (sk-or-...)
 *   OPENROUTER_BASE_URL  default https://openrouter.ai/api/v1
 *   OPENROUTER_MODEL     default moonshotai/kimi-k2
 *   MOONSHOT_API_KEY     clave de Kimi directo (sk-...)
 *   MOONSHOT_BASE_URL    default https://api.moonshot.cn/v1  (global: https://api.moonshot.ai/v1)
 *   MOONSHOT_MODEL       default moonshot-v1-8k
 *   ANTHROPIC_API_KEY    clave de Claude
 *   ANTHROPIC_MODEL      default claude-haiku-4-5
 *
 * API: chatJSON({ system, user, maxTokens, userId, feature }) → objeto JSON parseado.
 *   Lanza si la respuesta no contiene JSON válido (el caller decide cómo manejarlo).
 *   `userId`/`feature` son opcionales: si vienen, se registra el consumo de tokens
 *   en la tabla AiUsage (best-effort) para el panel del superadmin. Las llamadas de
 *   scripts CLI sin sesión pueden omitir userId (queda null).
 */

const ANTHROPIC_VERSION = "2023-06-01";

// ─── Registro de consumo de tokens (best-effort) ──────────────────────────────
// Normaliza el bloque `usage` de cada proveedor a { promptTokens, completionTokens,
// totalTokens }. OpenAI-compatible usa prompt/completion/total; Anthropic usa
// input/output (sin total → se suma).
function normalizarUsageOpenAI(u) {
  if (!u) return null;
  const p = u.prompt_tokens ?? 0, c = u.completion_tokens ?? 0;
  return { promptTokens: p, completionTokens: c, totalTokens: u.total_tokens ?? (p + c) };
}
function normalizarUsageAnthropic(u) {
  if (!u) return null;
  const p = u.input_tokens ?? 0, c = u.output_tokens ?? 0;
  return { promptTokens: p, completionTokens: c, totalTokens: p + c };
}

// Persiste una fila de uso. NUNCA lanza: si la DB falla, el matching/acta sigue.
async function registrarUso({ userId, feature, provider, model, usage }) {
  if (!usage) return;
  try {
    const prisma = require("../db/client");
    await prisma.aiUsage.create({
      data: {
        userId:           userId || null,
        feature:          feature || "desconocido",
        provider,
        model:            model || "",
        promptTokens:     usage.promptTokens     || 0,
        completionTokens: usage.completionTokens || 0,
        totalTokens:      usage.totalTokens      || 0,
      },
    });
  } catch (e) {
    console.error("[aiClient] no se pudo registrar el consumo de tokens:", e.message);
  }
}

function elegirProveedor() {
  const forzado = (process.env.AI_PROVIDER || "auto").toLowerCase();
  if (forzado === "openrouter")                     return "openrouter";
  if (forzado === "kimi" || forzado === "moonshot") return "kimi";
  if (forzado === "anthropic" || forzado === "claude") return "anthropic";
  // auto: OpenRouter → Kimi → Anthropic, según qué clave exista.
  if (process.env.OPENROUTER_API_KEY) return "openrouter";
  if (process.env.MOONSHOT_API_KEY)   return "kimi";
  return "anthropic";
}

// Extrae el primer objeto JSON de un texto (los modelos a veces lo envuelven en
// ```json ... ``` o agregan prosa alrededor).
function extraerJSON(texto) {
  const m = (texto || "").match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`La respuesta de IA no contiene JSON: ${(texto || "").slice(0, 200)}`);
  return JSON.parse(m[0]);
}

// ─── Genérico OpenAI-compatible (OpenRouter, Kimi/Moonshot) ───────────────────

async function chatOpenAICompatible({ apiKey, baseURL, model, extraHeaders = {}, system, user, maxTokens }) {
  // `response_format: json_object` no lo soportan todos los proveedores de OpenRouter
  // (ej. Kimi K2 vía Novita da 400). Por eso es opt-in (AI_JSON_MODE=1); por defecto
  // confiamos en el prompt ("devuelve SOLO JSON") + extraerJSON() por regex.
  const usarJsonMode = process.env.AI_JSON_MODE === "1";
  const res = await fetch(`${baseURL.replace(/\/$/, "")}/chat/completions`, {
    method:  "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}`, ...extraHeaders },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature: 0.2,                       // matching = tarea determinista
      ...(usarJsonMode ? { response_format: { type: "json_object" } } : {}),
      messages: [
        ...(system ? [{ role: "system", content: system }] : []),
        { role: "user", content: user },
      ],
    }),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`IA HTTP ${res.status} (${model}): ${txt.slice(0, 300)}`);
  }
  const data = await res.json();
  const texto = data?.choices?.[0]?.message?.content ?? "";
  return { json: extraerJSON(texto), usage: normalizarUsageOpenAI(data?.usage), model };
}

async function chatOpenRouter(opts) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("Falta OPENROUTER_API_KEY para usar OpenRouter.");
  return chatOpenAICompatible({
    apiKey,
    baseURL: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
    model:   process.env.OPENROUTER_MODEL || "moonshotai/kimi-k2",
    // Headers opcionales que OpenRouter usa para rankings (no obligatorios).
    extraHeaders: { "HTTP-Referer": "https://zajuna.app", "X-Title": "Zajuna" },
    ...opts,
  });
}

async function chatKimi(opts) {
  const apiKey = process.env.MOONSHOT_API_KEY;
  if (!apiKey) throw new Error("Falta MOONSHOT_API_KEY para usar Kimi.");
  return chatOpenAICompatible({
    apiKey,
    baseURL: process.env.MOONSHOT_BASE_URL || "https://api.moonshot.cn/v1",
    model:   process.env.MOONSHOT_MODEL || "moonshot-v1-8k",
    ...opts,
  });
}

// ─── Anthropic / Claude ───────────────────────────────────────────────────────

async function chatAnthropic({ system, user, maxTokens }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Falta ANTHROPIC_API_KEY para usar Claude.");
  const model = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5";

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method:  "POST",
    headers: {
      "Content-Type":      "application/json",
      "x-api-key":         apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      ...(system ? { system } : {}),
      messages: [{ role: "user", content: user }],
    }),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Anthropic HTTP ${res.status}: ${txt.slice(0, 300)}`);
  }
  const data = await res.json();
  const texto = data?.content?.[0]?.text ?? "";
  return { json: extraerJSON(texto), usage: normalizarUsageAnthropic(data?.usage), model };
}

// ─── API pública ──────────────────────────────────────────────────────────────

/**
 * Envía un prompt y devuelve el JSON parseado de la respuesta.
 * @param {{ system?: string, user: string, maxTokens?: number, userId?: string|null, feature?: string }} opts
 */
async function chatJSON({ system, user, maxTokens = 512, userId = null, feature = "matching" }) {
  const proveedor = elegirProveedor();
  let resultado;
  if (proveedor === "openrouter")    resultado = await chatOpenRouter({ system, user, maxTokens });
  else if (proveedor === "kimi")     resultado = await chatKimi({ system, user, maxTokens });
  else                               resultado = await chatAnthropic({ system, user, maxTokens });

  // Registra el consumo de tokens para el panel del superadmin (no bloquea ni falla).
  await registrarUso({ userId, feature, provider: proveedor, model: resultado.model, usage: resultado.usage });
  return resultado.json;
}

function proveedorActivo() { return elegirProveedor(); }

module.exports = { chatJSON, proveedorActivo };
