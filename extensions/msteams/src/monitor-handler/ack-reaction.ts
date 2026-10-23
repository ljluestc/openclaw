import { resolveAckReaction, shouldAckReaction } from "openclaw/plugin-sdk/channel-feedback";
import type { OpenClawConfig } from "../../runtime-api.js";
import { resolveMSTeamsAccountConfig } from "../accounts.js";
import { formatUnknownError } from "../errors.js";
import { reactMessageMSTeams } from "../graph-messages.js";

/**
 * Resolve the Graph target for an automatic acknowledgement, or undefined when
 * Teams cannot address the inbound message unambiguously.
 *
 * Channel messages need the explicit `teamId/channelId` pair (an opaque channel
 * conversation id would resolve as a chat). Chats need a Graph-native `19:` id;
 * Bot Framework personal-chat ids (`a:...`) are not accepted by Graph.
 */
function resolveMSTeamsAckTarget(params: {
  isChannel: boolean;
  conversationId: string;
  nativeChannelId: string | undefined;
}): string | undefined {
  if (params.isChannel) {
    return params.nativeChannelId;
  }
  return params.conversationId.startsWith("19:")
    ? `conversation:${params.conversationId}`
    : undefined;
}

/**
 * Best-effort acknowledgement for an admitted Teams turn, using the shared
 * `messages.ackReaction` / `messages.ackReactionScope` policy.
 *
 * Graph `setReaction` supports delegated permissions only, so automatic acks
 * require `delegatedAuth.enabled`; without it every attempt would fail. The
 * reaction is attributed to the delegated user. Failures never block the turn.
 */
export function maybeSendMSTeamsAckReaction(params: {
  cfg: OpenClawConfig;
  accountId: string;
  agentId: string;
  isDirectMessage: boolean;
  isChannel: boolean;
  conversationId: string;
  nativeChannelId: string | undefined;
  messageId: string | undefined;
  threadRootId: string | undefined;
  wasMentioned: boolean;
  logVerbose: (message: string) => void;
}): void {
  if (!params.messageId) {
    return;
  }
  if (!resolveMSTeamsAccountConfig(params.cfg, params.accountId).delegatedAuth?.enabled) {
    return;
  }
  const reactionType = resolveAckReaction(params.cfg, params.agentId, {
    channel: "msteams",
    accountId: params.accountId,
  });
  if (
    !reactionType ||
    !shouldAckReaction({
      scope: params.cfg.messages?.ackReactionScope,
      isDirect: params.isDirectMessage,
      isGroup: !params.isDirectMessage,
      isMentionableGroup: !params.isDirectMessage,
      canDetectMention: true,
      effectiveWasMentioned: params.wasMentioned,
    })
  ) {
    return;
  }
  const to = resolveMSTeamsAckTarget(params);
  if (!to) {
    params.logVerbose("msteams: skipping ack reaction (conversation has no Graph message target)");
    return;
  }
  void reactMessageMSTeams({
    cfg: params.cfg,
    accountId: params.accountId,
    to,
    messageId: params.messageId,
    threadRootId: params.threadRootId,
    reactionType,
  }).catch((err: unknown) => {
    params.logVerbose(`msteams: ack reaction failed: ${formatUnknownError(err)}`);
  });
}
