import { type Profile, resolveStocktakeUserId } from "./config";

/**
 * What `rex` can actually do with the credentials on the active profile.
 *
 * Retail Express splits its surface across two unrelated credential sets: the
 * REST API key (everything in the catalogue) and the legacy WMS SOAP account
 * (stocktake submission only). An agent that only discovers the split by
 * hitting a wall mid-count wastes the operator's time, so the gap is described
 * as data here — which credentials are missing, where they come from, and which
 * workflows still work without them.
 */

/** Where the WMS credential set comes from. Not derivable, not self-service. */
export const WMS_CREDENTIAL_SOURCE =
  "Request from Retail Express support or your account admin, and confirm the Web Services Interface licence is enabled on the account.";

export interface CredentialField {
  /** Key in config.toml under `[profiles.<name>]`. */
  key: string;
  /** Equivalent environment variable. */
  env: string;
  description: string;
}

export const WMS_CREDENTIAL_FIELDS: readonly CredentialField[] = [
  { key: "wms_client_id", env: "REX_WMS_CLIENT_ID", description: "WMS client GUID" },
  { key: "wms_username", env: "REX_WMS_USERNAME", description: "WMS username" },
  { key: "wms_password", env: "REX_WMS_PASSWORD", description: "WMS password" },
  { key: "wms_url", env: "REX_WMS_URL", description: "WMS SOAP service URL" },
] as const;

export interface CredentialStatus {
  configured: boolean;
  /** Human/agent-readable `key / ENV_VAR` labels for what is absent. */
  missing: string[];
  source?: string;
  remedy?: string;
}

function label(field: CredentialField): string {
  return `${field.key} / ${field.env}`;
}

/**
 * `rex config wms` writes to config.toml, which a `REX_API_KEY` profile never
 * reads — pointing an env-mode user at it would have them edit a file the CLI
 * is ignoring. Env-mode profiles get env-var advice instead.
 */
function wmsRemedy(profile: Profile): string {
  if (profile.source === "env") {
    return `Export ${WMS_CREDENTIAL_FIELDS.map((field) => field.env).join(", ")} (config.toml is ignored while REX_API_KEY is set), or run \`rex auth login <name> --key <key>\` and unset REX_API_KEY to use a stored profile.`;
  }
  return `rex config wms ${profile.name} --client-id <guid> --username <name> --password <password> --url <url>`;
}

/** Inspect the WMS SOAP credential set on `profile`. Never throws. */
export function wmsCredentialStatus(profile: Profile): CredentialStatus {
  const present: Record<string, string | undefined> = {
    wms_client_id: profile.wmsClientId,
    wms_username: profile.wmsUsername,
    wms_password: profile.wmsPassword,
    wms_url: profile.wmsUrl,
  };
  const missing = WMS_CREDENTIAL_FIELDS.filter((field) => !present[field.key]).map(label);
  if (missing.length === 0) return { configured: true, missing: [] };
  return {
    configured: false,
    missing,
    source: WMS_CREDENTIAL_SOURCE,
    remedy: wmsRemedy(profile),
  };
}

/**
 * Inspect the Retail Express user id used to attribute stocktake submissions.
 *
 * `resolveStocktakeUserId` throws on a malformed value, which would take
 * `rex doctor` down with it — the one command someone runs precisely because
 * something is misconfigured. A bad value is reported as unconfigured, with the
 * parse error attached.
 */
export interface StocktakeUserIdStatus extends CredentialStatus {
  userId?: number;
  /** Parse error when a value is present but unusable. */
  invalid?: string;
}

export function stocktakeUserIdStatus(profile: Profile): StocktakeUserIdStatus {
  let userId: number | undefined;
  try {
    userId = resolveStocktakeUserId(profile);
  } catch (err) {
    return {
      configured: false,
      missing: ["stocktake_user_id / REX_STOCKTAKE_USER_ID"],
      invalid: err instanceof Error ? err.message : String(err),
      source: "Any enabled Retail Express user id — list them with `rex api GET users`.",
      remedy:
        profile.source === "env"
          ? "Export REX_STOCKTAKE_USER_ID=<id>, or pass `rex stocktake begin --user-id <id>`."
          : `rex config wms ${profile.name} --stocktake-user-id <id>`,
    };
  }
  if (userId !== undefined) return { configured: true, missing: [], userId };
  return {
    configured: false,
    missing: ["stocktake_user_id / REX_STOCKTAKE_USER_ID"],
    source: "Any enabled Retail Express user id — list them with `rex api GET users`.",
    remedy:
      profile.source === "env"
        ? "Export REX_STOCKTAKE_USER_ID=<id>, or pass `rex stocktake begin --user-id <id>`."
        : `rex config wms ${profile.name} --stocktake-user-id <id>`,
  };
}

export type CapabilityState = "available" | "blocked";

export interface Capability {
  status: CapabilityState;
  summary: string;
  /** Credential labels standing between the profile and this capability. */
  blockedBy?: string[];
  remedy?: string;
}

export interface CapabilityReport {
  profile: string;
  profileSource: Profile["source"];
  credentials: {
    restApi: CredentialStatus & { note: string };
    wmsSoap: CredentialStatus;
    stocktakeUserId: StocktakeUserIdStatus;
  };
  capabilities: Record<string, Capability>;
  blocked: string[];
  nextSteps: string[];
}

/**
 * Build the full credentials → capabilities picture for a profile. Offline: it
 * reads configuration only and makes no network calls, so it stays usable as a
 * pre-flight check before any work begins.
 */
export function capabilityReport(profile: Profile): CapabilityReport {
  const wms = wmsCredentialStatus(profile);
  const userId = stocktakeUserIdStatus(profile);

  const capabilities: Record<string, Capability> = {
    "catalogue.read": {
      status: "available",
      summary: "Read products, inventory, customers, orders, suppliers, outlets.",
    },
    "catalogue.write": {
      status: "available",
      summary: "Update products, pricing, and stock via the REST API.",
    },
    "sales.stats": {
      status: "available",
      summary: "Sync the local sales cache and run offline aggregation reports.",
    },
    "stocktake.count": {
      status: "available",
      summary:
        "Count products against live stock on hand and compute variances locally (`rex stocktake begin --local`).",
    },
    "stocktake.export": {
      status: "available",
      summary: "Emit a counted-vs-system worksheet for manual entry in the Retail Express UI.",
    },
    "stocktake.submit": wms.configured
      ? userId.configured
        ? { status: "available", summary: "Submit a stocktake to Retail Express WMS for authorisation." }
        : {
            status: "blocked",
            summary: "Submitting a stocktake needs a Retail Express user id for attribution.",
            blockedBy: userId.missing,
            remedy: `${userId.remedy} (or pass \`rex stocktake begin --user-id <id>\`)`,
          }
      : {
          status: "blocked",
          summary: "Submitting a stocktake needs the WMS SOAP credential set, which is separate from the REST API key.",
          blockedBy: wms.missing,
          remedy: wms.remedy,
        },
  };

  const blocked = Object.entries(capabilities)
    .filter(([, capability]) => capability.status === "blocked")
    .map(([id]) => id);

  const nextSteps: string[] = [];
  if (!wms.configured) {
    nextSteps.push(WMS_CREDENTIAL_SOURCE);
    nextSteps.push(`Then: ${wms.remedy}`);
    nextSteps.push("Meanwhile: `rex stocktake begin --local` counts and reports variances for manual entry.");
  } else if (!userId.configured) {
    nextSteps.push(`Set a submission user id: ${userId.remedy}`);
  }

  return {
    profile: profile.name,
    profileSource: profile.source,
    credentials: {
      restApi: {
        configured: true,
        missing: [],
        note:
          profile.source === "env"
            ? "Resolved from REX_API_KEY, so config.toml is not consulted for this run. Verify it works with `rex auth test`."
            : "A profile cannot resolve without an API key; verify it works with `rex auth test`.",
      },
      wmsSoap: wms,
      stocktakeUserId: userId,
    },
    capabilities,
    blocked,
    nextSteps,
  };
}
