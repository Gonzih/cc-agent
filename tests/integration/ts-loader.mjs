/**
 * Custom Node.js ESM loader that remaps ".js" imports to ".ts" when the .js
 * file does not exist on disk (the standard TypeScript convention).
 *
 * Usage:
 *   node --experimental-strip-types --loader ./tests/integration/ts-loader.mjs --test ...
 *
 * This is necessary because Node.js v22's --experimental-strip-types flag does
 * NOT perform the .js → .ts fallback automatically (that was added in v23+).
 */

import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

export async function resolve(specifier, context, nextResolve) {
  // Only remap relative specifiers ending in .js
  if (
    specifier.startsWith(".") &&
    specifier.endsWith(".js") &&
    context.parentURL
  ) {
    try {
      const parentDir = dirname(fileURLToPath(context.parentURL));
      const absJs = resolvePath(parentDir, specifier);
      const absTs = absJs.replace(/\.js$/, ".ts");
      if (!existsSync(absJs) && existsSync(absTs)) {
        // Resolve the .ts version instead
        return nextResolve(pathToFileURL(absTs).href, context);
      }
    } catch {
      // Fall through to default resolution
    }
  }
  return nextResolve(specifier, context);
}
