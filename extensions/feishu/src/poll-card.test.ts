// Feishu poll-card builder tests.

import { describe, expect, it } from "vitest";
import {
  assertFeishuPollDefinition,
  buildFeishuPollCard,
  FEISHU_POLL_MAX_OPTIONS_LIMIT,
} from "./poll-card.js";

const sampleDefinition = {
  pollId: "poll-1",
  question: "Lunch?",
  options: [
    { id: "opt-1", label: "Pizza" },
    { id: "opt-2", label: "Sushi" },
  ],
  maxSelections: 1,
} as const;

describe("Feishu poll card", () => {
  it("renders question, divider, and one button per option", () => {
    const out = buildFeishuPollCard({ definition: { ...sampleDefinition } });
    expect(out.card.schema).toBe("2.0");
    const body = out.card.body;
    if (!body || Array.isArray(body) || typeof body !== "object") {
      throw new Error("expected object body");
    }
    const elements = (body as { elements?: unknown[] }).elements ?? [];
    expect(elements.length).toBe(2 + sampleDefinition.options.length);
    const buttonElements = elements.filter(
      (element): element is Record<string, unknown> =>
        typeof element === "object" &&
        element !== null &&
        (element as { tag?: unknown }).tag === "button",
    );
    expect(buttonElements.length).toBe(2);
    const decodedValues = buttonElements.map((element) => {
      const value = (element as { value?: string }).value;
      expect(typeof value).toBe("string");
      return JSON.parse(value as string) as {
        pollId?: string;
        optionId?: string;
        a?: string;
      };
    });
    for (const value of decodedValues) {
      expect(value.pollId).toBe(sampleDefinition.pollId);
      expect(value.a).toBe("feishu.poll.vote");
    }
    expect(decodedValues.map((value) => value.optionId).sort()).toEqual(["opt-1", "opt-2"]);
  });

  it("renders static tally view when closed", () => {
    const totals = { "opt-1": 3, "opt-2": 1 } as const;
    const out = buildFeishuPollCard({
      definition: { ...sampleDefinition },
      totals,
      closed: true,
    });
    expect(out.totalVotes).toBe(4);
    const body = out.card.body as { elements?: Array<Record<string, unknown>> };
    const tags = (body.elements ?? []).map((element) => element.tag);
    expect(tags).toEqual(["markdown", "hr", "markdown"]);
    const tallyMarkdown = (body.elements ?? [])[2] as {
      content?: string;
    };
    expect(tallyMarkdown.content).toContain("Pizza");
    expect(tallyMarkdown.content).toContain("Sushi");
    expect(tallyMarkdown.content).toContain("**3**");
    expect(tallyMarkdown.content).toContain("**1**");
  });

  it("fallback text mirrors the active buttons", () => {
    const out = buildFeishuPollCard({ definition: { ...sampleDefinition } });
    expect(out.fallbackText).toContain("📊 Lunch?");
    expect(out.fallbackText).toContain("• Pizza (0)");
    expect(out.fallbackText).toContain("• Sushi (0)");
    expect(out.fallbackText).toContain("Votes so far: 0");
  });

  it("enforces maximum option count", () => {
    const tooManyOptions = Array.from(
      { length: FEISHU_POLL_MAX_OPTIONS_LIMIT + 1 },
      (_, index) => ({ id: `opt-${index + 1}`, label: `Option ${index + 1}` }),
    );
    expect(() =>
      assertFeishuPollDefinition({
        pollId: "poll-bad",
        question: "too many?",
        options: tooManyOptions,
        maxSelections: 1,
      }),
    ).toThrow(/at most/);
  });

  it("rejects duplicate option ids", () => {
    expect(() =>
      assertFeishuPollDefinition({
        pollId: "poll-bad",
        question: "?",
        options: [
          { id: "opt-1", label: "A" },
          { id: "opt-1", label: "B" },
        ],
        maxSelections: 1,
      }),
    ).toThrow(/duplicate option id/);
  });

  it("rejects fewer than two options", () => {
    expect(() =>
      assertFeishuPollDefinition({
        pollId: "poll-bad",
        question: "?",
        options: [{ id: "opt-1", label: "only" }],
        maxSelections: 1,
      }),
    ).toThrow(/at least 2/);
  });

  it("rejects maxSelections > options.length", () => {
    expect(() =>
      assertFeishuPollDefinition({
        pollId: "poll-bad",
        question: "?",
        options: [
          { id: "opt-1", label: "A" },
          { id: "opt-2", label: "B" },
        ],
        maxSelections: 5,
      }),
    ).toThrow(/maxSelections/);
  });
});
