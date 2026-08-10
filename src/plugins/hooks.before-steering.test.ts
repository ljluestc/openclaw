/** Tests for the `before_steering` plugin hook — sticky-block merge, fail-closed posture, modifiedPrompt semantics. */
import { describe, expect, it, vi } from "vitest";
import type { GlobalHookRunnerRegistry } from "./hook-registry.types.js";
import type {
  PluginHookAgentContext,
  PluginHookBeforeSteeringEvent,
  PluginHookRegistration,
} from "./hook-types.js";
import { createHookRunner } from "./hooks.js";

function makeRegistry(hooks: PluginHookRegistration[] = []): GlobalHookRunnerRegistry {
  return {
    hooks: [],
    typedHooks: hooks,
    plugins: [],
  };
}

const ctx: PluginHookAgentContext = {
  runId: "run-1",
  agentId: "agent-1",
  sessionKey: "session-1",
  sessionId: "sid-1",
};

const event: PluginHookBeforeSteeringEvent = {
  prompt: "look at this steering payload",
  sessionKey: "session-1",
  sessionId: "sid-1",
  queueMode: "steer",
  steeringMode: "all",
};

describe("before_steering hook", () => {
  it("returns undefined when no handlers registered", async () => {
    const runner = createHookRunner(makeRegistry());
    const result = await runner.runBeforeSteering(event, ctx);
    expect(result).toBeUndefined();
  });

  it("returns no block when no handler returns a result", async () => {
    const registry = makeRegistry([
      {
        pluginId: "audit",
        hookName: "before_steering",
        handler: async () => undefined,
        source: "test",
      },
    ]);
    const runner = createHookRunner(registry);
    const result = await runner.runBeforeSteering(event, ctx);
    expect(result).toBeUndefined();
  });

  it("returns modified prompt when a handler rewrites it", async () => {
    const registry = makeRegistry([
      {
        pluginId: "redactor",
        hookName: "before_steering",
        handler: async () => ({ modifiedPrompt: "[redacted]" }),
        source: "test",
      },
    ]);
    const runner = createHookRunner(registry);
    const result = await runner.runBeforeSteering(event, ctx);
    expect(result?.block).toBeUndefined();
    expect(result?.modifiedPrompt).toBe("[redacted]");
  });

  it("returns block when a handler blocks", async () => {
    const registry = makeRegistry([
      {
        pluginId: "security",
        hookName: "before_steering",
        handler: async () => ({ block: true, blockReason: "prompt injection" }),
        source: "test",
      },
    ]);
    const runner = createHookRunner(registry);
    const result = await runner.runBeforeSteering(event, ctx);
    expect(result?.block).toBe(true);
    expect(result?.blockReason).toBe("prompt injection");
  });

  it("sticky-block: once any handler blocks, later handlers cannot unblock", async () => {
    const blockHandler = vi.fn(async () => ({ block: true, blockReason: "first" }));
    const unblockHandler = vi.fn(async () => ({ block: false }));
    const registry = makeRegistry([
      {
        pluginId: "blocker",
        hookName: "before_steering",
        handler: blockHandler,
        source: "test",
        priority: 10,
      },
      {
        pluginId: "would-unblock",
        hookName: "before_steering",
        handler: unblockHandler,
        source: "test",
        priority: 5,
      },
    ]);
    const runner = createHookRunner(registry);
    const result = await runner.runBeforeSteering(event, ctx);
    expect(result?.block).toBe(true);
    expect(result?.blockReason).toBe("first");
    expect(blockHandler).toHaveBeenCalledTimes(1);
    // shouldStop kicks in for blocking handlers; later handlers don't execute.
    expect(unblockHandler).not.toHaveBeenCalled();
  });

  it("priority ordering: higher priority runs first; modifications chain last-defined-wins", async () => {
    const calls: string[] = [];
    const firstHandler = vi.fn(async () => {
      calls.push("first");
      return { modifiedPrompt: "[v1]" };
    });
    const secondHandler = vi.fn(async () => {
      calls.push("second");
      return { modifiedPrompt: "[v2]" };
    });
    const registry = makeRegistry([
      {
        pluginId: "first",
        hookName: "before_steering",
        handler: firstHandler,
        source: "test",
        priority: 20,
      },
      {
        pluginId: "second",
        hookName: "before_steering",
        handler: secondHandler,
        source: "test",
        priority: 10,
      },
    ]);
    const runner = createHookRunner(registry);
    const result = await runner.runBeforeSteering(event, ctx);
    expect(calls).toEqual(["first", "second"]);
    // Last-defined modifiedPrompt wins — matches the existing before_install
    // / before_agent_finalize merge contract.
    expect(result?.modifiedPrompt).toBe("[v2]");
    expect(result?.block).toBeUndefined();
  });

  it("fail-closed: a throwing handler raises instead of silently passing", async () => {
    const registry = makeRegistry([
      {
        pluginId: "throws",
        hookName: "before_steering",
        handler: async () => {
          throw new Error("plugin crashed");
        },
        source: "test",
      },
    ]);
    const runner = createHookRunner(registry);
    await expect(runner.runBeforeSteering(event, ctx)).rejects.toThrow(/plugin crashed/);
  });
});
