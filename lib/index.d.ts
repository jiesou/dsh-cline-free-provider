import type { Context } from '@deepseek-ai/cordis';
import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm';
import z from '@deepseek-ai/schemastery';
import { type ThinkingLevelMap } from '@earendil-works/pi-ai';
export declare const name = "cline-free-provider";
export declare const inject: string[];
interface ReasoningMetadata {
    supportedEfforts?: string[];
    mandatory?: boolean;
}
interface ClineModel {
    id: string;
    name?: string;
    contextWindow?: number;
    maxTokens?: number;
    reasoning?: ReasoningMetadata;
}
export interface Config {
    apiKeyEnv?: string;
    baseURL?: string;
    defaultMaxTokens?: number;
    defaultContextWindow?: number;
    /** Provider-owned model-request retry policy; omission uses normal defaults. */
    retryPolicy?: RetryPolicyConfig;
}
export declare const Config: z<Config>;
export declare function fetchFreeModels(url?: string, fetchImpl?: typeof fetch): Promise<ClineModel[]>;
export declare function fetchOpenRouterReasoning(url?: string, fetchImpl?: typeof fetch): Promise<Map<string, ReasoningMetadata>>;
export declare function reasoningMapFor(reasoning: ReasoningMetadata | undefined): ThinkingLevelMap;
export declare function apply(ctx: Context, config: Config): Promise<void>;
export {};
