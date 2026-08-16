// Feishu plugin module implements poll-vote card-action handling.
//
// The Feishu card-action webhook delivers a JSON envelope whose `action`
// matches `FEISHU_POLL_VOTE_ACTION`. We:
//   1. Verify the option id is valid for the named poll.
//   2. Dedup the vote using `poll-store.ts` (last-vote-wins for
//      single-choice, additive for multi-choice).
//   3. Re-render the card with the fresh tally and PATCH it in-place via
//      Feishu's `im/v1/messages/{message_id}` PATCH endpoint.
//
// Errors and unknowns fall through to the standard "invalid interaction"
// notice sent by `card-action.ts`.
import { asDateTimestampMs } from "openclaw/plugin-sdk/number-runtime";
import type { PluginRuntime, ClawdbotConfig, RuntimeEnv } from "../runtime-api.js";
import { resolveFeishuRuntimeAccount } from "./accounts.js";
import type { FeishuCardActionEvent } from "./card-action.js";
import { createFeishuClient } from "./client.js";
import {
  buildFeishuPollCard,
  type FeishuPollDefinition,
  type FeishuPollOption,
} from "./poll-card.js";
import {
  closeFeishuPoll,
  isFeishuPollRegistered,
  readFeishuPollDefinition,
  readFeishuPollTotals,
  recordFeishuPollVote,
  type FeishuPollVoteTotals,
} from "./poll-store.js";
import { sendCardFeishu, sendMessageFeishu } from "./send.js";

/**
 * Derive (or look up) the `FeishuPollDefinition` for an incoming card-action
 * event. The webhook payload only encodes the option id; the card itself
 * was originally posted via `poll-adapter.ts` so the registry in
 * `poll-store.ts` already holds the canonical definition.
 */
export function buildFeishuPollDefinitionFromCard(
  event: FeishuCardActionEvent,
): FeishuPollDefinition | null {
  const raw = event.action.value as Record<string, unknown> | undefined;
  const optionId = resolvePollOptionId(raw);
  if (!optionId) {
    return null;
  }
  // We still need the poll id. The envelope's `p.pollId` field (added by
  // `poll-card.ts`) is the source of truth for the live poll.
  const pollId = typeof raw?.pollId === "string" ? (raw.pollId as string) : "";
  if (!pollId) {
    return null;
  }
  void optionId; // accepted by caller via readFeishuPollDefinition → pollId match
  return readFeishuPollDefinition(pollId) ?? null;
}

function resolvePollOptionId(raw?: Record<string, unknown>): string | undefined {
  if (!raw) {
    return undefined;
  }
  if (typeof raw.optionId === "string") {
    return raw.optionId;
  }
  const p = raw.p as Record<string, unknown> | undefined;
  if (p && typeof p.id === "string") {
    return p.id;
  }
  return undefined;
}

export const FEISHU_POLL_VOTE_ACTION = "feishu.poll.vote";

type ParsedPollCallback =
  | {
      kind: "valid";
      pollId: string;
      optionId: string;
    }
  | {
      kind: "invalid";
      reason: "malformed" | "unknown_poll" | "unknown_option";
    };

function parsePollCallbackValue(value: unknown): ParsedPollCallback {
  if (!value || typeof value !== "object") {
    return { kind: "invalid", reason: "malformed" };
  }
  const record = value as Record<string, unknown>;
  const pollId = readPollCallbackField(record, "pollId");
  const optionId = readPollCallbackField(record, "optionId");
  if (!pollId || !optionId) {
    return { kind: "invalid", reason: "malformed" };
  }
  return { kind: "valid", pollId, optionId };
}

function readPollCallbackField(record: Record<string, unknown>, key: string): string {
  const top = record[key];
  if (typeof top === "string") {
    const trimmed = top.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  const p = record.p as Record<string, unknown> | undefined;
  if (p) {
    const nested = p[key];
    if (typeof nested === "string") {
      const trimmed = nested.trim();
      if (trimmed) {
        return trimmed;
      }
    }
  }
  return "";
}

export async function handleFeishuPollVote(params: {
  cfg: ClawdbotConfig;
  event: FeishuCardActionEvent;
  definition: FeishuPollDefinition;
  accountId?: string;
  runtime?: RuntimeEnv;
  channelRuntime?: PluginRuntime["channel"];
}): Promise<void> {
  const parsed = parsePollCallbackValue(
    (params.event.action.value as Record<string, unknown> | undefined)?.p ??
      params.event.action.value,
  );
  if (parsed.kind !== "valid") {
    throw new Error(`Invalid Feishu poll callback: ${parsed.reason}`);
  }
  if (!isFeishuPollRegistered(parsed.pollId) || parsed.pollId !== params.definition.pollId) {
    throw new Error(`Poll not registered: ${parsed.pollId}`);
  }
  if (!params.definition.options.some((option) => option.id === parsed.optionId)) {
    throw new Error(`Unknown option: ${parsed.optionId}`);
  }

  const result = recordFeishuPollVote({
    pollId: parsed.pollId,
    optionIds: [parsed.optionId],
    voterId: params.event.operator.open_id,
    multiSelect: params.definition.maxSelections > 1,
  });
  if (!result.accepted) {
    await sendMessageFeishu({
      cfg: params.cfg,
      to: resolveCallbackTarget(params.event),
      text: "⚠️ Vote could not be recorded (vote limit reached).",
      accountId: params.accountId,
    });
    return;
  }

  await patchPollCardWithTotals({
    cfg: params.cfg,
    event: params.event,
    definition: params.definition,
    totals: result.totals,
    accountId: params.accountId,
  });
}

function resolveCallbackTarget(event: FeishuCardActionEvent): string {
  const chatId = event.context.chat_id?.trim();
  if (chatId) {
    return `chat:${chatId}`;
  }
  return `user:${event.operator.open_id}`;
}

async function patchPollCardWithTotals(params: {
  cfg: ClawdbotConfig;
  event: FeishuCardActionEvent;
  definition: FeishuPollDefinition;
  totals: FeishuPollVoteTotals;
  accountId?: string;
}): Promise<void> {
  const messageId = params.event.open_message_id ?? params.event.context.open_message_id;
  if (!messageId?.trim()) {
    // Fallback: re-send a tally card. Preserves UX even when the original
    // webhook omitted the message id we need for PATCH.
    await resendClosedTallyCard(params);
    return;
  }

  const account = resolveFeishuRuntimeAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  const rendered = buildFeishuPollCard({
    definition: params.definition,
    totals: params.totals,
  });
  // Card Kit allows updating the body of a delivered card via a PATCH call
  // on the originating message id. We use the documented `update_message`
  // endpoint shape: { body: { elements } } applied to the `body`.
  const validNow = typeof params.event.token === "string" ? params.event.token : undefined;
  if (validNow === undefined) {
    await resendClosedTallyCard(params);
    return;
  }
  try {
    await createFeishuClient(account).im.v1.message.patch({
      path: { message_id: messageId },
      data: {
        content: {
          // Card 2.0 patch payload shape.
          type: "card",
          data: rendered.card,
        },
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    // Fallback: resend a closed tally card so the user still sees the result.
    if (asDateTimestampMs(Date.now()) !== undefined) {
      await resendClosedTallyCard(params);
      return;
    }
    throw new Error(`Failed to patch poll card (${message}); tally card sent.`);
  }
}

async function resendClosedTallyCard(params: {
  cfg: ClawdbotConfig;
  event: FeishuCardActionEvent;
  definition: FeishuPollDefinition;
  totals: FeishuPollVoteTotals;
  accountId?: string;
}): Promise<void> {
  const rendered = buildFeishuPollCard({
    definition: params.definition,
    totals: params.totals,
    closed: true,
  });
  await sendCardFeishu({
    cfg: params.cfg,
    to: resolveCallbackTarget(params.event),
    card: rendered.card,
    accountId: params.accountId,
  });
}

export type { FeishuPollDefinition, FeishuPollOption };

export async function closeFeishuPollAndAnnounce(params: {
  cfg: ClawdbotConfig;
  event: FeishuCardActionEvent;
  definition: FeishuPollDefinition;
  accountId?: string;
}): Promise<void> {
  const totals =
    closeFeishuPoll(params.definition.pollId) ??
    readFeishuPollTotals(params.definition.pollId) ??
    {};
  const rendered = buildFeishuPollCard({
    definition: params.definition,
    totals,
    closed: true,
  });
  await sendCardFeishu({
    cfg: params.cfg,
    to: resolveCallbackTarget(params.event),
    card: rendered.card,
    accountId: params.accountId,
  });
}
