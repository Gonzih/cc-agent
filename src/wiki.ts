import { wikiKey, wikiUpdatedKey } from "@gonzih/cc-wire";
import { getRedis } from "./redis.js";
import { logger } from "./logger.js";

const WIKI_TTL_SECONDS = 90 * 24 * 60 * 60; // 90 days

export interface WikiPage {
  name: string;
  slug: string;
  content: string;
}

export class WikiStore {
  private mem = new Map<string, Map<string, string>>(); // repoSlug → (pageName → content)

  async savePage(repoSlug: string, pageName: string, content: string): Promise<void> {
    const redis = getRedis();
    if (redis) {
      try {
        await redis.hset(wikiKey(repoSlug), pageName, content);
        await redis.expire(wikiKey(repoSlug), WIKI_TTL_SECONDS);
        await redis.set(wikiUpdatedKey(repoSlug), new Date().toISOString(), "EX", WIKI_TTL_SECONDS);
        logger.info("wiki:savePage", { repoSlug, pageName, length: content.length });
        return;
      } catch (err) {
        logger.error("wiki:savePage Redis failed", err);
      }
    }
    if (!this.mem.has(repoSlug)) this.mem.set(repoSlug, new Map());
    this.mem.get(repoSlug)!.set(pageName, content);
  }

  async getPage(repoSlug: string, pageName: string): Promise<string | null> {
    const redis = getRedis();
    if (redis) {
      try {
        return await redis.hget(wikiKey(repoSlug), pageName);
      } catch (err) {
        logger.error("wiki:getPage Redis failed", err);
      }
    }
    return this.mem.get(repoSlug)?.get(pageName) ?? null;
  }

  async listPages(repoSlug: string): Promise<string[]> {
    const redis = getRedis();
    if (redis) {
      try {
        return await redis.hkeys(wikiKey(repoSlug));
      } catch (err) {
        logger.error("wiki:listPages Redis failed", err);
      }
    }
    return Array.from(this.mem.get(repoSlug)?.keys() ?? []);
  }

  async deletePage(repoSlug: string, pageName: string): Promise<boolean> {
    const redis = getRedis();
    if (redis) {
      try {
        const deleted = await redis.hdel(wikiKey(repoSlug), pageName);
        await redis.set(wikiUpdatedKey(repoSlug), new Date().toISOString(), "EX", WIKI_TTL_SECONDS);
        return deleted > 0;
      } catch (err) {
        logger.error("wiki:deletePage Redis failed", err);
      }
    }
    const repoMap = this.mem.get(repoSlug);
    if (!repoMap) return false;
    return repoMap.delete(pageName);
  }

  async getAllPages(repoSlug: string): Promise<WikiPage[]> {
    const redis = getRedis();
    if (redis) {
      try {
        const raw = await redis.hgetall(wikiKey(repoSlug));
        if (!raw) return [];
        return Object.entries(raw).map(([name, content]) => ({ name, slug: name, content }));
      } catch (err) {
        logger.error("wiki:getAllPages Redis failed", err);
      }
    }
    const repoMap = this.mem.get(repoSlug);
    if (!repoMap) return [];
    return Array.from(repoMap.entries()).map(([name, content]) => ({ name, slug: name, content }));
  }

  async deleteAll(repoSlug: string): Promise<void> {
    const redis = getRedis();
    if (redis) {
      try {
        await redis.del(wikiKey(repoSlug));
        await redis.del(wikiUpdatedKey(repoSlug));
        logger.info("wiki:deleteAll", { repoSlug });
        return;
      } catch (err) {
        logger.error("wiki:deleteAll Redis failed", err);
      }
    }
    this.mem.delete(repoSlug);
  }
}

export const wikiStore = new WikiStore();
