/* =============================================================================
 * KASAUTI — ai/providers.ts   (v2.0 "Parakh")
 * -----------------------------------------------------------------------------
 * WHAT:  Bring-your-own-model. Two wire formats cover almost every provider:
 *          'openai'    — POST {base}/chat/completions  (OpenAI, Ollama, NVIDIA
 *                        NIM / Nemotron, OpenRouter, Groq, LM Studio, vLLM …)
 *          'anthropic' — POST {base}/v1/messages        (Claude)
 *        VS Code's own language models (Copilot etc.) are a third route,
 *        handled in views/parakh.ts because it needs the `vscode` API.
 * WHY:   Kanak's requirement: people pick the AI they like. One adapter per
 *        wire format instead of one per vendor keeps this file small and lets
 *        any new OpenAI-compatible service work with zero code changes
 *        (preset 'custom' + a base URL).
 *        No vscode import: the MCP server and tests use the same code.
 * FLOW:  views/parakh.ts reads settings + SecretStorage -> chat() -> text ->
 *        ai/verify.ts extracts the code block and verifies it.
 * ========================================================================== */

export type WireFormat = 'openai' | 'anthropic';
export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }

export interface ProviderPreset {
  id: string;
  label: string;
  format: WireFormat;
  baseUrl: string;
  needsKey: boolean;
  /** true = code stays on this machine (no consent prompt needed). */
  local: boolean;
  /** Suggested model id; empty = the user must type one (names change too
   *  often for a default to stay right). */
  defaultModel: string;
  keyHint?: string;
}

export const PRESETS: ProviderPreset[] = [
  { id: 'ollama', label: 'Ollama (local, free, offline)', format: 'openai', baseUrl: 'http://localhost:11434/v1', needsKey: false, local: true, defaultModel: 'qwen2.5-coder:7b' },
  { id: 'lmstudio', label: 'LM Studio (local)', format: 'openai', baseUrl: 'http://localhost:1234/v1', needsKey: false, local: true, defaultModel: '' },
  { id: 'openai', label: 'OpenAI', format: 'openai', baseUrl: 'https://api.openai.com/v1', needsKey: true, local: false, defaultModel: '', keyHint: 'platform.openai.com → API keys' },
  { id: 'anthropic', label: 'Anthropic (Claude)', format: 'anthropic', baseUrl: 'https://api.anthropic.com', needsKey: true, local: false, defaultModel: '', keyHint: 'console.anthropic.com → API keys' },
  { id: 'nvidia', label: 'NVIDIA NIM (Nemotron and others)', format: 'openai', baseUrl: 'https://integrate.api.nvidia.com/v1', needsKey: true, local: false, defaultModel: '', keyHint: 'build.nvidia.com → Get API key' },
  { id: 'openrouter', label: 'OpenRouter (many models, one key)', format: 'openai', baseUrl: 'https://openrouter.ai/api/v1', needsKey: true, local: false, defaultModel: '', keyHint: 'openrouter.ai/keys' },
  { id: 'groq', label: 'Groq', format: 'openai', baseUrl: 'https://api.groq.com/openai/v1', needsKey: true, local: false, defaultModel: '', keyHint: 'console.groq.com/keys' },
  { id: 'custom', label: 'Custom OpenAI-compatible endpoint', format: 'openai', baseUrl: '', needsKey: false, local: false, defaultModel: '' },
];
export const presetById = (id: string) => PRESETS.find((p) => p.id === id);

/** Is a base URL on this machine? Used to skip the "code leaves your machine" prompt. */
export function isLocalUrl(url: string): boolean {
  try { return /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/.test(new URL(url).hostname); } catch { return false; }
}

export interface ResolvedProvider { id: string; format: WireFormat; baseUrl: string; model: string; apiKey?: string; label: string }

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export class ProviderError extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}

/**
 * Send a chat and return the assistant's text.
 * Errors are rewritten into sentences a user can act on ("wrong key",
 * "Ollama not running") — a raw 401 JSON blob helps nobody.
 */
export async function chat(p: ResolvedProvider, messages: ChatMessage[], opts: { timeoutMs?: number; signal?: AbortSignal; fetchImpl?: FetchLike; maxTokens?: number } = {}): Promise<string> {
  const f = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  const signal = opts.signal ?? AbortSignal.timeout(opts.timeoutMs ?? 180_000);
  const base = p.baseUrl.replace(/\/+$/, '');
  let url: string, headers: Record<string, string>, body: unknown;
  if (p.format === 'anthropic') {
    url = `${base}${base.endsWith('/v1') ? '' : '/v1'}/messages`;
    headers = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...(p.apiKey ? { 'x-api-key': p.apiKey } : {}) };
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    body = { model: p.model, max_tokens: opts.maxTokens ?? 4096, system, messages: messages.filter((m) => m.role !== 'system') };
  } else {
    url = `${base}/chat/completions`;
    headers = { 'content-type': 'application/json', ...(p.apiKey ? { authorization: `Bearer ${p.apiKey}` } : {}) };
    body = { model: p.model, messages, temperature: 0.2, max_tokens: opts.maxTokens ?? 4096, stream: false };
  }
  let res;
  try {
    res = await f(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (/abort|timeout/i.test(msg)) throw new ProviderError(`${p.label} did not answer in time.`);
    if (isLocalUrl(base)) throw new ProviderError(`Cannot reach ${p.label} at ${base}. Is it running? (Ollama: \`ollama serve\`, then \`ollama pull ${p.model}\`)`);
    throw new ProviderError(`Cannot reach ${p.label} (${msg}). Check the internet connection or the base URL.`);
  }
  const text = await res.text();
  if (!res.ok) {
    const detail = (() => { try { const j = JSON.parse(text); return j.error?.message ?? j.message ?? j.detail ?? text; } catch { return text; } })();
    const hint = res.status === 401 || res.status === 403 ? ' — the API key is missing or wrong (KASAUTI: Set AI API Key).'
      : res.status === 404 ? ` — check the model id "${p.model}" and the base URL.`
      : res.status === 429 ? ' — rate limit or quota reached; wait or switch provider.' : '';
    throw new ProviderError(`${p.label} returned HTTP ${res.status}: ${String(detail).slice(0, 300)}${hint}`, res.status);
  }
  let j: any;
  try { j = JSON.parse(text); } catch { throw new ProviderError(`${p.label} returned something that is not JSON.`); }
  const out = p.format === 'anthropic'
    ? (j.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('')
    : j.choices?.[0]?.message?.content ?? '';
  if (!out) throw new ProviderError(`${p.label} returned an empty answer.`);
  return out;
}
