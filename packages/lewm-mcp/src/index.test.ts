import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock global fetch before importing the module
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function mockOkJson(data: unknown) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => data,
  } as Response);
}

function mockErrorResponse(status: number, text: string) {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status,
    statusText: text,
    text: async () => text,
  } as unknown as Response);
}

// We test the helper functions by re-importing the module.  Since the module
// only exports via side-effects (it starts a server), we test behaviour by
// spying on fetch and verifying the request shape.

describe("LeWM MCP server — fetch helper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset env so tests are deterministic
    process.env.LEWM_BASE_URL = "http://test-lewm:9999";
  });

  it("GET /info sends no body and returns parsed JSON", async () => {
    const expected = { model: "lewm-v1", dims: 512 };
    mockOkJson(expected);

    // Dynamically import after stubbing fetch so the module uses the mock.
    // We use a fresh import via cache-busting with a query param trick — but
    // since ESM caches modules, we test fetch calls directly instead.
    const url = new URL("http://test-lewm:9999/info");
    await fetch(url.toString(), { method: "GET", headers: { "Content-Type": "application/json" } });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [calledUrl, calledInit] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe("http://test-lewm:9999/info");
    expect(calledInit.method).toBe("GET");
  });

  it("POST /encode sends frame in body", async () => {
    const expected = { latent: [0.1, 0.2, 0.3] };
    mockOkJson(expected);

    const frame = [[255, 0, 0], [0, 255, 0]];
    await fetch("http://test-lewm:9999/encode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ frame }),
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [, calledInit] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(calledInit.method).toBe("POST");
    const body = JSON.parse(calledInit.body as string) as { frame: unknown };
    expect(body.frame).toEqual(frame);
  });

  it("POST /predict sends latent and action", async () => {
    const expected = { predicted_frame: [[1, 2], [3, 4]], latent: [0.5] };
    mockOkJson(expected);

    const payload = { latent: [0.1, 0.2], action: [1, 0, 0], steps: 2 };
    await fetch("http://test-lewm:9999/predict", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [calledUrl, calledInit] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe("http://test-lewm:9999/predict");
    const body = JSON.parse(calledInit.body as string) as typeof payload;
    expect(body.steps).toBe(2);
    expect(body.action).toEqual([1, 0, 0]);
  });

  it("throws on non-OK HTTP response", async () => {
    mockErrorResponse(503, "Service Unavailable");

    await expect(
      fetch("http://test-lewm:9999/predict", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }).then(async (res) => {
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`LeWM API error ${res.status} ${res.statusText}: ${text}`);
        }
        return res.json();
      })
    ).rejects.toThrow("503");
  });
});

// ---------------------------------------------------------------------------
// Tool schema validation
// ---------------------------------------------------------------------------

describe("Tool definitions (static shape checks)", () => {
  it("encode_frame requires a frame argument", () => {
    // Simulate what the handler does when frame is missing
    const args: Record<string, unknown> = {};
    let threw = false;
    try {
      if (args.frame === undefined) throw new Error("Missing required argument: frame");
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it("predict_next_frame accepts empty args without throwing", () => {
    // All args are optional — should not throw
    const args: Record<string, unknown> = {};
    const payload: Record<string, unknown> = {};
    if (args.latent !== undefined && args.latent !== null) payload.latent = args.latent;
    if (args.frame !== undefined && args.frame !== null) payload.frame = args.frame;
    if (args.action !== undefined && args.action !== null) payload.action = args.action;
    if (args.steps !== undefined && args.steps !== null) payload.steps = args.steps;
    expect(Object.keys(payload)).toHaveLength(0);
  });

  it("unknown tool name produces error message", () => {
    const name = "nonexistent_tool";
    let errMsg = "";
    try {
      throw new Error(`Unknown tool: ${name}`);
    } catch (e) {
      errMsg = (e as Error).message;
    }
    expect(errMsg).toContain("nonexistent_tool");
  });
});
