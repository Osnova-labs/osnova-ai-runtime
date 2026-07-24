import type { OperationRisk, Permission } from "@osnova/types";
import type { CredentialStore } from "./credential-store.js";
import { readBoundedJsonResponse } from "./tool-client.js";

export interface ModelRequest {
  projectPath?: string;
  model: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  temperature?: number;
  maxTokens?: number;
  responseSchema?: Record<string, unknown>;
  signal?: AbortSignal;
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
    const response = await fetch(new URL("chat/completions", ensureSlash(this.endpoint)), {
      method: "POST", signal: request.signal,
      headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({
        model: request.model, messages: request.messages, temperature: request.temperature ?? 0,
        max_tokens: request.maxTokens,
        ...(request.responseSchema ? { response_format: { type: "json_schema", json_schema: { name: "osnova_response", strict: true, schema: request.responseSchema } } } : {})
      })
    });
    if (!response.ok) throw new Error(`Model provider returned HTTP ${response.status}.`);
    const body = await readBoundedJsonResponse(response) as { model?: string; choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    const text = body.choices?.[0]?.message?.content;
    if (typeof text !== "string") throw new Error("Model provider returned no text result.");
    return { text, model: body.model ?? request.model, usage: { inputTokens: body.usage?.prompt_tokens, outputTokens: body.usage?.completion_tokens } };
  }
}

export async function requestAgentPlan(provider: ModelProvider, model: string, goal: string, snapshot: string, planSchema: Record<string, unknown>, projectPath: string): Promise<{ plan: unknown; model: string }> {
  const response = await provider.complete({
    projectPath,
    model,
    messages: [
      { role: "system", content: "Build a bounded Osnova operation plan. Use only operations in the supplied capability snapshot. Return JSON only. Never invent filesystem or shell actions." },
      { role: "user", content: `Goal:\n${goal}\n\nCapabilities and compact context:\n${snapshot}` }
    ],
    responseSchema: planSchema,
    maxTokens: 4_096,
    signal: AbortSignal.timeout(300_000)
  });
  return { plan: JSON.parse(response.text) as unknown, model: response.model };
}

function ensureSlash(value: string): string { return value.endsWith("/") ? value : `${value}/`; }
