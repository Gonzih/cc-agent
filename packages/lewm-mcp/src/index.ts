#!/usr/bin/env node
/**
 * lewm-mcp — MCP server for LeWorldModel (LeWM) inference API
 *
 * Exposes the following tools to MCP clients (Claude, etc.):
 *   - predict_next_frame  : run forward inference to predict the next frame
 *   - encode_frame        : encode a raw frame into a latent representation
 *   - get_model_info      : retrieve model metadata / configuration
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const LEWM_BASE_URL =
  process.env.LEWM_BASE_URL ?? "http://localhost:8000";

// ---------------------------------------------------------------------------
// LeWM API helpers
// ---------------------------------------------------------------------------

async function lewmFetch(
  path: string,
  method: "GET" | "POST",
  body?: unknown
): Promise<unknown> {
  const url = `${LEWM_BASE_URL}${path}`;
  const init: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }

  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(
      `LeWM API error ${res.status} ${res.statusText}: ${text}`
    );
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

/** GET /info — model metadata */
async function getModelInfo(): Promise<unknown> {
  return lewmFetch("/info", "GET");
}

/**
 * POST /encode — encode a raw frame into a latent vector
 *
 * Expected request body: { frame: number[][] | string }
 *   frame can be a base64-encoded image string or a 2-D pixel array.
 */
async function encodeFrame(frame: unknown): Promise<unknown> {
  return lewmFetch("/encode", "POST", { frame });
}

/**
 * POST /predict — predict the next frame
 *
 * Expected request body:
 *   {
 *     latent?: number[],           // pre-encoded latent (if skipping encode step)
 *     frame?: number[][] | string, // raw frame (server will encode internally)
 *     action?: number[],           // optional action conditioning vector
 *     steps?: number               // how many steps ahead to predict (default 1)
 *   }
 */
async function predictNextFrame(
  latent: unknown,
  frame: unknown,
  action: unknown,
  steps: unknown
): Promise<unknown> {
  const payload: Record<string, unknown> = {};
  if (latent !== undefined && latent !== null) payload.latent = latent;
  if (frame !== undefined && frame !== null) payload.frame = frame;
  if (action !== undefined && action !== null) payload.action = action;
  if (steps !== undefined && steps !== null) payload.steps = steps;
  return lewmFetch("/predict", "POST", payload);
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "lewm-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get_model_info",
      description:
        "Retrieve metadata and configuration about the loaded LeWorldModel (architecture, input/output dimensions, checkpoint info, etc.).",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      },
    },
    {
      name: "encode_frame",
      description:
        "Encode a raw video/image frame into a latent representation using the LeWM encoder.",
      inputSchema: {
        type: "object",
        properties: {
          frame: {
            description:
              "The frame to encode. Can be a base64-encoded PNG/JPEG string or a 2-D array of pixel values (H×W or H×W×C).",
            oneOf: [
              { type: "string", description: "Base64-encoded image data" },
              {
                type: "array",
                description: "2-D or 3-D pixel array",
                items: { type: "array", items: { type: "number" } },
              },
            ],
          },
        },
        required: ["frame"],
      },
    },
    {
      name: "predict_next_frame",
      description:
        "Run forward inference to predict the next frame (or N steps ahead). Provide either a pre-encoded latent vector or a raw frame; the server will encode it if needed.",
      inputSchema: {
        type: "object",
        properties: {
          latent: {
            type: "array",
            items: { type: "number" },
            description:
              "Pre-encoded latent vector (from encode_frame). Mutually optional with 'frame'.",
          },
          frame: {
            description:
              "Raw frame to condition on (base64 string or pixel array). The server encodes it before predicting.",
            oneOf: [
              { type: "string" },
              {
                type: "array",
                items: { type: "array", items: { type: "number" } },
              },
            ],
          },
          action: {
            type: "array",
            items: { type: "number" },
            description:
              "Optional action conditioning vector (e.g., controller input).",
          },
          steps: {
            type: "integer",
            minimum: 1,
            default: 1,
            description: "Number of steps to predict ahead (default: 1).",
          },
        },
        required: [],
      },
    },
  ],
}));

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    let result: unknown;

    switch (name) {
      case "get_model_info":
        result = await getModelInfo();
        break;

      case "encode_frame":
        if (args.frame === undefined) {
          throw new Error("Missing required argument: frame");
        }
        result = await encodeFrame(args.frame);
        break;

      case "predict_next_frame":
        result = await predictNextFrame(
          args.latent,
          args.frame,
          args.action,
          args.steps
        );
        break;

      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr so it doesn't pollute the MCP stdio channel
  process.stderr.write(
    `lewm-mcp started — LeWM base URL: ${LEWM_BASE_URL}\n`
  );
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err}\n`);
  process.exit(1);
});
