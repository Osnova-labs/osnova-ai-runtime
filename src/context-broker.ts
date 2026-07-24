import { mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { listArtifacts, listNotes, readArtifact, readNote } from "@osnova/project";
import type { ApprovalDecision, ArtifactDescriptor, ContextEnvelope, ContextLevel } from "@osnova/types";
import { writeJsonAtomic } from "./atomic.js";
import { resolveSafeExistingFile } from "./atomic.js";

export interface ContextRequest {
  projectPath: string;
  artifactIds?: string[];
  level: ContextLevel;
  budgetTokens: number;
  recipient: "local" | "cloud";
  approval?: ApprovalDecision;
}

export type CustomContextProvider = (input: {
  projectPath: string; artifact: ArtifactDescriptor; level: ContextLevel; budgetTokens: number; recipient: "local" | "cloud"; approval?: ApprovalDecision;
}) => Promise<ContextEnvelope>;

export class ContextBroker {
  readonly #providers = new Map<string, CustomContextProvider>();

  register(providerId: string, provider: CustomContextProvider): void { this.#providers.set(providerId, provider); }

  async preview(projectPath: string, budgetTokens = 1_000): Promise<ContextEnvelope> {
    const [artifacts, notes] = await Promise.all([listArtifacts(projectPath), listNotes(projectPath)]);
    const sensitive = artifacts.some((artifact) => artifact.metadata?.sensitivity === "sensitive");
    const visibleArtifacts = artifacts.slice(0, 30);
    const lines = [
      `Project context catalog: ${notes.length} notes, ${artifacts.length} registered artifacts.`,
      ...notes.slice(0, 30).map((note) => `- note: ${note.title} (${note.relativePath})`),
      ...visibleArtifacts.map((artifact) => `- ${artifact.type}: ${artifact.title ?? artifact.id} [${artifact.id}]`)
    ];
    const text = lines.join("\n");
    return envelope(
      "compact", truncate(text, Math.max(0, budgetTokens)),
      visibleArtifacts.map((artifact) => ({ artifactId: artifact.id, providerId: "host.catalog" })),
      sensitive ? "sensitive" : "project", sensitive ? ["local"] : ["local", "cloud"], "host.catalog/1"
    );
  }

  async resolve(request: ContextRequest): Promise<ContextEnvelope> {
    const artifactIds = request.artifactIds ?? (await listArtifacts(request.projectPath)).map((artifact) => artifact.id);
    let remaining = Math.max(0, request.budgetTokens);
    const parts: string[] = [];
    const sources: ContextEnvelope["sources"] = [];
    let truncated = false;
    let sensitivity: ContextEnvelope["sensitivity"] = "public";
    let recipients: ContextEnvelope["allowedRecipients"] = ["local", "cloud"];
    for (const artifactId of artifactIds) {
      if (remaining <= 0) { truncated = true; break; }
      const artifact = await readArtifact(request.projectPath, artifactId);
      const resolved = await this.#resolveArtifact(request.projectPath, artifact, request.level, remaining, request.recipient, request.approval);
      if (!resolved.allowedRecipients.includes(request.recipient)) throw new Error(`Artifact ${artifact.id} cannot be sent to ${request.recipient}.`);
      if (resolved.text) parts.push(resolved.text);
      sources.push(...resolved.sources);
      remaining -= resolved.tokenEstimate;
      truncated ||= resolved.truncated;
      if (resolved.sensitivity === "sensitive") sensitivity = "sensitive";
      else if (resolved.sensitivity === "project" && sensitivity === "public") sensitivity = "project";
      recipients = recipients.filter((recipient) => resolved.allowedRecipients.includes(recipient));
    }
    const text = parts.join("\n\n");
    const limited = truncate(text, request.budgetTokens);
    return { level: request.level, text: limited.text, sources, sensitivity, allowedRecipients: recipients,
      tokenEstimate: estimateTokens(limited.text), truncated: truncated || limited.truncated,
      freshness: new Date().toISOString(), providerVersion: "host.broker/1" };
  }

  async #resolveArtifact(projectPath: string, artifact: ArtifactDescriptor, level: ContextLevel, budgetTokens: number, recipient: "local" | "cloud", approval?: ApprovalDecision): Promise<ContextEnvelope> {
    const policy = artifact.context ?? { mode: "automatic" as const };
    const sensitivity = artifact.metadata?.sensitivity === "sensitive" ? "sensitive" : "project";
    const recipients: ContextEnvelope["allowedRecipients"] = sensitivity === "sensitive" ? ["local"] : ["local", "cloud"];
    const metadata = `${artifact.title ?? artifact.id} (${artifact.type}); payloads: ${artifact.payloads.map((payload) => `${payload.mediaType}, ${payload.size} bytes`).join("; ")}`;
    if (policy.mode === "none" || level === "compact") {
      return envelope(level, truncate(metadata, budgetTokens), [{ artifactId: artifact.id }], sensitivity, recipients, "host.metadata/1");
    }
    if (policy.mode === "custom") {
      const provider = policy.providerId ? this.#providers.get(policy.providerId) : undefined;
      if (!provider) return envelope(level, truncate(`${metadata}\nPayload unavailable: context provider is missing.`, budgetTokens), [{ artifactId: artifact.id }], sensitivity, recipients, "host.missing-provider/1");
      return normalizeCustomEnvelope(await provider({ projectPath, artifact, level, budgetTokens, recipient, approval }), artifact, budgetTokens, sensitivity, recipients);
    }
    if (policy.mode === "declarative") {
      const selected = Object.fromEntries((policy.fields ?? Object.keys(artifact.metadata ?? {})).map((field) => [field, readField(artifact.metadata ?? {}, field)]));
      const rendered = policy.template
        ? policy.template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, field: string) => String(readField(artifact.metadata ?? {}, field) ?? ""))
        : JSON.stringify(selected, null, 2);
      const text = `${metadata}\n${rendered}`;
      return envelope(level, truncate(text, budgetTokens), [{ artifactId: artifact.id }], sensitivity, recipients, "host.declarative/1");
    }
    const extracted: string[] = [metadata];
    for (const payload of artifact.payloads) {
      const filePath = await resolveSafeExistingFile(projectPath, payload.path, "Context payload");
      if (isTextMedia(payload.mediaType)) extracted.push(await readTextPrefix(filePath, budgetTokens * 4 + 1));
      else {
        const media = await safeMediaMetadata(filePath, payload.mediaType);
        if (media) extracted.push(media);
      }
    }
    if (extracted.length === 1) extracted.push("Payload content is not exposed for this media type; only safe metadata is available.");
    return envelope(level, truncate(extracted.join("\n\n"), budgetTokens), artifact.payloads.map((payload) => ({ artifactId: artifact.id, payloadPath: payload.path, providerId: "host.automatic" })), sensitivity, recipients, "host.automatic/1");
  }
}

export class ProjectIndexer {
  readonly #preferSqlite: boolean;

  constructor(options: { preferSqlite?: boolean } = {}) {
    this.#preferSqlite = options.preferSqlite ?? true;
  }

  async rebuild(projectPath: string): Promise<{ indexed: number; engine: "sqlite-fts5" | "portable" }> {
    const documents = await collectIndexDocuments(projectPath);
    const indexPath = path.join(projectPath, ".osnova", "index", "context.sqlite");
    const portablePath = path.join(projectPath, ".osnova", "index", "context.json");
    if (this.#preferSqlite) {
      try {
        const { DatabaseSync } = await import("node:sqlite");
        await mkdir(path.dirname(indexPath), { recursive: true });
        const db = new DatabaseSync(indexPath);
        try {
          db.exec("PRAGMA journal_mode=WAL; CREATE VIRTUAL TABLE IF NOT EXISTS documents USING fts5(id UNINDEXED, kind UNINDEXED, title, body); DELETE FROM documents;");
          const insert = db.prepare("INSERT INTO documents (id, kind, title, body) VALUES (?, ?, ?, ?)");
          for (const document of documents) insert.run(document.id, document.kind, document.title, document.body);
        } finally { db.close(); }
        await rm(portablePath, { force: true });
        return { indexed: documents.length, engine: "sqlite-fts5" };
      } catch {
        // Electron releases can embed a Node version without node:sqlite. The
        // portable index preserves local search instead of blocking the project.
      }
    }
    await writeJsonAtomic(portablePath, { version: 1, documents });
    return { indexed: documents.length, engine: "portable" };
  }

  async search(projectPath: string, query: string, limit = 20): Promise<Array<{ id: string; kind: string; title: string; snippet: string }>> {
    if (this.#preferSqlite) {
      try {
        const { DatabaseSync } = await import("node:sqlite");
        const db = new DatabaseSync(path.join(projectPath, ".osnova", "index", "context.sqlite"), { readOnly: true });
        try {
          return db.prepare("SELECT id, kind, title, snippet(documents, 3, '[', ']', '…', 20) AS snippet FROM documents WHERE documents MATCH ? LIMIT ?")
            .all(query, limit) as Array<{ id: string; kind: string; title: string; snippet: string }>;
        } finally { db.close(); }
      } catch {
        // Fall through to the index built for runtimes without SQLite FTS5.
      }
    }
    const portablePath = path.join(projectPath, ".osnova", "index", "context.json");
    const parsed = JSON.parse(await readFile(portablePath, "utf8")) as { version?: unknown; documents?: unknown };
    if (parsed.version !== 1 || !Array.isArray(parsed.documents)) throw new Error("Portable project index is invalid; rebuild it.");
    return searchPortableIndex(parsed.documents as IndexDocument[], query, limit);
  }
}

interface IndexDocument { id: string; kind: "note" | "artifact"; title: string; body: string }

async function collectIndexDocuments(projectPath: string): Promise<IndexDocument[]> {
  const documents: IndexDocument[] = [];
  const artifacts = await listArtifacts(projectPath);
  const pathPolicies = new Map<string, ArtifactDescriptor>();
  for (const artifact of artifacts) {
    for (const payload of artifact.payloads) {
      const existing = pathPolicies.get(payload.path);
      if (!existing || contextRestriction(artifact) > contextRestriction(existing)) pathPolicies.set(payload.path, artifact);
    }
  }
  for (const note of await listNotes(projectPath)) {
    const document = await readNote(projectPath, note.relativePath);
    const policyArtifact = pathPolicies.get(note.relativePath);
    const mode = policyArtifact?.context?.mode ?? "automatic";
    const body = mode === "none" || mode === "custom" ? "" : mode === "declarative" ? JSON.stringify(policyArtifact?.metadata ?? {}) : document.body;
    documents.push({ id: note.id, kind: "note", title: note.title, body });
  }
  for (const artifact of artifacts) {
    const mode = artifact.context?.mode ?? "automatic";
    const parts = [JSON.stringify(artifact.metadata ?? {})];
    if (mode === "automatic") {
      for (const payload of artifact.payloads.filter((candidate) => isTextMedia(candidate.mediaType))) {
        try { parts.push(await readTextPrefix(await resolveSafeExistingFile(projectPath, payload.path, "Index payload"), 1024 * 1024)); }
        catch { /* A corrupt derived descriptor is skipped without reading outside the project. */ }
      }
    }
    documents.push({ id: artifact.id, kind: "artifact", title: artifact.title ?? artifact.id, body: mode === "none" || mode === "custom" ? "" : parts.join("\n") });
  }
  return documents;
}

function contextRestriction(artifact: ArtifactDescriptor): number {
  return ({ automatic: 0, declarative: 1, custom: 2, none: 3 } as const)[artifact.context?.mode ?? "automatic"];
}

function searchPortableIndex(documents: IndexDocument[], query: string, limit: number): Array<{ id: string; kind: string; title: string; snippet: string }> {
  const terms = query.toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  if (!terms.length) return [];
  return documents
    .map((document) => {
      const haystack = `${document.title}\n${document.body}`.toLocaleLowerCase();
      const score = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
      const first = Math.max(0, Math.min(...terms.map((term) => haystack.indexOf(term)).filter((position) => position >= 0)) - 50);
      return { document, score, snippet: document.body.slice(first, first + 240) };
    })
    .filter((entry) => entry.score === terms.length)
    .sort((left, right) => right.score - left.score || left.document.title.localeCompare(right.document.title))
    .slice(0, Math.max(0, limit))
    .map(({ document, snippet }) => ({ id: document.id, kind: document.kind, title: document.title, snippet }));
}

function envelope(level: ContextLevel, limited: { text: string; truncated: boolean }, sources: ContextEnvelope["sources"], sensitivity: ContextEnvelope["sensitivity"], allowedRecipients: ContextEnvelope["allowedRecipients"], providerVersion: string): ContextEnvelope {
  return { level, text: limited.text, sources, sensitivity, allowedRecipients, tokenEstimate: estimateTokens(limited.text), truncated: limited.truncated, freshness: new Date().toISOString(), providerVersion };
}

function truncate(text: string, tokens: number): { text: string; truncated: boolean } {
  const maxCharacters = Math.max(0, tokens * 4);
  return text.length <= maxCharacters ? { text, truncated: false } : { text: `${text.slice(0, Math.max(0, maxCharacters - 1))}…`, truncated: true };
}

function estimateTokens(text: string): number { return Math.ceil(text.length / 4); }
function isTextMedia(mediaType: string): boolean { return mediaType.startsWith("text/") || ["application/json", "application/ld+json", "application/xml"].includes(mediaType); }
function readField(value: Record<string, unknown>, field: string): unknown {
  let cursor: unknown = value;
  for (const part of field.split(".")) {
    if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

async function safeMediaMetadata(filePath: string, mediaType: string): Promise<string | undefined> {
  if (mediaType !== "image/png" && mediaType !== "audio/wav") return undefined;
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(64);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (mediaType === "image/png" && bytesRead >= 24 && buffer.subarray(1, 4).toString("ascii") === "PNG") {
      return `PNG metadata: ${buffer.readUInt32BE(16)} × ${buffer.readUInt32BE(20)} pixels.`;
    }
    if (mediaType === "audio/wav" && bytesRead >= 44 && buffer.subarray(0, 4).toString("ascii") === "RIFF") {
      const channels = buffer.readUInt16LE(22);
      const sampleRate = buffer.readUInt32LE(24);
      const byteRate = buffer.readUInt32LE(28);
      const dataSize = buffer.readUInt32LE(40);
      return `WAV metadata: ${channels} channel(s), ${sampleRate} Hz, ${byteRate ? Math.round(dataSize / byteRate * 1000) : 0} ms.`;
    }
    return undefined;
  } finally { await handle.close(); }
}

async function readTextPrefix(filePath: string, maxBytes: number): Promise<string> {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(Math.max(0, Math.min(maxBytes, 8 * 1024 * 1024)));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally { await handle.close(); }
}

function normalizeCustomEnvelope(
  candidate: ContextEnvelope,
  artifact: ArtifactDescriptor,
  budgetTokens: number,
  hostSensitivity: ContextEnvelope["sensitivity"],
  hostRecipients: ContextEnvelope["allowedRecipients"]
): ContextEnvelope {
  const limited = truncate(candidate.text ?? "", budgetTokens);
  const payloadPaths = new Set(artifact.payloads.map((payload) => payload.path));
  const sources = candidate.sources
    .filter((source) => source.artifactId === artifact.id && (!source.payloadPath || payloadPaths.has(source.payloadPath)))
    .map((source) => ({ ...source, providerId: source.providerId ?? artifact.context?.providerId }));
  if (!sources.length) sources.push({ artifactId: artifact.id, providerId: artifact.context?.providerId });
  const sensitivity = hostSensitivity === "sensitive" || candidate.sensitivity === "sensitive"
    ? "sensitive"
    : hostSensitivity === "project" || candidate.sensitivity === "project" ? "project" : "public";
  const allowedRecipients = hostRecipients.filter((recipient) => candidate.allowedRecipients.includes(recipient));
  const textTokens = estimateTokens(limited.text);
  const structuredTokens = estimateTokens(candidate.structured ? JSON.stringify(candidate.structured) : "");
  const structured = textTokens + structuredTokens <= budgetTokens ? candidate.structured : undefined;
  return {
    level: candidate.level,
    text: limited.text || undefined,
    structured,
    sources,
    sensitivity,
    allowedRecipients,
    tokenEstimate: textTokens + (structured ? structuredTokens : 0),
    truncated: limited.truncated || candidate.truncated || Boolean(candidate.structured && !structured),
    freshness: candidate.freshness,
    providerVersion: candidate.providerVersion || "custom/unknown"
  };
}
