import type { Context } from '@deepseek-ai/cordis'
import { assertUsableApiKey, errorChain, LlmError, resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter, type ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import type {} from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { createProvider, type AuthContext, type Context as PiContext, type CredentialStore, type Model, type ProviderStreams, type ThinkingLevelMap } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'

export const name = 'cline-free-provider'
export const inject = ['llm']

const NS = 'cline-free-provider'
const PROVIDER = 'cline'
const DISPLAY_NAME = 'Cline'

/** Envelope types that must stay AUTH-classified instead of being rewritten. */
const AUTH_ERROR_TYPES = new Set(['AuthError', 'authentication_error', 'invalid_api_key', 'unauthorized'])

const EXTRA_FREE_MODELS: Readonly<Record<string, string>> = {
  'deepseek/deepseek-v4-flash': 'DeepSeek V4 Flash (free)',
  'z-ai/glm-5.3-flash': 'GLM 5.3 Flash (free)',
}

interface ReasoningMetadata {
  /** Effort ids the OpenRouter secondary scan credits this model with. */
  supportedEfforts?: string[]
  /** Upstream says thinking cannot be turned off on this model. */
  mandatory?: boolean
}

interface ClineModel {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  /** Whether the Cline feed lists `reasoning_effort` among its `supported_parameters`. */
  supportsReasoningEffort?: boolean
  /** Whether the feed's `architecture.input_modalities` names `image`. */
  imageInput?: boolean
  /** Optional ladder from the OpenRouter secondary scan (absent if that scan failed). */
  reasoning?: ReasoningMetadata
}

export interface Config {
  apiKeyEnv?: string
  baseURL?: string
  defaultMaxTokens?: number
  defaultContextWindow?: number
  /** Provider-owned model-request retry policy; omission uses normal defaults. */
  retryPolicy?: RetryPolicyConfig
}

export const Config: z<Config> = z.object({
  apiKeyEnv: z.string().role('credential-ref').default('CLINE_API_KEY'),
  baseURL: z.string().default('https://api.cline.bot/api/v1'),
  defaultMaxTokens: z.number().step(1).min(1).default(32_768),
  defaultContextWindow: z.number().step(1).min(1).default(262_144),
  retryPolicy: RetryPolicySchema,
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

async function fetchJson(url: string, timeoutMs: number, label: string, fetchImpl: typeof fetch = fetch): Promise<unknown> {
  const response = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error(`${label} endpoint answered HTTP ${response.status}`)
  return await response.json()
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
    const extraName = EXTRA_FREE_MODELS[raw.id]
    if (!raw.id.endsWith(':free') && extraName === undefined) continue
    const name = extraName ?? (typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : undefined)
    const contextWindow = positiveNumber(raw.context_length)
    const maxTokens = positiveNumber(isRecord(raw.top_provider) ? raw.top_provider.max_completion_tokens : undefined)
    const supportedParameters = Array.isArray(raw.supported_parameters)
      ? (raw.supported_parameters as unknown[]).filter((x): x is string => typeof x === 'string')
      : undefined
    const architecture = isRecord(raw.architecture) ? raw.architecture : undefined
    const imageInput = architecture !== undefined && Array.isArray(architecture.input_modalities)
      && (architecture.input_modalities as unknown[]).includes('image')
    models.push({
      id: raw.id,
      ...(name === undefined ? {} : { name }),
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
      ...(supportedParameters?.includes('reasoning_effort') ? { supportsReasoningEffort: true } : {}),
      ...(imageInput ? { imageInput: true } : {}),
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
    if (efforts === undefined || efforts.length === 0) continue
    byId.set(raw.id, {
      supportedEfforts: efforts,
      ...typeof r.mandatory === 'boolean' ? { mandatory: r.mandatory } : {},
    })
  }
  return byId
}

// The Cline feed's `supported_parameters` asserts controllability, OpenRouter's
// scan supplies the ladder. Either one missing means no effort control at all —
// never a fabricated ladder.
function reasoningLevelsFor(model: ClineModel): string[] {
  if (!model.supportsReasoningEffort) return []
  const efforts = model.reasoning?.supportedEfforts
  if (efforts === undefined || efforts.length === 0) return []
  return efforts
}

/** pi-ai's standard ladder keys (off = explicit close; the rest are depths). */
const PI_LEVEL_KEYS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

// `Default` (the harness's "no selection" path) is the *absent key* — leaving
// `reasoning_effort` off the wire and letting the upstream choose. Each ladder
// level the endpoint accepts lands at its own key with its own wire value; the
// `off` key carries the upstream's literal close value when the feed names one
// (e.g. `none`), so the selector's "Off" entry is a real switch rather than a
// no-op. Mandatory models omit the `off` key entirely — the harness then has
// no way to disable thinking.
function reasoningMapFor(levels: readonly string[], mandatory: boolean | undefined): ThinkingLevelMap {
  const map: ThinkingLevelMap = {}
  for (const key of PI_LEVEL_KEYS) {
    map[key] = levels.includes(key) ? key : null
  }
  map.off = mandatory ? null : 'none'
  return map
}

function buildModels(scanned: readonly ClineModel[], baseURL: string, config: Config): Model<'openai-completions'>[] {
  return scanned.map(model => {
    const levels = reasoningLevelsFor(model)
    const mandatory = model.reasoning?.mandatory
    const controllable = levels.length > 0
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
      reasoning: controllable,
      // Declared from the feed's own `architecture.input_modalities`; a model
      // the feed leaves silent stays text-only (under-claiming refuses the
      // image while it is still cheap, over-claiming leaves a durable message
      // no request can replay).
      input: model.imageInput ? ['text', 'image'] : ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: { requiresReasoningContentOnAssistantMessages: false },
      contextWindow: model.contextWindow ?? config.defaultContextWindow ?? 262_144,
      maxTokens: model.maxTokens ?? config.defaultMaxTokens ?? 32_768,
      ...(controllable ? { thinkingLevelMap: reasoningMapFor(levels, mandatory) } : {}),
    }
  })
}

// Replayed thinking blocks carry no wire signature; marking them
// `reasoning_content` keeps the transport from mangling history. Never gated on
// `model.reasoning`: a model with no effort control still streams thinking.
const normalizeReasoningContext = (context: PiContext): PiContext => ({
  ...context,
  messages: context.messages.map(message => message.role !== 'assistant' ? message : {
    ...message,
    content: message.content.map(block =>
      block.type === 'thinking' && block.thinking.trim().length > 0 && block.thinkingSignature === undefined
        ? { ...block, thinkingSignature: 'reasoning_content' }
        : block),
  }),
})

// Free-tier refusals (ended promotions, region blocks) arrive as HTTP 401/403,
// which the harness classifies as AUTH and masks as "API key is invalid".
// Rewriting the envelope to `[cline <type>] <message>` gets the real reason past
// that classification; genuine auth envelopes and unparseable text pass through.
const rewriteRefusalMessage = (errorMessage: string): string => {
  const start = errorMessage.indexOf('{')
  const end = errorMessage.lastIndexOf('}')
  if (start < 0 || end <= start) return errorMessage
  let parsed: unknown
  try { parsed = JSON.parse(errorMessage.slice(start, end + 1)) } catch { return errorMessage }
  if (!isRecord(parsed)) return errorMessage
  // Accept both the raw envelope (`{"type":"error","error":{…}}`) and the
  // SDK-unwrapped inner object (`{"type":"ModelError","message":"…"}`).
  const detail = parsed.type === 'error' && isRecord(parsed.error) ? parsed.error : parsed
  const message = [detail.message, isRecord(detail.error) ? detail.error.message : undefined, detail.detail]
    .find((value): value is string => typeof value === 'string')
  if (message === undefined) return errorMessage
  const type = typeof detail.type === 'string' ? detail.type : 'Error'
  const code = typeof detail.code === 'string' ? detail.code : ''
  if (AUTH_ERROR_TYPES.has(type) || AUTH_ERROR_TYPES.has(code)) return errorMessage
  // Dropping the status prefix is what defeats the AUTH classifier.
  return `[cline ${type}] ${message}`
}

// Required by the adapter, unused by this route: the credential comes from
// `resolveApiKey`, so pi-ai never stores one nor asks an ambient question.
const PI_AUTH: { credentials: CredentialStore, authContext: AuthContext } = {
  credentials: {
    read: async () => undefined,
    list: async () => [],
    modify: async (_providerId, mutate) => mutate(undefined),
    delete: async () => {},
  },
  authContext: { env: async () => undefined, fileExists: async () => false },
}

const sanitizeStream = <S extends { push(event: unknown): void }>(stream: S): S => {
  const originalPush = stream.push.bind(stream)
  stream.push = (event: unknown) => {
    if (isRecord(event) && event.type === 'error' && isRecord(event.error) && typeof event.error.errorMessage === 'string') {
      event.error.errorMessage = rewriteRefusalMessage(event.error.errorMessage)
    }
    originalPush(event)
  }
  return stream
}

const CLINE_VALID_EFFORTS = new Set(['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none'])

function sanitizePayload(params: Record<string, unknown>, explicitReasoning: unknown): void {
  if (typeof params.reasoning_effort === 'string') {
    if (explicitReasoning === undefined) {
      delete params.reasoning_effort
    } else if (params.reasoning_effort === 'off') {
      params.reasoning_effort = 'none'
    } else if (!CLINE_VALID_EFFORTS.has(params.reasoning_effort)) {
      delete params.reasoning_effort
    }
  }
}

function withPayloadSanitization<T extends { onPayload?: (payload: unknown, model: Model<any>) => unknown }>(
  options: T | undefined,
  explicitReasoning: unknown,
): T {
  const customOnPayload = options?.onPayload
  return {
    ...options,
    onPayload: async (params: unknown, model: Model<any>) => {
      let current = params
      if (customOnPayload) {
        current = (await customOnPayload(params, model)) ?? params
      }
      if (isRecord(current)) {
        sanitizePayload(current, explicitReasoning)
      }
      return current
    },
  } as T
}

const baseApi = openAICompletionsApi()
const api: ProviderStreams = {
  stream: (model, context, options) => {
    const explicitReasoning = isRecord(options) ? options.reasoningEffort : undefined
    return sanitizeStream(baseApi.stream(model, normalizeReasoningContext(context), withPayloadSanitization(options, explicitReasoning)))
  },
  streamSimple: (model, context, options) => {
    const explicitReasoning = options?.reasoning
    return sanitizeStream(baseApi.streamSimple(model, normalizeReasoningContext(context), withPayloadSanitization(options, explicitReasoning)))
  },
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  let current: () => Config = () => config

  // Outside the settings-backed config, so a settings snapshot cannot clobber a
  // scan.
  let scanned: ClineModel[] = []

  const buildProfiles = (): ReadonlyMap<string, ResolvedPiAiProviderProfile> => {
    const opts = current()
    const baseURL = opts.baseURL ?? 'https://api.cline.bot/api/v1'
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
      models: buildModels(scanned, baseURL, opts),
      api,
    })
    const profiles = new Map<string, ResolvedPiAiProviderProfile>([
      [
        PROVIDER,
        {
          provider: PROVIDER,
          displayName: DISPLAY_NAME,
          apiKeyEnv: credentialRef(opts.apiKeyEnv ?? 'CLINE_API_KEY'),
          streamIdleTimeoutMs: 300_000,
          maxRequestImageBytes: 20_971_520,
          requestImagePixelBudget: 4_194_304,
          requestImageMaxBytes: 1_048_576,
          retryPolicy: resolveRetryPolicy(opts.retryPolicy, 'cline-free-provider: retryPolicy'),
          piProvider,
          configuredMaxTokens: new Map(),
        },
      ],
    ])
    return profiles
  }

  // PiAiAdapter memoizes its snapshot on this Map's identity, so a fresh Map per
  // request would rebuild the whole pi-ai collection: rebuild only on change.
  let profiles = buildProfiles()

  const adapter = new PiAiAdapter({
    resolveAttachments: () => ctx.get('attachments'),
    profiles: () => profiles,
    auth: PI_AUTH,
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
    { provider: PROVIDER, displayName: DISPLAY_NAME, settingsNs: NS, settingsPath: [] },
  ])
  ctx.llm.registerAdapter([PROVIDER], adapter)

  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, NS, Config, config, {
      setSource: (source) => {
        current = source
      },
      onChange: () => {
        profiles = buildProfiles()
      },
    })
  })

  // The catalog is fetched once at mount. Mount never awaits it: an unreachable
  // upstream must not kill the plugin.
  async function sync(): Promise<void> {
    const [entries, reasoningById] = await Promise.all([
      fetchFreeModels(),
      // Optional metadata: a failed secondary scan must not disable models.
      fetchOpenRouterReasoning().catch((error: unknown) => {
        ctx.logger.warn('[%s] OpenRouter reasoning scan failed; falling back to Cline-only metadata: %s',
          name, errorChain(error))
        return new Map<string, ReasoningMetadata>()
      }),
    ])
    const next = entries.map(entry => ({
      ...entry,
      ...(reasoningById.has(entry.id) ? { reasoning: reasoningById.get(entry.id) } : {}),
    }))
    if (next.length === 0) {
      throw new Error('no free models found; keeping the previous catalog')
    }
    if (deepEqualJson(next, scanned)) return
    scanned = next
    profiles = buildProfiles()
    ctx.logger.info('[%s] synced %d free model(s): %s', name, scanned.length, scanned.map(m => m.id).join(', '))
  }

  void sync().catch((error: unknown) => {
    ctx.logger.warn('[%s] initial catalog scan failed: %s', name, errorChain(error))
  })
}
