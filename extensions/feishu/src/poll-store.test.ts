// Feishu poll-store tests. State is process-local; the harness resets the
// store between tests via the dedicated __resetFeishuPollStoreForTests seam.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetFeishuPollStoreForTests,
  closeFeishuPoll,
  isFeishuPollRegistered,
  newFeishuPollId,
  readFeishuPollDefinition,
  readFeishuPollTotals,
  recordFeishuPollVote,
  registerFeishuPoll,
} from "./poll-store.js";

const sampleDefinition = {
  pollId: "",
  question: "Lunch?",
  options: [
    { id: "opt-1", label: "Pizza" },
    { id: "opt-2", label: "Sushi" },
  ],
  maxSelections: 1,
};

beforeEach(() => {
  __resetFeishuPollStoreForTests();
});

afterEach(() => {
  __resetFeishuPollStoreForTests();
});

describe("Feishu poll store", () => {
  it("registers and reads back a definition", () => {
    const def = { ...sampleDefinition, pollId: newFeishuPollId() };
    registerFeishuPoll({
      pollId: def.pollId,
      optionIds: def.options.map((option) => option.id),
      definition: def,
    });
    expect(isFeishuPollRegistered(def.pollId)).toBe(true);
    expect(readFeishuPollDefinition(def.pollId)?.question).toBe("Lunch?");
    expect(readFeishuPollTotals(def.pollId)).toEqual({
      "opt-1": 0,
      "opt-2": 0,
    });
  });

  it("dedups single-choice votes (last wins)", () => {
    const def = { ...sampleDefinition, pollId: newFeishuPollId() };
    registerFeishuPoll({
      pollId: def.pollId,
      optionIds: def.options.map((option) => option.id),
      definition: def,
    });

    const first = recordFeishuPollVote({
      pollId: def.pollId,
      optionIds: ["opt-1"],
      voterId: "voter-1",
      multiSelect: false,
    });
    expect(first.accepted).toBe(true);
    expect(first.totals).toEqual({ "opt-1": 1, "opt-2": 0 });

    const switched = recordFeishuPollVote({
      pollId: def.pollId,
      optionIds: ["opt-2"],
      voterId: "voter-1",
      multiSelect: false,
    });
    // Single-choice dedup: option-1 voter removed before option-2 added.
    expect(switched.accepted).toBe(true);
    expect(switched.totals).toEqual({ "opt-1": 0, "opt-2": 1 });
  });

  it("stacks votes across voters but excludes unknown options", () => {
    const def = { ...sampleDefinition, pollId: newFeishuPollId() };
    registerFeishuPoll({
      pollId: def.pollId,
      optionIds: def.options.map((option) => option.id),
      definition: def,
    });

    for (const voter of ["voter-a", "voter-b"]) {
      const result = recordFeishuPollVote({
        pollId: def.pollId,
        optionIds: ["opt-1"],
        voterId: voter,
        multiSelect: false,
      });
      expect(result.accepted).toBe(true);
    }
    expect(readFeishuPollTotals(def.pollId)).toEqual({
      "opt-1": 2,
      "opt-2": 0,
    });

    const nonexistent = recordFeishuPollVote({
      pollId: def.pollId,
      optionIds: ["opt-imaginary"],
      voterId: "voter-c",
      multiSelect: false,
    });
    // No registration for opt-imaginary means the lookup never finds it —
    // but our store still has the entry; we accept silently (the card UI
    // never sends an unknown option id).
    expect(nonexistent.accepted).toBe(true);
    expect(readFeishuPollTotals(def.pollId)).toEqual({
      "opt-1": 2,
      "opt-2": 0,
    });
  });

  it("rejects votes for unknown poll ids", () => {
    const result = recordFeishuPollVote({
      pollId: "does-not-exist",
      optionIds: ["opt-1"],
      voterId: "voter-x",
      multiSelect: false,
    });
    expect(result.accepted).toBe(false);
  });

  it("closeFeishuPoll returns final totals and removes the record", () => {
    const def = { ...sampleDefinition, pollId: newFeishuPollId() };
    registerFeishuPoll({
      pollId: def.pollId,
      optionIds: def.options.map((option) => option.id),
      definition: def,
    });
    recordFeishuPollVote({
      pollId: def.pollId,
      optionIds: ["opt-2"],
      voterId: "voter-x",
      multiSelect: false,
    });
    expect(closeFeishuPoll(def.pollId)).toEqual({ "opt-1": 0, "opt-2": 1 });
    expect(isFeishuPollRegistered(def.pollId)).toBe(false);
    expect(closeFeishuPoll(def.pollId)).toBeUndefined();
  });
});
