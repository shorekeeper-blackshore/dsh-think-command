/**
 * Offline verification for the /think plugin:
 *  1. pure command core: listing, aliasing, switching through the fallback seam
 *  2. QQ bridge: real QQBot/SessionManager prototypes from the installed profile
 *     are patched; emit('message', /think) is intercepted and the normal
 *     message listener is skipped; SessionManager construction is captured.
 *
 * Run: node --import ./test/register-resolve-hook.mjs test/qq-bridge.test.mjs
 *
 * The QQ half needs a profile with @tencent-connect/dsh-qqbot installed and the
 * dsh install path resolvable; override with DSH_PROFILE_DIR / DSH_ANCHOR.
 */
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'

// The plugin writes a bridge diagnostic file on activation; keep the offline
// run from clobbering the running Host's file (which names the live pid).
process.env.DSH_THINK_STATUS_DIR ??= mkdtempSync(path.join(tmpdir(), 'dsh-think-status-'))

const PROFILE_DIR =
  process.env.DSH_PROFILE_DIR ??
  path.join(
    process.env.DSH_HOME ?? path.join(homedir(), '.dsh'),
    'profiles',
    process.env.DSH_PROFILE ?? 'web',
  )
const plugin = await import(
  pathToFileURL(path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../lib/impl.js')).href
)
const sdkPackage = plugin.installedPackage(PROFILE_DIR, '@tencent-connect/qqbot-nodejs')
const qqbotPackage = plugin.installedPackage(PROFILE_DIR, '@tencent-connect/dsh-qqbot')
const sdk = await import(pathToFileURL(sdkPackage.entry).href)
const sessionManagerPath = plugin.sessionManagerModulePath(qqbotPackage)
assert.ok(sessionManagerPath, 'the installed qqbot package exposes a SessionManager module')
const sm = await import(pathToFileURL(sessionManagerPath).href)
const sessionIds = await import(
  pathToFileURL(path.join(path.dirname(sessionManagerPath), 'session-id.js')).href
)

let failures = 0
const check = (name, fn) => {
  try {
    fn()
    console.log(`✓ ${name}`)
  } catch (error) {
    failures += 1
    console.error(`✗ ${name}\n  ${error instanceof Error ? error.stack : String(error)}`)
  }
}
const checkAsync = async (name, fn) => {
  try {
    await fn()
    console.log(`✓ ${name}`)
  } catch (error) {
    failures += 1
    console.error(`✗ ${name}\n  ${error instanceof Error ? error.stack : String(error)}`)
  }
}

// ── fake Host context for the command core ─────────────────────────────
/** DeepSeek official: off / low / high / max. */
const REASONING = {
  efforts: [
    { id: 'off', name: 'Off', description: '关闭思考' },
    { id: 'low', name: 'Low' },
    { id: 'high', name: 'High' },
    { id: 'max', name: 'Max' },
  ],
  defaultEffort: 'high',
}

/** MiMo (xiaomi, llm-pi-ai): off / minimal / low / medium / high, no default. */
const MIMO_REASONING = {
  efforts: [
    { id: 'off', name: 'Off' },
    { id: 'minimal', name: 'Minimal' },
    { id: 'low', name: 'Low' },
    { id: 'medium', name: 'Medium' },
    { id: 'high', name: 'High' },
  ],
}

/** A model that can only turn thinking off. */
const OFF_ONLY_REASONING = { efforts: [{ id: 'off', name: 'Off' }], defaultEffort: 'off' }

function makeAgent({ route = { provider: 'deepseek-official', model: 'deepseek-flash' } } = {}) {
  const appended = []
  return {
    options: { ...route },
    session: {
      id: 'session-1',
      append: (type, data) => appended.push({ type, data }),
      requestHeader: () => undefined,
      appended,
    },
  }
}

function makeCtx({ controller, reasoning = REASONING, projection, route = { provider: 'deepseek-official', model: 'deepseek-flash' } } = {}) {
  const calls = { resolveCallConfig: [], resolveModelInfo: [] }
  return {
    calls,
    get(key) {
      if (key === 'sessionProjections') return { stateOf: () => projection }
      if (key === 'sessionController') return controller
      if (key === 'agentDefaultModel') return { currentSelection: () => route }
      return undefined
    },
    llm: {
      async resolveModelInfo(provider, model) {
        calls.resolveModelInfo.push([provider, model])
        return { provider, model, reasoning }
      },
      async resolveCallConfig(config) {
        calls.resolveCallConfig.push(config)
        return { ...config }
      },
    },
  }
}

check('exports the expected plugin shape', () => {
  assert.equal(plugin.name, 'command-think')
  assert.ok(plugin.inject.includes('commands'))
  assert.equal(typeof plugin.apply, 'function')
})

await checkAsync('derivedSessionId matches the qqbot plugin derivation', async () => {
  const manager = new sm.SessionManager(
    { on() {}, get() {}, effect() {} },
    { appId: 'app-123', sessionIdleTimeout: 1000 },
    { appId: 'app-123' },
    { info() {}, warn() {}, debug() {}, error() {} },
  )
  const derive =
    typeof manager.deriveSessionId === 'function'
      ? manager.deriveSessionId.bind(manager)
      : sessionIds.legacyDerivedSessionId
  const expected = derive('qqbot:app-123:c2c:peer-1')
  assert.equal(plugin.derivedSessionId('app-123', 'c2c', 'peer-1'), expected)
  manager.evictor?.dispose?.()
})

check('sessionManagerModulePath supports both lib/ (entry) and dist/ layouts', () => {
  /** Create an empty fixture file and return its absolute path. */
  const touch = (root, relative) => {
    const file = path.join(root, relative)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, '')
    return file
  }

  // qqbot 0.5.x: the package entry is lib/index.js and the module sits beside it.
  const libRoot = mkdtempSync(path.join(tmpdir(), 'dsh-qqbot-layout-'))
  const libEntry = touch(libRoot, 'lib/index.js')
  const libModule = touch(libRoot, 'lib/session/session-manager.js')
  assert.equal(
    plugin.sessionManagerModulePath({ packageDir: libRoot, entry: libEntry }),
    libModule,
  )

  // qqbot 0.4.x published the same files under dist/.
  const distRoot = mkdtempSync(path.join(tmpdir(), 'dsh-qqbot-layout-'))
  const distEntry = touch(distRoot, 'dist/index.js')
  const distModule = touch(distRoot, 'dist/session/session-manager.js')
  assert.equal(
    plugin.sessionManagerModulePath({ packageDir: distRoot, entry: distEntry }),
    distModule,
  )
})

await checkAsync('bridge install patches the real QQBot/SessionManager prototypes', async () => {
  const logger = { info() {}, warn() {}, error() {}, debug() {} }
  const result = plugin.installQqbotPatches({
    QQBot: sdk.QQBot,
    SessionManager: sm.SessionManager,
    logger,
  })
  assert.equal(result.patched, true)
  assert.equal(sdk.QQBot.prototype.emit.__dshThinkWrapped, true)
  assert.equal(sm.SessionManager.prototype.getOrCreate.__dshThinkWrapped, true)
})

await checkAsync('SessionManager construction captures the live manager', async () => {
  const factory = { appId: 'capture-app' }
  const manager = new sm.SessionManager(
    { on() {}, get() {}, effect() {} },
    { appId: 'capture-app', sessionIdleTimeout: 1000 },
    factory,
    { info() {}, warn() {}, debug() {}, error() {} },
  )
  const state = globalThis[Symbol.for('dsh-think-command.qqbot-bridge')]
  assert.equal(state.managers.get('capture-app'), manager)
  manager.evictor?.dispose?.()
})

await checkAsync('QQ emit("/think") is intercepted and skips the message listener', async () => {
  const state = globalThis[Symbol.for('dsh-think-command.qqbot-bridge')]
  const bot = new sdk.QQBot({ appId: 'app-qq', appSecret: 'secret' })
  let normalListenerCalls = 0
  bot.on('message', () => {
    normalListenerCalls += 1
  })

  let intercepted = null
  state.handler = async ({ bot: botArg, mCtx, line }) => {
    intercepted = { bot: botArg === bot, line, content: mCtx.message.content }
  }

  const replyTarget = { scope: 'c2c', targetId: 'peer-1', msgId: 'msg-1' }
  await bot.emit('message', { bot, message: { content: '/think low', kind: 'c2c', senderId: 'peer-1' }, replyTarget })
  assert.equal(normalListenerCalls, 0)
  assert.deepEqual(intercepted, { bot: true, line: '/think low', content: '/think low' })

  // non-/think lines still reach the normal listener
  await bot.emit('message', { bot, message: { content: 'hello', kind: 'c2c', senderId: 'peer-1' }, replyTarget })
  assert.equal(normalListenerCalls, 1)

  // no handler (plugin inactive) → line falls through again
  state.handler = null
  await bot.emit('message', { bot, message: { content: '/think', kind: 'c2c', senderId: 'peer-1' }, replyTarget })
  assert.equal(normalListenerCalls, 2)
})

await checkAsync('handleQqThink resolves the peer Agent and replies with the command text', async () => {
  const agent = makeAgent()
  const replies = []
  const manager = {
    records: new Map(),
    getSessionRecord(scope, peerId) {
      return scope === 'c2c' && peerId === 'peer-9' ? { agent } : undefined
    },
    async getOrCreate() {
      throw new Error('should not create when a record exists')
    },
  }
  const ctx = {
    commands: {
      async execute(gotAgent, line) {
        assert.equal(gotAgent, agent)
        assert.equal(line, '/think max')
        return { commandId: 'c1', result: { kind: 'success', text: '✅ switched to max' } }
      },
    },
  }
  const bot = { appId: 'app-9', async sendMarkdown(target, content) { replies.push([target, content]) } }
  const mCtx = {
    message: { content: '/think max', kind: 'c2c', senderId: 'peer-9' },
    replyTarget: { scope: 'c2c', targetId: 'peer-9', msgId: 'm1' },
  }
  await plugin.handleQqThink({ ctx, bot, mCtx, line: '/think max', managers: new Map([['app-9', manager]]), logger: {} })
  assert.equal(replies.length, 1)
  assert.equal(replies[0][1], '✅ switched to max')
})

await checkAsync('handleQqThink asks for a first message when no session exists', async () => {
  const replies = []
  const ctx = { commands: { async execute() { throw new Error('must not run') } } }
  const bot = { appId: 'app-x', async sendMarkdown(target, content) { replies.push(content) } }
  const mCtx = { message: { content: '/think', kind: 'c2c', senderId: 'nobody' }, replyTarget: {} }
  await plugin.handleQqThink({ ctx, bot, mCtx, line: '/think', managers: new Map(), logger: {} })
  assert.match(replies[0], /先发送一条普通消息/)
})

// ── command core through the registered handler ────────────────────────
async function invokeWith(ctx, invocation) {
  activeCtx = ctx
  const handler = captured.handler
  assert.ok(handler, 'command handler was captured')
  return handler(invocation)
}

let captured = {}
let activeCtx = makeCtx()
const logger = { info() {}, warn() {}, error() {}, debug() {} }
const applyCtx = {
  get(key) {
    if (key === 'logger') return logger
    return activeCtx.get(key)
  },
  get llm() {
    return activeCtx.llm
  },
  effect(factory) {
    const produced = factory()
    if (typeof produced !== 'function') {
      for (const value of produced) {
        if (typeof value === 'function') value()
        else if (value !== undefined) captured.disposer = value
      }
    }
    return () => {}
  },
  commands: {
    register(definition) {
      captured.handler = definition.handler
      captured.definition = definition
      return () => {}
    },
    execute: async (...args) => activeCtx.commands.execute(...args),
  },
}
plugin.apply(applyCtx)

await checkAsync('/think lists the current level and every switchable level', async () => {
  const ctx = makeCtx()
  const agent = makeAgent()
  const result = await invokeWith(ctx, { agent, rawInput: '', signal: new AbortController().signal })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /当前: high/)
  assert.match(result.text, /• high: High — 高/)
  assert.match(result.text, /• off: Off — 关闭思考/)
  assert.match(result.text, /\/think <等级>/)
})

await checkAsync('/think low validates and records the selection (fallback seam)', async () => {
  const ctx = makeCtx()
  const agent = makeAgent()
  const result = await invokeWith(ctx, { agent, rawInput: ' low ', signal: new AbortController().signal })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /思考等级已切换为 low/)
  assert.deepEqual(ctx.calls.resolveCallConfig[0], {
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    reasoningEffort: 'low',
  })
  assert.deepEqual(agent.session.appended[0], {
    type: 'model/selection',
    data: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low' },
  })
  assert.equal(agent.options.reasoningEffort, 'low')
})

await checkAsync('/think 高 uses the Chinese alias', async () => {
  const ctx = makeCtx()
  const agent = makeAgent()
  const result = await invokeWith(ctx, { agent, rawInput: ' 高 ', signal: new AbortController().signal })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /思考等级已切换为 high/)
})

await checkAsync('/think shows the newly selected level as current', async () => {
  const ctx = makeCtx()
  const agent = makeAgent()
  await invokeWith(ctx, { agent, rawInput: 'max', signal: new AbortController().signal })
  const result = await invokeWith(ctx, { agent, rawInput: '', signal: new AbortController().signal })
  assert.match(result.text, /当前: max/)
})

await checkAsync('/think <unknown> lists the available levels', async () => {
  const ctx = makeCtx()
  const result = await invokeWith(ctx, { agent: makeAgent(), rawInput: 'turbo', signal: new AbortController().signal })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /不支持的思考等级 "turbo"/)
  assert.match(result.text, /• max: Max/)
})

/**
 * Drive one QQ `/think` line through the bridge with a fake
 * `commands.execute` that delegates to the real registered handler, the same
 * way the live host dispatches it.
 */
async function qqRoundTrip(ctx, line) {
  activeCtx = ctx
  const agent = makeAgent()
  const replies = []
  const commandCtx = {
    ...ctx,
    commands: {
      async execute(gotAgent, gotLine) {
        const rawInput = gotLine.replace(/^\/think(?:\s+|$)/, '')
        const result = await captured.handler({
          agent: gotAgent,
          rawInput,
          signal: new AbortController().signal,
        })
        return { commandId: 'qq-1', result }
      },
    },
  }
  const manager = {
    getSessionRecord: (scope, peerId) =>
      scope === 'c2c' && peerId === 'peer-7' ? { agent } : undefined,
    async getOrCreate() {
      throw new Error('should not create when a record exists')
    },
  }
  const bot = {
    appId: 'app-7',
    async sendMarkdown(target, content) {
      replies.push([target, content])
    },
  }
  const mCtx = {
    message: { content: line, kind: 'c2c', senderId: 'peer-7' },
    replyTarget: { scope: 'c2c', targetId: 'peer-7', msgId: 'm7' },
  }
  await plugin.handleQqThink({
    ctx: commandCtx,
    bot,
    mCtx,
    line,
    managers: new Map([['app-7', manager]]),
    logger: {},
  })
  return replies
}

await checkAsync('QQ /think lists clickable command-input chips (like /model)', async () => {
  const replies = await qqRoundTrip(makeCtx(), '/think')
  assert.equal(replies.length, 1)
  const text = replies[0][1]
  assert.match(text, /### 🧠 思考等级/)
  assert.match(text, /<qqbot-cmd-input text="\/think off" show="\/think off（关闭思考）"\/>/)
  assert.match(text, /<qqbot-cmd-input text="\/think high" show="\/think high（高）"\/>/)
  assert.match(text, /点击填入输入框/)
  assert.ok(!text.includes('• high: High'), 'QQ reply must not carry the Web bullet list')
})

await checkAsync('QQ /think <unknown> offers clickable levels instead of plain bullets', async () => {
  const replies = await qqRoundTrip(makeCtx(), '/think turbo')
  const text = replies[0][1]
  assert.match(text, /^❌ 不支持的思考等级 "turbo"/)
  assert.match(text, /<qqbot-cmd-input text="\/think max"/)
  assert.ok(!text.includes('• max: Max'))
})

await checkAsync('session-controller seam is used when the Host exposes it', async () => {
  const ctx = makeCtx()
  const agent = makeAgent()
  let applied
  ctx.get = (key) => {
    if (key === 'sessionController') {
      return {
        agents: {
          selectForNextRequest(gotAgent, selection) {
            applied = { gotAgent, selection }
          },
        },
      }
    }
    if (key === 'sessionProjections') return { stateOf: () => undefined }
    return undefined
  }
  const result = await invokeWith(ctx, { agent, rawInput: 'off', signal: new AbortController().signal })
  assert.equal(result.kind, 'success')
  assert.equal(applied.gotAgent, agent)
  assert.deepEqual(applied.selection, {
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    reasoningEffort: 'off',
  })
})

await checkAsync('no reasoning metadata reports a model that cannot switch', async () => {
  const ctx = makeCtx()
  ctx.llm.resolveModelInfo = async (provider, model) => ({ provider, model })
  const result = await invokeWith(ctx, { agent: makeAgent(), rawInput: 'low', signal: new AbortController().signal })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /没有开放思考等级/)
})

// ── cross-model level fitting (DeepSeek vs MiMo vocabularies) ─────────
const MIMO_ROUTE = { provider: 'xiaomi', model: 'mimo-v2.6-flash' }
const DEEPSEEK_ROUTE = { provider: 'deepseek-official', model: 'deepseek-flash' }

async function switchWith({ reasoning, route, agentRoute, rawInput }) {
  const ctx = makeCtx({ reasoning, route })
  const agent = makeAgent({ route: agentRoute ?? route })
  const result = await invokeWith(ctx, { agent, rawInput, signal: new AbortController().signal })
  return { ctx, agent, result }
}

await checkAsync('MiMo: /think 最低 (a level only MiMo has) switches to minimal', async () => {
  const { ctx, agent, result } = await switchWith({ reasoning: MIMO_REASONING, route: MIMO_ROUTE, rawInput: '最低' })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /切换为 minimal/)
  assert.deepEqual(ctx.calls.resolveCallConfig[0], { ...MIMO_ROUTE, reasoningEffort: 'minimal' })
  assert.equal(agent.options.reasoningEffort, 'minimal')
})

await checkAsync('MiMo: /think 中 picks its medium level', async () => {
  const { agent, result } = await switchWith({ reasoning: MIMO_REASONING, route: MIMO_ROUTE, rawInput: '中' })
  assert.match(result.text, /切换为 medium/)
  assert.equal(agent.options.reasoningEffort, 'medium')
})

await checkAsync('MiMo: /think 最高 (DeepSeek naming) fits the highest available level', async () => {
  const { agent, result } = await switchWith({ reasoning: MIMO_REASONING, route: MIMO_ROUTE, rawInput: '最高' })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /切换为 high/)
  assert.match(result.text, /当前模型没有「最高」这一档/)
  assert.equal(agent.options.reasoningEffort, 'high')
})

await checkAsync('MiMo: /think max (a DeepSeek-only id) fits instead of erroring', async () => {
  const { agent, result } = await switchWith({ reasoning: MIMO_REASONING, route: MIMO_ROUTE, rawInput: 'max' })
  assert.match(result.text, /切换为 high/)
  assert.equal(agent.options.reasoningEffort, 'high')
})

await checkAsync('MiMo: /think 高 still resolves exactly to high', async () => {
  const { result } = await switchWith({ reasoning: MIMO_REASONING, route: MIMO_ROUTE, rawInput: '高' })
  assert.match(result.text, /切换为 high/)
  assert.ok(!result.text.includes('当前模型没有'))
})

await checkAsync('DeepSeek: /think 中 fits to high (DeepSeek has no medium)', async () => {
  const { agent, result } = await switchWith({ reasoning: REASONING, route: DEEPSEEK_ROUTE, rawInput: '中' })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /切换为 high/)
  assert.match(result.text, /当前模型没有「中」这一档/)
  assert.equal(agent.options.reasoningEffort, 'high')
})

await checkAsync('DeepSeek: /think 最低 fits to low', async () => {
  const { agent, result } = await switchWith({ reasoning: REASONING, route: DEEPSEEK_ROUTE, rawInput: '最低' })
  assert.match(result.text, /切换为 low/)
  assert.equal(agent.options.reasoningEffort, 'low')
})

await checkAsync('DeepSeek: /think on resolves through the model default', async () => {
  const { agent, result } = await switchWith({ reasoning: REASONING, route: DEEPSEEK_ROUTE, rawInput: '思考' })
  assert.match(result.text, /切换为 high/)
  assert.equal(agent.options.reasoningEffort, 'high')
})

await checkAsync('/think 默认 clears the explicit level', async () => {
  const ctx = makeCtx({ reasoning: MIMO_REASONING, route: MIMO_ROUTE })
  const agent = makeAgent({ route: MIMO_ROUTE })
  agent.options.reasoningEffort = 'medium'
  const result = await invokeWith(ctx, { agent, rawInput: '默认', signal: new AbortController().signal })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /已恢复模型默认思考等级/)
  assert.deepEqual(agent.session.appended[0], { type: 'model/selection', data: { ...MIMO_ROUTE } })
  assert.equal(agent.options.reasoningEffort, undefined)
})

await checkAsync('/think listing fits MiMo levels and shows the cross-model hint', async () => {
  const ctx = makeCtx({ reasoning: MIMO_REASONING, route: MIMO_ROUTE })
  const agent = makeAgent({ route: MIMO_ROUTE })
  const result = await invokeWith(ctx, { agent, rawInput: '', signal: new AbortController().signal })
  assert.match(result.text, /• minimal: Minimal — 最低/)
  assert.match(result.text, /• medium: Medium — 中/)
  assert.match(result.text, /不同模型开放的等级不同/)
  assert.doesNotMatch(result.text, /• max:/)
})

await checkAsync('/think flags a level inherited from another model as unsupported', async () => {
  const projection = { pending: { ...MIMO_ROUTE, reasoningEffort: 'max' }, lastUsed: null }
  const ctx = makeCtx({ reasoning: MIMO_REASONING, route: MIMO_ROUTE, projection })
  const agent = makeAgent({ route: MIMO_ROUTE })
  const result = await invokeWith(ctx, { agent, rawInput: '', signal: new AbortController().signal })
  assert.match(result.text, /当前: max ⚠️/)
  assert.match(result.text, /\/think 默认 清除/)
})

await checkAsync('a model that only offers off reports no switchable level', async () => {
  const { result } = await switchWith({ reasoning: OFF_ONLY_REASONING, route: MIMO_ROUTE, rawInput: 'low' })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /只开放手动关闭思考/)
})

await checkAsync('QQ /think 最低 switches on the MiMo channel too', async () => {
  const ctx = makeCtx({ reasoning: MIMO_REASONING, route: MIMO_ROUTE })
  const replies = await qqRoundTrip(ctx, '/think 最低')
  assert.equal(replies.length, 1)
  assert.match(replies[0][1], /切换为 minimal/)
})

await checkAsync('QQ /think targets the peer route reported by the QQ plugin after /model', async () => {
  // The QQ plugin switches models by forking a Session, so its inherited
  // request headers still describe the old model. The bridge must use the
  // QQ plugin's own per-peer route instead of the stale Session projection.
  const ctx = makeCtx({ reasoning: MIMO_REASONING, route: MIMO_ROUTE })
  const applied = []
  ctx.get = (key) => {
    if (key === 'sessionController') {
      return { agents: { selectForNextRequest: (_agent, selection) => applied.push(selection) } }
    }
    if (key === 'sessionProjections') {
      return { stateOf: () => ({ pending: null, lastUsed: { ...DEEPSEEK_ROUTE, reasoningEffort: 'max' } }) }
    }
    if (key === 'agentDefaultModel') return { currentSelection: () => DEEPSEEK_ROUTE }
    return undefined
  }
  activeCtx = ctx
  const agent = makeAgent({ route: DEEPSEEK_ROUTE })
  const manager = {
    getSessionRecord: (scope, peerId) => (scope === 'c2c' && peerId === 'peer-route' ? { agent } : undefined),
    getEffectiveModel: (scope, peerId) => (scope === 'c2c' && peerId === 'peer-route' ? MIMO_ROUTE : undefined),
    sessionKey: (scope, peerId) => `qqbot:app-route:${scope}:${peerId}`,
    modelResolver: { hasOverride: () => true },
  }
  const commandCtx = {
    ...ctx,
    commands: {
      async execute(gotAgent, gotLine) {
        const rawInput = gotLine.replace(/^\/think(?:\s+|$)/, '')
        const result = await captured.handler({
          agent: gotAgent,
          rawInput,
          signal: new AbortController().signal,
        })
        return { commandId: 'qq-route', result }
      },
    },
  }
  const replies = []
  const bot = { appId: 'app-route', async sendMarkdown(target, content) { replies.push([target, content]) } }
  const mCtx = {
    message: { content: '/think 最低', kind: 'c2c', senderId: 'peer-route' },
    replyTarget: { scope: 'c2c', targetId: 'peer-route', msgId: 'mr' },
  }
  await plugin.handleQqThink({
    ctx: commandCtx,
    bot,
    mCtx,
    line: '/think 最低',
    managers: new Map([['app-route', manager]]),
    logger: {},
  })
  assert.equal(replies.length, 1)
  assert.match(replies[0][1], /切换为 minimal/)
  assert.deepEqual(applied, [{ ...MIMO_ROUTE, reasoningEffort: 'minimal' }])
})

await checkAsync('QQ /think keeps its own selection while no /model override exists', async () => {
  // The Web picker can move the global default after a QQ Session started; the
  // active Session's own route must win over that default when the peer has no
  // explicit /model override.
  const ctx = makeCtx({ reasoning: MIMO_REASONING, route: MIMO_ROUTE })
  const applied = []
  ctx.get = (key) => {
    if (key === 'sessionController') {
      return { agents: { selectForNextRequest: (_agent, selection) => applied.push(selection) } }
    }
    if (key === 'sessionProjections') {
      return { stateOf: () => ({ pending: null, lastUsed: { ...MIMO_ROUTE, reasoningEffort: 'medium' } }) }
    }
    if (key === 'agentDefaultModel') return { currentSelection: () => DEEPSEEK_ROUTE }
    return undefined
  }
  activeCtx = ctx
  const agent = makeAgent({ route: MIMO_ROUTE })
  const manager = {
    getSessionRecord: (scope, peerId) => (scope === 'c2c' && peerId === 'peer-keep' ? { agent } : undefined),
    // The QQ plugin would fall back to the (now DeepSeek) global default here.
    getEffectiveModel: () => DEEPSEEK_ROUTE,
    sessionKey: (scope, peerId) => `qqbot:app-keep:${scope}:${peerId}`,
    modelResolver: { hasOverride: () => false },
  }
  const commandCtx = {
    ...ctx,
    commands: {
      async execute(gotAgent, gotLine) {
        const rawInput = gotLine.replace(/^\/think(?:\s+|$)/, '')
        const result = await captured.handler({
          agent: gotAgent,
          rawInput,
          signal: new AbortController().signal,
        })
        return { commandId: 'qq-keep', result }
      },
    },
  }
  const replies = []
  const bot = { appId: 'app-keep', async sendMarkdown(target, content) { replies.push([target, content]) } }
  const mCtx = {
    message: { content: '/think 高', kind: 'c2c', senderId: 'peer-keep' },
    replyTarget: { scope: 'c2c', targetId: 'peer-keep', msgId: 'mk' },
  }
  await plugin.handleQqThink({
    ctx: commandCtx,
    bot,
    mCtx,
    line: '/think 高',
    managers: new Map([['app-keep', manager]]),
    logger: {},
  })
  assert.equal(replies.length, 1)
  assert.deepEqual(applied, [{ ...MIMO_ROUTE, reasoningEffort: 'high' }])
})

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nall checks passed')
}
process.exit(process.exitCode ?? 0)
