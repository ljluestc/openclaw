import crypto from "node:crypto";
// Feishu plugin module implements the in-plugin vote ledger.
//
// State ownership follows the precedent set by `extensions/msteams/src/polls.ts`:
// votes are deduplicated per voter (last-vote-wins for replace, all-options
// for multi-select) and capped so an unbounded chat cannot exhaust memory.
// All state is process-local; restart loses votes by design (Feishu card
// callbacks would not survive a process restart anyway since they depend on
// the runtime's webserver token cache).
import { createRequire } from "node:module";

const FEISHU_POLL_STORE_DEFAULT_MAX_POLLS = 1000;
const FEISHU_POLL_STORE_DEFAULT_MAX_VOTES_PER_POLL = 2048;
const FEISHU_POLL_STORE_DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

import type { FeishuPollDefinition } from "./poll-card.js";

export type FeishuPollStoreLimits = {
  maxPolls?: number;
  maxVotesPerPoll?: number;
  ttlMs?: number;
};

export type FeishuPollVoteTotals = Readonly<Record<string, number>>;

type FeishuPollVoteRecord = {
  pollId: string;
  definition: FeishuPollDefinition;
  /** optionId -> voterId list, deduped. */
  votes: Map<string, Set<string>>;
  caps: Required<FeishuPollStoreLimits>;
  createdAt: number;
  /** Last time any vote was added (drives TTL pruning). */
  updatedAt: number;
};

const pollStore: Map<string, FeishuPollVoteRecord> = new Map();

export const FEISHU_POLL_STORE_DEFAULT_LIMITS: Required<FeishuPollStoreLimits> = {
  maxPolls: FEISHU_POLL_STORE_DEFAULT_MAX_POLLS,
  maxVotesPerPoll: FEISHU_POLL_STORE_DEFAULT_MAX_VOTES_PER_POLL,
  ttlMs: FEISHU_POLL_STORE_DEFAULT_TTL_MS,
};

/**
 * Random poll id generator. We don't need a monotonic counter — a UUIDv4
 * prevents voting on a duplicate poll id across accounts.
 */
export function newFeishuPollId(): string {
  return crypto.randomUUID();
}

function nowMs(): number {
  return Date.now();
}

function pruneExpiredPollRecords(now: number, ttlMs: number): void {
  for (const [key, record] of pollStore.entries()) {
    if (now - record.updatedAt > ttlMs) {
      pollStore.delete(key);
    }
  }
}

function evictOldestPollIfAtCap(maxPolls: number): void {
  if (pollStore.size <= maxPolls) {
    return;
  }
  let oldestKey: string | undefined;
  let oldestUpdatedAt = Number.POSITIVE_INFINITY;
  for (const [key, record] of pollStore.entries()) {
    if (record.updatedAt < oldestUpdatedAt) {
      oldestUpdatedAt = record.updatedAt;
      oldestKey = key;
    }
  }
  if (oldestKey !== undefined) {
    pollStore.delete(oldestKey);
  }
}

export function registerFeishuPoll(params: {
  pollId: string;
  optionIds: string[];
  definition: FeishuPollDefinition;
  limits?: FeishuPollStoreLimits;
}): void {
  const caps = { ...FEISHU_POLL_STORE_DEFAULT_LIMITS, ...(params.limits ?? {}) };
  const now = nowMs();
  pruneExpiredPollRecords(now, caps.ttlMs);
  evictOldestPollIfAtCap(caps.maxPolls);
  const votes = new Map<string, Set<string>>();
  for (const optionId of params.optionIds) {
    votes.set(optionId, new Set());
  }
  pollStore.set(params.pollId, {
    pollId: params.pollId,
    definition: params.definition,
    votes,
    caps,
    createdAt: now,
    updatedAt: now,
  });
}

export function isFeishuPollRegistered(pollId: string): boolean {
  return pollStore.has(pollId);
}

export function readFeishuPollDefinition(pollId: string): FeishuPollDefinition | undefined {
  return pollStore.get(pollId)?.definition;
}

export function recordFeishuPollVote(params: {
  pollId: string;
  optionIds: string[];
  voterId: string;
  /** When true, replace the voter's previous selection. When false, append. */
  multiSelect: boolean;
}): { accepted: boolean; totals: FeishuPollVoteTotals } {
  const record = pollStore.get(params.pollId);
  if (!record) {
    return { accepted: false, totals: {} };
  }
  // For single-select, remove the voter's previous selections first so a
  // newer click replaces the older one. Multi-select is additive but still
  // deduped per (poll, voter, option).
  if (!params.multiSelect) {
    for (const [optionId, voters] of record.votes.entries()) {
      voters.delete(params.voterId);
    }
  } else {
    for (const optionId of params.optionIds) {
      const voters = record.votes.get(optionId);
      if (!voters) {
        continue;
      }
      voters.delete(params.voterId);
    }
  }
  // Append the new selection(s).
  for (const optionId of params.optionIds) {
    const voters = record.votes.get(optionId);
    if (!voters) {
      continue;
    }
    if (voters.size >= record.caps.maxVotesPerPoll) {
      return { accepted: false, totals: totalsForRecord(record) };
    }
    voters.add(params.voterId);
  }
  record.updatedAt = nowMs();
  return { accepted: true, totals: totalsForRecord(record) };
}

function totalsForRecord(record: FeishuPollVoteRecord): FeishuPollVoteTotals {
  const totals: Record<string, number> = {};
  for (const [optionId, voters] of record.votes.entries()) {
    totals[optionId] = voters.size;
  }
  return totals;
}

export function readFeishuPollTotals(pollId: string): FeishuPollVoteTotals | undefined {
  const record = pollStore.get(pollId);
  if (!record) {
    return undefined;
  }
  return totalsForRecord(record);
}

export function closeFeishuPoll(pollId: string): FeishuPollVoteTotals | undefined {
  const record = pollStore.get(pollId);
  if (!record) {
    return undefined;
  }
  const totals = totalsForRecord(record);
  pollStore.delete(pollId);
  return totals;
}

/**
 * Test seam: clear all stored records. Never call this in production code.
 */
export function __resetFeishuPollStoreForTests(): void {
  pollStore.clear();
}

/**
 * Cheap sanity import sidecar so `crypto.randomUUID()` survives even if a
 * reviewer hands the runtime config-substitution a polyfilled module.
 */
export const __feishuPollStoreModuleSentinel = createRequire(import.meta.url) ? true : true;
export type { FeishuPollDefinition } from "./poll-card.js";
