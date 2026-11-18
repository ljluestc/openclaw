// Openai tests cover GPT-Live (quicksilver) realtime voice gating.
import { describe, expect, it, vi } from "vitest";
import { OpenAIQuicksilverGatewayBridge } from "./realtime-quicksilver-gateway-bridge.js";
import { buildAzureOpenAIGptLiveWebSocketUrl } from "./realtime-quicksilver-wire.js";
import { isOpenAIGptLiveModel, isSupportedOpenAIGptLiveModel } from "./realtime-quicksilver.js";
import { buildOpenAIRealtimeVoiceProvider } from "./realtime-voice-provider.js";

describe("openai gpt-live model detection", () => {
  it("matches the gpt-live model family", () => {
    expect(isOpenAIGptLiveModel("gpt-live-1")).toBe(true);
    expect(isOpenAIGptLiveModel("gpt-live-1-mini")).toBe(true);
    expect(isOpenAIGptLiveModel(" GPT-Live-1 ")).toBe(true);
    expect(isOpenAIGptLiveModel("gpt-live")).toBe(true);
  });

  it("rejects non-live models and prefix lookalikes", () => {
    expect(isOpenAIGptLiveModel(undefined)).toBe(false);
    expect(isOpenAIGptLiveModel("gpt-realtime-2.1")).toBe(false);
    expect(isOpenAIGptLiveModel("gpt-liveish")).toBe(false);
  });

  it("distinguishes released routes from unlisted family members", () => {
    expect(isSupportedOpenAIGptLiveModel("gpt-live-1")).toBe(true);
    expect(isSupportedOpenAIGptLiveModel(" GPT-Live-1 ")).toBe(true);
    expect(isSupportedOpenAIGptLiveModel("gpt-live-1-codex")).toBe(true);
    expect(isSupportedOpenAIGptLiveModel(" GPT-Live-1-Codex ")).toBe(true);
    expect(isSupportedOpenAIGptLiveModel("gpt-live-test-canary")).toBe(false);
  });
});

describe("openai realtime voice provider gpt-live transport routing", () => {
  it("routes gpt-live by the host-owned delegation seam", () => {
    const provider = buildOpenAIRealtimeVoiceProvider();
    const callbacks = {
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    };
    expect(
      provider.createBridge({
        ...callbacks,
        providerConfig: { apiKey: "test-key", model: "gpt-live-test-canary" },
      }),
    ).toMatchObject({
      supportsToolResultContinuation: true,
      handlesInputAudioBargeIn: true,
      outputAudioMode: "continuous",
    });
    expect(
      provider.createBridge({
        ...callbacks,
        providerConfig: { apiKey: "test-key", model: "gpt-live-1" },
        runAgentConsult: vi.fn(async () => ({ text: "done" })),
      }),
    ).toMatchObject({
      supportsToolResultContinuation: false,
      handlesInputAudioBargeIn: true,
      outputAudioMode: "continuous",
    });
    expect(() =>
      provider.createBridge({
        ...callbacks,
        providerConfig: { apiKey: "test-key", model: "gpt-realtime-2.1" },
      }),
    ).not.toThrow();
  });

  describe("Azure Foundry", () => {
    const azure = {
      apiKey: "azure-resource-key",
      model: "gpt-live-1",
      azureEndpoint: "https://example.openai.azure.com",
      azureDeployment: "live-prod",
    };
    const createAzureBridge = (providerConfig: Record<string, unknown>, gatewayRelay = true) =>
      buildOpenAIRealtimeVoiceProvider().createBridge({
        providerConfig,
        onAudio: vi.fn(),
        onClearAudio: vi.fn(),
        ...(gatewayRelay ? { runAgentConsult: async () => ({ text: "done" }) } : {}),
      });

    it("routes gpt-live-1 through the Gateway relay bridge", () => {
      expect(createAzureBridge(azure)).toBeInstanceOf(OpenAIQuicksilverGatewayBridge);
    });

    it("requires the Gateway relay", () => {
      expect(() => createAzureBridge(azure, false)).toThrow(
        "Azure GPT-Live is available only through the Talk Gateway relay",
      );
    });

    it.each([
      [{ model: "gpt-live-1-codex" }, "supports model gpt-live-1 only"],
      [{ model: "gpt-live-test-canary" }, "supports model gpt-live-1 only"],
      [{ azureEndpoint: undefined }, "requires azureEndpoint"],
      [{ azureApiVersion: "2025-08-28" }, "remove azureApiVersion"],
      [{ apiKey: undefined }, "requires the Azure resource key"],
      [{ azureEndpoint: "http://example.openai.azure.com" }, "must be an https:// URL"],
    ] as const)("rejects %j with a next step", (override, message) => {
      vi.stubEnv("OPENAI_API_KEY", "openai-platform-key");
      try {
        expect(() => createAzureBridge({ ...azure, ...override })).toThrow(message);
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  it.each([
    "https://example.openai.azure.com",
    "https://example.openai.azure.com/",
    "https://example.openai.azure.com/openai",
    "https://example.openai.azure.com/openai/v1/",
    "wss://example.openai.azure.com/openai/v1?api-version=preview",
  ])("builds the Azure Live sessions URL from %s", (endpoint) => {
    expect(buildAzureOpenAIGptLiveWebSocketUrl(endpoint)).toBe(
      "wss://example.openai.azure.com/openai/v1/live/sessions",
    );
  });
});
