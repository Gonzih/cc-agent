import { getRedis } from "./redis.js";
import { logger } from "./logger.js";
import { TOKEN_INDEX_KEY } from "@gonzih/cc-wire";

export interface TokenStatus {
  index: number;
  total: number;
  allExhausted: boolean;
}

/**
 * Parse CLAUDE_TOKENS env (comma-split), fallback to CLAUDE_CODE_OAUTH_TOKEN.
 * Returns the list of tokens to rotate through.
 */
export function loadTokens(): string[] {
  const multi = process.env.CLAUDE_TOKENS;
  if (multi) {
    const tokens = multi.split(",").map((t) => t.trim()).filter(Boolean);
    if (tokens.length > 0) return tokens;
  }
  const single = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (single) return [single];
  return [];
}

/** Get the token at the current Redis index (cca:token:index). */
export async function getCurrentToken(): Promise<string> {
  const tokens = loadTokens();
  if (tokens.length === 0) return "";
  if (tokens.length === 1) return tokens[0];

  const redis = getRedis();
  if (!redis) return tokens[0];

  const raw = await redis.get(TOKEN_INDEX_KEY);
  const counter = raw ? parseInt(raw, 10) : 0;
  const index = counter % tokens.length;
  return tokens[index];
}

/**
 * Increment Redis index (INCR cca:token:index, mod token count).
 * Returns the next token.
 */
export async function rotateToken(): Promise<string> {
  const tokens = loadTokens();
  if (tokens.length <= 1) return tokens[0] ?? "";

  const redis = getRedis();
  if (!redis) return tokens[0];

  const newCounter = await redis.incr(TOKEN_INDEX_KEY);
  const index = newCounter % tokens.length;
  logger.info("token:rotated", { counter: newCounter, index, total: tokens.length });
  return tokens[index];
}

/** Returns { index, total, allExhausted }. */
export async function getTokenStatus(): Promise<TokenStatus> {
  const tokens = loadTokens();
  const total = tokens.length;
  if (total === 0) return { index: 0, total: 0, allExhausted: true };

  const redis = getRedis();
  let counter = 0;
  if (redis) {
    const raw = await redis.get(TOKEN_INDEX_KEY);
    counter = raw ? parseInt(raw, 10) : 0;
  }

  const index = counter % total;
  // allExhausted: we've rotated through all tokens (counter >= total means we've
  // incremented past the last token and are wrapping around again).
  const allExhausted = counter >= total;
  return { index, total, allExhausted };
}

/** Reset all tokens (when reset time passes or manually triggered). */
export async function resetTokens(): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  await redis.del(TOKEN_INDEX_KEY);
  logger.info("token:reset");
}
