import {
  AuthOrchestrationOperateScope,
  ExternalMcpHeaders,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpServerRequest } from "effect/http";

import { EnvironmentAuth } from "../auth/EnvironmentAuth.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import type { McpCapability, McpInvocationScope } from "./McpInvocationContext.ts";

const decodeHeaders = Schema.decodeUnknownEffect(ExternalMcpHeaders);

/** External clients explicitly select a thread and authenticate on every MCP request. */
export const makeExternalMcpResolver = Effect.gen(function* () {
  const auth = yield* EnvironmentAuth;
  const threads = yield* ThreadManagementService;
  const settingsService = yield* ServerSettingsService;
  const environment = yield* ServerEnvironment;
  return Effect.fn("ExternalMcpAccess.resolve")(function* (
    request: HttpServerRequest.HttpServerRequest,
  ) {
    if (!request.headers.authorization?.startsWith("Bearer ")) return undefined;
    const headers = yield* decodeHeaders(request.headers);
    const threadId = headers["x-t3-thread-id"];
    const session = yield* auth.authenticateHttpRequest(request);
    if (!session.scopes.includes(AuthOrchestrationOperateScope)) return undefined;
    const thread = yield* threads.getThreadShell(threadId);
    if (thread === null || thread.deletedAt !== null) return undefined;
    const settings = resolveProjectSettings(
      yield* settingsService.getSettings,
      thread.projectId,
    ).settings;
    // The same tools a provider in this thread gets.
    const capabilities = new Set<McpCapability>(["orchestration", "worktree", "pull-requests"]);
    if (settings.enableAgentBrowserAccess) capabilities.add("preview");
    if (settings.enableAgentDeviceAccess) capabilities.add("device");
    // Stable across HTTP requests and reconnects, distinct from managed providers.
    const providerSessionId = `external:${encodeURIComponent(session.sessionId)}:${encodeURIComponent(threadId)}`;
    return {
      environmentId: yield* environment.getEnvironmentId,
      capabilities,
      issuedAt: yield* Clock.currentTimeMillis,
      requestNamespace: providerSessionId,
      thread: {
        threadId,
        providerSessionId,
        providerInstanceId: ProviderInstanceId.make("external"),
      },
      client: undefined,
    } satisfies McpInvocationScope;
  });
});

/**
 * Optional on `/mcp`, like `McpClientAuthenticator`: without it a request
 * carrying X-T3-Thread-Id is refused. Any failure resolves to no access.
 */
export class ExternalMcpResolver extends Context.Service<
  ExternalMcpResolver,
  {
    readonly resolve: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<McpInvocationScope | undefined>;
  }
>()("t3/mcp/ExternalMcpAccess/ExternalMcpResolver") {}

export const layer = Layer.effect(
  ExternalMcpResolver,
  Effect.map(makeExternalMcpResolver, (resolve) =>
    ExternalMcpResolver.of({
      resolve: (request) => resolve(request).pipe(Effect.orElseSucceed(() => undefined)),
    }),
  ),
);
