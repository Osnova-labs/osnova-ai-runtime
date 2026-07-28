import type { OperationRisk, Permission } from "@osnova/types";
import type { CredentialStore } from "./credential-store.js";
import { readBoundedJsonResponse } from "./tool-client.js";

const CONTEXT_SELECTION_MAX_TOKENS = 16_384;
const AGENT_REPLY_MAX_TOKENS = 32_768;
const AGENT_PLAN_MAX_TOKENS = 16_384;

export interface ModelRequest {
  projectPath?: string;
  model: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  temperature?: number;
  maxTokens?: number;
  responseSchema?: Record<string, unknown>;
  signal?: AbortSignal;
  onTextDelta?: (delta: string) => void;
}

export interface ModelResponse { text: string; model: string; usage?: { inputTokens?: number; outputTokens?: number } }
export interface ModelProvider {
  id: string;
  recipient: "local" | "cloud";
  sourceExtensionId?: string;
  permissions?: Permission[];
  risk?: OperationRisk;
  complete(request: ModelRequest): Promise<ModelResponse>;
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly recipient: "local" | "cloud";
  constructor(readonly id: string, readonly endpoint: string, readonly credentials: CredentialStore, readonly credentialAccount?: string) {
    const host = new URL(endpoint).hostname;
    this.recipient = ["127.0.0.1", "localhost", "::1"].includes(host) ? "local" : "cloud";
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const key = this.credentialAccount ? await this.credentials.get(this.credentialAccount) : undefined;
    const streaming = Boolean(request.onTextDelta);
    const response = await fetch(new URL("chat/completions", ensureSlash(this.endpoint)), {
      method: "POST", signal: request.signal,
      headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({
        model: request.model, messages: request.messages, temperature: request.temperature ?? 0,
        max_tokens: request.maxTokens,
        stream: streaming,
        ...(streaming ? { stream_options: { include_usage: true } } : {}),
        ...(request.responseSchema ? { response_format: { type: "json_schema", json_schema: { name: "osnova_response", strict: true, schema: request.responseSchema } } } : {})
      })
    });
    if (!response.ok) throw new Error(`Model provider returned HTTP ${response.status}.`);
    if (streaming && response.body && response.headers.get("content-type")?.includes("text/event-stream")) {
      return readStreamingResponse(response, request.model, request.onTextDelta!);
    }
    const body = await readBoundedJsonResponse(response) as { model?: string; choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    const text = body.choices?.[0]?.message?.content;
    if (typeof text !== "string") throw new Error("Model provider returned no text result.");
    return { text, model: body.model ?? request.model, usage: { inputTokens: body.usage?.prompt_tokens, outputTokens: body.usage?.completion_tokens } };
  }
}

export async function requestContextSelection(
  provider: ModelProvider,
  model: string,
  goal: string,
  snapshot: string,
  projectPath: string,
  signal?: AbortSignal
): Promise<{ selection: unknown; model: string }> {
  const response = await provider.complete({
    projectPath,
    model,
    messages: [
      {
        role: "system",
        content: "Inspect the compact Osnova project catalog and choose only the sources needed to answer the user's goal. Return JSON only. Use exact project-relative paths and artifact ids from the catalog. Add focused search queries when titles alone are insufficient."
      },
      { role: "user", content: `Goal:\n${goal}\n\nCompact project catalog:\n${snapshot}` }
    ],
    responseSchema: contextSelectionSchema(),
    maxTokens: CONTEXT_SELECTION_MAX_TOKENS,
    signal
  });
  return { selection: parseModelJson(response.text), model: response.model };
}

export async function requestAgentReply(
  provider: ModelProvider,
  model: string,
  goal: string,
  researchedContext: string,
  projectPath: string,
  options: { signal?: AbortSignal; onDelta?: (delta: string) => void } = {}
): Promise<ModelResponse> {
  return provider.complete({
    projectPath,
    model,
    messages: [
      {
        role: "system",
        content: "Answer the user clearly using the researched Osnova project sources. Mention uncertainty when the sources are insufficient. Do not emit JSON or an operation plan in this response."
      },
      { role: "user", content: `Goal:\n${goal}\n\nResearched project context:\n${researchedContext}` }
    ],
    maxTokens: AGENT_REPLY_MAX_TOKENS,
    signal: options.signal ?? AbortSignal.timeout(300_000),
    onTextDelta: options.onDelta
  });
}

export async function requestAgentPlan(
  provider: ModelProvider,
  model: string,
  goal: string,
  snapshot: string,
  planSchema: Record<string, unknown>,
  projectPath: string,
  signal?: AbortSignal
): Promise<{ plan: unknown; model: string }> {
  const response = await provider.complete({
    projectPath,
    model,
    messages: [
      {
        role: "system",
        content: "Build a bounded Osnova operation plan only when project changes are needed. Return JSON only. Use only listed operations. Never invent filesystem or shell actions. Return an empty steps array for a read-only answer."
      },
      { role: "user", content: `Goal:\n${goal}\n\nAvailable operations and researched project context:\n${snapshot}` }
    ],
    responseSchema: planSchema,
    maxTokens: AGENT_PLAN_MAX_TOKENS,
    signal: signal ?? AbortSignal.timeout(300_000)
  });
  return { plan: parseModelJson(response.text), model: response.model };
}

function ensureSlash(value: string): string { return value.endsWith("/") ? value : `${value}/`; }

async function readStreamingResponse(response: Response, fallbackModel: string, onTextDelta: (delta: string) => void): Promise<ModelResponse> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let model = fallbackModel;
  let usage: ModelResponse["usage"];
  let receivedBytes = 0;
  let finishReason: string | undefined;
  const processLine = (line: string): void => {
    const normalized = line.replace(/\r$/, "");
    if (!normalized.startsWith("data:")) return;
    const payload = normalized.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    const chunk = JSON.parse(payload) as {
      model?: string;
      choices?: Array<{ delta?: { content?: string }; message?: { content?: string }; finish_reason?: string | null }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      error?: { message?: string };
    };
    if (chunk.error) throw new Error(chunk.error.message || "Model provider streaming error.");
    model = chunk.model ?? model;
    finishReason = chunk.choices?.[0]?.finish_reason ?? finishReason;
    const delta = chunk.choices?.[0]?.delta?.content ?? chunk.choices?.[0]?.message?.content;
    if (typeof delta === "string" && delta) {
      text += delta;
      onTextDelta(delta);
    }
    if (chunk.usage) usage = { inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens };
  };
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    receivedBytes += value.byteLength;
    if (receivedBytes > 32 * 1024 * 1024) {
      await reader.cancel();
      throw new Error("Model streaming response exceeds 32 MiB.");
    }
    buffer += decoder.decode(value, { stream: true });
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      processLine(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) processLine(buffer);
  if (!text) throw new Error("Model provider returned no streamed text result.");
  if (finishReason === "length") throw new Error("Model response reached its output limit.");
  return { text, model, usage };
}

function contextSelectionSchema(): Record<string, unknown> {
  return {
    type: "object",
    required: ["queries", "projectRelativePaths", "artifactIds"],
    additionalProperties: false,
    properties: {
      queries: { type: "array", maxItems: 6, items: { type: "string" } },
      projectRelativePaths: { type: "array", maxItems: 12, items: { type: "string" } },
      artifactIds: { type: "array", maxItems: 8, items: { type: "string" } }
    }
  };
}

function parseModelJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(trimmed) as unknown;
  } catch (error) {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try { return JSON.parse(trimmed.slice(start, end + 1)) as unknown; }
      catch { /* The normalized error below is clearer than an engine offset. */ }
    }
    throw new Error(`Model returned incomplete structured data${error instanceof SyntaxError ? "" : "."}`);
  }
}
