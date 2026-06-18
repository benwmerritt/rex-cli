import type { Command } from "commander";
import { createAuth } from "../core/auth";
import { RexClient } from "../core/client";
import { type Profile, resolveProfile } from "../core/config";
import { Output, type OutputMode } from "../core/output";
import { createRateLimiter } from "../core/ratelimit";
import { fetchTransport } from "../core/transport";
import { requireWmsConfig, WmsClient, type WmsClientLike } from "../core/wms";

export interface GlobalOptions {
  json?: boolean;
  human?: boolean;
  profile?: string;
  dryRun?: boolean;
  allowPrice?: boolean;
  page?: number;
  pageSize?: number;
  all?: boolean;
  verbose?: boolean;
  [key: string]: unknown;
}

export interface ContextDeps {
  /** Inject a client (tests use a fake transport); defaults to a live client. */
  clientFactory?: (profile: Profile) => RexClient;
  /** Inject the WMS SOAP client used by stocktake commands. */
  wmsClientFactory?: (profile: Profile) => WmsClientLike;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Override the Output sink (tests capture stdout/stderr). */
  output?: Output;
}

function defaultClient(profile: Profile): RexClient {
  const auth = createAuth({
    apiKey: profile.apiKey,
    baseUrl: profile.baseUrl,
    version: profile.version,
    profile: profile.name,
    transport: fetchTransport,
  });
  const limiter = createRateLimiter({ profile: profile.name });
  return new RexClient({
    baseUrl: profile.baseUrl,
    version: profile.version,
    apiKey: profile.apiKey,
    auth,
    limiter,
  });
}

/**
 * Per-invocation context. Profile + client resolution is lazy so commands that
 * don't hit the API (config init, auth login) never require a profile.
 */
export class RunContext {
  readonly globals: GlobalOptions;
  readonly output: Output;
  private readonly deps: ContextDeps;
  private cachedProfile?: Profile;
  private cachedClient?: RexClient;
  private cachedWmsClient?: WmsClientLike;

  constructor(globals: GlobalOptions, deps: ContextDeps = {}) {
    this.globals = globals;
    this.deps = deps;
    const mode: OutputMode = globals.human ? "human" : "json";
    this.output = deps.output ?? new Output({ mode });
  }

  get dryRun(): boolean {
    return Boolean(this.globals.dryRun);
  }

  get allowPrice(): boolean {
    return Boolean(this.globals.allowPrice);
  }

  profile(): Profile {
    if (!this.cachedProfile) {
      this.cachedProfile = resolveProfile({
        profileFlag: this.globals.profile,
        env: this.deps.env,
        cwd: this.deps.cwd,
      });
    }
    return this.cachedProfile;
  }

  client(): RexClient {
    if (!this.cachedClient) {
      const profile = this.profile();
      this.cachedClient = this.deps.clientFactory
        ? this.deps.clientFactory(profile)
        : defaultClient(profile);
    }
    return this.cachedClient;
  }

  wmsClient(): WmsClientLike {
    if (!this.cachedWmsClient) {
      const profile = this.profile();
      this.cachedWmsClient = this.deps.wmsClientFactory
        ? this.deps.wmsClientFactory(profile)
        : new WmsClient({ config: requireWmsConfig(profile), transport: fetchTransport });
    }
    return this.cachedWmsClient;
  }
}

export type PositionalArgs = Array<string | undefined>;

export type Handler = (ctx: RunContext, opts: GlobalOptions, args: PositionalArgs) => Promise<void> | void;

/**
 * Wrap a command handler: build the context from merged global+local options,
 * run it, and funnel any error through the Output chokepoint into a stable exit
 * code. Uses a non-arrow function so commander binds `this` to the command.
 */
export function run(deps: ContextDeps, handler: Handler) {
  return async function (this: Command, ...cmdArgs: unknown[]): Promise<void> {
    const command = cmdArgs[cmdArgs.length - 1] as Command;
    const positional = cmdArgs
      .slice(0, Math.max(0, cmdArgs.length - 2))
      .flatMap((arg) => (Array.isArray(arg) ? arg : [arg]))
      .map((arg) => (arg === undefined ? undefined : String(arg)));
    const opts = command.optsWithGlobals() as GlobalOptions;
    const ctx = new RunContext(opts, deps);
    try {
      await handler(ctx, opts, positional);
    } catch (err) {
      process.exitCode = ctx.output.error(err);
    }
  };
}

/** Commander option coercer for integer flags. */
export function asInt(value: string): number {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) throw new Error(`expected an integer, got "${value}"`);
  return n;
}
