// Feishu plugin module implements poll card rendering.
//
// Polls in Feishu are rendered as Card 2.0 messages: a markdown question, a
// `divider`, one button per option, and an aggregate footer that displays the
// running tally. Each button click is dispatched via Feishu's
// `card.action.trigger` webhook — see `card-action.ts` and `poll-action.ts`
// for the vote-recording, card-update, and dedup flow.
//
// Card invariants:
//   * `schema` is fixed at "2.0".
//   * Buttons use a `callback` behavior whose value is the
//     `FEISHU_POLL_VOTE_ACTION` envelope (decoded by `poll-action.ts`).
//   * Once anyone has voted, the option row is replaced by a static
//     markdown block with current counts (and the buttons are hidden) to
//     match Feishu's `FEISHU_CARD_MAX_ELEMENTS` budget across tallies.

import { assertFeishuCardWithinEnvelope } from "./presentation-card.js";

const FEISHU_POLL_MAX_OPTIONS = 12;

export type FeishuPollVoteTotals = Readonly<Record<string, number>>;

export type FeishuPollOption = {
  /** Stable id used in the button callback value. */
  id: string;
  /** User-visible label rendered as a plain-text button label. */
  label: string;
};

export type FeishuPollDefinition = {
  pollId: string;
  question: string;
  options: FeishuPollOption[];
  /** 1 for single-choice, >1 for multiple choice. */
  maxSelections: number;
  /** Optional closing ISO-8601 timestamp displayed as the footer note. */
  closesAt?: string;
};

export type FeishuPollCard = {
  pollId: string;
  maxSelections: number;
  totalVotes: number;
  card: Record<string, unknown>;
  fallbackText: string;
};

function escapeFeishuPollOptionLabel(label: string): string {
  return label.replace(/[&<>]/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      default:
        return char;
    }
  });
}

function countFeishuPollVotes(
  optionIds: string[],
  totals: FeishuPollVoteTotals | undefined,
): FeishuPollVoteTotals {
  if (!totals) {
    return Object.fromEntries(optionIds.map((optionId) => [optionId, 0]));
  }
  // Coerce missing entries to 0 so the footer line is never undefined.
  return Object.fromEntries(
    optionIds.map((optionId) => [optionId, Math.max(0, totals[optionId] ?? 0)]),
  );
}

function buildFeishuPollQuestionBlock(question: string): Record<string, unknown> {
  return {
    tag: "markdown",
    content:
      `<font color='grey'>📊 Poll</font>\n\n` + `**${escapeFeishuPollOptionLabel(question)}**`,
  };
}

function buildFeishuPollDivider(): Record<string, unknown> {
  return { tag: "hr" };
}

function buildFeishuPollOptionButtons(
  options: FeishuPollOption[],
  pollId: string,
): Record<string, unknown>[] {
  return options.map((option) => ({
    tag: "button",
    text: {
      tag: "plain_text",
      content: escapeFeishuPollOptionLabel(option.label),
    },
    type: "default",
    size: "medium",
    // Flat pollId + optionId at the top level keeps the webhook handler in
    // `poll-action.ts` and `card-action.ts` independent of the
    // `card-interaction` envelope schema (`a`, `p`, etc.). Stable `v`
    // marker lets us reject stale-format callbacks in the future.
    value: JSON.stringify({
      v: 1,
      k: "poll",
      a: "feishu.poll.vote",
      pollId,
      optionId: option.id,
      p: { id: option.id, pollId },
    }),
  }));
}

function buildFeishuPollTallyBlock(
  options: FeishuPollOption[],
  totals: FeishuPollVoteTotals,
  totalVotes: number,
  maxSelections: number,
  closesAt: string | undefined,
): Record<string, unknown> {
  const lines = options.map((option) => {
    const count = totals[option.id] ?? 0;
    const pct = totalVotes === 0 ? 0 : Math.round((count / totalVotes) * 100);
    return `• ${escapeFeishuPollOptionLabel(option.label)} — **${count}** (${pct}%)`;
  });
  const footer =
    (maxSelections > 1 ? `\n_Multi-choice — up to ${maxSelections} selections._` : "") +
    (closesAt ? `\n_Poll closes at ${closesAt}._` : "");
  return {
    tag: "markdown",
    content: `${lines.join("\n")}${footer}`,
  };
}

function feishuPollFallbackText(
  definition: FeishuPollDefinition,
  totals: FeishuPollVoteTotals | undefined,
): string {
  const counted = countFeishuPollVotes(
    definition.options.map((option) => option.id),
    totals,
  );
  const total = Object.values(counted).reduce((sum, n) => sum + n, 0);
  const header = `📊 ${definition.question}`;
  const body = definition.options
    .map((option) => `• ${option.label} (${counted[option.id] ?? 0})`)
    .join("\n");
  return `${header}\n\n${body}\n\nVotes so far: ${total}`;
}

export const FEISHU_POLL_MAX_OPTIONS_LIMIT = FEISHU_POLL_MAX_OPTIONS;

export function buildFeishuPollCard(params: {
  definition: FeishuPollDefinition;
  totals?: FeishuPollVoteTotals;
  /** When true, render the static tally view instead of click buttons. */
  closed?: boolean;
}): FeishuPollCard {
  const totals = countFeishuPollVotes(
    params.definition.options.map((option) => option.id),
    params.totals,
  );
  const totalVotes = Object.values(totals).reduce((sum, n) => sum + n, 0);
  const elements: Record<string, unknown>[] = [
    buildFeishuPollQuestionBlock(params.definition.question),
    buildFeishuPollDivider(),
  ];
  if (params.closed) {
    elements.push(
      buildFeishuPollTallyBlock(
        params.definition.options,
        totals,
        totalVotes,
        params.definition.maxSelections,
        params.definition.closesAt,
      ),
    );
  } else {
    elements.push(
      ...buildFeishuPollOptionButtons(params.definition.options, params.definition.pollId),
    );
  }
  const card: Record<string, unknown> = {
    schema: "2.0",
    config: { width_mode: "fill" },
    body: { elements },
  };
  assertFeishuCardWithinEnvelope(card, "Feishu poll card");
  return {
    pollId: params.definition.pollId,
    maxSelections: params.definition.maxSelections,
    totalVotes,
    card,
    fallbackText: feishuPollFallbackText(params.definition, totals),
  };
}

/**
 * Validates that a poll definition matches the Feishu outbound-adapter
 * limits. The LCM-side tool is responsible for the rest of the input
 * sanitization (option count / deduplication / type-checking).
 */
export function assertFeishuPollDefinition(definition: FeishuPollDefinition): void {
  if (!definition.pollId.trim()) {
    throw new Error("Feishu poll definition requires a non-empty pollId.");
  }
  if (!definition.question.trim()) {
    throw new Error("Feishu poll definition requires a question.");
  }
  if (definition.options.length < 2) {
    throw new Error("Feishu poll requires at least 2 options.");
  }
  if (definition.options.length > FEISHU_POLL_MAX_OPTIONS) {
    throw new Error(`Feishu polls support at most ${FEISHU_POLL_MAX_OPTIONS} options.`);
  }
  if (
    !Number.isInteger(definition.maxSelections) ||
    definition.maxSelections < 1 ||
    definition.maxSelections > definition.options.length
  ) {
    throw new Error("Feishu poll.maxSelections must be an integer between 1 and options.length.");
  }
  for (const option of definition.options) {
    if (!option.id.trim() || !option.label.trim()) {
      throw new Error("Feishu poll options require non-empty id and label.");
    }
    if (definition.options.filter((other) => other.id === option.id).length > 1) {
      throw new Error(`Feishu poll has duplicate option id: ${option.id}`);
    }
    if (definition.options.filter((other) => other.label === option.label).length > 1) {
      throw new Error(`Feishu poll has duplicate option label: ${option.label}`);
    }
  }
}
