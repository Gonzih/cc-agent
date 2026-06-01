# Plan: LLM Wiki Layer

## Task restated
Add a per-repo knowledge base (wiki) stored as a Redis HASH. Each page is a markdown string keyed by page name. Auto-inject wiki content into every `spawn_agent` call. Expose 5 MCP tools: get_wiki, get_wiki_page, update_wiki_page, delete_wiki_page, list_wiki_pages.

## Approach chosen
Create `src/wiki.ts` with a WikiStore class (mirrors LearningsStore pattern in store.ts). Export a `wikiStore` singleton from store.ts. Auto-inject wiki pages in agent.ts `spawn()` after learnings injection. Register 5 MCP tools in index.ts.

## Redis key schema
- `cca:wiki:{repoSlug}` → Redis HASH (field=pageName, value=markdown content)
- `cca:wiki:{repoSlug}:updated` → STRING (ISO timestamp of last update)
- TTL: 90 days (same as learnings)
- repoSlug = `repoKey(repoUrl)` e.g. `gonzih/cc-agent`

## Files to touch
- `src/wiki.ts` (new)
- `src/store.ts` — import WikiStore and export wikiStore singleton
- `src/agent.ts` — import wikiStore, inject wiki pages into task in spawn()
- `src/index.ts` — import wikiStore, add 5 tool defs + case handlers
- `src/wiki.test.ts` (new)
- `README.md` — add 5 tools to table
