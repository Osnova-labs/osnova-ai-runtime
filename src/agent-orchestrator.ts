import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { appendSessionEvent } from "@osnova/project";
import type { AgentPlan, AgentStep, ApprovalDecision, JobDescriptor } from "@osnova/types";
import { writeJsonAtomic } from "./atomic.js";
import type { ContextBroker } from "./context-broker.js";
import type { JobManager } from "./job-manager.js";
import type { ModelProvider } from "./model-provider.js";
import { requestAgentPlan } from "./model-provider.js";
import type { OperationRegistry } from "./operation-registry.js";
import type { OperationService } from "./operation-service.js";
import { validateJsonSchema } from "./schema.js";

export interface AgentRun {
  id: string;
  projectPath: string;
  sessionId?: string;
  plan: AgentPlan;
  providerId?: string;
  model?: string;
  status: "ready" | "running" | "waiting-approval" | "succeeded" | "failed" | "cancelled";
  stepJobs: Record<string, string>;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreatePlanInput {
  projectPath: string;
  goal: string;
  sessionId?: string;
  providerId?: string;
  model?: string;
  draft?: Omit<AgentPlan, "schemaVersion" | "id" | "createdAt" | "maxSteps" | "maxDurationSeconds"> & { maxSteps?: number };
  maxSteps?: number;
  maxDurationSeconds?: number;
  contextBudgetTokens?: number;
  recipientApproval?: { recipient: "cloud"; approved: boolean; decidedAt: string };
  providerApproval?: ApprovalDecision;
}

export class AgentOrchestrator {
  readonly #providers = new Map<string, ModelProvider>();

  constructor(
    readonly dataRoot: string,
    readonly registry: OperationRegistry,
    readonly context: ContextBroker,
    readonly operations: OperationService,
    readonly jobs: JobManager
  ) {}

  registerProvider(provider: ModelProvider): void { this.#providers.set(provider.id, provider); }
  listProviders(): Array<{ id: string; recipient: "local" | "cloud"; sourceExtensionId?: string; permissions: string[]; risk: string }> {
    return [...this.#providers.values()].map(({ id, recipient, sourceExtensionId, permissions = [], risk = "safe-read" }) => ({ id, recipient, sourceExtensionId, permissions, risk }));
  }

  async plan(input: CreatePlanInput): Promise<AgentRun> {
    const maxSteps = Math.min(Math.max(input.maxSteps ?? 12, 1), 50);
    const maxDurationSeconds = Math.min(Math.max(input.maxDurationSeconds ?? 1_800, 1), 86_400);
    const contextBudgetTokens = Math.min(Math.max(input.contextBudgetTokens ?? 2_000, 128), 32_000);
    let candidate: AgentPlan;
    let planningProviderId: string | undefined;
    let planningModel: string | undefined;
    if (input.draft) {
      const raw = { goal: input.draft.goal, steps: input.draft.steps };
      assertPlanCandidate(raw, maxSteps);
      candidate = { ...raw, schemaVersion: "1", id: randomUUID(), createdAt: new Date().toISOString(), maxSteps: Math.min(input.draft.maxSteps ?? maxSteps, maxSteps), maxDurationSeconds };
    } else {
      const provider = input.providerId ? this.#providers.get(input.providerId) : undefined;
      if (!provider || !input.model) throw new Error("Agent planning requires a configured model provider and model, or an explicit draft plan.");
      if (provider.sourceExtensionId) {
        const connected = this.operations.projects.get(input.projectPath).manifest.extensions?.some((extension) => extension.id === provider.sourceExtensionId && extension.enabled !== false);
        if (!connected) throw new Error(`Model provider extension is not connected to this project: ${provider.sourceExtensionId}`);
        const evaluation = this.operations.policy.evaluate(input.projectPath, provider.sourceExtensionId, {
          id: provider.id, toolId: provider.id, version: "1", title: provider.id, inputSchema: {}, outputSchema: {},
          permissions: provider.permissions ?? [], risk: provider.risk ?? "safe-read", agentVisibility: "hidden", execution: "immediate"
        });
        if (!evaluation.allowed) throw new Error(`${evaluation.reason} Missing: ${evaluation.missingPermissions.join(", ")}`);
        const cloudApproval = provider.recipient === "cloud" && input.recipientApproval?.approved;
        if (evaluation.approvalRequired && !(input.providerApproval?.approved || cloudApproval)) throw new Error(`Model provider ${provider.id} requires explicit runtime approval.`);
        if (input.providerApproval) {
          await this.operations.policy.rememberApproval(input.projectPath, provider.id, input.providerApproval);
          if (input.sessionId) await appendSessionEvent(input.projectPath, input.sessionId, {
            type: "approval", data: {
              kind: "model-provider-runtime", providerId: provider.id,
              permissions: provider.permissions ?? [], risk: provider.risk ?? "safe-read",
              approved: input.providerApproval.approved, scope: input.providerApproval.scope,
              decidedAt: input.providerApproval.decidedAt
            }
          });
        }
      }
      if (provider.recipient === "cloud" && !(input.recipientApproval?.approved && input.recipientApproval.recipient === "cloud")) {
        throw new Error("Cloud model planning requires explicit data-recipient approval.");
      }
      const preview = await this.context.preview(input.projectPath, contextBudgetTokens);
      if (!preview.allowedRecipients.includes(provider.recipient)) throw new Error(`Compact context cannot be sent to ${provider.recipient}.`);
      if (provider.recipient === "cloud" && input.sessionId) await appendSessionEvent(input.projectPath, input.sessionId, {
        type: "approval", data: { kind: "model-context", providerId: provider.id, recipient: "cloud", approved: true, decidedAt: input.recipientApproval?.decidedAt }
      });
      const capabilities = this.#availableOperations(input.projectPath).filter(({ definition }) => definition.agentVisibility === "automatic").map(({ definition }) => ({
        id: definition.id, title: definition.title, description: definition.description,
        inputSchema: definition.inputSchema, produces: definition.produces, risk: definition.risk
      }));
      const response = await requestAgentPlan(provider, input.model, input.goal, `${preview.text ?? ""}\n\nOperations:\n${JSON.stringify(capabilities)}`, agentPlanSchema(maxSteps), input.projectPath);
      const raw = response.plan;
      assertPlanCandidate(raw, maxSteps);
      const planned = raw as { goal: string; steps: AgentStep[] };
      candidate = { goal: planned.goal, steps: planned.steps, schemaVersion: "1", id: randomUUID(), createdAt: new Date().toISOString(), maxSteps, maxDurationSeconds };
      planningProviderId = provider.id;
      planningModel = response.model;
    }
    candidate.goal = input.goal;
    candidate.steps = candidate.steps.map((step) => this.#normalizeStep(step, input.projectPath));
    this.#validatePlan(candidate, maxSteps, input.projectPath);
    const now = new Date().toISOString();
    const run: AgentRun = { id: randomUUID(), projectPath: input.projectPath, sessionId: input.sessionId, plan: candidate, providerId: planningProviderId, model: planningModel, status: "ready", stepJobs: {}, createdAt: now, updatedAt: now };
    await this.#persist(run);
    if (input.sessionId) await appendSessionEvent(input.projectPath, input.sessionId, { type: "plan", data: { runId: run.id, plan: candidate, providerId: run.providerId, model: run.model } });
    return run;
  }

  async execute(runOrId: AgentRun | string): Promise<AgentRun> {
    const run = typeof runOrId === "string" ? await this.get(runOrId) : runOrId;
    if (["succeeded", "cancelled"].includes(run.status)) return run;
    run.status = "running";
    await this.#persist(run);
    const deadline = Date.parse(run.createdAt) + (run.plan.maxDurationSeconds ?? 1_800) * 1_000;
    try {
      for (const step of topologicalSteps(run.plan.steps)) {
        if (Date.now() >= deadline) return this.#update(run, { status: "failed", error: "Agent run exceeded its time budget." });
        const existingJobId = run.stepJobs[step.id];
        if (existingJobId) {
          const existing = this.jobs.get(existingJobId);
          if (existing.status === "waiting-approval") return this.#update(run, { status: "waiting-approval" });
          if (["queued", "running"].includes(existing.status)) {
            const completed = await waitForJob(this.jobs, existing.id, deadline - Date.now());
            if (completed.status !== "succeeded") return this.#update(run, { status: "failed", error: completed.error ?? `Step ${step.id} failed.` });
          } else if (existing.status !== "succeeded") {
            return this.#update(run, { status: "failed", error: existing.error ?? `Step ${step.id} failed.` });
          }
          continue;
        }
        const job = await this.operations.invoke({
          projectPath: run.projectPath, sessionId: run.sessionId, operationId: step.operationId,
          arguments: step.arguments, artifactIds: this.#resolveStepArtifacts(run, step), publishArtifacts: true,
          provenanceRunId: run.id, model: run.model
        });
        run.stepJobs[step.id] = job.id;
        await this.#persist(run);
        if (job.status === "waiting-approval") return this.#update(run, { status: "waiting-approval" });
        const completed = await waitForJob(this.jobs, job.id, deadline - Date.now());
        if (completed.status !== "succeeded") return this.#update(run, { status: "failed", error: completed.error ?? `Step ${step.id} failed.` });
      }
      return this.#update(run, { status: "succeeded" });
    } catch (error) {
      return this.#update(run, { status: "failed", error: error instanceof Error ? error.message : String(error) });
    }
  }

  async approve(runId: string, stepId: string, decision: ApprovalDecision): Promise<AgentRun> {
    const run = await this.get(runId);
    const jobId = run.stepJobs[stepId];
    if (!jobId) throw new Error(`Step is not waiting for approval: ${stepId}`);
    await this.operations.decide(jobId, { ...decision, planId: run.plan.id, stepId: jobId });
    return this.execute(run);
  }

  async cancel(runId: string): Promise<AgentRun> {
    const run = await this.get(runId);
    await Promise.all(Object.values(run.stepJobs).map((jobId) => this.jobs.cancel(jobId).catch(() => undefined)));
    return this.#update(run, { status: "cancelled" });
  }

  async get(runId: string): Promise<AgentRun> {
    return JSON.parse(await readFile(path.join(this.dataRoot, "agent-runs", `${runId}.json`), "utf8")) as AgentRun;
  }

  #normalizeStep(step: AgentStep, projectPath: string): AgentStep {
    const operation = this.registry.get(step.operationId, this.operations.projects.extensionVersions(projectPath)).definition;
    const dependsOn = [...new Set([...(step.dependsOn ?? []), ...(step.inputFromSteps ?? [])])];
    return { ...step, dependsOn: dependsOn.length ? dependsOn : undefined, approvalRequired: ["network-egress", "external-side-effect", "privileged"].includes(operation.risk) };
  }

  #validatePlan(plan: AgentPlan, limit: number, projectPath: string): void {
    if (plan.steps.length > limit || plan.steps.length > plan.maxSteps) throw new Error(`Agent plan exceeds ${Math.min(limit, plan.maxSteps)} steps.`);
    const ids = new Set<string>();
    for (const step of plan.steps) {
      if (!step.id || ids.has(step.id)) throw new Error(`Duplicate or empty step id: ${step.id}`);
      ids.add(step.id);
      const operation = this.registry.get(step.operationId, this.operations.projects.extensionVersions(projectPath)).definition;
      if (!this.#availableOperations(projectPath).some((registered) => registered.definition.id === operation.id)) throw new Error(`Operation is not connected to this project: ${operation.id}`);
      if (operation.agentVisibility === "hidden") throw new Error(`Operation is hidden from the agent: ${operation.id}`);
      this.registry.validateInput(operation.id, step.arguments, this.operations.projects.extensionVersions(projectPath));
    }
    for (const step of plan.steps) {
      for (const dependency of step.dependsOn ?? []) if (!ids.has(dependency)) throw new Error(`Step ${step.id} depends on missing step ${dependency}.`);
      for (const source of step.inputFromSteps ?? []) if (!ids.has(source)) throw new Error(`Step ${step.id} reads artifacts from missing step ${source}.`);
    }
    topologicalSteps(plan.steps);
  }

  #resolveStepArtifacts(run: AgentRun, step: AgentStep): string[] | undefined {
    const artifactIds = new Set(step.inputArtifacts?.map((artifact) => artifact.artifactId) ?? []);
    for (const sourceStepId of step.inputFromSteps ?? []) {
      const jobId = run.stepJobs[sourceStepId];
      if (!jobId) throw new Error(`Source step has not run: ${sourceStepId}`);
      const sourceJob = this.jobs.get(jobId);
      if (sourceJob.status !== "succeeded") throw new Error(`Source step did not succeed: ${sourceStepId}`);
      for (const artifactId of sourceJob.artifactIds ?? []) artifactIds.add(artifactId);
    }
    return artifactIds.size ? [...artifactIds] : undefined;
  }

  #availableOperations(projectPath: string) {
    const project = this.operations.projects.get(projectPath);
    const enabled = new Set((project.manifest.extensions ?? []).filter((extension) => extension.enabled !== false).map((extension) => extension.id));
    return this.registry.list({ extensionVersions: this.operations.projects.extensionVersions(projectPath) }).filter((operation) => operation.extensionId === "osnova.builtin" || enabled.has(operation.extensionId));
  }

  async #update(run: AgentRun, patch: Partial<AgentRun>): Promise<AgentRun> {
    Object.assign(run, patch, { updatedAt: new Date().toISOString() });
    await this.#persist(run);
    return run;
  }

  async #persist(run: AgentRun): Promise<void> { await writeJsonAtomic(path.join(this.dataRoot, "agent-runs", `${run.id}.json`), run); }
}

function topologicalSteps(steps: AgentStep[]): AgentStep[] {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const result: AgentStep[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error("Agent plan contains a dependency cycle.");
    if (visited.has(id)) return;
    visiting.add(id);
    const step = byId.get(id);
    if (!step) throw new Error(`Missing step: ${id}`);
    for (const dependency of step.dependsOn ?? []) visit(dependency);
    visiting.delete(id); visited.add(id); result.push(step);
  };
  for (const step of steps) visit(step.id);
  return result;
}

function waitForJob(jobs: JobManager, jobId: string, timeoutMs = 1_800_000): Promise<JobDescriptor> {
  const terminal = new Set(["succeeded", "failed", "cancelled", "interrupted", "waiting-approval"]);
  const current = jobs.get(jobId);
  if (terminal.has(current.status)) return Promise.resolve(current);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      jobs.off("changed", changed);
      void jobs.cancel(jobId).catch(() => undefined);
      reject(new Error("Agent run exceeded its time budget."));
    }, Math.max(1, timeoutMs));
    timeout.unref?.();
    const changed = (job: JobDescriptor) => {
      if (job.id === jobId && terminal.has(job.status)) { clearTimeout(timeout); jobs.off("changed", changed); resolve(job); }
    };
    jobs.on("changed", changed);
  });
}

function agentPlanSchema(maxSteps: number): Record<string, unknown> {
  return {
    type: "object", required: ["goal", "steps"], additionalProperties: false,
    properties: {
      goal: { type: "string" },
      steps: { type: "array", maxItems: maxSteps, items: {
        type: "object", required: ["id", "operationId", "title", "arguments"], additionalProperties: false,
        properties: {
          id: { type: "string" }, operationId: { type: "string" }, title: { type: "string" }, arguments: { type: "object" },
          inputArtifacts: { type: "array", items: { type: "object", required: ["artifactId"], additionalProperties: false, properties: { artifactId: { type: "string" } } } },
          inputFromSteps: { type: "array", items: { type: "string" } }, dependsOn: { type: "array", items: { type: "string" } }, approvalRequired: { type: "boolean" }
        }
      } }
    }
  };
}

function assertPlanCandidate(value: unknown, maxSteps: number): asserts value is { goal: string; steps: AgentStep[] } {
  const validation = validateJsonSchema(agentPlanSchema(maxSteps), value);
  if (!validation.valid) throw new Error(`Model returned an invalid agent plan: ${validation.issues.join(" ")}`);
}
