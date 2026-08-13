import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
  ProviderStreams,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
// Pi's extension loader aliases pi-ai to its compatibility entrypoint so the
// extension shares Pi's runtime instance. Import the lazy transports from that
// entrypoint; direct `pi-ai/api/*` subpaths can be incorrectly appended to the
// aliased `compat.js` path by jiti (for example `compat.js/api/...`).
import {
  anthropicMessagesApi,
  googleGenerativeAIApi,
  openAICompletionsApi,
  openAIResponsesApi,
} from "@earendil-works/pi-ai/compat";

export const SUPPORTED_APIS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
] as const;
export type SupportedApi = (typeof SUPPORTED_APIS)[number];

export function isSupportedApi(api: string): api is SupportedApi {
  return (SUPPORTED_APIS as readonly string[]).includes(api);
}

export function inferApi(type: string, explicit?: Api): Api {
  if (explicit) return explicit;
  const normalized = type.toLowerCase();
  switch (normalized) {
    case "anthropic": return "anthropic-messages";
    case "gemini":
    case "google": return "google-generative-ai";
    case "openai-responses": return "openai-responses";
    case "openai":
    case "openai-compatible":
    case "openrouter":
    case "sub2api":
    case "deepseek":
    case "ollama":
    case "vllm":
    case "azure": return "openai-completions";
    default: return type as Api;
  }
}

function streamsFor(api: SupportedApi): ProviderStreams {
  switch (api) {
    case "openai-completions": return openAICompletionsApi();
    case "openai-responses": return openAIResponsesApi();
    case "anthropic-messages": return anthropicMessagesApi();
    case "google-generative-ai": return googleGenerativeAIApi();
  }
}

/** Dispatch a routed model through pi-ai's native protocol implementation. */
export function streamWithTransport(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  if (!isSupportedApi(model.api)) throw new Error(`unsupported pi-switch transport: ${model.api}`);
  return streamsFor(model.api).streamSimple(model, context, options);
}
