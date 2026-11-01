import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelParameterValue } from '../modelSelection';

export type RunResultLike = {
  status: string;
  result?: string;
  error?: { message: string };
  usage?: { totalTokens: number };
};

export type RunLike = {
  supports(operation: 'cancel'): boolean;
  cancel(): Promise<void>;
  wait(): Promise<RunResultLike>;
};

export type SendMessage = {
  text: string;
  images?: Array<{ data: string; mimeType: string; dimension: { width: number; height: number } }>;
};

export type AgentLike = {
  send(message: SendMessage, options?: { model?: { id: string; params?: ModelParameterValue[] } }): Promise<RunLike>;
  summarize(): Promise<RunLike>;
  [Symbol.asyncDispose](): Promise<void>;
};

export type CreateAgentOptions = {
  apiKey: string;
  modelId: string;
  modelParams: ModelParameterValue[];
  cwd: string;
};

/** The SDK model selection. A send that passed only the id would replace the chosen params. */
function modelSelection(modelId: string, params: ModelParameterValue[]): { id: string; params?: ModelParameterValue[] } {
  return { id: modelId, ...(params.length > 0 ? { params } : {}) };
}

const maxConcurrency = 6;

/** The pool width: an integer override is clamped to 1 through 6, and anything else is 6. */
export function agentConcurrency(raw: string | undefined = process.env.BOOK_DISTILLER_AGENT_CONCURRENCY): number {
  const text = raw?.trim() ?? '';
  if (!/^-?[0-9]+$/.test(text)) {
    return maxConcurrency;
  }
  const width = Number(text);
  if (!Number.isSafeInteger(width)) {
    return maxConcurrency;
  }
  return Math.min(maxConcurrency, Math.max(1, width));
}

type WorkRoot = { path: string; temporary: boolean };

// One pool slot is one warm agent with its own stable directory. A slot outlives a disposed agent:
// the worker that owns it creates a replacement in the same directory.
type Slot = {
  index: number;
  dir?: string;
  agent?: AgentLike;
  creating?: Promise<AgentLike>;
  runs: Set<RunLike>;
  latestTokens: number;
  dead: boolean;
};

const slots = new Map<number, Slot>();
let workRoot: Promise<WorkRoot> | undefined;
let cancelRequested = false;
let carriedTokens = 0;
let reported = false;
let listener: ((total: number | null) => void) | undefined;

export function onTokenTotal(next: (total: number | null) => void): void {
  listener = next;
}

/** The sum of every live slot's latest total plus what disposed agents already counted. */
function currentTotal(): number | null {
  if (!reported) {
    return null;
  }
  let total = carriedTokens;
  for (const slot of slots.values()) {
    total += slot.latestTokens;
  }
  return total;
}

function emitTotal(): void {
  listener?.(currentTotal());
}

export function sessionTokenTotal(): number | null {
  return currentTotal();
}

function recordUsage(slot: Slot, usage: { totalTokens: number } | undefined): void {
  // A report from an agent that was already disposed is not counted again.
  if (slot.dead || !usage || !Number.isFinite(usage.totalTokens)) {
    return;
  }
  slot.latestTokens = usage.totalTokens;
  reported = true;
  emitTotal();
}

function acquireRoot(): Promise<WorkRoot> {
  if (!workRoot) {
    const configured = process.env.BOOK_DISTILLER_WORK_ROOT;
    const temporary = configured === undefined || configured === '';
    const made = (async (): Promise<WorkRoot> => {
      const path = temporary ? await mkdtemp(join(tmpdir(), 'book-distiller-work-')) : configured;
      await mkdir(path, { recursive: true });
      return { path, temporary };
    })();
    workRoot = made;
    made.catch(() => {
      if (workRoot === made) {
        workRoot = undefined;
      }
    });
  }
  return workRoot;
}

async function releaseRoot(): Promise<void> {
  const pending = workRoot;
  workRoot = undefined;
  if (!pending) {
    return;
  }
  let held: WorkRoot;
  try {
    held = await pending;
  } catch {
    return;
  }
  if (!held.temporary) {
    return;
  }
  try {
    if (process.env.BOOK_DISTILLER_WORKSPACE_DELETE_FAIL === '1') {
      throw new Error('EBUSY: resource busy or locked');
    }
    await rm(held.path, { recursive: true, force: true });
  } catch {
    // A locked directory is left in place. It must never reject the queue.
  }
}

function slotFor(index: number): Slot {
  let slot = slots.get(index);
  if (!slot) {
    slot = { index, runs: new Set(), latestTokens: 0, dead: false };
    slots.set(index, slot);
  }
  return slot;
}

async function slotDirectory(slot: Slot): Promise<string> {
  if (slot.dir) {
    return slot.dir;
  }
  const root = await acquireRoot();
  const dir = join(root.path, `slot-${slot.index + 1}`);
  await mkdir(dir, { recursive: true });
  slot.dir = dir;
  return dir;
}

/** The stable directory one pool slot works in. Created on first use, kept until every agent is disposed. */
export function acquireSlotWorkspace(index: number): Promise<string> {
  return slotDirectory(slotFor(index));
}

async function createAgent(options: CreateAgentOptions): Promise<AgentLike> {
  const standIn = process.env.BOOK_DISTILLER_STANDIN_AGENT;
  if (standIn) {
    const { createStandInAgent } = await import('./standInAgent');
    return createStandInAgent(standIn, options);
  }
  const { Agent } = await import('@cursor/sdk');
  return (await Agent.create({
    apiKey: options.apiKey,
    model: modelSelection(options.modelId, options.modelParams),
    local: { cwd: options.cwd, enableAgentRetries: false },
    tools: [],
  })) as unknown as AgentLike;
}

async function ensureAgent(
  slot: Slot,
  apiKey: string,
  modelId: string,
  modelParams: ModelParameterValue[],
): Promise<AgentLike> {
  if (slot.agent) {
    return slot.agent;
  }
  if (slot.creating) {
    return slot.creating;
  }
  const pending = (async (): Promise<AgentLike> => {
    const cwd = await slotDirectory(slot);
    return createAgent({ apiKey, modelId, modelParams, cwd });
  })();
  slot.creating = pending;
  pending.then(
    (created) => {
      if (slot.creating === pending) {
        slot.agent = created;
        slot.creating = undefined;
      }
    },
    () => {
      if (slot.creating === pending) {
        slot.creating = undefined;
      }
    },
  );
  return pending;
}

export function hasHeldState(): boolean {
  return slots.size > 0 || workRoot !== undefined;
}

async function disposeOne(agent: AgentLike | undefined): Promise<void> {
  if (!agent) {
    return;
  }
  try {
    await agent[Symbol.asyncDispose]();
  } catch {
    // A failed dispose still releases the held state.
  }
}

async function cancelRuns(runs: Iterable<RunLike>): Promise<void> {
  await Promise.all(
    [...runs].map(async (run) => {
      if (!run.supports('cancel')) {
        return;
      }
      try {
        await run.cancel();
      } catch {
        // wait() reports the outcome.
      }
    }),
  );
}

/**
 * Dispose every slot's agent, then delete the temporary work root. Never throws.
 * `key` resets the token total; `other` and `quit` keep what was already counted.
 */
export async function disposeAgent(reason: 'key' | 'other' | 'quit'): Promise<void> {
  const held = [...slots.values()];
  slots.clear();
  if (reason === 'key') {
    carriedTokens = 0;
    reported = false;
  } else {
    for (const slot of held) {
      carriedTokens += slot.latestTokens;
    }
  }
  for (const slot of held) {
    slot.dead = true;
    slot.latestTokens = 0;
  }
  await Promise.all(
    held.map(async (slot) => {
      const pending = slot.creating;
      let agent = slot.agent;
      slot.creating = undefined;
      slot.agent = undefined;
      if (!agent && pending) {
        try {
          agent = await pending;
        } catch {
          agent = undefined;
        }
      }
      const runs = [...slot.runs];
      slot.runs.clear();
      await cancelRuns(runs);
      await disposeOne(agent);
    }),
  );
  await releaseRoot();
  if (reason === 'key') {
    emitTotal();
  }
}

/** Disposes one slot's agent after its send threw. The slot keeps its directory for a replacement. */
async function disposeSlotAgent(slot: Slot): Promise<void> {
  const agent = slot.agent;
  slot.agent = undefined;
  slot.creating = undefined;
  carriedTokens += slot.latestTokens;
  slot.latestTokens = 0;
  await disposeOne(agent);
}

export function beginSession(): void {
  cancelRequested = false;
}

export function cancelWasRequested(): boolean {
  return cancelRequested;
}

/** Sets the cancel flag and stops every in-flight send or summary when the SDK allows it. */
export async function requestCancel(): Promise<void> {
  cancelRequested = true;
  const runs: RunLike[] = [];
  for (const slot of slots.values()) {
    runs.push(...slot.runs);
  }
  await cancelRuns(runs);
}

async function track(slot: Slot, run: RunLike): Promise<RunResultLike> {
  slot.runs.add(run);
  try {
    if (cancelRequested && run.supports('cancel')) {
      await run.cancel().catch(() => undefined);
    }
    const result = await run.wait();
    recordUsage(slot, result.usage);
    return result;
  } finally {
    slot.runs.delete(run);
  }
}

/** Sends one message on the warm agent in this slot, creating the agent on first use. */
export async function sendOnSlot(
  index: number,
  apiKey: string,
  modelId: string,
  modelParams: ModelParameterValue[],
  message: SendMessage,
): Promise<RunResultLike> {
  const slot = slotFor(index);
  const held = await ensureAgent(slot, apiKey, modelId, modelParams);
  let run: RunLike;
  try {
    run = await held.send(message, { model: modelSelection(modelId, modelParams) });
  } catch (error) {
    await disposeSlotAgent(slot);
    throw error;
  }
  return track(slot, run);
}

/** Compacts this slot's agent context. Resolves true when the user cancelled it. Never throws. */
export async function summarizeSlot(index: number): Promise<boolean> {
  const slot = slots.get(index);
  const held = slot?.agent;
  if (!slot || !held) {
    return false;
  }
  try {
    const result = await track(slot, await held.summarize());
    return result.status === 'cancelled';
  } catch {
    return false;
  }
}
