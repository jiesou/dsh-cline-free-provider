import type { Context } from '@deepseek-ai/cordis';
import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm';
import z from '@deepseek-ai/schemastery';
export declare const name = "cline-free-provider";
export declare const inject: string[];
interface ReasoningMetadata {
    /** Effort ids the OpenRouter secondary scan credits this model with. */
    supportedEfforts?: string[];
    /** Upstream says thinking cannot be turned off on this model. */
    mandatory?: boolean;
}
interface ClineModel {
    id: string;
    name?: string;
    contextWindow?: number;
    maxTokens?: number;
    /** Whether the Cline feed lists `reasoning_effort` among its `supported_parameters`. */
    supportsReasoningEffort?: boolean;
    /** Whether the feed's `architecture.input_modalities` names `image`. */
    imageInput?: boolean;
    /** Optional ladder from the OpenRouter secondary scan (absent if that scan failed). */
    reasoning?: ReasoningMetadata;
}
export interface Config {
    apiKeyEnv?: string;
    baseURL?: string;
    defaultMaxTokens?: number;
    defaultContextWindow?: number;
    /** Base64 image payload one request accepts before older images are offloaded (default 2 MiB). */
    maxRequestImageBytes?: number;
    /** Per-image request budget after re-encoding (default 1 MiB). */
    requestImageMaxBytes?: number;
    /** Provider-owned model-request retry policy; omission uses normal defaults. */
    retryPolicy?: RetryPolicyConfig;
}
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    apiKeyEnv: z<string, string, "volatile-defined">;
    baseURL: z<string, string, "volatile-defined">;
    defaultMaxTokens: z<number, number, "volatile-defined">;
    defaultContextWindow: z<number, number, "volatile-defined">;
    maxRequestImageBytes: z<number, number, "volatile-defined">;
    requestImageMaxBytes: z<number, number, "volatile-defined">;
    retryPolicy: z<NoInfer<RetryPolicyConfig>, NoInfer<RetryPolicyConfig>, "volatile">;
}>>, Schemastery.ObjectT<NoInfer<{
    apiKeyEnv: z<string, string, "volatile-defined">;
    baseURL: z<string, string, "volatile-defined">;
    defaultMaxTokens: z<number, number, "volatile-defined">;
    defaultContextWindow: z<number, number, "volatile-defined">;
    maxRequestImageBytes: z<number, number, "volatile-defined">;
    requestImageMaxBytes: z<number, number, "volatile-defined">;
    retryPolicy: z<NoInfer<RetryPolicyConfig>, NoInfer<RetryPolicyConfig>, "volatile">;
}>>, "plain">;
/**
 * {@link Config} as the Loader holds it: every field is volatile, so a settings write
 * reaches the running plugin as a committed reference instead of remounting it, and
 * the field is one the settings service shows a form for.
 */
type LiveConfig = Schemastery.TypeT<typeof Config>;
export declare function fetchFreeModels(url?: string, fetchImpl?: typeof fetch, freeBucketIds?: ReadonlySet<string>): Promise<ClineModel[]>;
/**
 * Cline's own free-tier designation, straight from the feed the Cline client
 * uses to tag FREE in its model picker (and the CLI uses to zero billing).
 * The catalog feed's `pricing` field is the upstream market price and does
 * not reflect this list, which rotates.
 */
export declare function fetchFreeModelIds(url?: string, fetchImpl?: typeof fetch): Promise<Set<string>>;
export declare function fetchOpenRouterReasoning(url?: string, fetchImpl?: typeof fetch): Promise<Map<string, ReasoningMetadata>>;
export declare function apply(ctx: Context, config: LiveConfig): Promise<void>;
export {};
