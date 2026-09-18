import {
  AuthOrchestrationOperateScope,
  ExternalMcpHeaders,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpServerRequest } from "effect/unstable/http";

import { EnvironmentAuth } from "../auth/EnvironmentAuth.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import type { McpCapability, McpInvocationScope } from "./McpInvocationContext.ts";

const decodeHeaders = Schema.decodeUnknownEffect(ExternalMcpHeaders);

/** External clients explicitly select a thread and authenticate on every MCP request. */
export const makeExternalMcpResolver = Effect.gen(function* () {
  const auth = yield* EnvironmentAuth;
  const query = yield* ProjectionSnapshotQuery;
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
    const thread = yield* query.getThreadShellById(threadId);
    if (Option.isNone(thread)) return undefined;
    const settings = resolveProjectSettings(
      yield* settingsService.getSettings,
      thread.value.projectId,
    ).settings;
    const capabilities = new Set<McpCapability>(["pull-requests"]);
    if (settings.enableAgentBrowserAccess) capabilities.add("preview");
    if (settings.enableAgentDeviceAccess) capabilities.add("device");
    return {
      environmentId: yield* environment.getEnvironmentId,
      threadId,
      // Stable across HTTP requests and reconnects, distinct from managed providers.
      providerSessionId: `external:${encodeURIComponent(session.sessionId)}:${encodeURIComponent(threadId)}`,
      providerInstanceId: ProviderInstanceId.make("external"),
      capabilities,
      issuedAt: yield* Clock.currentTimeMillis,
    } satisfies McpInvocationScope;
  });
});
