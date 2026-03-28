import { execFile, spawn } from "child_process";
import { EventEmitter } from "events";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { promisify } from "util";
import { logger } from "./logger.js";

const execFileAsync = promisify(execFile);

/** Returns env with DOCKER_HOST set to the colima socket (unless already set). */
export function getDockerEnv(): NodeJS.ProcessEnv {
  if (process.env.DOCKER_HOST) return process.env as NodeJS.ProcessEnv;
  return { ...process.env, DOCKER_HOST: `unix://${homedir()}/.colima/default/docker.sock` };
}

export async function isDockerAvailable(): Promise<boolean> {
  try {
    await execFileAsync("docker", ["info"], { timeout: 5000, env: getDockerEnv() } as Parameters<typeof execFileAsync>[2]);
    return true;
  } catch {
    return false;
  }
}

export interface DockerContainerInfo {
  id: string;
  name: string;
  status: string;
  uptime: string;
}

export async function listCcAgentContainers(): Promise<DockerContainerInfo[]> {
  try {
    const { stdout } = await execFileAsync("docker", [
      "ps",
      "--filter", "label=cc-agent",
      "--format", "{{.ID}}\t{{.Names}}\t{{.Status}}\t{{.RunningFor}}",
    ], { env: getDockerEnv() } as Parameters<typeof execFileAsync>[2]);
    return (stdout as string)
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line: string) => {
        const [id, name, status, uptime] = line.split("\t");
        return { id: id ?? "", name: name ?? "", status: status ?? "", uptime: uptime ?? "" };
      });
  } catch {
    return [];
  }
}

/**
 * Builds additional `-e` and `-v` args for `docker run` to forward host
 * credentials (GitHub, npm, git identity, SSH keys) into the container.
 */
export function buildDockerCredentialArgs(): { args: string[]; hasGitIdentity: boolean } {
  const args: string[] = [];
  const home = homedir();

  // Forward additional credential env vars if set on host
  const envVarsToCopy = ["NPM_TOKEN", "CLAUDE_MODEL", "CLAUDE_CODE_OAUTH_TOKEN"];
  for (const key of envVarsToCopy) {
    const val = process.env[key];
    if (val) args.push("-e", `${key}=${val}`);
  }

  // Mount ~/.gitconfig if it exists (read-only; system-level config acts as fallback)
  let hasGitIdentity = false;
  const gitconfigPath = `${home}/.gitconfig`;
  if (existsSync(gitconfigPath)) {
    args.push("-v", `${gitconfigPath}:/root/.gitconfig:ro`);
    const content = readFileSync(gitconfigPath, "utf8");
    hasGitIdentity = content.includes("email");
  }

  // Mount ~/.ssh if it exists (for SSH-based git operations)
  const sshPath = `${home}/.ssh`;
  if (existsSync(sshPath)) {
    args.push("-v", `${sshPath}:/root/.ssh:ro`);
  }

  // Mount ~/.npmrc if it exists
  const npmrcPath = `${home}/.npmrc`;
  if (existsSync(npmrcPath)) {
    args.push("-v", `${npmrcPath}:/root/.npmrc:ro`);
  }

  return { args, hasGitIdentity };
}

export interface DockerAgentProcess extends EventEmitter {
  kill(): void;
  pid: undefined;
  stdin: null;
}

/**
 * Run a cc-agent job inside a Docker container.
 *
 * Emits:
 *   "text"  (line: string)      — each line of container output
 *   "exit"  (code: number)      — container exit code
 *   "error" (err: unknown)      — fatal error before container starts
 */
export function runDockerAgent(opts: {
  containerName: string;
  repoUrl: string;
  task: string;
  anthropicToken?: string;
  githubToken?: string;
  namespace?: string;
}): DockerAgentProcess {
  const emitter = new EventEmitter() as DockerAgentProcess;
  emitter.pid = undefined;
  emitter.stdin = null;

  let containerStarted = false;
  let killed = false;

  emitter.kill = () => {
    killed = true;
    if (containerStarted) {
      execFile("docker", ["rm", "-f", opts.containerName], { env: getDockerEnv() }, () => {});
    }
  };

  void (async () => {
    try {
      // Build docker env args
      const envArgs: string[] = [];
      if (opts.anthropicToken) {
        envArgs.push("-e", `ANTHROPIC_AUTH_TOKEN=${opts.anthropicToken}`);
        envArgs.push("-e", `ANTHROPIC_API_KEY=${opts.anthropicToken}`);
        envArgs.push("-e", `CLAUDE_CODE_OAUTH_TOKEN=${opts.anthropicToken}`);
      }
      if (opts.githubToken) {
        envArgs.push("-e", `GITHUB_TOKEN=${opts.githubToken}`);
        envArgs.push("-e", `GH_TOKEN=${opts.githubToken}`);
      }
      if (opts.namespace) {
        envArgs.push("-e", `CC_AGENT_NAMESPACE=${opts.namespace}`);
      }
      envArgs.push("-e", "HOME=/root");
      // Agent self-awareness: let the container know it's isolated
      envArgs.push("-e", "IN_DOCKER=true");
      envArgs.push("-e", "DOCKER_CONTAINER=1");
      // Pass task and repo via env to avoid shell quoting issues
      envArgs.push("-e", `CC_DOCKER_TASK=${opts.task}`);
      envArgs.push("-e", `CC_DOCKER_REPO=${opts.repoUrl}`);

      // Inject host credentials (GitHub, npm, git identity, SSH keys)
      const { args: credentialArgs, hasGitIdentity } = buildDockerCredentialArgs();
      envArgs.push(...credentialArgs);

      // Git identity fallback env vars (highest git precedence, used when host
      // .gitconfig is absent or has no email set)
      if (!hasGitIdentity) {
        envArgs.push("-e", "GIT_AUTHOR_NAME=cc-agent");
        envArgs.push("-e", "GIT_AUTHOR_EMAIL=cc-agent@local");
        envArgs.push("-e", "GIT_COMMITTER_NAME=cc-agent");
        envArgs.push("-e", "GIT_COMMITTER_EMAIL=cc-agent@local");
      }

      const containerScript = [
        "set -e",
        // Install system deps (node:22 is Debian-based)
        "apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq git curl >/dev/null 2>&1",
        // Install gh CLI via direct binary download (amd64)
        "GH_VERSION=2.65.0",
        "ARCH=$(dpkg --print-architecture 2>/dev/null || echo amd64)",
        "curl -fsSL \"https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${ARCH}.tar.gz\" -o /tmp/gh.tar.gz",
        "tar -xzf /tmp/gh.tar.gz -C /tmp",
        "mv /tmp/gh_${GH_VERSION}_linux_${ARCH}/bin/gh /usr/local/bin/",
        // Install claude-code
        "npm install -g @anthropic-ai/claude-code >/dev/null 2>&1",
        // Configure git at system level (lower priority than mounted ~/.gitconfig)
        "git config --system user.email 'cc-agent@localhost'",
        "git config --system user.name 'cc-agent'",
        // Configure HTTPS credential helper for GitHub token (system level)
        "git config --system credential.helper '!f() { echo username=x-access-token; echo password=$GITHUB_TOKEN; }; f'",
        // Inject npm token if provided and no ~/.npmrc already present
        "if [ -n \"$NPM_TOKEN\" ] && [ ! -f /root/.npmrc ]; then echo \"//registry.npmjs.org/:_authToken=${NPM_TOKEN}\" > /root/.npmrc; fi",
        // Clone repo
        "git clone --depth 1 \"$CC_DOCKER_REPO\" /workspace",
        "cd /workspace",
        // Run Claude (dangerously-skip-permissions needed for non-interactive use)
        "exec claude --dangerously-skip-permissions --print --output-format stream-json -p \"$CC_DOCKER_TASK\"",
      ].join(" && ");

      if (killed) return;

      // Start container in detached mode
      const { stdout: dockerIdRaw } = await execFileAsync("docker", [
        "run", "-d",
        "--name", opts.containerName,
        "--label", "cc-agent",
        ...envArgs,
        "node:22-slim",
        "/bin/sh", "-c", containerScript,
      ], { env: getDockerEnv() } as Parameters<typeof execFileAsync>[2]);
      const dockerId = (dockerIdRaw as string).trim();
      containerStarted = true;
      logger.info("docker:container-started", { name: opts.containerName, id: dockerId });

      if (killed) {
        execFile("docker", ["rm", "-f", opts.containerName], { env: getDockerEnv() }, () => {});
        emitter.emit("exit", 1);
        return;
      }

      // Stream logs from container
      const logProc = spawn("docker", ["logs", "-f", opts.containerName], {
        stdio: ["ignore", "pipe", "pipe"],
        env: getDockerEnv(),
      });

      let buf = "";
      const onData = (data: Buffer): void => {
        buf += data.toString();
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          emitter.emit("text", line);
        }
      };
      logProc.stdout?.on("data", onData);
      logProc.stderr?.on("data", onData);

      // Wait for container to finish
      let exitCode = 0;
      try {
        const { stdout: waitOut } = await execFileAsync("docker", ["wait", opts.containerName], { env: getDockerEnv() } as Parameters<typeof execFileAsync>[2]);
        exitCode = parseInt((waitOut as string).trim(), 10);
        if (isNaN(exitCode)) exitCode = 0;
      } catch {
        exitCode = 1;
      }

      // Drain remaining buffered output
      if (buf.trim()) emitter.emit("text", buf);
      logProc.kill();

      // Cleanup container
      containerStarted = false;
      try {
        await execFileAsync("docker", ["rm", "-f", opts.containerName], { env: getDockerEnv() } as Parameters<typeof execFileAsync>[2]);
      } catch {
        // Best-effort cleanup
      }

      logger.info("docker:container-done", { name: opts.containerName, exitCode });
      emitter.emit("exit", exitCode);
    } catch (err) {
      logger.error("docker:error", { name: opts.containerName, error: String(err) });
      emitter.emit("error", err);
      emitter.emit("exit", 1);
    }
  })();

  return emitter;
}
