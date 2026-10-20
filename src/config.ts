/**
 * Configuration, resolved once at startup.
 *
 * Writes are OFF unless JIRA_MCP_ALLOW_WRITES is exactly "true". This is the
 * outermost of the four gate layers: an operator who has not deliberately
 * enabled writes cannot be talked into one, whatever the conversation says.
 */

export interface Config {
  baseUrl: string;
  email: string;
  apiToken: string;
  /** Absolute path where staged drafts and the audit log are written. */
  stateDir: string;
  /** False unless explicitly enabled. Checked again at every write. */
  allowWrites: boolean;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(
      `${name} is not set. Copy .env.example and supply a value; see README.md.`,
    );
  }
  return value.trim();
}

export function loadConfig(): Config {
  const baseUrl = required("JIRA_BASE_URL").replace(/\/+$/, "");

  if (!/^https:\/\//i.test(baseUrl)) {
    throw new Error("JIRA_BASE_URL must be an https:// URL.");
  }

  return {
    baseUrl,
    email: required("JIRA_EMAIL"),
    apiToken: required("JIRA_API_TOKEN"),
    stateDir: process.env.JIRA_MCP_STATE_DIR?.trim() || ".jira-mcp",
    // Deliberately strict. "1", "yes" and "TRUE" are all treated as false,
    // so enabling writes is always a conscious act.
    allowWrites: process.env.JIRA_MCP_ALLOW_WRITES === "true",
  };
}
