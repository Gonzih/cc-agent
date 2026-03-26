# lewm-mcp

MCP server that exposes the **LeWorldModel (LeWM)** inference API to Claude and other Model Context Protocol clients.

## Tools

| Tool | Description |
|------|-------------|
| `get_model_info` | Retrieve model metadata and configuration |
| `encode_frame` | Encode a raw frame into a latent representation |
| `predict_next_frame` | Predict the next frame (optionally N steps ahead) |

## Quick start

```bash
npx lewm-mcp
```

By default the server connects to `http://localhost:8000`. Override with:

```bash
LEWM_BASE_URL=http://my-lewm-server:8000 npx lewm-mcp
```

## Claude Desktop config

```json
{
  "mcpServers": {
    "lewm": {
      "command": "npx",
      "args": ["lewm-mcp"],
      "env": {
        "LEWM_BASE_URL": "http://localhost:8000"
      }
    }
  }
}
```

## LeWM API contract

The server expects the inference server to expose:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/info` | GET | Returns model metadata JSON |
| `/encode` | POST | Body: `{frame}` → returns `{latent}` |
| `/predict` | POST | Body: `{latent?, frame?, action?, steps?}` → returns prediction |

## License

MIT
