/**
 * `/think` — inspect and switch the current Session's reasoning (thinking)
 * level.
 *
 * Channels:
 * - Any surface with a Harness command adapter (Web chat composer, CLI, …)
 *   gets the command from `ctx.commands`.
 * - The QQ bot channel (@tencent-connect/dsh-qqbot) has its own slash-command
 *   registry and forwards unknown `/…` text straight to the model, so this
 *   plugin additionally bridges `/think` on the live QQBot instance: it wraps
 *   `QQBot#emit('message', …)`, runs the exact same command through
 *   `ctx.commands.execute(agent, line, …)` and replies through the bot without
 *   ever sending the line to the model.
 *
 * Applying a level uses the same live, durable seam as the Web model picker:
 * `sessionController`'s selection installer appends `model/selection` and
 * updates the Agent-scoped request routing. Compositions without that seam
 * fall back to `agent.options.reasoningEffort` plus the same durable event.
 *
 * @module dsh-think-command
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const name = 'command-think'
export const inject = ['commands', 'llm']

const USAGE = '用法: /think <等级>    例: /think high 或 /think 高；/think 默认 恢复模型默认'

/**
 * Canonical ordering of the reasoning levels the installed adapters can
 * expose. Different models advertise different subsets — DeepSeek offers
 * off/low/high/max, MiMo offers off/minimal/low/medium/high — so a user
 * request is resolved against this shared scale instead of against the
 * vocabulary of whichever model happened to be active when the plugin was
 * written.
 */
const LEVEL_SCALE = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** Human-readable fallbacks for effort ids whose adapter supplies no description. */
const EFFORT_TEXT = {
  off: '关闭思考',
  none: '关闭思考',
  disabled: '关闭思考',
  minimal: '最低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '很高',
  max: '最高',
}

/**
 * Chinese descriptions shown instead of an adapter's English description.
 * DeepSeek advertises sentences such as "Use for simple tasks that do not need
 * reasoning."; the chat is Chinese, so the known levels get Chinese wording
 * (unknown ids keep whatever the adapter supplied).
 */
const EFFORT_DESCRIPTION = {
  off: '关闭思考（适合不需要推理的简单任务）',
  none: '关闭思考（适合不需要推理的简单任务）',
  disabled: '关闭思考（适合不需要推理的简单任务）',
  minimal: '最低（尽量少思考）',
  low: '低（适合日常或延迟敏感任务）',
  medium: '中（平衡速度与深度）',
  high: '高（大多数任务的默认档）',
  xhigh: '很高（适合较复杂的推理）',
  max: '最高（留给最难、最看重质量的任务）',
}

/**
 * Concept words users type for each canonical level. A token names an intent,
 * not a model-specific id: `/think 最高` asks for the deepest level, whichever
 * id (max, xhigh or high) the current model calls it.
 */
const LEVEL_CONCEPTS = [
  ['off', ['off', 'none', 'disabled', '关闭', '关', '关掉', '禁用', '不思考', '不推理', '停止思考']],
  ['minimal', ['minimal', '最低', '最低档', '最小', '很轻', '极低']],
  ['low', ['low', '低', '低档', '较少', '轻']],
  ['medium', ['medium', '中', '中等', '中档', '平衡', '适度']],
  ['high', ['high', '高', '高档', '较高', '深度']],
  ['xhigh', ['xhigh', '很高', '极高', '超高']],
  ['max', ['max', '最高', '最高档', '最大', '极限']],
]

/** token → canonical level id. */
const CONCEPT_BY_TOKEN = new Map(
  LEVEL_CONCEPTS.flatMap(([level, tokens]) => tokens.map((token) => [token, level])),
)

/** Tokens that clear the explicit level and fall back to the model default. */
const CLEAR_TOKENS = new Set(['默认', 'default', 'auto', '自动', '重置', 'reset', '清空', '空'])

/** Tokens that mean "turn thinking on" without naming a depth. */
const ENABLE_TOKENS = new Set(['on', '思考', '开启', '开启思考', '启用'])

/** Bound the QQ command round trip so a stuck lookup cannot wedge the chain. */
const QQ_COMMAND_TIMEOUT_MS = 30_000

/* ------------------------------------------------------------------ *
 * Channel selection
 * ------------------------------------------------------------------ */

/**
 * Channel of the invocation currently being dispatched. The registered
 * command handler is shared by every adapter; the QQ bridge dials it through
 * `ctx.commands.execute` inside this async scope, so replies can use QQ's
 * markdown command-input chips while Web/CLI keep the plain listing.
 *
 * The QQ bridge also carries the peer's effective route: the QQ plugin switches
 * models by forking a Session, whose inherited request headers still name the
 * previous model, so the durable projection alone can describe the wrong route
 * right after `/model`. The bridge's own resolver is authoritative there.
 */
const invocationChannel = new AsyncLocalStorage()

/** `'qq'` inside the QQ bridge dispatch, `'web'` everywhere else. */
function activeChannel() {
  return invocationChannel.getStore()?.channel ?? 'web'
}

/* ------------------------------------------------------------------ *
 * Command core
 * ------------------------------------------------------------------ */

function safeGet(ctx, key) {
  try {
    return ctx.get(key)
  } catch {
    return undefined
  }
}

/** Normalize one user token: trim surrounding quotes and lowercase it. */
function normalizeToken(raw) {
  return raw.trim().toLowerCase().replace(/^["'“”「」]+|["'“”「」]+$/g, '')
}

/** Scale position of one adapter effort id (`none`/`disabled` count as off). */
function levelRank(id) {
  const normalized = String(id).toLowerCase()
  if (normalized === 'none' || normalized === 'disabled') return 0
  const rank = LEVEL_SCALE.indexOf(normalized)
  return rank === -1 ? undefined : rank
}

/** Whether the current model advertises one effort id. */
function effortSupported(id, reasoning) {
  if (id === undefined) return true
  if (reasoning === undefined) return false
  return reasoning.efforts.some((effort) => String(effort.id).toLowerCase() === String(id).toLowerCase())
}

function projectionState(ctx, session) {
  const projections = safeGet(ctx, 'sessionProjections')
  if (projections === undefined || typeof projections.stateOf !== 'function') return undefined
  try {
    return projections.stateOf(session, 'modelSelection')
  } catch {
    return undefined
  }
}

/**
 * Resolve the exact provider/model route the Session will send its next
 * request to, preferring the durable model-selection projection (Web picker or
 * an earlier `/think`), then the pending `request/header`, then the Agent's own
 * configured options, then the deployment default.
 *
 * @param {object} ctx - Host context.
 * @param {object} agent - the receiving agent.
 * @returns {{ provider: string, model: string }}
 */
function currentRoute(ctx, agent) {
  const projection = projectionState(ctx, agent.session)
  const intended = projection?.pending ?? projection?.lastUsed
  if (intended?.provider && intended.model) return { provider: intended.provider, model: intended.model }

  const header = agent.session.requestHeader?.()
  if (header?.config?.provider && header.config.model) {
    return { provider: header.config.provider, model: header.config.model }
  }

  const options = agent.options
  if (options?.provider && options.model) return { provider: options.provider, model: options.model }

  const fallback = safeGet(ctx, 'agentDefaultModel')?.currentSelection?.()
  if (fallback?.provider && fallback.model) return { provider: fallback.provider, model: fallback.model }

  throw new Error('无法解析当前会话的模型路由')
}

/**
 * Effective thinking level plus where it came from.
 *
 * `supported` reports whether the current model actually advertises the level.
 * A durable selection made under another model (for example `max` while the
 * session later moved to a model that tops out at `high`) is still shown, but
 * flagged: it would be rejected by the next request and `/think` can repair it.
 *
 * @param {object} ctx - Host context.
 * @param {object} agent - the receiving agent.
 * @param {{ provider: string, model: string }} route - exact route.
 * @param {{ efforts?: readonly { id: string }[], defaultEffort?: string } | undefined} reasoning - model reasoning metadata.
 * @returns {{ id: string | undefined, source: string, supported: boolean }}
 */
function currentEffort(ctx, agent, route, reasoning) {
  const state = (id, source) => ({ id, source, supported: effortSupported(id, reasoning) })
  const projection = projectionState(ctx, agent.session)
  const intended = projection?.pending ?? projection?.lastUsed
  if (
    intended?.provider === route.provider &&
    intended.model === route.model &&
    intended.reasoningEffort !== undefined
  ) {
    return state(intended.reasoningEffort, projection?.pending ? '已选（待生效）' : '最近一次请求')
  }

  // Agent options may describe the deployment default rather than this model;
  // only trust an effort that belongs to the route actually in use.
  const options = agent.options
  const optionsRouteMatches =
    options?.provider === undefined ||
    options?.model === undefined ||
    (options.provider === route.provider && options.model === route.model)
  if (options?.reasoningEffort !== undefined && optionsRouteMatches) {
    return state(options.reasoningEffort, '会话设置')
  }

  const header = agent.session.requestHeader?.()
  if (
    header?.config?.provider === route.provider &&
    header.config.model === route.model &&
    header.config.reasoningEffort !== undefined
  ) {
    return state(
      header.config.reasoningEffort,
      header.adapterDefaults?.reasoningEffort === true ? '模型默认' : '最近一次请求',
    )
  }

  if (reasoning?.defaultEffort !== undefined) return state(reasoning.defaultEffort, '模型默认')
  return state(undefined, '未指定')
}

/** Effort entries that actually change thinking depth (everything but `off`). */
function switchableEfforts(reasoning) {
  if (reasoning === undefined) return []
  return reasoning.efforts.filter((effort) => levelRank(effort.id) !== 0)
}

/** One current-level phrase, warning when a stale level is unsupported here. */
function currentLevelLine(force) {
  if (force.id === undefined) return `默认（${force.source}）`
  if (force.supported) return force.id
  return `${force.id} ⚠️（当前模型不支持该等级，下一轮会失败；可用 /think 默认 清除）`
}

/** Footer explaining that levels are model-specific and auto-fitted. */
const LEVELS_HINT =
  '提示: 不同模型开放的等级不同；输入其它模型的等级（如 最高 / max），会自动选择当前模型最接近的一档。/think 默认 恢复模型默认。'

/** Render one effort entry. */
function effortLine(effort, currentId) {
  const key = String(effort.id).toLowerCase()
  const marker = effort.id === currentId ? '  (当前)' : ''
  const description = EFFORT_DESCRIPTION[key] ?? effort.description ?? EFFORT_TEXT[key]
  const suffix = description ? ` — ${description}` : ''
  return `  • ${effort.id}: ${effort.name}${suffix}${marker}`
}

/** Render the listing shown by `/think` with no arguments. */
function renderListing(route, force, reasoning) {
  const current = force.id ?? reasoning?.defaultEffort
  const lines = ['🧠 思考等级', `当前: ${currentLevelLine(force)}`, `模型: ${route.provider}/${route.model}`]
  if (reasoning === undefined || reasoning.efforts.length === 0) {
    lines.push('', '当前模型没有暴露可切换的思考等级。')
    return lines.join('\n')
  }
  if (switchableEfforts(reasoning).length === 0) {
    lines.push('', '当前模型只开放手动关闭思考，没有可切换的思考等级。')
    return lines.join('\n')
  }
  lines.push('', '可切换等级:')
  for (const effort of reasoning.efforts) lines.push(effortLine(effort, current))
  lines.push('', USAGE, LEVELS_HINT)
  return lines.join('\n')
}

/**
 * Human label for one effort, skipping names that merely repeat the id.
 * The Chinese wording comes first so a DeepSeek chip reads `（关闭思考）`
 * instead of its English adapter description.
 */
function effortLabel(effort) {
  const id = String(effort.id).toLowerCase()
  const candidates = [EFFORT_TEXT[id], effort.name, effort.description]
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue
    const label = candidate.trim()
    if (label.length > 0 && label.toLowerCase() !== id) return label
  }
  return undefined
}

/** One QQ markdown command chip: tapping it fills `/think <id>` into the composer. */
function qqCommandChip(effort) {
  const id = String(effort.id)
  const label = effortLabel(effort)
  const show = label === undefined ? `/think ${id}` : `/think ${id}（${label}）`
  return `<qqbot-cmd-input text="/think ${id}" show="${show}"/>`
}

/**
 * Render the bare `/think` reply for the QQ channel. Mirrors the qqbot
 * plugin's own `/model` reply: the switchable levels become
 * `<qqbot-cmd-input>` chips that fill the QQ input box when tapped.
 *
 * @param {{ provider: string, model: string }} route - exact route.
 * @param {{ id?: string, source: string, supported: boolean }} force - effective level.
 * @param {{ efforts: readonly { id: string, name?: string }[], defaultEffort?: string } | undefined} reasoning
 * @returns {string}
 */
function renderQqListing(route, force, reasoning) {
  const current = force.id ?? reasoning?.defaultEffort
  const lines = [
    '### 🧠 思考等级',
    '',
    `**当前:** ${currentLevelLine(force)}`,
    `**模型:** ${route.provider}/${route.model}`,
  ]
  if (reasoning === undefined || reasoning.efforts.length === 0) {
    lines.push('', '当前模型没有暴露可切换的思考等级。')
    return lines.join('\n')
  }
  if (switchableEfforts(reasoning).length === 0) {
    lines.push('', '当前模型只开放手动关闭思考，没有可切换的思考等级。')
    return lines.join('\n')
  }
  lines.push('', '**可切换等级（点击填入输入框）:**', '')
  for (const effort of reasoning.efforts) lines.push(qqCommandChip(effort))
  lines.push('', '也可以手动输入: `/think <等级>`；`/think 默认` 恢复模型默认。')
  return lines.join('\n')
}

/** Render the unsupported-level refusal for the QQ channel, with chips. */
function renderQqUnknownLevel(route, input, reasoning) {
  return [
    `❌ 不支持的思考等级 "${input}"`,
    '',
    `**模型:** ${route.provider}/${route.model}`,
    '',
    '**可选等级（点击填入输入框）:**',
    '',
    ...reasoning.efforts.map((effort) => qqCommandChip(effort)),
    '',
    '也可以手动输入: `/think <等级>`；其它模型的等级会自动换成当前模型最接近的一档。',
  ].join('\n')
}

/**
 * Resolve one user-provided level token against the model's advertised efforts.
 *
 * Exact adapter ids and names win. Otherwise the token is read as a scale
 * concept (`最高`, `max`, `中`, `medium`, …) and mapped onto the nearest level
 * the model actually offers — a level borrowed from another model still
 * switches this one instead of being rejected, and the caller can tell the
 * user which level was chosen.
 *
 * @param {string} raw - trimmed user input.
 * @param {{ efforts: readonly { id: string, name: string }[], defaultEffort?: string }} reasoning - model reasoning metadata.
 * @returns {{ effort: { id: string, name: string }, requested?: string, adjusted?: boolean } | undefined}
 */
function matchEffort(raw, reasoning) {
  const token = normalizeToken(raw)
  if (!token) return undefined
  const direct = reasoning.efforts.find(
    (effort) => String(effort.id).toLowerCase() === token || String(effort.name).toLowerCase() === token,
  )
  if (direct !== undefined) return { effort: direct }

  // "on"/"思考" means "think at this model's usual depth".
  const concept = ENABLE_TOKENS.has(token)
    ? (reasoning.defaultEffort ?? 'high')
    : (CONCEPT_BY_TOKEN.get(token) ?? (LEVEL_SCALE.includes(token) ? token : undefined))
  if (concept === undefined) return undefined
  const targetRank = levelRank(concept)
  if (targetRank === undefined) return undefined

  const ranked = reasoning.efforts.map((effort) => ({ effort, rank: levelRank(effort.id) }))
  const exact = ranked.find((entry) => entry.rank === targetRank)
  if (exact !== undefined) return { effort: exact.effort, requested: token, adjusted: false }

  // Closest level on the same side of `off`: asking for thinking must never
  // silently fall back to "off", and asking for "off" needs a real off level.
  const pool = ranked.filter((entry) =>
    entry.rank === undefined ? false : targetRank === 0 ? entry.rank === 0 : entry.rank > 0,
  )
  if (pool.length === 0) return undefined
  const preferHigher = targetRank >= levelRank('medium')
  pool.sort((left, right) => {
    const distance = Math.abs(left.rank - targetRank) - Math.abs(right.rank - targetRank)
    if (distance !== 0) return distance
    return preferHigher ? right.rank - left.rank : left.rank - right.rank
  })
  return { effort: pool[0].effort, requested: token, adjusted: true }
}

/**
 * Apply one validated selection through the most capable available seam.
 *
 * @param {object} ctx - Host context.
 * @param {object} agent - the receiving agent.
 * @param {{ provider: string, model: string, reasoningEffort?: string }} selection - validated selection.
 * @returns {Promise<'selection' | 'controller' | 'session'>} applied seam.
 */
async function applySelection(ctx, agent, selection) {
  const controller = safeGet(ctx, 'sessionController')

  // Same live seam the Web model picker uses: append the durable
  // `model/selection` event and update the Agent's request routing without
  // forcing the deployment default to change.
  const internals = controller?.agents
  if (internals !== undefined && typeof internals.selectForNextRequest === 'function') {
    internals.selectForNextRequest(agent, selection)
    return 'selection'
  }

  // Documented Remote fallback: also persists the choice as the default.
  if (controller !== undefined && typeof controller.selectModel === 'function') {
    await controller.selectModel({
      sessionId: agent.session.id,
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
    })
    return 'controller'
  }

  // Compositions without the Session-controller seam: the durable event keeps
  // the choice visible, and the Agent option makes it effective immediately.
  agent.session.append('model/selection', selection)
  if (agent.options !== undefined && agent.options !== null) {
    if (selection.reasoningEffort === undefined) delete agent.options.reasoningEffort
    else agent.options.reasoningEffort = selection.reasoningEffort
  }
  return 'session'
}

/**
 * Execute one parsed `/think` invocation.
 *
 * @param {object} ctx - Host context.
 * @param {object} invocation - `ctx.commands` invocation.
 * @returns {Promise<{ kind: 'success' | 'error', text: string }>}
 */
async function executeThink(ctx, invocation) {
  const { agent, signal } = invocation
  const input = invocation.rawInput.trim()
  const channel = activeChannel()

  let route
  try {
    route = invocationChannel.getStore()?.route ?? currentRoute(ctx, agent)
  } catch (error) {
    return { kind: 'error', text: `❌ ${error instanceof Error ? error.message : String(error)}` }
  }

  let info
  try {
    info = await ctx.llm.resolveModelInfo(route.provider, route.model, signal)
  } catch (error) {
    if (signal?.aborted) return { kind: 'error', text: '思考等级查询已取消。' }
    return {
      kind: 'error',
      text: `❌ 无法读取模型 ${route.provider}/${route.model} 的能力信息: ${
        error instanceof Error ? error.message : String(error)
      }`,
    }
  }

  const reasoning = info?.reasoning
  const effective = currentEffort(ctx, agent, route, reasoning)

  // ── show ──
  if (input.length === 0) {
    return {
      kind: 'success',
      text: channel === 'qq' ? renderQqListing(route, effective, reasoning) : renderListing(route, effective, reasoning),
    }
  }

  const token = normalizeToken(input)

  // ── restore the model default ──
  if (CLEAR_TOKENS.has(token)) {
    const selection = { provider: route.provider, model: route.model }
    try {
      await applySelection(ctx, agent, selection)
    } catch (error) {
      return {
        kind: 'error',
        text: `❌ 恢复默认思考等级失败: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
    const fallback = reasoning?.defaultEffort
    return {
      kind: 'success',
      text: `✅ 已恢复模型默认思考等级${fallback === undefined ? '' : `（${fallback}）`}，从下一轮回复开始生效。`,
    }
  }

  // ── switch ──
  if (reasoning === undefined || reasoning.efforts.length === 0) {
    return {
      kind: 'error',
      text: `❌ 模型 ${route.provider}/${route.model} 没有开放思考等级，无法切换。`,
    }
  }
  if (switchableEfforts(reasoning).length === 0) {
    return {
      kind: 'error',
      text: `❌ 模型 ${route.provider}/${route.model} 只开放手动关闭思考，没有可切换的思考等级。`,
    }
  }

  const matched = matchEffort(input, reasoning)
  if (matched === undefined) {
    return {
      kind: 'error',
      text:
        channel === 'qq'
          ? renderQqUnknownLevel(route, input, reasoning)
          : [
              `❌ 不支持的思考等级 "${input}"（模型 ${route.provider}/${route.model}）`,
              '',
              '可选等级:',
              ...reasoning.efforts.map((effort) => effortLine(effort, effective.id)),
              '',
              USAGE,
              LEVELS_HINT,
            ].join('\n'),
    }
  }

  const matchedEffort = matched.effort
  let resolved
  try {
    resolved = await ctx.llm.resolveCallConfig(
      { provider: route.provider, model: route.model, reasoningEffort: matchedEffort.id },
      signal,
    )
  } catch (error) {
    if (signal?.aborted) return { kind: 'error', text: '思考等级切换已取消。' }
    return {
      kind: 'error',
      text: `❌ 等级 "${matchedEffort.id}" 被 ${route.provider}/${route.model} 拒绝: ${
        error instanceof Error ? error.message : String(error)
      }`,
    }
  }

  const effortId = resolved?.reasoningEffort ?? matchedEffort.id
  const selection = {
    provider: route.provider,
    model: route.model,
    ...(effortId === undefined ? {} : { reasoningEffort: effortId }),
  }

  try {
    await applySelection(ctx, agent, selection)
  } catch (error) {
    return {
      kind: 'error',
      text: `❌ 思考等级切换失败: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  const knownLabel = effortLabel(matchedEffort)
  const label = knownLabel === undefined ? `${effortId}` : `${effortId}（${knownLabel}）`
  const adjustment =
    matched.adjusted === true
      ? `\n（当前模型没有「${input}」这一档，已选择最接近的 ${effortId}；不会沿用其它模型的等级名）`
      : ''
  return {
    kind: 'success',
    text: `✅ 思考等级已切换为 ${label}，从下一轮回复开始生效。${adjustment}`,
  }
}

/* ------------------------------------------------------------------ *
 * QQ bot channel bridge
 * ------------------------------------------------------------------ */

const BRIDGE_KEY = Symbol.for('dsh-think-command.qqbot-bridge')

/** Process-wide patch state shared across plugin reloads (HMR-safe). */
function bridgeState() {
  if (globalThis[BRIDGE_KEY] === undefined) {
    globalThis[BRIDGE_KEY] = { handler: null, owner: null, managers: new Map(), patched: false }
  }
  return globalThis[BRIDGE_KEY]
}

/** Persist a small bridge diagnostic file so activation can be verified offline. */
function writeBridgeStatus(status) {
  try {
    const home = process.env.DSH_HOME ?? path.join(homedir(), '.dsh')
    // Tests point this at a scratch directory so they never overwrite the
    // running Host's own diagnostic file.
    const dir = process.env.DSH_THINK_STATUS_DIR ?? path.join(home, 'cache', 'dsh-think-command')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      path.join(dir, 'bridge-status.json'),
      `${JSON.stringify({ ...status, pid: process.pid, at: new Date().toISOString() }, null, 2)}\n`,
    )
  } catch {
    /* diagnostics are best effort */
  }
}

/** True for a complete `/think` command line. */
function isThinkLine(line) {
  return /^\/think(?:\s|$)/i.test(line)
}

/** Format a level listing for logs without leaking the whole object. */
function logLevel(logger, message) {
  try {
    logger?.info?.(`[dsh-think-command] ${message}`)
  } catch {
    /* logging must never break the bridge */
  }
}

/**
 * Capture the live QQ SessionManager from a bot so `/think` can resolve the
 * exact peer's Agent without owning the qqbot plugin's private state.
 */
function rememberManager(state, manager) {
  try {
    const appId = manager?.config?.appId ?? manager?.config?.accountId
    if (typeof appId === 'string' && appId.length > 0) state.managers.set(appId, manager)
    else state.managers.set('default', manager)
  } catch {
    /* ignore */
  }
}

/**
 * Install idempotent prototype hooks over the QQ SDK and the qqbot plugin's
 * SessionManager. Safe to call on every plugin (re)activation: the patches live
 * on the module prototypes and only consult the current bridge handler.
 *
 * @param {object} options
 * @param {any} options.QQBot - `QQBot` class from `@tencent-connect/qqbot-nodejs`.
 * @param {any} options.SessionManager - `SessionManager` class from the qqbot plugin.
 * @param {any} [options.logger] - logger used for one-time diagnostics.
 * @returns {{ patched: boolean }}
 */
export function installQqbotPatches({ QQBot, SessionManager, logger }) {
  const state = bridgeState()
  let installed = false

  if (SessionManager?.prototype !== undefined) {
    if (typeof SessionManager.prototype.registerScopePromptInjection === 'function') {
      const original = SessionManager.prototype.registerScopePromptInjection
      if (!original.__dshThinkWrapped) {
        const wrapped = function (...args) {
          rememberManager(state, this)
          return original.apply(this, args)
        }
        wrapped.__dshThinkWrapped = true
        SessionManager.prototype.registerScopePromptInjection = wrapped
        installed = true
      }
    }
    /** Any of these methods being called proves this manager instance is live. */
    for (const method of ['getOrCreate', 'getSessionRecord', 'findBySessionId', 'findByAgent']) {
      const original = SessionManager.prototype[method]
      if (typeof original !== 'function' || original.__dshThinkWrapped) continue
      const wrapped = function (...args) {
        rememberManager(state, this)
        return original.apply(this, args)
      }
      wrapped.__dshThinkWrapped = true
      SessionManager.prototype[method] = wrapped
      installed = true
    }
  }

  if (QQBot?.prototype !== undefined && typeof QQBot.prototype.emit === 'function') {
    if (!QQBot.prototype.emit.__dshThinkWrapped) {
      const original = QQBot.prototype.emit
      const wrapped = function (event, ...args) {
        if (event === 'message' && typeof state.handler === 'function') {
          const mCtx = args[0]
          const line = String(mCtx?.message?.content ?? '').trim()
          if (isThinkLine(line)) {
            return state.handler({ bot: this, mCtx, line }).catch((error) => {
              const message = error instanceof Error ? error.message : String(error)
              logLevel(logger, `QQ /think failed: ${message}`)
              return replyToQq({
                bot: this,
                mCtx,
                kind: 'error',
                text: `/think 执行失败: ${message}`,
              }).catch(() => undefined)
            })
          }
        }
        return original.apply(this, [event, ...args])
      }
      wrapped.__dshThinkWrapped = true
      QQBot.prototype.emit = wrapped
      installed = true
    }
    if (installed || state.patched) state.patched = true
  }

  return { patched: installed || state.patched }
}

/**
 * Resolve an installed package's directory and entry file without going through
 * Node's `exports` map (the QQ SDK exports only an `import` condition, which
 * `require.resolve` from a CommonJS-style loader rejects).
 *
 * @param {string} profile - profile directory.
 * @param {string} name - package name, e.g. `@tencent-connect/dsh-qqbot`.
 * @returns {{ packageDir: string, entry: string } | undefined}
 */
export function installedPackage(profile, name) {
  const packageDir = path.join(profile, 'node_modules', ...name.split('/'))
  const manifestPath = path.join(packageDir, 'package.json')
  if (!existsSync(manifestPath)) return undefined
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const entry = path.join(packageDir, manifest.module ?? manifest.main ?? 'index.js')
    return { packageDir, entry }
  } catch {
    return undefined
  }
}

/**
 * Resolve the qqbot SessionManager module inside an installed package.
 *
 * The plugin's build output moved between releases: 0.4.x published compiled
 * files under `dist/`, while 0.5.x ships them under `lib/` (where the package
 * manifest's `main` points). Probe next to the package entry first and keep
 * the historical layouts as fallbacks, so a qqbot upgrade cannot silently
 * disable the bridge by moving its files again.
 *
 * @param {{ packageDir: string, entry: string }} pkg - installed package.
 * @returns {string | undefined} existing module path, if any.
 */
export function sessionManagerModulePath(pkg) {
  const candidates = [
    path.join(path.dirname(pkg.entry), 'session', 'session-manager.js'),
    path.join(pkg.packageDir, 'lib', 'session', 'session-manager.js'),
    path.join(pkg.packageDir, 'dist', 'session', 'session-manager.js'),
  ]
  return candidates.find((candidate) => existsSync(candidate))
}

/** This plugin's package name, read from the package manifest beside this file. */
const SELF_PACKAGE = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).name
  } catch {
    return undefined
  }
})()

/** Real path of this package directory, used to identify the owning profile. */
function selfPackageDir() {
  try {
    return realpathSync(new URL('..', import.meta.url))
  } catch {
    return undefined
  }
}

/**
 * Resolve the profile directory that owns the installed qqbot packages.
 *
 * The Host process is often launched without `DSH_PROFILE` / `DSH_PROFILE_DIR`
 * (systemd runs `dsh --profile web` from an unrelated cwd), so fall back to
 * scanning `$DSH_HOME/profiles/*` for the profile that installed this package.
 *
 * @returns {string | null} absolute profile directory.
 */
function profileDir() {
  const explicit = process.env.DSH_PROFILE_DIR
  if (explicit !== undefined && explicit.length > 0) return explicit
  const profile = process.env.DSH_PROFILE
  if (profile !== undefined && profile.length > 0) {
    return path.join(homedir(), '.dsh', 'profiles', profile)
  }

  const home = process.env.DSH_HOME ?? path.join(homedir(), '.dsh')
  const profilesRoot = path.join(home, 'profiles')
  let profileDirs = []
  try {
    profileDirs = readdirSync(profilesRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(profilesRoot, entry.name))
  } catch {
    return null
  }

  const matches = []
  for (const dir of profileDirs) {
    const manifestPath = path.join(dir, 'package.json')
    if (!existsSync(manifestPath)) continue
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      const bundles = manifest.dsh?.profile?.bundles ?? []
      if (SELF_PACKAGE !== undefined && (manifest.dependencies?.[SELF_PACKAGE] !== undefined || bundles.includes(SELF_PACKAGE))) {
        matches.push(dir)
      }
    } catch {
      /* ignore unreadable profile manifests */
    }
  }
  if (matches.length === 1) return matches[0]
  if (matches.length > 1) {
    const selfDir = selfPackageDir()
    for (const dir of matches) {
      if (selfDir === undefined || SELF_PACKAGE === undefined) break
      try {
        if (realpathSync(path.join(dir, 'node_modules', SELF_PACKAGE)) === selfDir) return dir
      } catch {
        /* try the next candidate */
      }
    }
    return matches[0]
  }
  return profileDirs.length === 1 ? profileDirs[0] : null
}

/** Derive the deterministic Session id the qqbot plugin uses for a peer. */
export function derivedSessionId(appId, scope, peerId) {
  const hash = createHash('sha256').update(`qqbot:${appId}:${scope}:${peerId}`).digest('hex')
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`
}

/**
 * Resolve the peer's latest Session id from the qqbot plugin's own per-peer
 * preference file, which records the forked session after `/model`.
 *
 * @param {string} appId - QQ bot AppId.
 * @param {string} scope - `c2c` or `group`.
 * @param {string} peerId - sender OpenID (c2c) or group OpenID (group).
 * @returns {string | undefined} recorded durable Session id.
 */
function preferredSessionId(appId, scope, peerId) {
  try {
    const prefsPath = path.join(homedir(), '.dsh-qqbot', 'model-prefs.json')
    const data = JSON.parse(readFileSync(prefsPath, 'utf8'))
    const key = `qqbot:${appId}:${scope}:${peerId}`
    const sessionId = data?.sessionIds?.[key]
    if (typeof sessionId === 'string' && sessionId.length > 0) return sessionId
  } catch {
    /* no preference file yet */
  }
  return undefined
}

/** Best-effort Agent lookup when no SessionManager has been observed yet. */
function findAgentWithoutManager(ctx, appId, scope, peerId) {
  const agents = safeGet(ctx, 'agents')
  if (agents === undefined || typeof agents.get !== 'function') return undefined
  const preferred = preferredSessionId(appId, scope, peerId)
  for (const candidate of [preferred, derivedSessionId(appId, scope, peerId)]) {
    if (candidate === undefined) continue
    try {
      const agent = agents.get(candidate)
      if (agent !== undefined) return agent
    } catch {
      /* try the next candidate */
    }
  }
  return undefined
}

/** Send one plain command result back to the QQ peer. */
async function replyToQq({ bot, mCtx, text, kind }) {
  const target = mCtx?.replyTarget ?? mCtx?.message?.replyTarget
  if (text === undefined || text.length === 0) return
  const content = kind === 'error' && !text.startsWith('❌') ? `❌ ${text}` : text
  try {
    await bot.sendMarkdown(target, content)
  } catch (error) {
    try {
      await bot.sendText(target, content)
    } catch {
      throw error
    }
  }
}

/**
 * Whether the QQ plugin records an explicit per-peer `/model` override for this
 * peer. The QQ plugin keeps that flag next to the route it forked for; reach it
 * defensively because it is an internal (version-pinned) seam.
 *
 * @param {any} manager - captured QQ SessionManager, when one was observed.
 * @param {'c2c' | 'group'} scope - chat scope.
 * @param {string} peerId - peer identity inside that scope.
 * @param {string | undefined} appId - bot AppId, used only when the manager
 *   exposes no `sessionKey` helper.
 * @returns {boolean} true when an explicit override exists.
 */
function explicitQqModelOverride(manager, scope, peerId, appId) {
  if (manager === undefined) return false
  const key =
    typeof manager.sessionKey === 'function'
      ? manager.sessionKey(scope, peerId)
      : appId === undefined
        ? undefined
        : `qqbot:${appId}:${scope}:${peerId}`
  if (typeof key !== 'string') return false
  const resolver = manager.modelResolver
  return typeof resolver?.hasOverride === 'function' ? resolver.hasOverride(key) === true : false
}

/**
 * Handle one intercepted `/think` line on the QQ channel.
 *
 * @param {object} options
 * @param {object} options.ctx - Host context.
 * @param {any} options.bot - live QQBot instance.
 * @param {any} options.mCtx - inbound middleware context.
 * @param {string} options.line - complete slash line.
 * @param {Map<string, any>} options.managers - captured SessionManagers by appId.
 * @param {any} [options.logger] - logger.
 */
export async function handleQqThink({ ctx, bot, mCtx, line, managers, logger }) {
  const message = mCtx?.message
  if (message === undefined) return
  const scope = message.kind === 'group' ? 'group' : 'c2c'
  const peerId = scope === 'group' ? (message.groupOpenid ?? message.senderId) : message.senderId
  if (typeof peerId !== 'string' || peerId.length === 0) return

  const manager = managers.get(bot?.appId) ?? managers.get('default') ?? [...managers.values()][0]
  let agent
  if (manager !== undefined) {
    try {
      const record =
        manager.getSessionRecord?.(scope, peerId) ??
        (await manager.getOrCreate(scope, peerId, message.senderId, mCtx.replyTarget ?? message.replyTarget))
      agent = record?.agent
    } catch (error) {
      logLevel(logger, `QQ /think could not resolve the peer session: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (agent === undefined) agent = findAgentWithoutManager(ctx, bot?.appId, scope, peerId)

  if (agent === undefined) {
    await replyToQq({
      bot,
      mCtx,
      kind: 'error',
      text: '当前还没有活跃的 QQ 会话。请先发送一条普通消息，再使用 /think。',
    })
    return
  }

  // The QQ plugin's own per-peer route is authoritative only when the peer has
  // an explicit `/model` override: after `/model` it forked a Session whose
  // inherited request headers still name the previous model, so resolving from
  // the Session alone would target the wrong model's level list. Without an
  // override the Session's own route (including an earlier `/think` selection)
  // is the truth.
  let peerRoute
  try {
    if (explicitQqModelOverride(manager, scope, peerId, bot?.appId)) {
      const candidate = manager?.getEffectiveModel?.(scope, peerId)
      if (
        typeof candidate?.provider === 'string' &&
        candidate.provider.length > 0 &&
        typeof candidate.model === 'string' &&
        candidate.model.length > 0
      ) {
        peerRoute = { provider: candidate.provider, model: candidate.model }
      }
    }
  } catch {
    /* fall back to the Session's own route */
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), QQ_COMMAND_TIMEOUT_MS)
  let execution
  try {
    execution = await invocationChannel.run(
      { channel: 'qq', ...(peerRoute === undefined ? {} : { route: peerRoute }) },
      () => ctx.commands.execute(agent, line, [], controller.signal),
    )
  } finally {
    clearTimeout(timer)
  }

  if (execution === undefined) {
    await replyToQq({
      bot,
      mCtx,
      kind: 'error',
      text: `未识别的指令 ${line.split(/\s+/)[0]}。`,
    })
    return
  }

  await replyToQq({
    bot,
    mCtx,
    text: execution.result.text,
    kind: execution.result.kind,
  })
}

/**
 * Load the installed QQ packages and install the `/think` bridge. Failure is a
 * warning, never a plugin failure: Web/CLI command support must still work.
 *
 * @param {object} ctx - Host context.
 * @param {any} logger - Host logger.
 * @returns {Promise<((payload: object) => Promise<void>) | null>} the live handler, or null when unavailable.
 */
async function installQqbotBridge(ctx, logger) {
  const dir = profileDir()
  if (dir === null) {
    logLevel(logger, 'no profile directory; QQ bridge skipped')
    writeBridgeStatus({ ok: false, reason: 'no profile directory' })
    return null
  }

  const sdkPackage = installedPackage(dir, '@tencent-connect/qqbot-nodejs')
  if (sdkPackage === undefined) {
    logLevel(logger, 'qqbot SDK not installed in profile; QQ bridge skipped')
    writeBridgeStatus({ ok: false, reason: 'qqbot SDK not installed' })
    return null
  }
  const qqbotPackage = installedPackage(dir, '@tencent-connect/dsh-qqbot')
  if (qqbotPackage === undefined) {
    logLevel(logger, 'dsh-qqbot not installed in profile; QQ bridge skipped')
    writeBridgeStatus({ ok: false, reason: 'dsh-qqbot not installed' })
    return null
  }

  const sdk = await import(pathToFileURL(sdkPackage.entry).href)
  if (typeof sdk.QQBot !== 'function') {
    throw new Error(`QQBot export missing from ${sdkPackage.entry}`)
  }

  const sessionManagerPath = sessionManagerModulePath(qqbotPackage)
  if (sessionManagerPath === undefined) {
    logLevel(logger, 'qqbot SessionManager module not found; QQ bridge skipped')
    writeBridgeStatus({ ok: false, reason: 'qqbot SessionManager module not found' })
    return null
  }
  const sessionModule = await import(pathToFileURL(sessionManagerPath).href)
  if (typeof sessionModule.SessionManager !== 'function') {
    throw new Error(`SessionManager export missing from ${sessionManagerPath}`)
  }

  const result = installQqbotPatches({
    QQBot: sdk.QQBot,
    SessionManager: sessionModule.SessionManager,
    logger,
  })

  const state = bridgeState()
  const handler = (payload) => handleQqThink({ ...payload, ctx, managers: state.managers, logger })

  writeBridgeStatus({
    ok: true,
    patched: result.patched,
    qqChips: true,
    profile: dir,
    sdk: sdkPackage.entry,
    sessionManager: sessionManagerPath,
  })
  logLevel(logger, `QQ bridge ready (patched=${result.patched}) — /think works on the QQ bot channel`)
  return handler
}

/* ------------------------------------------------------------------ *
 * Plugin entry
 * ------------------------------------------------------------------ */

/**
 * Register `/think` for every command adapter and bridge the QQ bot channel.
 *
 * @param {object} ctx - Host context carrying `commands` and `llm`.
 */
export function apply(ctx) {
  const logger = safeGet(ctx, 'logger')
  const owner = {}

  /** Drop the bridge handler only when this plugin generation still owns it. */
  const retire = () => {
    const state = bridgeState()
    if (state.owner === owner) {
      state.handler = null
      state.owner = null
    }
  }

  ctx.effect(function* () {
    yield retire
    yield ctx.commands.register({
      name: 'think',
      description: '查看或切换当前会话的思考（推理）等级，如 /think low',
      input: { hint: '等级（如 off / low / high，可用中文；以当前模型开放为准）' },
      handler: (invocation) => executeThink(ctx, invocation),
    })
  }, 'command-think lifecycle')

  // Fire-and-forget: command registration is synchronous and must not depend on
  // the QQ bridge importing successfully.
  ctx.effect(() => {
    let cancelled = false
    void installQqbotBridge(ctx, logger)
      .then((handler) => {
        if (cancelled || handler === null) return
        const state = bridgeState()
        state.handler = handler
        state.owner = owner
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        logLevel(logger, `QQ bridge install failed: ${message}`)
        writeBridgeStatus({ ok: false, reason: message })
      })
    return () => {
      cancelled = true
      retire()
    }
  }, 'command-think qqbot bridge')
}
