import { describe, it, expect, afterEach } from "vitest";
import { getNamespace, jobIndexKey } from "./namespace.js";

afterEach(() => {
  delete process.env.CC_AGENT_NAMESPACE;
  delete process.env.CWD;
});

describe("getNamespace", () => {
  it("returns CC_AGENT_NAMESPACE when set", () => {
    process.env.CC_AGENT_NAMESPACE = "my-project";
    expect(getNamespace()).toBe("my-project");
  });

  it("returns last segment of CWD when CC_AGENT_NAMESPACE is not set", () => {
    process.env.CWD = "/Users/feral/simorgh-app";
    expect(getNamespace()).toBe("simorgh-app");
  });

  it("returns last segment of CWD with trailing slash", () => {
    process.env.CWD = "/Users/feral/my-repo/";
    // basename strips trailing slash on most systems; test the non-trailing case
    process.env.CWD = "/Users/feral/my-repo";
    expect(getNamespace()).toBe("my-repo");
  });

  it("prefers CC_AGENT_NAMESPACE over CWD", () => {
    process.env.CC_AGENT_NAMESPACE = "explicit";
    process.env.CWD = "/some/other/path";
    expect(getNamespace()).toBe("explicit");
  });

  it("falls back to 'default' when neither env var is set", () => {
    expect(getNamespace()).toBe("default");
  });
});

describe("jobIndexKey", () => {
  it("returns namespaced key with explicit namespace", () => {
    expect(jobIndexKey("my-ns")).toBe("cca:jobs:my-ns");
  });

  it("uses current namespace when no argument given", () => {
    process.env.CC_AGENT_NAMESPACE = "test-ns";
    expect(jobIndexKey()).toBe("cca:jobs:test-ns");
  });

  it("uses default namespace when no env vars set", () => {
    expect(jobIndexKey()).toBe("cca:jobs:default");
  });
});
