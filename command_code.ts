// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Luan Weslley

import type { Plugin } from "@opencode-ai/plugin"
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

type CatalogModel = { limit?: { context?: number; output?: number }; attachment?: boolean }
type Catalog = Record<string, { models?: Record<string, CatalogModel> }>

// Entrypoint dual: o default export é { id, server, setup }. O loader v1
// (opencode 1.x) usa server (Hooks: config/auth/chat.params); o loader v2
// (opencode 2.x) usa setup (provider/integration) e ignora server. O mesmo
// arquivo pode ser copiado/simlinkado em ~/.config/opencode/plugins.

// Sends the model's official output ceiling as max_tokens: first the live
// Command Code client catalog (maxOutputTokens), then the models.dev catalog
// (the same registry the Command Code CLI loads) - direct provider record, else
// the most conservative record found across providers. Models absent from both
// fall back to 64000 - the effective floor of the Command Code CLI
// (min(wire default 64000, floor(contextWindow / 2))) - or their own declared
// output limit when that is lower. Their gateway does not pre-gate per model
// (only a hard schema ceiling of 200000 on max_tokens, seen by third-party
// proxies as a 400 "Too big: expected number to be <=200000"), so the per-model
// ceiling is resolved client-side and clamped to that ceiling.
// Failure cycle: large max_tokens against a nearly-full window can 400 on
// strict upstreams (prompt + max_tokens > window). opencode classifies that as
// context_overflow (never retried), flags the session for compaction, compacts,
// and the turn continues with the reduced history - automatic recovery that
// requires compaction.auto (the default). The error event stays visible.
const WIRE_DEFAULT = 64_000
const GATEWAY_CEILING = 200_000

let catalogPromise: Promise<Catalog | undefined> | undefined
const memo = new Map<string, number | undefined>()

function loadCatalog(): Promise<Catalog | undefined> {
  catalogPromise ??= (async () => {
    const res = await fetch("https://models.dev/api.json", {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(6_000),
    }).catch(() => undefined)
    const data = res?.ok ? await res.json().catch(() => undefined) : undefined
    if (data && typeof data === "object" && !Array.isArray(data)) return data as Catalog
    return undefined
  })()
  return catalogPromise
}

function lastSegment(id: string) {
  const index = id.lastIndexOf("/")
  return index === -1 ? id : id.slice(index + 1)
}

function candidatesFor(id: string): string[] {
  const model = id.slice(id.indexOf("/") + 1)
  const stripped = model.replace(/:free$/i, "")
  return stripped === model ? [model] : [model, stripped]
}

function directCap(data: Catalog, id: string): number | undefined {
  const slash = id.indexOf("/")
  if (slash === -1) return undefined
  const models = Object.entries(data)
    .find(([key]) => key.toLowerCase() === id.slice(0, slash).toLowerCase())
    ?.[1]?.models
  if (!models) return undefined
  for (const candidate of candidatesFor(id)) {
    const entry = Object.entries(models).find(([key]) => key.toLowerCase() === candidate.toLowerCase())
    const output = entry?.[1]?.limit?.output
    if (typeof output === "number" && output > 0) return output
  }
  return undefined
}

function scannedCap(data: Catalog, id: string): number | undefined {
  const outputs: number[] = []
  for (const candidate of candidatesFor(id)) {
    const suffix = candidate.toLowerCase()
    for (const provider of Object.values(data)) {
      for (const [key, model] of Object.entries(provider.models ?? {})) {
        if (lastSegment(key).toLowerCase() !== suffix) continue
        const output = model?.limit?.output
        if (typeof output === "number" && output > 0) outputs.push(output)
      }
    }
  }
  return outputs.length ? Math.min(...outputs) : undefined
}

async function modelsDevCap(id: string): Promise<number | undefined> {
  const data = await loadCatalog()
  return data ? (directCap(data, id) ?? scannedCap(data, id)) : undefined
}

async function capFor(id: string): Promise<number | undefined> {
  if (memo.has(id)) return memo.get(id)
  const catalog = await getRemoteCatalog()
  const model = catalog?.models.find((item) => item.id.toLowerCase() === id.toLowerCase())
  const cap = model?.maxOutput ?? (await modelsDevCap(id))
  memo.set(id, cap)
  return cap
}

// ─── Catálogo vivo + sync (hook config) ─────────────────────────────────────
// O provider commandcode é "custom": o opencode não descobre modelos sozinho,
// ele mostra apenas o que está em provider.commandcode.models. A fonte agora é
// o catálogo vivo do próprio Provider API, o mesmo que o CLI consome:
//   GET /provider/v1/models?view=client  -> catálogo rico (106 modelos)
//   GET /provider/v1/models              -> supported_endpoints por modelo
// Ambos são públicos (não precisam de API key) e trazem nome, context_length,
// reasoningEfforts, inputModalities, maxOutputTokens, minimumPlan, hidden,
// aliases e pricing. A segunda rota é usada só para juntar supported_endpoints
// (a view client não traz esse campo) e excluir modelos que não aceitam
// /chat/completions - Claude responde apenas em /messages.
//
// Este hook roda antes do opencode ler os providers (provider.ts:1440) e
// SINCRONIZA os dois lados:
//   (a) memória - injeta/atualiza os modelos no cfg da sessão;
//   (b) disco   - edita o opencode.json/opencode.jsonc cirurgicamente:
//       substitui as linhas dos modelos permitidos, insere as novas e remove as
//       obsoletas DENTRO do bloco "models" do provider, preservando comentários,
//       indentação, LF/CRLF e todo o resto byte a byte; grava um backup .bak
//       antes e troca via rename atômico (com fallback de escrita direta, útil
//       no Windows). O caminho respeita OPENCODE_CONFIG_DIR/XDG_CONFIG_HOME e
//       aceita opencode.json ou opencode.jsonc. O bloco é localizado
//       ESTRUTURALMENTE (provider > commandcode > models, via scanner JSONC),
//       nunca por busca textual.
//
// O snapshot (~/.cache/opencode/commandcode-models.json) evita buscar o
// catálogo a cada startup: o TTL é o refreshAfterSeconds publicado pelo próprio
// endpoint (900s por padrão). Se a rede falhar, o snapshot antigo cobre a
// sessão; sem snapshot, o config fica como está. Qualquer falha vira no-op.
//
// Plano: tentamos detectar o plano real da assinatura em
// GET /alpha/billing/subscriptions (Authorization: Bearer <key>), usando a key
// do env, do config ou do auth store do opencode. A ordem é: override explícito
// (options.plan/COMMAND_CODE_PLAN) -> exige key (env/config/auth store) ->
// cache local (6h) -> detecção -> último cache conhecido -> fallback. Sem key
// (mesmo com cache) ou com key inválida, o provider fica só com um modelo
// placeholder "Connect Command Code (/connect)": zero modelos faria o runtime
// remover o provider e ele sumir do /connect. Com key mas nível indeterminado
// (endpoint fora/alpha mudou/200 sem plano ativo), o fallback mostra todos os
// modelos até Max; se o usuário tentar um fora do plano, a própria API responde
// com o erro de plano. Modelos hidden e sem /chat/completions nunca entram.
// Entradas existentes fora do filtro/catálogo são removidas, a menos que estejam
// em KEEP_MODELS. Overrides manuais preservados: name, limit.output
// (planejamento), temperature e options/variants quando os levels ainda existem.
// O resto - context, reasoning, attachment/modalities, efforts e cost - vem do
// catálogo. O caminho do config pode ser trocado por COMMAND_CODE_CONFIG.
//
// Provider/auth: o hook config cria provider.commandcode se ele não existir
// (npm, nome, baseURL, env) e o hook auth registra o método "API Key" no
// /connect. A key é devolvida ao provider pelo loader e nunca é logada. O
// plano detectado pelo loader fica em cache; a troca dos modelos (placeholder
// -> plano real) acontece no próximo startup, porque o config não é recarregado
// e o loader recebe uma cópia pública do provider (não altera models).

const PLAN_RANK: Record<string, number> = {
  "individual-go": 0,
  "individual-goat": 1,
  "individual-pro": 2,
  "individual-max": 3,
  "individual-provider": 4,
}
const FALLBACK_PLAN = "individual-max"
const PROVIDER_ID = "commandcode"
const PROVIDER_NPM = "@ai-sdk/openai-compatible"
const PROVIDER_NAME = "Command Code"
const PROVIDER_BASE_URL = "https://api.commandcode.ai/provider/v1"
const PROVIDER_ENV = ["COMMANDCODE_API_KEY", "COMMAND_CODE_API_KEY"]
const PLACEHOLDER_ID = "connect"
const V2_PACKAGE = "@opencode/ai/providers/openai-compatible"
const SYNC_OUTPUT = 32_000
const PRUNE_STALE = true
const KEEP_MODELS = new Set<string>([])
const CACHE_DIR = process.env.XDG_CACHE_HOME ? join(process.env.XDG_CACHE_HOME, "opencode") : join(homedir(), ".cache", "opencode")
const DATA_DIR = process.env.XDG_DATA_HOME ? join(process.env.XDG_DATA_HOME, "opencode") : join(homedir(), ".local", "share", "opencode")
const CONFIG_DIR =
  process.env.OPENCODE_CONFIG_DIR ??
  (process.env.XDG_CONFIG_HOME ? join(process.env.XDG_CONFIG_HOME, "opencode") : join(homedir(), ".config", "opencode"))
const CONFIG_PATH =
  process.env.COMMAND_CODE_CONFIG ??
  [join(CONFIG_DIR, "opencode.jsonc"), join(CONFIG_DIR, "opencode.json")].find((path) => existsSync(path)) ??
  join(CONFIG_DIR, "opencode.jsonc")
const AUTH_PATH = join(DATA_DIR, "auth.json")
const SNAPSHOT_PATH = join(CACHE_DIR, "commandcode-models.json")
const REPORT_PATH = join(CACHE_DIR, "commandcode-sync-report.json")
const PLAN_CACHE_PATH = join(CACHE_DIR, "commandcode-plan.json")
const CLIENT_URL = "https://api.commandcode.ai/provider/v1/models?view=client"
const PLAIN_URL = "https://api.commandcode.ai/provider/v1/models"
const PLAN_URL = "https://api.commandcode.ai/alpha/billing/subscriptions"
const DEFAULT_REFRESH_SECONDS = 900
const PLAN_CACHE_TTL_MS = 6 * 60 * 60 * 1000
const ACTIVE_SUBSCRIPTION_STATUSES = new Set(["active", "trialing", "past_due"])
const FETCH_TIMEOUT = 6_000
const SNAPSHOT_SCHEMA = 2

type RemoteModel = {
  id: string
  name: string
  context: number
  efforts: string[]
  plan: string
  attachment: boolean
  input: string[]
  maxOutput?: number
  created?: number
  pricing?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
  hidden: boolean
  chat: boolean
}

type RemoteCatalog = {
  schema: number
  syncedAt: string
  source: string
  catalogVersion?: string
  refreshAfterSeconds: number
  models: RemoteModel[]
}

type EntryUpdate = { id: string; entry: Record<string, any>; isNew: boolean }
type SyncResult = { updated: EntryUpdate[]; pruned: string[]; kept: string[] }
type SyncReport = {
  syncedAt: string
  plan: string
  planSource: string
  source: string
  catalogVersion?: string
  added: string[]
  updated: string[]
  pruned: string[]
  kept: string[]
  fileUpdated: boolean
}
type PlanCache = { planId: string; detectedAt: string }
type ResolvedPlan = { planId?: string; source: string }
type DetectResult = { planId?: string; outcome: "ok" | "unauthorized" | "unknown" }

type V2Credential = { type?: string; key?: unknown; access?: unknown }
type V2Connection = { type?: string; id?: string; [key: string]: unknown }
type V2Model = {
  id: string
  modelID: string
  providerID: string
  name: string
  capabilities: { tools: boolean; input: string[]; output: string[] }
  variants: { id: string; settings?: Record<string, unknown> }[]
  time: { released: number }
  cost: {
    input: number
    output: number
    cache: { read: number; write: number }
    tier?: { type: "context"; size: number }
  }[]
  status: "alpha" | "beta" | "deprecated" | "active"
  enabled: boolean
  limit: { context: number; output: number }
  settings?: Record<string, unknown>
}
type V2ProviderInfo = {
  id: string
  name: string
  activation: "auto" | "enabled" | "disabled"
  package: string
  integrationID?: string
  settings?: Record<string, unknown>
}
type V2ProviderEditor = {
  get: (id: string) => { provider: V2ProviderInfo; models: ReadonlyMap<string, V2Model> } | undefined
  add: (input: { info: V2ProviderInfo; models: readonly V2Model[]; sourceConnection?: V2Connection }) => void
  update: (id: string, update: (provider: V2ProviderInfo) => void) => void
  models: {
    set: (id: string, models: readonly V2Model[]) => void
  }
}
type V2IntegrationEditor = {
  update: (id: string, update: (integration: { id: string; name: string }) => void) => void
  method: {
    update: (
      input:
        | { integrationID: string; method: { type: "key"; label?: string } }
        | { integrationID: string; method: { type: "env"; names: string[] } },
    ) => void
  }
}
type V2Context = {
  options?: Record<string, unknown>
  integration: {
    transform: (callback: (editor: V2IntegrationEditor) => void) => Promise<unknown>
    connection: {
      active: (id: string) => Promise<V2Connection | undefined>
      resolve: (connection: V2Connection) => Promise<V2Credential | undefined>
    }
  }
  provider: {
    transform: (callback: (editor: V2ProviderEditor) => void) => Promise<unknown>
  }
}

function rankFor(planId: string | undefined): number {
  if (!planId) return PLAN_RANK[FALLBACK_PLAN]
  return PLAN_RANK[planId] ?? PLAN_RANK[FALLBACK_PLAN]
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string" && item.length > 0)
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
}

function remotePricing(value: unknown): RemoteModel["pricing"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const pricing = value as Record<string, unknown>
  const input = typeof pricing.input === "number" ? pricing.input : positiveNumber(pricing.inputCost)
  const output = typeof pricing.output === "number" ? pricing.output : positiveNumber(pricing.outputCost)
  const cacheRead = typeof pricing.cacheRead === "number" ? pricing.cacheRead : positiveNumber(pricing.cacheReadCost)
  const cacheWrite =
    typeof pricing.cacheWrite === "number"
      ? pricing.cacheWrite
      : (positiveNumber(pricing.cacheWriteCost) ?? positiveNumber(pricing.cacheWrite1hCost))
  if (input === undefined && output === undefined && cacheRead === undefined && cacheWrite === undefined) return undefined
  return { input, output, cacheRead, cacheWrite }
}

function normalizeRemoteModel(raw: any, endpoints: string[] | undefined, created?: number): RemoteModel | undefined {
  if (!raw || typeof raw !== "object") return undefined
  if (typeof raw.id !== "string" || !raw.id) return undefined
  const input = stringList(raw.inputModalities)
  const efforts = stringList(raw.reasoningEfforts).map((effort) => effort.toLowerCase())
  const supported = endpoints ?? (raw.id.startsWith("claude-") ? ["/messages"] : ["/chat/completions"])
  return {
    id: raw.id,
    name: typeof raw.display?.label === "string" ? raw.display.label : typeof raw.name === "string" ? raw.name : raw.id,
    context: positiveNumber(raw.context_length) ?? 0,
    efforts,
    plan: typeof raw.minimumPlan === "string" ? raw.minimumPlan : "individual-go",
    attachment: input.includes("image"),
    input: input.length ? input : ["text"],
    maxOutput: positiveNumber(raw.maxOutputTokens),
    created: positiveNumber(created),
    pricing: remotePricing(raw.pricing),
    hidden: raw.hidden === true,
    chat: supported.includes("/chat/completions"),
  }
}

function normalizeSnapshotModel(raw: any): RemoteModel | undefined {
  if (!raw || typeof raw !== "object") return undefined
  if (typeof raw.id !== "string" || !raw.id) return undefined
  const legacyPlan: Record<string, string> = {
    Go: "individual-go",
    GOAT: "individual-goat",
    Pro: "individual-pro",
    Max: "individual-max",
    Provider: "individual-provider",
  }
  const plan = typeof raw.plan === "string" ? (legacyPlan[raw.plan] ?? raw.plan) : "individual-go"
  const input = stringList(raw.input ?? raw.inputModalities)
  return {
    id: raw.id,
    name: typeof raw.name === "string" ? raw.name : raw.id,
    context: positiveNumber(raw.context ?? raw.context_length) ?? 0,
    efforts: stringList(raw.efforts ?? raw.reasoningEfforts).map((effort) => effort.toLowerCase()),
    plan,
    attachment: raw.attachment === true || input.includes("image"),
    input: input.length ? input : ["text"],
    maxOutput: positiveNumber(raw.maxOutput ?? raw.maxOutputTokens),
    created: positiveNumber(raw.created),
    pricing: remotePricing(raw.pricing),
    hidden: raw.hidden === true,
    chat: raw.chat !== false && !raw.id.startsWith("claude-"),
  }
}

async function fetchJson(url: string): Promise<any | undefined> {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  }).catch(() => undefined)
  return response?.ok ? response.json().catch(() => undefined) : undefined
}

async function fetchRemoteCatalog(): Promise<RemoteCatalog | undefined> {
  const [enriched, plain] = await Promise.all([fetchJson(CLIENT_URL), fetchJson(PLAIN_URL)])
  if (!enriched || !Array.isArray(enriched.data)) return undefined
  const plainById = new Map<string, any>(
    (Array.isArray(plain?.data) ? plain.data : []).flatMap((raw: any) =>
      typeof raw?.id === "string" ? [[raw.id, raw] as const] : [],
    ),
  )
  const models = enriched.data.flatMap((raw: any) => {
    const plainModel = plainById.get(raw?.id)
    const model = normalizeRemoteModel(
      raw,
      plainModel ? stringList(plainModel.supported_endpoints) : undefined,
      typeof plainModel?.created === "number" ? plainModel.created : undefined,
    )
    return model ? [model] : []
  })
  if (!models.length) return undefined
  return {
    schema: SNAPSHOT_SCHEMA,
    syncedAt: new Date().toISOString(),
    source: CLIENT_URL,
    catalogVersion: typeof enriched.catalogVersion === "string" ? enriched.catalogVersion : undefined,
    refreshAfterSeconds: positiveNumber(enriched.refreshAfterSeconds) ?? DEFAULT_REFRESH_SECONDS,
    models,
  }
}

function loadSnapshot(): RemoteCatalog | undefined {
  try {
    const data = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"))
    if (data?.schema !== SNAPSHOT_SCHEMA || !Array.isArray(data.models)) return undefined
    const models = data.models.flatMap((raw: any) => {
      const model = normalizeSnapshotModel(raw)
      return model ? [model] : []
    })
    if (!models.length) return undefined
    return {
      schema: SNAPSHOT_SCHEMA,
      syncedAt: typeof data.syncedAt === "string" ? data.syncedAt : new Date(0).toISOString(),
      source: typeof data.source === "string" ? data.source : SNAPSHOT_PATH,
      catalogVersion: typeof data.catalogVersion === "string" ? data.catalogVersion : undefined,
      refreshAfterSeconds: positiveNumber(data.refreshAfterSeconds) ?? DEFAULT_REFRESH_SECONDS,
      models,
    }
  } catch {
    return undefined
  }
}

function snapshotFresh(catalog: RemoteCatalog) {
  const syncedAt = Date.parse(catalog.syncedAt)
  return Number.isFinite(syncedAt) && Date.now() - syncedAt < catalog.refreshAfterSeconds * 1000
}

function writeFileAtomic(path: string, text: string) {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, text)
  try {
    renameSync(tmp, path)
  } catch {
    writeFileSync(path, text)
    try {
      rmSync(tmp, { force: true })
    } catch {
      // sobra o tmp; a próxima escrita sobrescreve
    }
  }
}

function saveSnapshot(catalog: RemoteCatalog) {
  try {
    mkdirSync(dirname(SNAPSHOT_PATH), { recursive: true })
    writeFileAtomic(SNAPSHOT_PATH, JSON.stringify(catalog, null, 2))
  } catch {
    // snapshot é só fallback; falha aqui não importa
  }
}

let remotePromise: Promise<RemoteCatalog | undefined> | undefined
function getRemoteCatalog(): Promise<RemoteCatalog | undefined> {
  remotePromise ??= (async () => {
    const snapshot = loadSnapshot()
    if (snapshot && snapshotFresh(snapshot)) return snapshot
    const live = await fetchRemoteCatalog()
    if (live) {
      saveSnapshot(live)
      return live
    }
    return snapshot
  })()
  return remotePromise
}

function saveReport(report: Omit<SyncReport, "syncedAt">) {
  try {
    mkdirSync(dirname(REPORT_PATH), { recursive: true })
    writeFileAtomic(REPORT_PATH, JSON.stringify({ syncedAt: new Date().toISOString(), ...report }, null, 2))
  } catch {
    // relatório é best-effort; o sync em si já aconteceu
  }
}

function normalizePlan(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const plan = value.trim().toLowerCase()
  if (!plan || plan === "auto" || plan === "detect") return undefined
  if (plan in PLAN_RANK) return plan
  const friendly: Record<string, string> = {
    go: "individual-go",
    goat: "individual-goat",
    pro: "individual-pro",
    max: "individual-max",
    provider: "individual-provider",
  }
  return friendly[plan]
}

function authKeyFrom(entry: unknown): string | undefined {
  if (typeof entry === "string") {
    if (!entry) return undefined
    try {
      return authKeyFrom(JSON.parse(entry))
    } catch {
      return entry
    }
  }
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined
  const auth = entry as Record<string, unknown>
  if (typeof auth.key === "string" && auth.key) return auth.key
  if (typeof auth.access === "string" && auth.access) return auth.access
  if (typeof auth.token === "string" && auth.token) return auth.token
  return undefined
}

function readAuthKey(): string | undefined {
  try {
    if (process.env.OPENCODE_AUTH_CONTENT) {
      const content = JSON.parse(process.env.OPENCODE_AUTH_CONTENT)
      const key = authKeyFrom(content?.[PROVIDER_ID])
      if (key) return key
    }
  } catch {
    // conteúdo inválido: tenta o arquivo
  }
  try {
    const data = JSON.parse(readFileSync(AUTH_PATH, "utf8"))
    return authKeyFrom(data?.[PROVIDER_ID])
  } catch {
    return undefined
  }
}

async function detectPlan(key: string): Promise<DetectResult> {
  const response = await fetch(PLAN_URL, {
    headers: { authorization: `Bearer ${key}`, accept: "application/json" },
    signal: AbortSignal.timeout(4_000),
  }).catch(() => undefined)
  if (!response) return { outcome: "unknown" }
  if (response.status === 401 || response.status === 403) return { outcome: "unauthorized" }
  if (!response.ok) return { outcome: "unknown" }
  const payload = await response.json().catch(() => undefined)
  const entries: any[] = Array.isArray(payload?.data) ? payload.data : payload?.data ? [payload.data] : []
  const plans = entries.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || typeof entry.planId !== "string") return []
    if (typeof entry.status === "string" && !ACTIVE_SUBSCRIPTION_STATUSES.has(entry.status)) return []
    return [entry.planId as string]
  })
  const planId = plans.sort((a, b) => (PLAN_RANK[b] ?? -1) - (PLAN_RANK[a] ?? -1))[0]
  return planId ? { planId, outcome: "ok" } : { outcome: "unknown" }
}

function readPlanCache(): PlanCache | undefined {
  try {
    const data = JSON.parse(readFileSync(PLAN_CACHE_PATH, "utf8"))
    if (typeof data?.planId !== "string" || typeof data?.detectedAt !== "string") return undefined
    return { planId: data.planId, detectedAt: data.detectedAt }
  } catch {
    return undefined
  }
}

function planCacheFresh(cache: PlanCache) {
  const detectedAt = Date.parse(cache.detectedAt)
  return Number.isFinite(detectedAt) && Date.now() - detectedAt < PLAN_CACHE_TTL_MS
}

function savePlanCache(planId: string) {
  try {
    mkdirSync(dirname(PLAN_CACHE_PATH), { recursive: true })
    writeFileAtomic(PLAN_CACHE_PATH, JSON.stringify({ planId, detectedAt: new Date().toISOString() }, null, 2))
  } catch {
    // cache é best-effort; a detecção continua valendo nesta execução
  }
}

async function refreshPlanIfStale(key: string) {
  const cached = readPlanCache()
  if (cached && planCacheFresh(cached)) return
  const detected = await detectPlan(key)
  if (detected.planId) savePlanCache(detected.planId)
}

async function resolvePlan(cfg: any, optionPlan: unknown, keyOverride?: string): Promise<ResolvedPlan> {
  const forced = normalizePlan(optionPlan) ?? normalizePlan(process.env.COMMAND_CODE_PLAN)
  if (forced) return { planId: forced, source: "option" }
  const configKey = cfg?.provider?.[PROVIDER_ID]?.options?.apiKey
  const key =
    keyOverride ??
    process.env.COMMANDCODE_API_KEY ??
    process.env.COMMAND_CODE_API_KEY ??
    (typeof configKey === "string" ? configKey : undefined) ??
    readAuthKey()
  if (!key) return { source: "no-auth" }
  const cached = readPlanCache()
  if (cached && planCacheFresh(cached)) return { planId: cached.planId, source: "cache" }
  const detected = await detectPlan(key)
  if (detected.planId) {
    savePlanCache(detected.planId)
    return { planId: detected.planId, source: "detected" }
  }
  if (detected.outcome === "unauthorized") return { source: "invalid-auth" }
  if (cached) return { planId: cached.planId, source: "stale-cache" }
  return { source: "fallback" }
}

function ensureProvider(cfg: any) {
  const providers = (cfg.provider ??= {})
  const provider = (providers[PROVIDER_ID] ??= {})
  if (!provider || typeof provider !== "object" || Array.isArray(provider)) return
  provider.npm ??= PROVIDER_NPM
  provider.name ??= PROVIDER_NAME
  provider.env ??= [...PROVIDER_ENV]
  provider.options ??= {}
  if (provider.options && typeof provider.options === "object" && !Array.isArray(provider.options)) {
    provider.options.baseURL ??= PROVIDER_BASE_URL
  }
}

// O runtime apaga providers sem nenhum modelo (provider.ts), então zero modelos
// faria o Command Code sumir do /connect. Até existir auth válida, deixamos um
// único modelo placeholder claramente rotulado, sem expor os modelos reais.
function applyPlaceholder(cfg: any, log: (message: string, extra?: Record<string, unknown>) => void): SyncResult {
  const provider = cfg?.provider?.[PROVIDER_ID]
  if (!provider || typeof provider !== "object") {
    log("provider ausente no config; placeholder ignorado")
    return { updated: [], pruned: [], kept: [] }
  }
  const models: Record<string, any> = (provider.models ??= {})
  const removed = Object.keys(models).filter((id) => id !== PLACEHOLDER_ID)
  for (const id of removed) delete models[id]
  const entry = {
    name: "Connect Command Code (/connect)",
    limit: { context: 128_000, output: SYNC_OUTPUT },
    cost: { input: 0, output: 0 },
  }
  const isNew = !(PLACEHOLDER_ID in models)
  models[PLACEHOLDER_ID] = entry
  if (removed.length) log("modelos reais ocultos até o /connect", { ids: removed })
  return { updated: [{ id: PLACEHOLDER_ID, entry, isNew }], pruned: removed, kept: [] }
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    const other = b as unknown[]
    return a.length === other.length && a.every((value, index) => sameValue(value, other[index]))
  }
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every((key) => sameValue(left[key], right[key]))
}

function buildEntry(model: RemoteModel, existing: Record<string, any> | undefined): Record<string, any> {
  const entry: Record<string, any> = {
    name: typeof existing?.name === "string" ? existing.name : model.name,
  }
  if (model.efforts.length) entry.reasoning = true
  if (model.attachment) {
    entry.attachment = true
    entry.modalities = { input: model.input, output: ["text"] }
  }
  if (existing?.temperature === false) entry.temperature = false
  entry.limit = {
    context: model.context || existing?.limit?.context || 0,
    output: positiveNumber(existing?.limit?.output) ?? SYNC_OUTPUT,
  }
  if (model.efforts.length) {
    const existingEffort = existing?.options?.reasoningEffort
    const defaultEffort =
      typeof existingEffort === "string" && model.efforts.includes(existingEffort)
        ? existingEffort
        : model.efforts.includes("medium")
          ? "medium"
          : (model.efforts.find((effort) => effort !== "off") ?? model.efforts[0])
    entry.options = { reasoningEffort: defaultEffort }
    const existingVariants = existing?.variants
    const variantsValid =
      existingVariants &&
      typeof existingVariants === "object" &&
      !Array.isArray(existingVariants) &&
      Object.keys(existingVariants).every((level) => model.efforts.includes(level))
    entry.variants = variantsValid
      ? existingVariants
      : Object.fromEntries(model.efforts.map((level) => [level, { reasoningEffort: level }]))
  }
  if (model.pricing) {
    entry.cost = {
      input: model.pricing.input ?? 0,
      output: model.pricing.output ?? 0,
      ...(model.pricing.cacheRead !== undefined ? { cache_read: model.pricing.cacheRead } : {}),
      ...(model.pricing.cacheWrite !== undefined ? { cache_write: model.pricing.cacheWrite } : {}),
    }
  }
  return entry
}

function selectModels(catalog: RemoteCatalog, planId: string | undefined): RemoteModel[] {
  const targetRank = rankFor(planId)
  return catalog.models.filter(
    (model) => !model.hidden && model.chat && (PLAN_RANK[model.plan] ?? Infinity) <= targetRank,
  )
}

function syncModels(
  cfg: any,
  catalog: RemoteCatalog,
  planId: string | undefined,
  log: (message: string, extra?: Record<string, unknown>) => void,
): SyncResult {
  const provider = cfg?.provider?.[PROVIDER_ID]
  if (!provider || typeof provider !== "object") {
    log("provider ausente no config; sync ignorado")
    return { updated: [], pruned: [], kept: [] }
  }
  const configured: Record<string, any> = (provider.models ??= {})
  const allowed = selectModels(catalog, planId)
  const allowedLower = new Set(allowed.map((model) => model.id.toLowerCase()))
  const existingKeys = new Map(Object.keys(configured).map((key) => [key.toLowerCase(), key]))
  const updated: EntryUpdate[] = []
  for (const model of allowed) {
    const key = existingKeys.get(model.id.toLowerCase())
    const existing = key ? configured[key] : undefined
    const entry = buildEntry(model, existing)
    if (key && key !== model.id) delete configured[key]
    configured[model.id] = entry
    if (!existing || !sameValue(existing, entry)) updated.push({ id: model.id, entry, isNew: !existing })
  }
  const pruned: string[] = []
  const kept: string[] = []
  for (const id of Object.keys(configured)) {
    const lower = id.toLowerCase()
    if (allowedLower.has(lower)) continue
    if (!PRUNE_STALE || KEEP_MODELS.has(id)) {
      kept.push(id)
      continue
    }
    delete configured[id]
    pruned.push(id)
    const removed = catalog.models.find((model) => model.id.toLowerCase() === lower)
    log(`modelo removido do config: ${id}`, {
      reason: !removed ? "fora do catálogo" : removed.hidden ? "hidden" : !removed.chat ? "sem /chat/completions" : `plano ${removed.plan}`,
    })
  }
  if (kept.length) log("modelos preservados fora do filtro do catálogo", { ids: kept })
  return { updated, pruned, kept }
}

// Scanner de JSONC: percorre a partir de uma chave "{" e devolve o índice do
// "}" que a fecha, ignorando chaves dentro de strings e de comentários // e /* */.
function scanObject(text: string, openIndex: number): number | undefined {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = openIndex; i < text.length; i++) {
    const char = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === "/" && text[i + 1] === "/") {
      const newline = text.indexOf("\n", i)
      i = newline === -1 ? text.length : newline
      continue
    }
    if (char === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2)
      i = close === -1 ? text.length : close + 1
      continue
    }
    if (char === "{") depth++
    else if (char === "}") {
      depth--
      if (depth === 0) return i
    }
  }
  return undefined
}

// Busca estrutural de chave (não textual): percorre o objeto aberto em `open`
// e devolve o objeto da chave `key` que esteja no nível de cima, ignorando
// ocorrências dentro de strings, comentários e objetos aninhados.
type Span = { open: number; close: number }

function skipJsonc(text: string, index: number): number {
  while (index < text.length) {
    const char = text[index]
    if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      index++
      continue
    }
    if (char === "/" && text[index + 1] === "/") {
      const newline = text.indexOf("\n", index)
      index = newline === -1 ? text.length : newline + 1
      continue
    }
    if (char === "/" && text[index + 1] === "*") {
      const close = text.indexOf("*/", index + 2)
      index = close === -1 ? text.length : close + 2
      continue
    }
    break
  }
  return index
}

function readString(text: string, index: number): { value: string; end: number } | undefined {
  if (text[index] !== '"') return undefined
  let value = ""
  let escaped = false
  for (let i = index + 1; i < text.length; i++) {
    const char = text[i]
    if (escaped) {
      value += char
      escaped = false
      continue
    }
    if (char === "\\") {
      escaped = true
      continue
    }
    if (char === '"') return { value, end: i + 1 }
    value += char
  }
  return undefined
}

function findObjectByKey(text: string, key: string, open: number): Span | undefined {
  let depth = 0
  let i = open + 1
  while (i < text.length) {
    i = skipJsonc(text, i)
    if (i >= text.length) break
    const char = text[i]
    if (char === "{") {
      depth++
      i++
      continue
    }
    if (char === "}") {
      if (depth === 0) return undefined
      depth--
      i++
      continue
    }
    if (char === '"') {
      const str = readString(text, i)
      if (!str) return undefined
      if (depth === 0) {
        const after = skipJsonc(text, str.end)
        if (text[after] === ":" && str.value === key) {
          const valueStart = skipJsonc(text, after + 1)
          if (text[valueStart] !== "{") return undefined
          const close = scanObject(text, valueStart)
          if (close === undefined) return undefined
          return { open: valueStart, close }
        }
      }
      i = str.end
      continue
    }
    i++
  }
  return undefined
}

function modelsSpan(text: string): Span | undefined {
  const rootOpen = skipJsonc(text, 0)
  if (text[rootOpen] !== "{") return undefined
  const provider = findObjectByKey(text, "provider", rootOpen)
  if (!provider) return undefined
  const commandcode = findObjectByKey(text, "commandcode", provider.open)
  if (!commandcode) return undefined
  return findObjectByKey(text, "models", commandcode.open)
}

// Marca, por linha, se ela começa dentro de um comentário /* */ (strings são
// puladas para um "/*" dentro de um nome não contar como comentário).
function blockCommentStarts(lines: string[]): boolean[] {
  const starts: boolean[] = []
  let inComment = false
  for (const line of lines) {
    starts.push(inComment)
    let i = 0
    while (i < line.length) {
      if (inComment) {
        const close = line.indexOf("*/", i)
        if (close === -1) break
        inComment = false
        i = close + 2
        continue
      }
      if (line[i] === '"') {
        let j = i + 1
        while (j < line.length) {
          if (line[j] === "\\") {
            j += 2
            continue
          }
          if (line[j] === '"') {
            j++
            break
          }
          j++
        }
        i = j
        continue
      }
      if (line[i] === "/" && line[i + 1] === "/") break
      if (line[i] === "/" && line[i + 1] === "*") {
        inComment = true
        i += 2
        continue
      }
      i++
    }
  }
  return starts
}

const ENTRY_LINE = /^(\s*)"((?:[^"\\]|\\.)*)"\s*:/

function inlineEntry(entry: Record<string, any>) {
  return JSON.stringify(entry, null, 1).replace(/\n\s*/g, " ")
}

function withoutComma(line: string) {
  return line.replace(/,\s*$/, "")
}

function withComma(line: string) {
  return /,\s*$/.test(line) ? line : `${line.replace(/\s*$/, "")},`
}

// Edição cirúrgica do bloco "models" do provider commandcode no jsonc: troca
// linhas de modelo por chave, uma por linha, mantendo o resto intacto. Entradas
// que ocupam mais de uma linha (config pretty-printed) cancelam a escrita no
// arquivo; o sync em memória continua valendo.
function syncConfigFile(updated: EntryUpdate[], pruned: string[]) {
  if (!updated.length && !pruned.length) return false
  try {
    const text = readFileSync(CONFIG_PATH, "utf8")
    const span = modelsSpan(text)
    if (!span) return false
    const modelsOpen = span.open
    const modelsClose = span.close
    const newline = text.includes("\r\n") ? "\r\n" : "\n"

    const lines = text.slice(modelsOpen + 1, modelsClose).split(/\r?\n/)
    const inBlockComment = blockCommentStarts(lines)
    const prune = new Set(pruned.map((id) => id.toLowerCase()))
    const byId = new Map(updated.map((item) => [item.id.toLowerCase(), item]))
    const seen = new Set<string>()
    let indent: string | undefined
    const kept: string[] = []
    const modelLines: number[] = []
    for (const [index, line] of lines.entries()) {
      if (inBlockComment[index]) {
        kept.push(line)
        continue
      }
      const match = ENTRY_LINE.exec(line)
      if (!match) {
        kept.push(line)
        continue
      }
      indent ??= match[1]
      if (match[1] !== indent) {
        kept.push(line)
        continue
      }
      const braces = (line.match(/{/g) ?? []).length - (line.match(/}/g) ?? []).length
      if (braces !== 0) return false
      const key = match[2].toLowerCase()
      if (prune.has(key)) continue
      const item = byId.get(key)
      if (item) {
        kept.push(`${match[1]}"${item.id}": ${inlineEntry(item.entry)},`)
        seen.add(key)
      } else {
        kept.push(line)
      }
      modelLines.push(kept.length - 1)
    }
    if (!indent) indent = "                "

    const tail = kept.length && kept[kept.length - 1].trim() === "" ? kept.pop() : undefined
    const additions = updated.filter((item) => !seen.has(item.id.toLowerCase()))
    if (additions.length && modelLines.length) {
      const last = modelLines[modelLines.length - 1]
      kept[last] = withComma(kept[last])
    }
    for (const item of additions) {
      kept.push(`${indent}"${item.id}": ${inlineEntry(item.entry)},`)
      modelLines.push(kept.length - 1)
    }

    const lastEntry = modelLines.at(-1)
    if (lastEntry !== undefined) kept[lastEntry] = withoutComma(kept[lastEntry])
    if (tail !== undefined) kept.push(tail)

    const next = text.slice(0, modelsOpen + 1) + kept.join(newline) + text.slice(modelsClose)
    if (!modelsSpan(next)) return false

    writeFileSync(`${CONFIG_PATH}.bak`, text)
    writeFileAtomic(CONFIG_PATH, next)
    return true
  } catch {
    return false
  }
}

function defaultEffortFor(efforts: string[]): string | undefined {
  return efforts.includes("medium") ? "medium" : (efforts.find((effort) => effort !== "off") ?? efforts[0])
}

function v2Variants(efforts: string[]) {
  return efforts.map((level) => ({ id: level, settings: { reasoningEffort: level } }))
}

function v2Cost(model: RemoteModel): V2Model["cost"] {
  const pricing = model.pricing
  if (!pricing) return []
  return [
    {
      input: pricing.input ?? 0,
      output: pricing.output ?? 0,
      cache: { read: pricing.cacheRead ?? 0, write: pricing.cacheWrite ?? 0 },
    },
  ]
}

function v2Model(model: RemoteModel, cap: number | undefined, existing: V2Model | undefined): V2Model {
  const efforts = model.efforts
  const defaultEffort = defaultEffortFor(efforts)
  const existingVariants = existing?.variants?.length ? existing.variants : undefined
  const existingSettings =
    existing?.settings && Object.keys(existing.settings).length ? existing.settings : undefined
  const settings = existingSettings ?? (defaultEffort ? { reasoningEffort: defaultEffort } : undefined)
  return {
    id: model.id,
    modelID: model.id,
    providerID: PROVIDER_ID,
    name: typeof existing?.name === "string" && existing.name ? existing.name : model.name,
    capabilities: { tools: true, input: model.input, output: ["text"] },
    variants: existingVariants ?? v2Variants(efforts),
    time: { released: model.created ?? Math.floor(Date.now() / 1000) },
    cost: v2Cost(model),
    status: existing?.status ?? "active",
    enabled: typeof existing?.enabled === "boolean" ? existing.enabled : true,
    limit: {
      context: model.context || existing?.limit?.context || 0,
      output: Math.min(cap ?? existing?.limit?.output ?? SYNC_OUTPUT, GATEWAY_CEILING),
    },
    ...(settings ? { settings } : {}),
  }
}

function v2PlaceholderModel(): V2Model {
  return {
    id: PLACEHOLDER_ID,
    modelID: PLACEHOLDER_ID,
    providerID: PROVIDER_ID,
    name: "Connect Command Code (/connect)",
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    variants: [],
    time: { released: Math.floor(Date.now() / 1000) },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: 128_000, output: SYNC_OUTPUT },
  }
}

function v2CredentialKey(value: V2Credential | undefined): string | undefined {
  if (!value) return undefined
  if (value.type === "key" && typeof value.key === "string") return value.key
  if (value.type === "oauth" && typeof value.access === "string") return value.access
  return undefined
}

async function registerV2Provider(
  ctx: V2Context,
  key: string | undefined,
  connection: V2Connection | undefined,
  buildModels: (existing: ReadonlyMap<string, V2Model> | undefined) => V2Model[],
) {
  const settings: Record<string, unknown> = {
    baseURL: PROVIDER_BASE_URL,
    provider: PROVIDER_ID,
    ...(key ? { apiKey: key } : {}),
  }
  await ctx.provider.transform((editor) => {
    const current = editor.get(PROVIDER_ID)
    const models = buildModels(current?.models)
    if (current) {
      editor.update(PROVIDER_ID, (provider) => {
        provider.name = provider.name || PROVIDER_NAME
        provider.activation = provider.activation ?? "auto"
        provider.package = V2_PACKAGE
        provider.integrationID = PROVIDER_ID
        provider.settings = { ...settings, ...provider.settings, ...(key ? { apiKey: key } : {}) }
      })
      editor.models.set(PROVIDER_ID, models)
      return
    }
    editor.add({
      info: {
        id: PROVIDER_ID,
        name: PROVIDER_NAME,
        activation: "auto",
        package: V2_PACKAGE,
        integrationID: PROVIDER_ID,
        settings,
      },
      models,
      ...(connection ? { sourceConnection: connection } : {}),
    })
  })
}

async function v2Setup(ctx: V2Context) {
  try {
    await ctx.integration.transform((editor) => {
      editor.update(PROVIDER_ID, (integration) => {
        integration.name = PROVIDER_NAME
      })
      editor.method.update({ integrationID: PROVIDER_ID, method: { type: "key", label: "API Key" } })
      editor.method.update({ integrationID: PROVIDER_ID, method: { type: "env", names: [...PROVIDER_ENV] } })
    })
    const connection = await ctx.integration.connection.active(PROVIDER_ID).catch(() => undefined)
    const credential = connection
      ? await ctx.integration.connection.resolve(connection).catch(() => undefined)
      : undefined
    const key = v2CredentialKey(credential)
    const [catalog, plan] = await Promise.all([getRemoteCatalog(), resolvePlan({}, ctx.options?.plan, key)])
    const gated = plan.source === "no-auth" || plan.source === "invalid-auth"
    const selected = !gated && catalog ? selectModels(catalog, plan.planId) : []
    const caps = new Map<string, number | undefined>(
      await Promise.all(selected.map(async (model) => [model.id, await capFor(model.id)] as const)),
    )
    await registerV2Provider(ctx, key, connection, (existing) =>
      gated || !catalog
        ? [v2PlaceholderModel()]
        : selected.map((model) => v2Model(model, caps.get(model.id), existing?.get(model.id))),
    )
  } catch {
    // best-effort: catálogo/plano/provider não podem derrubar o startup do v2
  }
}

const server = (async ({ client }, options) => {
  const log = (message: string, extra?: Record<string, unknown>) => {
    try {
      void client.app
        .log({ body: { service: "command-code-sync", level: "info", message, extra } })
        .catch(() => undefined)
    } catch {
      // log é best-effort: nunca interfere no startup
    }
  }

  return {
    config: async (cfg) => {
      try {
        ensureProvider(cfg)
        const [catalog, plan] = await Promise.all([getRemoteCatalog(), resolvePlan(cfg, options?.plan)])
        if (plan.source === "no-auth" || plan.source === "invalid-auth") {
          const result = applyPlaceholder(cfg, log)
          saveReport({
            plan: "auth-required",
            planSource: plan.source,
            source: "placeholder",
            added: result.updated.map((item) => item.id),
            updated: [],
            pruned: result.pruned,
            kept: [],
            fileUpdated: false,
          })
          log("sem auth válida; modelos reais ocultos até o /connect", {
            planSource: plan.source,
            placeholder: PLACEHOLDER_ID,
          })
          return
        }
        if (!catalog) {
          log("catálogo do Command Code indisponível (rede e snapshot); config mantido como está")
          return
        }
        const result = syncModels(cfg, catalog, plan.planId, log)
        const fileUpdated = syncConfigFile(result.updated, result.pruned)
        const added = result.updated.filter((item) => item.isNew).map((item) => item.id)
        const refreshed = result.updated.filter((item) => !item.isNew).map((item) => item.id)
        saveReport({
          plan: plan.planId ?? "auto:max",
          planSource: plan.source,
          source: catalog.source,
          catalogVersion: catalog.catalogVersion,
          added,
          updated: refreshed,
          pruned: result.pruned,
          kept: result.kept,
          fileUpdated,
        })
        log("sync do catálogo concluído", {
          plan: plan.planId ?? "auto:max",
          planSource: plan.source,
          source: catalog.source,
          catalogVersion: catalog.catalogVersion,
          added: added.length,
          updated: refreshed.length,
          pruned: result.pruned.length,
          kept: result.kept.length,
          fileUpdated,
        })
      } catch (error) {
        log("sync falhou; config mantido como está", { error: String(error) })
      }
    },
    auth: {
      provider: PROVIDER_ID,
      methods: [
        {
          type: "api",
          label: "API Key",
          authorize: async (inputs) => {
            const key = inputs?.key?.trim()
            if (!key) return { type: "failed" as const }
            return { type: "success" as const, key }
          },
        },
      ],
      loader: async (getAuth) => {
        const auth = await getAuth()
        const key =
          auth?.type === "api"
            ? auth.key
            : auth?.type === "oauth"
              ? auth.access
              : auth?.type === "wellknown"
                ? auth.token
                : undefined
        if (key) void refreshPlanIfStale(key)
        return key ? { apiKey: key } : {}
      },
    },
    "chat.params": async (input, output) => {
      if (input.model.providerID !== "commandcode") return
      const cap = await capFor(input.model.api.id)
      const fallback = Math.min(input.model.limit.output || WIRE_DEFAULT, WIRE_DEFAULT)
      output.maxOutputTokens = Math.min(cap ?? fallback, GATEWAY_CEILING)
    },
  }
}) satisfies Plugin

export default {
  id: "commandcode",
  server,
  setup: v2Setup,
}
