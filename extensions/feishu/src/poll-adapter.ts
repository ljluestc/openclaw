// Feishu plugin module implements the poll outbound adapter.
//
// The ChannelOutboundAdapter.sendPoll hook in `src/channels/plugins/outbound.types.ts`
// routes both:
//   * Core's `create_poll` tool when the Feishu channel is the active
//     destination, and
//   * The shared `message` tool when its `action: "poll"` synonym is used.
//
// Both call sites expect a `ChannelPollResult`. We deliver the poll by
// posting a Card 2.0 message (built in `poll-card.ts`), registering the
// poll id in `poll-store.ts`, and returning the originating message id so
// inbound vote callbacks can update the card in-place via the
// `card.action.trigger` webhook.
import type {
  ChannelPollContext,
  ChannelPollResult,
} from "../../../../src/channels/plugins/types.core.js";
import { resolveFeishuAccount } from "./accounts.js";
import {
  assertFeishuPollDefinition,
  buildFeishuPollCard,
  FEISHU_POLL_VOTE_ACTION,
  type FeishuPollDefinition,
  type FeishuPollOption,
} from "./poll-card.js";
import { newFeishuPollId, registerFeishuPoll } from "./poll-store.js";
import { sendCardFeishu } from "./send.js";

export type SendPollFeishuParams = ChannelPollContext["poll"];

export type FeishuChannelPollResult = ChannelPollResult;

type FeishuPollInput = {
  question: string;
  options: string[];
  maxSelections?: number;
  /** Honor the shared "multi" flag from the message tool schema. */
  multi?: boolean;
  closesAt?: string;
};

function toFeishuPollDefinition(input: FeishuPollInput): FeishuPollDefinition {
  const optionLabels = input.options.map((option) => option.trim()).filter(Boolean);
  if (optionLabels.length !== input.options.length) {
    throw new Error("Feishu poll options must be non-empty strings.");
  }
  const maxSelections =
    typeof input.maxSelections === "number"
      ? Math.floor(input.maxSelections)
      : input.multi === true
        ? Math.max(2, optionLabels.length)
        : 1;
  const definition: FeishuPollDefinition = {
    pollId: newFeishuPollId(),
    question: input.question.trim(),
    options: optionLabels.map((label, index) => ({
      id: `opt-${index + 1}`,
      label,
    })),
    maxSelections,
  };
  if (input.closesAt) {
    definition.closesAt = input.closesAt;
  }
  return definition;
}

export async function sendPollFeishu(ctx: ChannelPollContext): Promise<FeishuChannelPollResult> {
  const account = resolveFeishuAccount({
    cfg: ctx.cfg,
    accountId: ctx.accountId ?? undefined,
  });
  const definition = toFeishuPollDefinition(ctx.poll as FeishuPollInput);
  assertFeishuPollDefinition(definition);
  registerFeishuPoll({
    pollId: definition.pollId,
    optionIds: definition.options.map((option) => option.id),
    definition,
  });
  const rendered = buildFeishuPollCard({ definition });
  const result = await sendCardFeishu({
    cfg: ctx.cfg,
    to: ctx.to,
    card: rendered.card,
    accountId: ctx.accountId ?? account.accountId,
  });
  return {
    ...result,
    pollId: definition.pollId,
  };
}

export const _FEISHU_POLL_VOTE_ACTION_FOR_TESTS = FEISHU_POLL_VOTE_ACTION;

export type { FeishuPollDefinition, FeishuPollOption };
