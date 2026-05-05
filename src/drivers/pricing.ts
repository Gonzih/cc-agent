import type { AgentPricing } from "./types.js";

/** Model pricing registry (USD per 1M tokens). */
const PRICING: Record<string, AgentPricing> = {
  // ── Claude models ────────────────────────────────────────────────────────
  "claude-haiku-4-5":             { inputPer1M: 0.80,  outputPer1M: 4.00,  cacheReadPer1M: 0.08,  cacheWritePer1M: 1.00 },
  "claude-haiku-4-5-20251001":    { inputPer1M: 0.80,  outputPer1M: 4.00,  cacheReadPer1M: 0.08,  cacheWritePer1M: 1.00 },
  "claude-sonnet-4-5":            { inputPer1M: 3.00,  outputPer1M: 15.00, cacheReadPer1M: 0.30,  cacheWritePer1M: 3.75 },
  "claude-sonnet-4-5-20251101":   { inputPer1M: 3.00,  outputPer1M: 15.00, cacheReadPer1M: 0.30,  cacheWritePer1M: 3.75 },
  "claude-sonnet-4-6":            { inputPer1M: 3.00,  outputPer1M: 15.00, cacheReadPer1M: 0.30,  cacheWritePer1M: 3.75 },
  "claude-opus-4-6":              { inputPer1M: 15.00, outputPer1M: 75.00, cacheReadPer1M: 1.50,  cacheWritePer1M: 18.75 },
  "claude-opus-4-5":              { inputPer1M: 15.00, outputPer1M: 75.00, cacheReadPer1M: 1.50,  cacheWritePer1M: 18.75 },
  "claude-3-opus-20240229":       { inputPer1M: 15.00, outputPer1M: 75.00, cacheReadPer1M: 1.50,  cacheWritePer1M: 18.75 },
  "claude-3-5-sonnet-20241022":   { inputPer1M: 3.00,  outputPer1M: 15.00, cacheReadPer1M: 0.30,  cacheWritePer1M: 3.75 },
  "claude-3-5-haiku-20241022":    { inputPer1M: 0.80,  outputPer1M: 4.00,  cacheReadPer1M: 0.08,  cacheWritePer1M: 1.00 },

  // ── OpenAI models ────────────────────────────────────────────────────────
  "gpt-4o":                       { inputPer1M: 2.50,  outputPer1M: 10.00 },
  "gpt-4o-2024-11-20":            { inputPer1M: 2.50,  outputPer1M: 10.00 },
  "gpt-4o-mini":                  { inputPer1M: 0.15,  outputPer1M: 0.60 },
  "gpt-4-turbo":                  { inputPer1M: 10.00, outputPer1M: 30.00 },
  "gpt-4-turbo-preview":          { inputPer1M: 10.00, outputPer1M: 30.00 },
  "gpt-4":                        { inputPer1M: 30.00, outputPer1M: 60.00 },
  "gpt-3.5-turbo":                { inputPer1M: 0.50,  outputPer1M: 1.50 },
  "o1":                           { inputPer1M: 15.00, outputPer1M: 60.00 },
  "o1-mini":                      { inputPer1M: 3.00,  outputPer1M: 12.00 },
  "o3-mini":                      { inputPer1M: 1.10,  outputPer1M: 4.40 },

  // ── Qwen models ──────────────────────────────────────────────────────────
  "qwen2.5-72b-instruct":         { inputPer1M: 0.40,  outputPer1M: 1.20 },
  "qwen2.5-32b-instruct":         { inputPer1M: 0.20,  outputPer1M: 0.60 },
  "qwen2.5-coder-32b-instruct":   { inputPer1M: 0.20,  outputPer1M: 0.60 },
  "qwen2.5-7b-instruct":          { inputPer1M: 0.10,  outputPer1M: 0.30 },
  "qwen3-235b-a22b":              { inputPer1M: 0.60,  outputPer1M: 2.40 },
  "qwen3-32b":                    { inputPer1M: 0.20,  outputPer1M: 0.60 },

  // ── Kimi / Moonshot models ────────────────────────────────────────────────
  "kimi-k1.5":                    { inputPer1M: 0.60,  outputPer1M: 2.50 },
  "kimi-k2":                      { inputPer1M: 0.60,  outputPer1M: 2.50 },
  "moonshot-v1-8k":               { inputPer1M: 0.12,  outputPer1M: 0.12 },
  "moonshot-v1-32k":              { inputPer1M: 0.24,  outputPer1M: 0.24 },
  "moonshot-v1-128k":             { inputPer1M: 0.60,  outputPer1M: 0.60 },

  // ── DeepSeek models ───────────────────────────────────────────────────────
  "deepseek-coder-v2":            { inputPer1M: 0.14,  outputPer1M: 0.28 },
  "deepseek-v3":                  { inputPer1M: 0.14,  outputPer1M: 0.28 },
  "deepseek-r1":                  { inputPer1M: 0.55,  outputPer1M: 2.19 },
  "deepseek-chat":                { inputPer1M: 0.14,  outputPer1M: 0.28 },

  // ── Gemini models (via Gemini CLI) ────────────────────────────────────────
  "gemini-2.5-pro":               { inputPer1M: 1.25,  outputPer1M: 10.00 },
  "gemini-2.5-flash":             { inputPer1M: 0.075, outputPer1M: 0.30 },
  "gemini-2.5-flash-lite":        { inputPer1M: 0.01,  outputPer1M: 0.04 },

  // ── Amp models (via Amp CLI) ──────────────────────────────────────────────
  "amp":                          { inputPer1M: 15.00, outputPer1M: 75.00 },
  "amp-fast":                     { inputPer1M: 0.25,  outputPer1M: 1.25 },

  // ── OpenAI Codex CLI models ───────────────────────────────────────────────
  "gpt-4.1":                      { inputPer1M: 2.00,  outputPer1M: 8.00 },
  "gpt-4.1-mini":                 { inputPer1M: 0.40,  outputPer1M: 1.60 },
  "o3":                           { inputPer1M: 10.00, outputPer1M: 40.00 },
  "o4-mini":                      { inputPer1M: 1.10,  outputPer1M: 4.40 },
};

const DEFAULT_PRICING: AgentPricing = { inputPer1M: 1.0, outputPer1M: 3.0 };

/**
 * Return pricing for a model. Falls back to DEFAULT_PRICING for unknown models.
 * Performs prefix matching so version-suffixed names resolve to the base model.
 */
export function getPricing(model: string): AgentPricing {
  if (!model) return DEFAULT_PRICING;

  // Exact match first
  if (PRICING[model]) return PRICING[model];

  // Prefix match (e.g. "claude-sonnet-4-6-20260101" → "claude-sonnet-4-6")
  for (const [key, pricing] of Object.entries(PRICING)) {
    if (model.startsWith(key)) return pricing;
  }

  return DEFAULT_PRICING;
}
