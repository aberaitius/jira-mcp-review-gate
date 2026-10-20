#!/usr/bin/env node
/**
 * jira-mcp-review-gate
 *
 * Connects Claude to Jira so a session can pull a ticket and analyse it, while
 * guaranteeing that nothing reaches Jira without a person having read it first.
 *
 * Reads are unrestricted. Writes pass five layers:
 *
 *   1. Writes are disabled unless JIRA_MCP_ALLOW_WRITES=true at startup.
 *   2. The posting tool accepts a draft id only. There is no code path that
 *      posts arbitrary text, so the model cannot compose and send in one step.
 *   3. Drafts are written to disk, so the reviewer reads the real text outside
 *      the conversation rather than a summary of it inside one.
 *   4. Posting requires approved: true, which the host surfaces as its own
 *      confirmation prompt showing the tool and its arguments.
 *   5. Drafts are single-use and every action is appended to an audit log.
 *
 * The design goal is that the honest answer to "could this post something I
 * did not see?" is no, for a structural reason rather than a behavioural one.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { loadConfig } from "./config.js";
import { DraftStore } from "./drafts.js";
import { JiraClient } from "./jira.js";

const config = loadConfig();
const jira = new JiraClient(config);
const drafts = new DraftStore(config.stateDir);

const server = new McpServer({
  name: "jira-mcp-review-gate",
  version: "1.0.0",
});

function text(body: string) {
  return { content: [{ type: "text" as const, text: body }] };
}

function failure(body: string) {
  return { content: [{ type: "text" as const, text: body }], isError: true };
}

// ── Reads ────────────────────────────────────────────────────────────────────
// Unrestricted. Reading a ticket changes nothing, so gating it would only
// train the reviewer to click through prompts that never matter.

server.registerTool(
  "jira_get_issue",
  {
    title: "Get a Jira issue",
    description:
      "Fetch one Jira issue by key, including its description, status, type, " +
      "priority, assignee, labels and components. Read-only.",
    inputSchema: {
      issueKey: z
        .string()
        .regex(/^[A-Z][A-Z0-9_]+-\d+$/i, "Expected a key such as ENG-1234"),
    },
  },
  async ({ issueKey }) => {
    try {
      const issue = await jira.getIssue(issueKey);
      await drafts.audit("read_issue", { issueKey: issue.key });
      return text(
        [
          `${issue.key} — ${issue.summary}`,
          `Status: ${issue.status}   Type: ${issue.issueType}   Priority: ${issue.priority ?? "none"}`,
          `Assignee: ${issue.assignee ?? "unassigned"}   Reporter: ${issue.reporter ?? "unknown"}`,
          `Components: ${issue.components.join(", ") || "none"}`,
          `Labels: ${issue.labels.join(", ") || "none"}`,
          `Updated: ${issue.updated}`,
          `URL: ${issue.url}`,
          "",
          "Description:",
          issue.description || "(empty)",
        ].join("\n"),
      );
    } catch (error) {
      return failure(`Could not fetch ${issueKey}: ${(error as Error).message}`);
    }
  },
);

server.registerTool(
  "jira_search_issues",
  {
    title: "Search Jira issues",
    description:
      "Run a JQL query and return matching issues. Read-only. Example JQL: " +
      '"project = ENG AND sprint in openSprints() ORDER BY updated DESC".',
    inputSchema: {
      jql: z.string().min(1),
      limit: z.number().int().min(1).max(50).default(20),
    },
  },
  async ({ jql, limit }) => {
    try {
      const hits = await jira.searchIssues(jql, limit);
      await drafts.audit("search", { jql, returned: hits.length });
      if (hits.length === 0) return text("No issues matched that query.");
      return text(
        hits
          .map(
            (h) =>
              `${h.key}  [${h.status}]  ${h.summary}  — ${h.assignee ?? "unassigned"}`,
          )
          .join("\n"),
      );
    } catch (error) {
      return failure(`Search failed: ${(error as Error).message}`);
    }
  },
);

// ── The gate ─────────────────────────────────────────────────────────────────

server.registerTool(
  "jira_draft_comment",
  {
    title: "Draft a comment for review",
    description:
      "Stage a comment for a human to review. This does NOT post anything to " +
      "Jira. It writes the exact text to a file and returns a draft id. Use " +
      "this to propose an analysis; a person reads it and only then may " +
      "jira_post_comment be called with that id.",
    inputSchema: {
      issueKey: z
        .string()
        .regex(/^[A-Z][A-Z0-9_]+-\d+$/i, "Expected a key such as ENG-1234"),
      comment: z.string().min(1).max(32_000),
    },
  },
  async ({ issueKey, comment }) => {
    const draft = await drafts.create(issueKey.toUpperCase(), comment);
    return text(
      [
        `Draft staged. Nothing has been sent to Jira.`,
        ``,
        `  draft id : ${draft.id}`,
        `  issue    : ${draft.issueKey}`,
        `  saved to : ${drafts.location}/${draft.id}.json`,
        ``,
        `Read the file, then — if you are satisfied with it — ask for it to be`,
        `posted. It will be posted exactly as written; the text cannot be`,
        `changed on the way out. Editing means drafting again.`,
      ].join("\n"),
    );
  },
);

server.registerTool(
  "jira_post_comment",
  {
    title: "Post an approved draft to Jira",
    description:
      "WRITES TO JIRA. Posts a previously staged draft, by id, exactly as it " +
      "was written. Requires explicit human approval: approved must be true, " +
      "and the operator must have started this server with writes enabled. " +
      "Cannot post text that was not staged first. Each draft posts once.",
    inputSchema: {
      draftId: z.string().uuid(),
      approved: z
        .boolean()
        .describe(
          "Must be true, and must reflect a person having actually read the draft.",
        ),
    },
  },
  async ({ draftId, approved }) => {
    // Layer 1 — the server was not started with writes enabled.
    if (!config.allowWrites) {
      await drafts.audit("post_refused", { draftId, reason: "writes_disabled" });
      return failure(
        "Refused: this server is running read-only. Writes require " +
          "JIRA_MCP_ALLOW_WRITES=true at startup, which is an operator " +
          "decision and cannot be changed from inside a conversation.",
      );
    }

    // Layer 4 — approval must be explicit.
    if (!approved) {
      await drafts.audit("post_refused", { draftId, reason: "not_approved" });
      return failure("Refused: approved was not true. Nothing was posted.");
    }

    // Layer 2 — the text must have been staged. There is no path that accepts
    // free text, so this lookup is the only source of what gets posted.
    const draft = await drafts.get(draftId);
    if (!draft) {
      await drafts.audit("post_refused", { draftId, reason: "unknown_draft" });
      return failure(
        `Refused: no draft with id ${draftId}. Stage one with jira_draft_comment first.`,
      );
    }

    // Layer 5 — single use.
    if (draft.consumedAt) {
      await drafts.audit("post_refused", { draftId, reason: "already_posted" });
      return failure(
        `Refused: that draft was already posted at ${draft.consumedAt}. ` +
          `Draft a new comment if you want to say something further.`,
      );
    }

    try {
      const { id } = await jira.addComment(draft.issueKey, draft.text);
      await drafts.markConsumed(draft.id);
      await drafts.audit("post_succeeded", {
        draftId: draft.id,
        issueKey: draft.issueKey,
        commentId: id,
      });
      return text(
        `Posted to ${draft.issueKey} as comment ${id}. Draft ${draft.id} is now closed.`,
      );
    } catch (error) {
      await drafts.audit("post_refused", {
        draftId,
        reason: "jira_error",
        message: (error as Error).message,
      });
      return failure(`Jira rejected the comment: ${(error as Error).message}`);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);

// stderr, not stdout — stdout carries the MCP protocol.
process.stderr.write(
  `jira-mcp-review-gate ready — ${config.baseUrl} — writes ${
    config.allowWrites ? "ENABLED" : "disabled"
  }\n`,
);
