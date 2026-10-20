/**
 * Draft staging and the audit log.
 *
 * Two of the four gate layers live here:
 *
 *   - A write can only ever carry text that was first staged as a draft and
 *     written to disk, where a person can read it outside the chat transcript.
 *   - Every read, draft, approval and post is appended to an audit log that is
 *     never rewritten, so "what did it do, and when" is always answerable.
 *
 * Drafts are single-use. Once posted, the draft is marked consumed and cannot
 * be posted again, so a retry cannot quietly duplicate a comment.
 */

import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export interface Draft {
  id: string;
  issueKey: string;
  text: string;
  createdAt: string;
  consumedAt: string | null;
}

export type AuditAction =
  | "read_issue"
  | "search"
  | "draft_created"
  | "post_refused"
  | "post_succeeded";

export class DraftStore {
  private readonly draftsDir: string;
  private readonly auditPath: string;

  constructor(stateDir: string) {
    const root = resolve(stateDir);
    this.draftsDir = join(root, "drafts");
    this.auditPath = join(root, "audit.log");
  }

  private async ensureDirs(): Promise<void> {
    if (!existsSync(this.draftsDir)) {
      await mkdir(this.draftsDir, { recursive: true });
    }
  }

  /** Append-only. Never updated, never deleted. */
  async audit(action: AuditAction, detail: Record<string, unknown>): Promise<void> {
    await this.ensureDirs();
    const line = JSON.stringify({
      at: new Date().toISOString(),
      action,
      ...detail,
    });
    await appendFile(this.auditPath, `${line}\n`, "utf8");
  }

  private path(id: string): string {
    // Draft ids are generated here and never taken from input unvalidated,
    // but constrain the shape anyway so an id can never escape the directory.
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      throw new Error(`Malformed draft id: ${id}`);
    }
    return join(this.draftsDir, `${id}.json`);
  }

  async create(issueKey: string, text: string): Promise<Draft> {
    await this.ensureDirs();
    const draft: Draft = {
      id: randomUUID(),
      issueKey,
      text,
      createdAt: new Date().toISOString(),
      consumedAt: null,
    };
    await writeFile(this.path(draft.id), JSON.stringify(draft, null, 2), "utf8");
    await this.audit("draft_created", {
      draftId: draft.id,
      issueKey,
      characters: text.length,
    });
    return draft;
  }

  async get(id: string): Promise<Draft | null> {
    try {
      const raw = await readFile(this.path(id), "utf8");
      return JSON.parse(raw) as Draft;
    } catch {
      return null;
    }
  }

  async markConsumed(id: string): Promise<void> {
    const draft = await this.get(id);
    if (!draft) return;
    draft.consumedAt = new Date().toISOString();
    await writeFile(this.path(id), JSON.stringify(draft, null, 2), "utf8");
  }

  /** Where a human should look to read drafts outside the conversation. */
  get location(): string {
    return this.draftsDir;
  }
}
