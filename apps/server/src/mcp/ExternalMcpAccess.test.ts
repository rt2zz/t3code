import { expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthSessionId,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationThreadShell,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { EnvironmentAuth, ServerAuthInvalidCredentialError } from "../auth/EnvironmentAuth.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { McpInvocationContext } from "./McpInvocationContext.ts";
import { McpSessionRegistry } from "./McpSessionRegistry.ts";
import { __testing } from "./McpHttpServer.ts";
import { makeExternalMcpResolver } from "./ExternalMcpAccess.ts";

const threadId = ThreadId.make("chief");
const projectId = ProjectId.make("chief-project");
const thread: OrchestrationThreadShell = {
  id: threadId,
  projectId,
  title: "Chief",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  pullRequests: [],
  latestTurn: null,
  createdAt: "2026-09-17T00:00:00Z",
  updatedAt: "2026-09-17T00:00:00Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
};

const request = (id = threadId, token = "client-token") =>
  HttpServerRequest.fromWeb(
    new Request("http://server.test/mcp", {
      headers: { authorization: `Bearer ${token}`, "x-t3-thread-id": id },
    }),
  );

const makeHarness = Effect.gen(function* () {
  let revoked = false;
  let exists = true;
  let allowed = true;
  let settings: ServerSettings = {
    ...DEFAULT_SERVER_SETTINGS,
    enableAgentBrowserAccess: true,
    enableAgentDeviceAccess: false,
  };
  const layers = Layer.mergeAll(
    Layer.mock(McpSessionRegistry)({
      resolve: (token) =>
        Effect.succeed(
          token === "provider-token"
            ? {
                environmentId: EnvironmentId.make("chief-environment"),
                threadId: ThreadId.make("managed-thread"),
                providerSessionId: "managed-session",
                providerInstanceId: ProviderInstanceId.make("codex"),
                capabilities: new Set(["preview"] as const),
                issuedAt: 1,
              }
            : undefined,
        ),
    }),
    Layer.mock(EnvironmentAuth)({
      authenticateHttpRequest: (req) =>
        revoked || req.headers.authorization !== "Bearer client-token"
          ? Effect.fail(new ServerAuthInvalidCredentialError({}))
          : Effect.succeed({
              sessionId: AuthSessionId.make("chief-client"),
              subject: "chief",
              method: "bearer-access-token" as const,
              scopes: allowed ? [AuthOrchestrationOperateScope] : [],
            }),
    }),
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadShellById: (id) =>
        Effect.sync(() => (exists && id === threadId ? Option.some(thread) : Option.none())),
    }),
    Layer.mock(ServerSettingsService)({ getSettings: Effect.sync(() => settings) }),
    Layer.mock(ServerEnvironment)({
      getEnvironmentId: Effect.succeed(EnvironmentId.make("chief-environment")),
    }),
  );
  const resolve = yield* makeExternalMcpResolver.pipe(Effect.provide(layers));
  const middleware = yield* __testing.makeMcpAuthMiddleware.pipe(Effect.provide(layers));
  return {
    resolve,
    authenticate: (req: HttpServerRequest.HttpServerRequest) =>
      middleware(
        McpInvocationContext.pipe(
          Effect.map((scope) =>
            HttpServerResponse.empty({
              status: 204,
              headers: { "x-thread-id": scope.threadId },
            }),
          ),
        ),
      ).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, req)),
    reconnect: () => makeExternalMcpResolver.pipe(Effect.provide(layers)),
    revoke: () => {
      revoked = true;
    },
    deleteThread: () => {
      exists = false;
    },
    deny: () => {
      allowed = false;
    },
    overrideSettings: (next: ServerSettings) => {
      settings = next;
    },
  };
});

it.effect("binds an external client to an existing thread without a provider session", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    const scope = yield* harness.resolve(request());
    expect(scope?.threadId).toBe(threadId);
    expect(scope?.providerInstanceId).toBe("external");
    expect([...scope!.capabilities]).toEqual(["pull-requests", "preview"]);
    const reconnected = yield* harness.reconnect();
    expect((yield* reconnected(request()))?.providerSessionId).toBe(scope?.providerSessionId);
    expect(yield* harness.resolve(request(ThreadId.make("other-thread")))).toBeUndefined();
  }),
);

it.effect("rechecks credentials and thread existence on subsequent requests", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    expect(yield* harness.resolve(request())).toBeDefined();
    harness.revoke();
    expect(yield* harness.resolve(request()).pipe(Effect.flip)).toBeInstanceOf(
      ServerAuthInvalidCredentialError,
    );
    const deleted = yield* makeHarness;
    expect(yield* deleted.resolve(request())).toBeDefined();
    deleted.deleteThread();
    expect(yield* deleted.resolve(request())).toBeUndefined();
  }),
);

it.effect("requires an operate scope and explicit bearer credential", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    harness.deny();
    expect(yield* harness.resolve(request())).toBeUndefined();
    expect(
      yield* harness.resolve(
        HttpServerRequest.fromWeb(
          new Request("http://server.test/mcp", {
            headers: { "x-t3-thread-id": threadId, cookie: "t3=some-cookie" },
          }),
        ),
      ),
    ).toBeUndefined();
    expect(
      yield* harness.resolve(request(threadId, "wrong-token")).pipe(Effect.flip),
    ).toBeInstanceOf(ServerAuthInvalidCredentialError);
  }),
);

it.effect("honors live project browser and device overrides", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    expect((yield* harness.resolve(request()))?.capabilities.has("preview")).toBe(true);
    harness.overrideSettings({
      ...DEFAULT_SERVER_SETTINGS,
      enableAgentBrowserAccess: true,
      enableAgentDeviceAccess: false,
      projectSettingsOverrides: {
        [projectId]: { enableAgentBrowserAccess: false, enableAgentDeviceAccess: true },
      },
    });
    expect([...(yield* harness.resolve(request()))!.capabilities]).toEqual([
      "pull-requests",
      "device",
    ]);
  }),
);

it.effect("selects external authentication explicitly and preserves provider token scope", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    const external = yield* harness.authenticate(request());
    expect(external.status).toBe(204);
    expect(external.headers["x-thread-id"]).toBe(threadId);
    const managed = yield* harness.authenticate(
      HttpServerRequest.fromWeb(
        new Request("http://server.test/mcp", {
          headers: { authorization: "Bearer provider-token" },
        }),
      ),
    );
    expect(managed.status).toBe(204);
    expect(managed.headers["x-thread-id"]).toBe("managed-thread");
    // A managed provider cannot select another thread by adding the external header.
    expect((yield* harness.authenticate(request(threadId, "provider-token"))).status).toBe(401);
    expect((yield* harness.authenticate(request(ThreadId.make("missing")))).status).toBe(401);
    const noThreadHeader = HttpServerRequest.fromWeb(
      new Request("http://server.test/mcp", {
        headers: { authorization: "Bearer client-token" },
      }),
    );
    expect((yield* harness.authenticate(noThreadHeader)).status).toBe(401);
    harness.revoke();
    expect((yield* harness.authenticate(request())).status).toBe(401);
  }),
);
