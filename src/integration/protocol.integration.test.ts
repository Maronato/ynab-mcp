import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./harness.js";
import { seedStandardBudget } from "./seed.js";

let harness: IntegrationHarness;

beforeEach(async () => {
  harness = await createIntegrationHarness({
    seed: seedStandardBudget,
  });
});

afterEach(async () => {
  await harness.close();
});

describe("tool listing", () => {
  it("lists all registered tools", async () => {
    const result = await harness.client.listTools();
    expect(result.tools.length).toBeGreaterThanOrEqual(27);
  });

  it("each tool has a name and inputSchema", async () => {
    const result = await harness.client.listTools();
    for (const tool of result.tools) {
      expect(tool).toHaveProperty("name");
      expect(typeof tool.name).toBe("string");
      expect(tool).toHaveProperty("inputSchema");
    }
  });
});

describe("resource listing", () => {
  it("lists registered resources", async () => {
    const result = await harness.client.listResources();
    expect(result.resources.length).toBeGreaterThan(0);
    for (const resource of result.resources) {
      expect(resource).toHaveProperty("name");
      expect(resource).toHaveProperty("uri");
    }
  });
});

describe("prompt listing", () => {
  it("lists registered prompts", async () => {
    const result = await harness.client.listPrompts();
    expect(result.prompts.length).toBeGreaterThan(0);
    for (const prompt of result.prompts) {
      expect(prompt).toHaveProperty("name");
    }
  });
});

describe("tool call validation", () => {
  it("returns error for tool call with wrong schema", async () => {
    const result = await harness.client.callTool({
      name: "search_transactions",
      arguments: { completely_wrong_field: true },
    });
    expect(result.isError).toBe(true);
  });
});
