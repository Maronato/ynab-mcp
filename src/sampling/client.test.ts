import { describe, expect, it, vi } from "vitest";
import { SamplingClient, SamplingNotAvailableError } from "./client.js";

function createMockServer(hasSampling: boolean) {
  return {
    getClientCapabilities: vi.fn(() => (hasSampling ? { sampling: {} } : {})),
    createMessage: vi.fn(),
  };
}

describe("SamplingClient", () => {
  describe("isAvailable", () => {
    it("returns false when capabilities have no sampling", () => {
      const server = createMockServer(false);
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const client = new SamplingClient(server as any);
      expect(client.isAvailable()).toBe(false);
    });

    it("returns false when getClientCapabilities returns undefined", () => {
      const server = {
        getClientCapabilities: vi.fn(() => undefined),
        createMessage: vi.fn(),
      };
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const client = new SamplingClient(server as any);
      expect(client.isAvailable()).toBe(false);
    });

    it("returns true when sampling capability is present", () => {
      const server = createMockServer(true);
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const client = new SamplingClient(server as any);
      expect(client.isAvailable()).toBe(true);
    });
  });

  describe("createMessage", () => {
    it("throws SamplingNotAvailableError when not available", async () => {
      const server = createMockServer(false);
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const client = new SamplingClient(server as any);

      await expect(
        client.createMessage({ messages: [], maxTokens: 100 }),
      ).rejects.toThrow(SamplingNotAvailableError);
      expect(server.createMessage).not.toHaveBeenCalled();
    });

    it("delegates to server.createMessage when available", async () => {
      const server = createMockServer(true);
      const mockResult = {
        role: "assistant",
        content: { type: "text", text: "hello" },
        model: "test-model",
        stopReason: "endTurn",
      };
      server.createMessage.mockResolvedValue(mockResult);
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const client = new SamplingClient(server as any);

      const params = { messages: [], maxTokens: 100 };
      const result = await client.createMessage(params);

      expect(result).toBe(mockResult);
      expect(server.createMessage).toHaveBeenCalledWith(params);
    });
  });

  describe("createJsonMessage", () => {
    it("parses valid JSON from text response", async () => {
      const server = createMockServer(true);
      server.createMessage.mockResolvedValue({
        role: "assistant",
        content: { type: "text", text: '[{"id": "1", "value": true}]' },
        model: "test-model",
        stopReason: "endTurn",
      });
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const client = new SamplingClient(server as any);

      const result = await client.createJsonMessage({
        messages: [],
        maxTokens: 100,
      });

      expect(result).toEqual([{ id: "1", value: true }]);
    });

    it("strips markdown code fences before parsing", async () => {
      const server = createMockServer(true);
      server.createMessage.mockResolvedValue({
        role: "assistant",
        content: {
          type: "text",
          text: '```json\n[{"id": "1"}]\n```',
        },
        model: "test-model",
        stopReason: "endTurn",
      });
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const client = new SamplingClient(server as any);

      const result = await client.createJsonMessage({
        messages: [],
        maxTokens: 100,
      });

      expect(result).toEqual([{ id: "1" }]);
    });

    it("strips bare code fences without language tag", async () => {
      const server = createMockServer(true);
      server.createMessage.mockResolvedValue({
        role: "assistant",
        content: {
          type: "text",
          text: '```\n{"key": "val"}\n```',
        },
        model: "test-model",
        stopReason: "endTurn",
      });
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const client = new SamplingClient(server as any);

      const result = await client.createJsonMessage({
        messages: [],
        maxTokens: 100,
      });

      expect(result).toEqual({ key: "val" });
    });

    it("throws on non-text content", async () => {
      const server = createMockServer(true);
      server.createMessage.mockResolvedValue({
        role: "assistant",
        content: { type: "image", data: "abc", mimeType: "image/png" },
        model: "test-model",
        stopReason: "endTurn",
      });
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const client = new SamplingClient(server as any);

      await expect(
        client.createJsonMessage({ messages: [], maxTokens: 100 }),
      ).rejects.toThrow("Sampling response did not contain text content.");
    });

    it("throws on invalid JSON", async () => {
      const server = createMockServer(true);
      server.createMessage.mockResolvedValue({
        role: "assistant",
        content: { type: "text", text: "not json at all" },
        model: "test-model",
        stopReason: "endTurn",
      });
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const client = new SamplingClient(server as any);

      await expect(
        client.createJsonMessage({ messages: [], maxTokens: 100 }),
      ).rejects.toThrow();
    });
  });
});
