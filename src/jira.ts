/**
 * A deliberately small Jira Cloud REST v3 client.
 *
 * Only the calls this server needs. Nothing here decides whether a write is
 * permitted — that is the gate's job in index.ts. This module just talks HTTP.
 */

import type { Config } from "./config.js";

export interface JiraIssue {
  key: string;
  summary: string;
  description: string;
  status: string;
  issueType: string;
  priority: string | null;
  assignee: string | null;
  reporter: string | null;
  labels: string[];
  components: string[];
  created: string;
  updated: string;
  url: string;
}

export interface JiraSearchHit {
  key: string;
  summary: string;
  status: string;
  assignee: string | null;
}

/**
 * Atlassian Document Format is a nested node tree. We only need the prose, so
 * walk it and concatenate text nodes, inserting breaks at block boundaries.
 */
function adfToText(node: unknown): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(adfToText).join("");

  if (typeof node === "object") {
    const n = node as Record<string, unknown>;
    if (n["type"] === "text" && typeof n["text"] === "string") return n["text"];

    const inner = adfToText(n["content"]);
    const blockTypes = new Set([
      "paragraph",
      "heading",
      "listItem",
      "codeBlock",
      "blockquote",
    ]);
    if (typeof n["type"] === "string" && blockTypes.has(n["type"])) {
      return `${inner}\n`;
    }
    return inner;
  }
  return "";
}

/** Wrap plain text back into the minimal ADF document Jira will accept. */
export function textToAdf(text: string): Record<string, unknown> {
  return {
    type: "doc",
    version: 1,
    content: text.split(/\n{2,}/).map((para) => ({
      type: "paragraph",
      content: [{ type: "text", text: para.replace(/\n/g, " ") }],
    })),
  };
}

export class JiraClient {
  private readonly auth: string;

  constructor(private readonly config: Config) {
    this.auth = Buffer.from(`${config.email}:${config.apiToken}`).toString(
      "base64",
    );
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    const response = await fetch(`${this.config.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Basic ${this.auth}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `Jira ${init.method ?? "GET"} ${path} failed: ${response.status} ${response.statusText}${
          body ? ` — ${body.slice(0, 400)}` : ""
        }`,
      );
    }

    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  async getIssue(key: string): Promise<JiraIssue> {
    const raw = await this.request<Record<string, any>>(
      `/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,description,status,issuetype,priority,assignee,reporter,labels,components,created,updated`,
    );
    const f = raw["fields"] ?? {};

    return {
      key: raw["key"],
      summary: f["summary"] ?? "",
      description: adfToText(f["description"]).trim(),
      status: f["status"]?.name ?? "Unknown",
      issueType: f["issuetype"]?.name ?? "Unknown",
      priority: f["priority"]?.name ?? null,
      assignee: f["assignee"]?.displayName ?? null,
      reporter: f["reporter"]?.displayName ?? null,
      labels: Array.isArray(f["labels"]) ? f["labels"] : [],
      components: Array.isArray(f["components"])
        ? f["components"].map((c: any) => c?.name).filter(Boolean)
        : [],
      created: f["created"] ?? "",
      updated: f["updated"] ?? "",
      url: `${this.config.baseUrl}/browse/${raw["key"]}`,
    };
  }

  async searchIssues(jql: string, limit: number): Promise<JiraSearchHit[]> {
    const raw = await this.request<Record<string, any>>(
      `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=${limit}&fields=summary,status,assignee`,
    );
    const issues: any[] = raw["issues"] ?? [];
    return issues.map((i) => ({
      key: i["key"],
      summary: i["fields"]?.summary ?? "",
      status: i["fields"]?.status?.name ?? "Unknown",
      assignee: i["fields"]?.assignee?.displayName ?? null,
    }));
  }

  /**
   * The only write this client can perform. index.ts will not call it without
   * a staged, approved draft.
   */
  async addComment(key: string, text: string): Promise<{ id: string }> {
    const result = await this.request<Record<string, any>>(
      `/rest/api/3/issue/${encodeURIComponent(key)}/comment`,
      { method: "POST", body: JSON.stringify({ body: textToAdf(text) }) },
    );
    return { id: result["id"] ?? "unknown" };
  }
}
