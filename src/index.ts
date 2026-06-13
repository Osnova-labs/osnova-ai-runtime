import { createServer } from "node:http";

export interface RuntimeStatus {
  name: "osnova-ai-runtime";
  version: string;
  status: "ready";
  capabilities: string[];
}

export function getRuntimeStatus(): RuntimeStatus {
  return {
    name: "osnova-ai-runtime",
    version: "0.1.0",
    status: "ready",
    capabilities: []
  };
}

export function startRuntime(port = Number(process.env.OSNOVA_AI_RUNTIME_PORT ?? 8717)): void {
  const server = createServer((request, response) => {
    if (request.url === "/health" || request.url === "/v1/status") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(getRuntimeStatus()));
      return;
    }

    response.statusCode = 404;
    response.end("Not Found");
  });

  server.listen(port, "127.0.0.1", () => {
    process.stdout.write(`osnova-ai-runtime listening on 127.0.0.1:${port}\n`);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startRuntime();
}
