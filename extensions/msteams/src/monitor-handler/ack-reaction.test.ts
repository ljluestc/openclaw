import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../runtime-api.js";
import { maybeSendMSTeamsAckReaction } from "./ack-reaction.js";

const reactMessageMSTeams = vi.hoisted(() => vi.fn());

vi.mock("../graph-messages.js", () => ({ reactMessageMSTeams }));

function buildCfg(overrides?: {
  delegatedAuth?: boolean;
  ackReactionScope?: NonNullable<OpenClawConfig["messages"]>["ackReactionScope"];
}): OpenClawConfig {
  return {
    messages: {
      ackReaction: "like",
      ...(overrides?.ackReactionScope ? { ackReactionScope: overrides.ackReactionScope } : {}),
    },
    channels: {
      msteams: {
        appId: "app-id",
        delegatedAuth: { enabled: overrides?.delegatedAuth ?? true },
      },
    },
  } as OpenClawConfig;
}

function send(
  cfg: OpenClawConfig,
  overrides: Partial<Parameters<typeof maybeSendMSTeamsAckReaction>[0]> = {},
) {
  const logVerbose = vi.fn();
  maybeSendMSTeamsAckReaction({
    cfg,
    accountId: "default",
    agentId: "main",
    isDirectMessage: false,
    isChannel: false,
    conversationId: "19:group@thread.v2",
    nativeChannelId: undefined,
    messageId: "msg-1",
    threadRootId: undefined,
    wasMentioned: true,
    logVerbose,
    ...overrides,
  });
  return { logVerbose };
}

describe("maybeSendMSTeamsAckReaction", () => {
  beforeEach(() => {
    reactMessageMSTeams.mockReset().mockResolvedValue({ ok: true });
  });

  it("acks a mentioned group chat message through its Graph chat target", () => {
    const cfg = buildCfg();
    send(cfg);
    expect(reactMessageMSTeams).toHaveBeenCalledWith({
      cfg,
      accountId: "default",
      to: "conversation:19:group@thread.v2",
      messageId: "msg-1",
      threadRootId: undefined,
      reactionType: "like",
    });
  });

  it("addresses channel replies with the team/channel pair and thread root", () => {
    send(buildCfg(), {
      isChannel: true,
      conversationId: "19:channel@thread.tacv2",
      nativeChannelId: "team-aad/19:channel@thread.tacv2",
      threadRootId: "root-1",
    });
    expect(reactMessageMSTeams).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "team-aad/19:channel@thread.tacv2",
        messageId: "msg-1",
        threadRootId: "root-1",
      }),
    );
  });

  it("skips targets Graph cannot address", () => {
    const channel = send(buildCfg(), { isChannel: true, nativeChannelId: undefined });
    send(buildCfg({ ackReactionScope: "direct" }), {
      isDirectMessage: true,
      conversationId: "a:bot-framework-dm",
    });
    expect(reactMessageMSTeams).not.toHaveBeenCalled();
    expect(channel.logVerbose).toHaveBeenCalledWith(
      expect.stringContaining("no Graph message target"),
    );
  });

  it("requires delegated auth and the shared scope decision", () => {
    send(buildCfg({ delegatedAuth: false }));
    send(buildCfg(), { wasMentioned: false });
    send(buildCfg({ ackReactionScope: "off" }));
    expect(reactMessageMSTeams).not.toHaveBeenCalled();
  });

  it("treats reaction failures as non-fatal", async () => {
    reactMessageMSTeams.mockRejectedValue(new Error("Forbidden"));
    const { logVerbose } = send(buildCfg());
    await Promise.resolve();
    await Promise.resolve();
    expect(logVerbose).toHaveBeenCalledWith(expect.stringContaining("Forbidden"));
  });
});
