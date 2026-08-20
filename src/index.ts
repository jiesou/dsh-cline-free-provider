import type { Context } from '@deepseek-ai/cordis'
import { LlmError, assertUsableApiKey, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter, type ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { createProvider, type Api, type Context as PiContext, type Model, type ProviderStreams, type ThinkingLevelMap } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'

export const name = 'cline-free-provider'
export const inject = ['llm', 'settings']

const NS = settingsNamespace('cline-free-provider')
const PROVIDER = 'cline'

interface ReasoningMetadata {
  supportedEfforts?: string[]
  mandatory?: boolean
}

interface ClineModel {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  reasoning?: ReasoningMetadata
}

export interface Config {
  apiKeyEnv?: string
  baseURL?: string
  defaultMaxTokens?: number
  defaultContextWindow?: number
}

export const Config: z<Config> = z.object({
  apiKeyEnv: z.string().role('credential-ref').default('CLINE_API_KEY'),
  baseURL: z.string().default('https://api.cline.bot/api/v1'),
  defaultMaxTokens: z.number().step(1).min(1).default(32_768),
  defaultContextWindow: z.number().step(1).min(1).default(262_144),
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

async function fetchJson(url: string, timeoutMs: number, label: string, fetchImpl: typeof fetch = fetch): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) {
      throw new Error(`${label} endpoint answered HTTP ${response.status}`)
    }
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchFreeModels(
  url: string = 'https://api.cline.bot/api/v1/ai/cline/models',
  fetchImpl: typeof fetch = fetch,
): Promise<ClineModel[]> {
  const payload = await fetchJson(url, 30_000, 'Cline models', fetchImpl)
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error('Cline models endpoint returned an unexpected shape')
  }
  const models: ClineModel[] = []
  for (const raw of payload.data) {
    if (!isRecord(raw) || typeof raw.id !== 'string') continue
    const extraName = raw.id === 'deepseek/deepseek-v4-flash' ? 'DeepSeek V4 Flash (free)' : undefined
    if (!raw.id.endsWith(':free') && extraName === undefined) continue
    const name = extraName ?? (typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : undefined)
    const contextWindow = positiveNumber(raw.context_length)
    const maxTokens = positiveNumber(isRecord(raw.top_provider) ? raw.top_provider.max_completion_tokens : undefined)
    models.push({
      id: raw.id,
      ...(name === undefined ? {} : { name }),
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...maxTokens === undefined ? {} : { maxTokens },
    })
  }
  models.sort((a, b) => a.id.localeCompare(b.id))
  return models
}

export async function fetchOpenRouterReasoning(
  url: string = 'https://openrouter.ai/api/v1/models',
  fetchImpl: typeof fetch = fetch,
): Promise<Map<string, ReasoningMetadata>> {
  const payload = await fetchJson(url, 300_000, 'OpenRouter models', fetchImpl)
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error('OpenRouter models endpoint returned an unexpected shape')
  }
  const byId = new Map<string, ReasoningMetadata>()
  for (const raw of payload.data) {
    if (!isRecord(raw) || typeof raw.id !== 'string') continue
    const r = isRecord(raw.reasoning) ? raw.reasoning : undefined
    if (r === undefined) continue
    const efforts = Array.isArray(r.supported_efforts)
      ? (r.supported_efforts as unknown[]).filter((x): x is string => typeof x === 'string')
      : undefined
    byId.set(raw.id, {
      ...(efforts === undefined || efforts.length === 0 ? {} : { supportedEfforts: efforts }),
      ...typeof r.mandatory === 'boolean' ? { mandatory: r.mandatory } : {},
    })
  }
  return byId
}

export function reasoningMapFor(reasoning: ReasoningMetadata | undefined): ThinkingLevelMap {
  if (reasoning === undefined) {
    return {}
  }
  const canOff = reasoning.mandatory !== true
  const map: ThinkingLevelMap = {}
  map.off = canOff ? undefined : null
  for (const level of ['minimal', 'low', 'medium', 'high'] as const) {
    if (reasoning.supportedEfforts !== undefined && !reasoning.supportedEfforts.includes(level)) {
      map[level] = null
    }
  }
  for (const level of ['xhigh', 'max'] as const) {
    map[level] = reasoning.supportedEfforts === undefined || reasoning.supportedEfforts.includes(level) ? level : null
  }
  return map
}

function toPiModel(model: ClineModel, baseURL: string, config: Config): Model<'openai-completions'> {
  const r = model.reasoning
  const hideControl = r !== undefined && r.mandatory && !r.supportedEfforts
  return {
    id: model.id,
    name: model.name ?? model.id,
    api: 'openai-completions',
    provider: PROVIDER,
    baseUrl: baseURL,
    headers: {
      'User-Agent': 'Cline/3.0.47',
      'HTTP-Referer': 'https://cline.bot',
      'X-Title': 'Cline',
      'X-IS-MULTIROOT': 'false',
      'X-CLIENT-TYPE': 'cline-sdk',
      'X-CLIENT-VERSION': '3.0.47',
      'X-PLATFORM': 'terminal',
      'X-PLATFORM-VERSION': '3.0.47',
      'X-CORE-VERSION': '0.0.66',
    },
    reasoning: !hideControl && r !== undefined,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: { requiresReasoningContentOnAssistantMessages: false },
    contextWindow: model.contextWindow ?? config.defaultContextWindow ?? 262_144,
    maxTokens: model.maxTokens ?? config.defaultMaxTokens ?? 32_768,
    ...(r !== undefined && !hideControl ? { thinkingLevelMap: reasoningMapFor(r) } : {}),
  }
}

const normalizeReasoningContext = (model: Model<Api>, context: PiContext): PiContext => {
  if (!model.reasoning) return context
  const messages = context.messages.map(message => {
    if (message.role !== 'assistant') return message
    const content = message.content.map(block =>
      block.type === 'thinking' && block.thinking.trim().length > 0 && block.thinkingSignature === undefined
        ? { ...block, thinkingSignature: 'reasoning_content' }
        : block,
    )
    return content === message.content ? message : { ...message, content }
  })
  return messages.some((message, index) => message !== context.messages[index]) ? { ...context, messages } : context
}

const baseApi = openAICompletionsApi()
const api: ProviderStreams = {
  stream: (model, context, options) => baseApi.stream(model, normalizeReasoningContext(model, context), options),
  streamSimple: (model, context, options) => baseApi.streamSimple(model, normalizeReasoningContext(model, context), options),
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  let current: () => Config = () => config
  let lastConfig: Config | undefined
  let memoized: ReadonlyMap<string, ResolvedPiAiProviderProfile> | undefined

  const [entries, reasoningById] = await Promise.all([
    fetchFreeModels(),
    // Reasoning metadata is optional; a failed secondary scan must not disable models.
    fetchOpenRouterReasoning().catch((error: unknown) => {
      ctx.logger.warn('[cline-free-provider] OpenRouter reasoning scan failed; falling back to Cline-only metadata: %s',
        error instanceof Error ? error.message : String(error))
      return new Map<string, ReasoningMetadata>()
    }),
  ])
  if (entries.length === 0) {
    throw new Error('no free models found; keeping the previous catalog')
  }
  const scanned = entries.map(entry => ({
    ...entry,
    ...(reasoningById.has(entry.id) ? { reasoning: reasoningById.get(entry.id) } : {}),
  }))
  ctx.logger.info(
    '[cline-free-provider] synced %d free model(s): %s',
    scanned.length,
    scanned.map(m => m.id).join(', '),
  )

  const buildProfiles = (): ReadonlyMap<string, ResolvedPiAiProviderProfile> => {
    const opts = current()
    if (opts === lastConfig && memoized !== undefined) return memoized
    const baseURL = opts.baseURL ?? 'https://api.cline.bot/api/v1'
    const models = scanned.map(model => toPiModel(model, baseURL, opts))
    const piProvider = createProvider({
      id: PROVIDER,
      name: 'Cline',
      baseUrl: baseURL,
      auth: {
        apiKey: {
          name: 'Cline',
          resolve: ({ credential }) => Promise.resolve({
            auth: credential?.key === undefined ? {} : { apiKey: credential.key },
            source: 'Cline',
          }),
        },
      },
      models,
      api,
    })
    const profiles = new Map<string, ResolvedPiAiProviderProfile>([
      [
        PROVIDER,
        {
          provider: PROVIDER,
          displayName: 'Cline',
          apiKeyEnv: credentialRef(opts.apiKeyEnv ?? 'CLINE_API_KEY'),
          streamIdleTimeoutMs: 300_000,
          maxRequestImageBytes: 20_971_520,
          retryPolicy: resolveRetryPolicy(undefined, 'cline-free-provider'),
          piProvider,
          configuredMaxTokens: new Map(),
        },
      ],
    ])
    lastConfig = opts
    memoized = profiles
    return profiles
  }

  const adapter = new PiAiAdapter({
    profiles: buildProfiles,
    resolveApiKey: async (provider, profile) => {
      const ref = profile.apiKeyEnv
      if (ref === undefined) return undefined
      const credentials = ctx.get('credentials')
      if (credentials !== undefined) {
        const hit = await credentials.resolve(ref)
        if (hit !== undefined) return assertUsableApiKey(hit.value, 'cline-free-provider', String(ref))
      } else {
        const ambient = launchEnvironmentOf(ctx).get(String(ref))
        if (ambient !== undefined && ambient.value.length > 0) {
          return assertUsableApiKey(ambient.value, 'cline-free-provider', String(ref))
        }
      }
      throw new LlmError(
        `cline-free-provider: no API key for provider route "${provider}"; store ${String(ref)} through the credentials`
        + ` service (the web Models page writes it), or export ${String(ref)} in the launching environment`,
        'MISSING_CREDENTIAL',
      )
    },
  })

  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: 'Cline', settingsNs: NS, settingsPath: [] },
  ])
  ctx.llm.registerAdapter([PROVIDER], adapter)

  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => {
      current = source
    },
    onChange: () => {},
  })
}
