import { appendFile, readFile } from 'node:fs/promises';
import type { AgentLike, CreateAgentOptions, RunLike, RunResultLike } from './heldAgent';

// Test seam: BOOK_DISTILLER_STANDIN_AGENT names a JSON file that scripts a fake SDK agent.
// BOOK_DISTILLER_AGENT_EVENTS names a JSON-lines file where create, send, cancel, summarize
// and dispose are recorded, each with the agentId that made it. No network is used.
type Script = {
  replies?: string[];
  // A reply keyed by the sectionId in the prompt, for agents that send in no fixed order.
  // A string array is consumed in order, one entry per send for that section.
  sectionReplies?: Record<string, string | string[]>;
  // Cumulative usage per turn, counted across every agent.
  usage?: number[];
  // Cumulative usage per turn for each agent. The agent created first reads entry 0.
  perAgentUsage?: number[][];
  hangSends?: number[];
  throwOnSend?: number[];
  cancelDelayMs?: number;
};

// Counters span agents, so a script indexes sends across a dispose and re-create.
let sends = 0;
let turns = 0;
let createdAgents = 0;

/** Test-only: in-process compose tests share this module and must not leak send indexes. */
export function resetStandInAgent(): void {
  sends = 0;
  turns = 0;
  createdAgents = 0;
}

async function record(entry: Record<string, unknown>): Promise<void> {
  const file = process.env.BOOK_DISTILLER_AGENT_EVENTS;
  if (file) {
    await appendFile(file, `${JSON.stringify(entry)}\n`, 'utf8');
  }
}

async function readScript(file: string): Promise<Script> {
  return JSON.parse(await readFile(file, 'utf8')) as Script;
}

function replyFor(
  script: Script,
  text: string,
  index: number,
  sectionCursors: Map<string, number>,
): string {
  for (const [sectionId, reply] of Object.entries(script.sectionReplies ?? {})) {
    if (!text.includes(`"sectionId": "${sectionId}"`)) {
      continue;
    }
    if (typeof reply === 'string') {
      return reply;
    }
    const cursor = sectionCursors.get(sectionId) ?? 0;
    sectionCursors.set(sectionId, cursor + 1);
    const next = reply[cursor];
    return typeof next === 'string' ? next : '';
  }
  return script.replies?.[index] ?? '';
}

export async function createStandInAgent(scriptFile: string, options: CreateAgentOptions): Promise<AgentLike> {
  const agentId = createdAgents;
  createdAgents += 1;
  const script = await readScript(scriptFile);
  await record({
    event: 'create',
    agentId,
    cwd: options.cwd,
    modelId: options.modelId,
    ...(options.modelParams.length > 0 ? { modelParams: options.modelParams } : {}),
  });

  let agentTurns = 0;
  const sectionCursors = new Map<string, number>();
  const nextUsage = (): { totalTokens: number } | undefined => {
    let total: number | undefined;
    if (script.perAgentUsage) {
      total = script.perAgentUsage[agentId]?.[agentTurns];
      agentTurns += 1;
    } else {
      total = script.usage?.[turns];
      turns += 1;
    }
    return total === undefined ? undefined : { totalTokens: total };
  };

  const makeRun = (kind: 'send' | 'summarize', hang: boolean, text: string): RunLike => {
    let release: (() => void) | undefined;
    let cancelled = false;
    const held = hang
      ? new Promise<void>((resolve) => {
          release = resolve;
        })
      : Promise.resolve();
    return {
      supports: () => true,
      async cancel(): Promise<void> {
        await record({ event: 'cancel', agentId, kind });
        cancelled = true;
        if (script.cancelDelayMs) {
          await new Promise((resolve) => setTimeout(resolve, script.cancelDelayMs));
        }
        release?.();
      },
      async wait(): Promise<RunResultLike> {
        await held;
        if (cancelled) {
          return { status: 'cancelled' };
        }
        const usage = nextUsage();
        return { status: 'finished', result: text, ...(usage ? { usage } : {}) };
      },
    };
  };

  return {
    async send(message, sendOptions): Promise<RunLike> {
      const index = sends;
      sends += 1;
      await record({
        event: 'send',
        agentId,
        modelId: sendOptions?.model?.id,
        ...(sendOptions?.model?.params && sendOptions.model.params.length > 0
          ? { modelParams: sendOptions.model.params }
          : {}),
        prompt: message.text.slice(0, 200),
      });
      if (script.throwOnSend?.includes(index)) {
        throw new Error('stand-in send failed');
      }
      return makeRun(
        'send',
        script.hangSends?.includes(index) === true,
        replyFor(script, message.text, index, sectionCursors),
      );
    },
    async summarize(): Promise<RunLike> {
      await record({ event: 'summarize', agentId });
      return makeRun('summarize', false, 'summary');
    },
    async [Symbol.asyncDispose](): Promise<void> {
      await record({ event: 'dispose', agentId });
    },
  };
}
