import { describe, it, expect } from "vitest";
import { getPricing } from "../pricing.js";

describe("getPricing", () => {
  it("returns correct pricing for claude-sonnet-4-6", () => {
    const p = getPricing("claude-sonnet-4-6");
    expect(p.inputPer1M).toBe(3.00);
    expect(p.outputPer1M).toBe(15.00);
    expect(p.cacheReadPer1M).toBe(0.30);
    expect(p.cacheWritePer1M).toBe(3.75);
  });

  it("returns correct pricing for claude-opus-4-6", () => {
    const p = getPricing("claude-opus-4-6");
    expect(p.inputPer1M).toBe(15.00);
    expect(p.outputPer1M).toBe(75.00);
  });

  it("returns correct pricing for gpt-4o", () => {
    const p = getPricing("gpt-4o");
    expect(p.inputPer1M).toBe(2.50);
    expect(p.outputPer1M).toBe(10.00);
  });

  it("returns correct pricing for qwen2.5-72b-instruct", () => {
    const p = getPricing("qwen2.5-72b-instruct");
    expect(p.inputPer1M).toBe(0.40);
    expect(p.outputPer1M).toBe(1.20);
  });

  it("returns correct pricing for deepseek-v3", () => {
    const p = getPricing("deepseek-v3");
    expect(p.inputPer1M).toBe(0.14);
    expect(p.outputPer1M).toBe(0.28);
  });

  it("returns correct pricing for kimi-k2", () => {
    const p = getPricing("kimi-k2");
    expect(p.inputPer1M).toBe(0.60);
    expect(p.outputPer1M).toBe(2.50);
  });

  it("returns default fallback for unknown model", () => {
    const p = getPricing("some-unknown-model-xyz");
    expect(p.inputPer1M).toBe(1.0);
    expect(p.outputPer1M).toBe(3.0);
  });

  it("returns default fallback for empty string", () => {
    const p = getPricing("");
    expect(p.inputPer1M).toBe(1.0);
    expect(p.outputPer1M).toBe(3.0);
  });

  it("does prefix matching for versioned model names", () => {
    // e.g. "claude-sonnet-4-6-20260101" should match "claude-sonnet-4-6"
    const p = getPricing("claude-sonnet-4-6-20260101");
    expect(p.inputPer1M).toBe(3.00);
    expect(p.outputPer1M).toBe(15.00);
  });

  it("returns correct pricing for claude-haiku-4-5", () => {
    const p = getPricing("claude-haiku-4-5");
    expect(p.inputPer1M).toBe(0.80);
    expect(p.outputPer1M).toBe(4.00);
  });
});
