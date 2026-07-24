import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { createNote, createArtifactRelation, importAsset, registerExistingArtifact } from "@osnova/project";
import type { ApprovalDecision, OperationDefinition, RuntimeDescriptor } from "@osnova/types";
import { AgentOrchestrator } from "./agent-orchestrator.js";
import { ArtifactIngestor } from "./artifact-ingestor.js";
import { ConnectorEngine } from "./connector-engine.js";
import { ContextBroker, ProjectIndexer } from "./context-broker.js";
import { createSystemCredentialStore } from "./credential-store.js";
import { DiagnosticsService } from "./diagnostics.js";
import { ExtensionManager } from "./extension-manager.js";
import { JobManager } from "./job-manager.js";
import { ModelManager } from "./model-manager.js";
import { OpenAICompatibleProvider } from "./model-provider.js";
import { OperationRegistry } from "./operation-registry.js";
import { OperationService } from "./operation-service.js";
import { PolicyEngine } from "./policy-engine.js";
import { ProjectService } from "./project-service.js";
import { createInvocationDirectories, removeInvocationDirectories, runtimeInvocationScopeRoot, RuntimeSupervisor } from "./runtime-supervisor.js";
import { stageModels } from "./operation-service.js";
import { writeJsonAtomic } from "./atomic.js";

export interface ModelProviderConfig {
  id: string;
  type: "openai-compatible";
  endpoint: string;
  credentialAccount?: string;
}

export class OsnovaRuntime {
  readonly projects = new ProjectService();
  readonly registry = new OperationRegistry();
  readonly policy: PolicyEngine;
  readonly jobs: JobManager;
  readonly supervisor = new RuntimeSupervisor();
  readonly ingestor = new ArtifactIngestor();
  readonly extensions: ExtensionManager;
  readonly context = new ContextBroker();
  readonly indexer = new ProjectIndexer();
  readonly connectors: ConnectorEngine;
  readonly models: ModelManager;
  readonly credentials;
  readonly operations: OperationService;
  readonly agent: AgentOrchestrator;
  readonly diagnostics: DiagnosticsService;

  constructor(readonly dataRoot = defaultRuntimeDataRoot()) {
    this.policy = new PolicyEngine(dataRoot);
    this.connectors = new ConnectorEngine(this.ingestor, this.policy);
    this.jobs = new JobManager(dataRoot);
    this.models = new ModelManager(dataRoot);
    this.credentials = createSystemCredentialStore(dataRoot);
    this.operations = new OperationService(dataRoot, this.projects, this.registry, this.policy, this.jobs, this.supervisor, this.ingestor, this.models);
    this.agent = new AgentOrchestrator(dataRoot, this.registry, this.context, this.operations, this.jobs);
    this.extensions = new ExtensionManager(dataRoot, this.registry, this.policy, this.context, this.connectors, this.supervisor, this.models, this.agent, this.projects);
    this.diagnostics = new DiagnosticsService(dataRoot, this.extensions, this.models, this.jobs);
    registerBuiltins(this);
  }

  async initialize(): Promise<void> {
    await this.jobs.initialize();
    await this.extensions.loadActive();
    for (const config of await this.listModelProviderConfigs()) this.#registerModelProvider(config);
  }

  async openProject(projectPath: string) {
    const project = await this.projects.open(projectPath);
    await this.extensions.reconcileProject(project.rootPath);
    await this.policy.hydrateProject(project.rootPath);
    return this.projects.get(project.rootPath);
  }

  async configureModelProvider(config: ModelProviderConfig, secret?: string): Promise<ModelProviderConfig> {
    if (!/^[a-z0-9][a-z0-9._-]+$/.test(config.id)) throw new Error("Model provider id must be namespaced.");
    const endpoint = new URL(config.endpoint);
    if (endpoint.protocol !== "https:" && !["127.0.0.1", "localhost", "::1"].includes(endpoint.hostname)) throw new Error("Cloud model providers require HTTPS.");
    if (secret) {
      if (!config.credentialAccount) throw new Error("credentialAccount is required when saving a secret.");
      await this.credentials.set(config.credentialAccount, secret);
    }
    const configs = [...(await this.listModelProviderConfigs()).filter((item) => item.id !== config.id), config].sort((left, right) => left.id.localeCompare(right.id));
    await writeJsonAtomic(path.join(this.dataRoot, "model-providers.json"), configs);
    this.#registerModelProvider(config);
    return config;
  }

  async listModelProviderConfigs(): Promise<ModelProviderConfig[]> {
    try { return JSON.parse(await readFile(path.join(this.dataRoot, "model-providers.json"), "utf8")) as ModelProviderConfig[]; }
    catch { return []; }
  }

  async syncConnector(projectPath: string, connectorId: string, approval?: ApprovalDecision) {
    const project = this.projects.get(projectPath);
    const definition = this.connectors.get(connectorId);
    const job = await this.jobs.create({ projectPath: project.rootPath, operationId: connectorId, input: {} });
    void (async () => {
      try {
        await this.jobs.transition(job.id, "running");
        const artifacts = await this.connectors.sync(project, connectorId, { signal: this.jobs.signal(job.id), producedTypes: definition.produces, approval });
        await this.jobs.transition(job.id, "succeeded", { artifactIds: artifacts.map((artifact) => artifact.id), progress: 1, result: { imported: artifacts.length } });
      } catch (error) {
        if (this.jobs.get(job.id).status !== "cancelled") await this.jobs.transition(job.id, "failed", { error: error instanceof Error ? error.message : String(error) });
      }
    })();
    return job;
  }

  async removeModel(sha256: string): Promise<void> {
    await this.models.remove(sha256, await this.extensions.modelDependents(sha256));
  }

  status() {
    return {
      name: "osnova-runtime" as const, version: "0.2.0", status: "ready" as const,
      capabilities: ["projects", "extensions", "operations", "jobs", "artifacts", "sessions", "context", "connectors", "models", "agent", "oci-optional"],
      openProjects: this.projects.list().map((project) => project.rootPath),
      runtimes: this.supervisor.status()
    };
  }

  async startRuntime(runtimeId: string, projectPath: string) {
    const project = this.projects.get(projectPath);
    const descriptor = this.extensions.getRuntime(runtimeId, project.rootPath);
    const directories = await createInvocationDirectories(runtimeInvocationScopeRoot(this.dataRoot, descriptor, project.rootPath), `health-${Date.now()}`);
    try {
      await stageModels(descriptor.models ?? [], this.models, directories.models);
      const health = await this.supervisor.call<Record<string, unknown>>(descriptor, "health", {}, { paths: directories, timeoutMs: 30_000 });
      return { runtimeId, health, state: this.supervisor.status(runtimeId)[0] };
    } finally { await removeInvocationDirectories(directories.root); }
  }

  async shutdown(): Promise<void> { await this.supervisor.stop(); }

  #registerModelProvider(config: ModelProviderConfig): void {
    if (config.type === "openai-compatible") this.agent.registerProvider(new OpenAICompatibleProvider(config.id, config.endpoint, this.credentials, config.credentialAccount));
  }
}

export function defaultRuntimeDataRoot(): string {
  if (process.env.OSNOVA_RUNTIME_HOME) return path.resolve(process.env.OSNOVA_RUNTIME_HOME);
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "Osnova", "runtime");
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA ?? os.homedir(), "Osnova", "runtime");
  return path.join(os.homedir(), ".local", "share", "osnova", "runtime");
}

function registerBuiltins(runtime: OsnovaRuntime): void {
  register(runtime, {
    id: "osnova.notes.create", toolId: "osnova.notes", version: "1.0.0", title: "Create note",
    description: "Create a Markdown note inside the project and register it as an artifact.",
    inputSchema: { type: "object", required: ["title"], additionalProperties: false, properties: { title: { type: "string", minLength: 1 }, body: { type: "string" }, folder: { type: "string" }, tags: { type: "array", items: { type: "string" } } } },
    outputSchema: { type: "object", required: ["artifactId", "relativePath"], properties: { artifactId: { type: "string" }, relativePath: { type: "string" } } },
    produces: ["osnova.note"], risk: "project-write", agentVisibility: "automatic", execution: "immediate", cancellable: false, idempotent: false,
    permissions: ["project:read", "artifact:create"]
  }, async ({ projectPath, arguments: args, provenance }) => {
    const project = runtime.projects.get(projectPath);
    const note = await createNote(project, { title: String(args.title), body: typeof args.body === "string" ? args.body : undefined, folderRelativePath: typeof args.folder === "string" ? args.folder : undefined, tags: Array.isArray(args.tags) ? args.tags.filter((tag): tag is string => typeof tag === "string") : undefined });
    const artifact = await registerExistingArtifact(project, { type: "osnova.note", title: note.title, projectRelativePath: note.relativePath, provenance: { source: "operation", toolId: "osnova.notes", operationId: "osnova.notes.create", runId: provenance.runId, model: provenance.model }, context: { mode: "automatic" } });
    return { structured: { artifactId: artifact.id, relativePath: note.relativePath }, publishedArtifactIds: [artifact.id] };
  });

  register(runtime, {
    id: "osnova.files.import", toolId: "osnova.files", version: "1.0.0", title: "Import file",
    inputSchema: { type: "object", required: ["sourcePath"], additionalProperties: false, properties: { sourcePath: { type: "string" }, folder: { type: "string" } } },
    outputSchema: { type: "object", required: ["artifactId", "relativePath"], properties: { artifactId: { type: "string" }, relativePath: { type: "string" } } },
    produces: ["osnova.file"], risk: "project-write", agentVisibility: "hidden", execution: "immediate", cancellable: false, idempotent: false,
    permissions: ["project:read", "artifact:create"]
  }, async ({ projectPath, arguments: args, provenance }) => {
    const project = runtime.projects.get(projectPath);
    const asset = await importAsset(project, { sourcePath: String(args.sourcePath), targetFolderRelativePath: typeof args.folder === "string" ? args.folder : undefined });
    const artifact = await registerExistingArtifact(project, { type: "osnova.file", title: asset.name, projectRelativePath: asset.relativePath, provenance: { source: "import", runId: provenance.runId, model: provenance.model }, context: { mode: "automatic" } });
    return { structured: { artifactId: artifact.id, relativePath: asset.relativePath }, publishedArtifactIds: [artifact.id] };
  });

  register(runtime, {
    id: "osnova.graph.link", toolId: "osnova.graph", version: "1.0.0", title: "Link artifacts",
    inputSchema: { type: "object", required: ["from", "to", "type"], additionalProperties: false, properties: { from: { type: "string" }, to: { type: "string" }, type: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]+$" } } },
    outputSchema: { type: "object", required: ["relationId"], properties: { relationId: { type: "string" } } },
    risk: "project-write", agentVisibility: "automatic", execution: "immediate", cancellable: false, idempotent: false, permissions: ["project:read", "artifact:create"]
  }, async ({ projectPath, arguments: args }) => {
    const relation = await createArtifactRelation(projectPath, { from: { artifactId: String(args.from) }, to: { artifactId: String(args.to) }, type: String(args.type) });
    return { structured: { relationId: relation.id } };
  });

  register(runtime, {
    id: "osnova.context.reindex", toolId: "osnova.knowledge", version: "1.0.0", title: "Rebuild project index",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    outputSchema: { type: "object", required: ["indexed", "engine"], properties: { indexed: { type: "integer" }, engine: { type: "string" } } },
    risk: "safe-read", agentVisibility: "explicit", execution: "job", timeoutSeconds: 120, cancellable: true, idempotent: true, permissions: ["project:read"]
  }, async ({ projectPath, progress }) => {
    progress(0.1, "Reading project materials");
    const result = await runtime.indexer.rebuild(projectPath);
    progress(1, "Index rebuilt");
    return { structured: result };
  });
}

function register(runtime: OsnovaRuntime, definition: OperationDefinition, handler: Parameters<OperationRegistry["register"]>[1]): void {
  const runtimeDescriptor: RuntimeDescriptor = { id: "osnova.builtin", kind: "builtin", lifecycle: "shared" };
  runtime.registry.register({ definition, extensionId: "osnova.builtin", runtime: runtimeDescriptor }, handler);
}
