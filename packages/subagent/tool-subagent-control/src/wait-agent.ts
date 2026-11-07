/** Input waiting owned by the subagent control plugin. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Wait failures retain a stable machine-readable reason through tool execution. */
class AgentWaitError extends HarnessError {
  constructor(message: string, code: 'WAIT_INVALID_TIMEOUT' | 'WAIT_UNAVAILABLE' | 'WAIT_BUDGET_EXHAUSTED') {
    super(message, code)
    this.name = 'AgentWaitError'
  }
}

/** Pending input ids that the latest successful wait of one model tool call reported. */
type ReportedInput = WeakMap<Agent, { readonly rootCallId: ToolCallId; readonly ids: ReadonlySet<MessageId> }>

/**
 * Wait without consuming input; every settlement removes its live resources.
 * Within one model tool call, such as a `run_code` program, pending input that
 * an earlier wait already reported does not end this wait: that input reaches
 * the model only after the call finishes, so a waiting loop cannot spin on it.
 */
function waitForInput(
  ctx: Context,
  agent: Agent,
  timeoutMs: number,
  signal: AbortSignal,
  lifetime: AbortSignal,
  reported: ReportedInput,
  rootCallId: ToolCallId,
): Promise<{ timedOut: boolean }> {
  lifetime.throwIfAborted()
  if (ctx.agents.get(agent.id) !== agent) {
    throw new AgentWaitError('wait_agent requires the exact live calling agent', 'WAIT_UNAVAILABLE')
  }
  const previous = reported.get(agent)
  const seen = previous?.rootCallId === rootCallId ? previous.ids : undefined
  return new Promise((resolve, reject) => {
    const finish = (settle: () => void): void => {
      clearTimeout(timer)
      offInbox()
      offDisposed()
      signal.removeEventListener('abort', onAbort)
      lifetime.removeEventListener('abort', onUnload)
      settle()
    }
    const onInput = (): void => {
      const pending = agent.inbox.nextStep
      if (pending.some(message => seen?.has(message.id) !== true)) {
        reported.set(agent, { rootCallId, ids: new Set(pending.map(message => message.id)) })
        finish(() => { resolve({ timedOut: false }) })
      }
    }
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Cancellation preserves the caller's exact AbortSignal reason.
    const onAbort = (): void => { finish(() => { reject(signal.reason) }) }
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- This plugin aborts its lifetime only with AgentWaitError.
    const onUnload = (): void => { finish(() => { reject(lifetime.reason) }) }
    const offInbox = ctx.on('agent/inbox/inserted', ({ agent: recipient }) => {
      if (recipient === agent) onInput()
    })
    const offDisposed = ctx.on('agent/disposed', ({ agent: disposed }) => {
      if (disposed === agent) {
        finish(() => {
          reject(new AgentWaitError('wait_agent ended because the calling agent was disposed', 'WAIT_UNAVAILABLE'))
        })
      }
    })
    signal.addEventListener('abort', onAbort, { once: true })
    lifetime.addEventListener('abort', onUnload, { once: true })
    const timer = setTimeout(() => { finish(() => { resolve({ timedOut: true }) }) }, timeoutMs)
    // Subscribe before reading pending input so an arrival cannot fall between them.
    if (signal.aborted) onAbort()
    else onInput()
  })
}

/**
 * Per-agent, per-turn wait budget.
 *
 * Waiting is not work: every `wait_agent` call is a full model request that
 * resends the entire context. A measured orchestration session
 * (`session-44946c74`: 28 turns, 371 steps, one Lead and 8 teammates) spent
 * 84.5 percent of its input tokens on waiting and status reads, with
 * `wait_agent` alone at 33.9 percent across 106 calls. Three turns of that
 * session produced nothing at all — 63, 73 and 52 steps of `wait_agent`,
 * `list_agents` and `get_goal`, together 30.8M input tokens.
 *
 * The counter resets when the turn number changes, so the bound applies per
 * turn rather than per session: a long task legitimately spans many turns,
 * while a single turn that only waits is waste.
 */
class WaitBudget {
  #maxPerTurn: number
  #turn: number | undefined
  #used = 0

  constructor(maxPerTurn: number) {
    this.#maxPerTurn = maxPerTurn
  }

  /**
   * Roll the counter onto `turn` when the turn advanced.
   * @param turn - current turn number of the calling agent.
   */
  #sync(turn: number): void {
    if (this.#turn !== turn) {
      this.#turn = turn
      this.#used = 0
    }
  }

  /**
   * Record one wait attempt.
   * @param turn - current turn number of the calling agent.
   * @returns whether the wait is admitted; false means the budget is spent.
   */
  admit(turn: number): boolean {
    // Zero disables the bound instead of blocking every wait.
    if (this.#maxPerTurn === 0) return true
    this.#sync(turn)
    if (this.#used >= this.#maxPerTurn) return false
    this.#used += 1
    return true
  }

  /** Configured per-turn limit. */
  get limit(): number {
    return this.#maxPerTurn
  }
}

/**
 * Register one inbox wait tool and cancel its waits when the plugin unloads.
 * @param ctx - plugin context owning the tool, event listeners, and wait lifetime.
 * @param maxWaitsPerTurn - waits one agent may spend in one turn; 0 disables the bound.
 */
export function registerWaitAgent(ctx: Context, maxWaitsPerTurn: number): void {
  const lifetime = new AbortController()
  const reported: ReportedInput = new WeakMap()
  // Budgets belong to this registration, not to the module: reloading the
  // plugin must not carry a spent counter into a fresh configuration.
  const budgets: WeakMap<Agent, WaitBudget> = new WeakMap()
  ctx.effect(() => () => {
    lifetime.abort(new AgentWaitError('wait_agent ended because its plugin was unloaded', 'WAIT_UNAVAILABLE'))
  }, 'subagent-control.waits()')
  ctx.tools.register(defineTool({
    name: 'wait_agent',
    description: 'Wait for input at your next step, including agent messages, completion notifications, and user steering. Returns immediately if new input is pending. `timedOut: false` means new input is pending. Pending input is delivered to the model after code execution finishes. The number of waits in one turn is bounded; when the budget is spent the tool refuses and you must answer in text instead of waiting again.',
    parameters: {
      timeout_ms: {
        type: 'integer',
        description: 'Wait duration in milliseconds, from 10000 through 3600000. Defaults to 30000.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { timedOut: { type: 'boolean', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const timeoutMs = args.timeout_ms ?? 30_000
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10_000 || timeoutMs > 3_600_000) {
        throw new AgentWaitError('timeout_ms must be an integer from 10000 through 3600000', 'WAIT_INVALID_TIMEOUT')
      }
      if (exec.agent === undefined) {
        throw new AgentWaitError('wait_agent requires a calling agent', 'WAIT_UNAVAILABLE')
      }
      if (maxWaitsPerTurn !== 0) {
        const agent = exec.agent
        let budget = budgets.get(agent)
        if (budget === undefined) {
          budget = new WaitBudget(maxWaitsPerTurn)
          budgets.set(agent, budget)
        }
        const turn = ctx.agents.turnBoundaryOf(agent.session).lastTurn
        if (!budget.admit(turn)) {
          // A spent budget is a tool refusal, not a crash: the model must be
          // told to stop waiting and answer, and the reason stays machine-readable.
          throw new AgentWaitError(
            `wait_agent budget for this turn is exhausted (${budget.limit} waits). `
            + 'Waiting is not progress: each wait resends the whole context as a new model request. '
            + 'Do not wait again in this turn. Report the current state, the exact blocker, and what you need from the user, then end the turn.',
            'WAIT_BUDGET_EXHAUSTED',
          )
        }
      }
      return await waitForInput(ctx, exec.agent, timeoutMs, exec.signal, lifetime.signal, reported, exec.rootCallId)
    },
  }))
}
