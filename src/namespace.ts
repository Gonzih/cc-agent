import { basename } from "path";
import { jobIndexKey as _jobIndexKey } from "@gonzih/cc-wire";

/**
 * Resolves the current namespace for job queue isolation.
 *
 * Resolution order:
 *   1. CC_AGENT_NAMESPACE env var (explicit override)
 *   2. Last path segment of CWD env var (e.g. /Users/feral/simorgh-app → simorgh-app)
 *   3. "default"
 */
export function getNamespace(): string {
  if (process.env.CC_AGENT_NAMESPACE) {
    return process.env.CC_AGENT_NAMESPACE;
  }
  if (process.env.CWD) {
    const segment = basename(process.env.CWD);
    if (segment) return segment;
  }
  return "default";
}

/** Returns the namespaced Redis key for the job index set. */
export function jobIndexKey(namespace = getNamespace()): string {
  return _jobIndexKey(namespace);
}
