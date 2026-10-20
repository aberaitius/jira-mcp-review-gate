# jira-mcp-review-gate

An MCP server that lets Claude pull a Jira ticket and analyse it, where reading
is unrestricted and **nothing reaches Jira that a person has not read first**.

The interesting part is not the Jira integration. It is the gate.

---

## The problem this is built around

An assistant that can read your tickets is useful. An assistant that can also
write to them is useful and dangerous, because the failure mode is not a crash
— it is a confidently wrong comment appearing on a ticket under your name,
which a colleague then acts on.

Most integrations handle this with instructions: *tell the model not to post
without asking.* That works until it doesn't, and you cannot tell which state
you are in by looking.

This one handles it structurally. The honest answer to *"could this post
something I did not see?"* is **no**, for reasons that do not depend on the
model behaving well.

## How the gate works

Five layers. The first four each independently prevent an unreviewed write; the
fifth makes every action answerable after the fact.

**1. Writes are off unless the operator turned them on.**
`JIRA_MCP_ALLOW_WRITES` must be exactly `"true"` in the environment the server
started in. Not `1`, not `yes`, not `TRUE`. Nothing inside a conversation can
change it. Run the server read-only and the posting tool cannot work at all.

**2. There is no code path that posts arbitrary text.**
`jira_post_comment` accepts a **draft id**, not a comment body. The only source
of posted text is a draft staged earlier by a separate tool. The model cannot
compose and send in one step, because the API does not offer that shape.

**3. Drafts are written to disk.**
Staging writes the exact text to `<state dir>/drafts/<id>.json`. The reviewer
reads the real file, outside the conversation — not a summary of it inside one,
where the summary and the payload can differ.

**4. Approval is explicit, twice.**
The call requires `approved: true`, and because it is a tool call the host shows
its own confirmation prompt with the tool name and arguments. The tool
description says `WRITES TO JIRA` in capitals so that prompt is unambiguous.

**5. Single-use drafts and an append-only audit log.**
A draft posts once; a retry is refused with the timestamp of the original, so a
network hiccup cannot silently double-post. Every read, search, draft, refusal
and successful post is appended to `audit.log` and never rewritten.

### What that looks like

```
> Analyse ENG-1234 and comment on it

  jira_get_issue(ENG-1234)                    ← free, read-only
  jira_draft_comment(ENG-1234, "...")         ← writes a file, posts nothing

  Draft staged. Nothing has been sent to Jira.
    draft id : 71da6ffd-a735-487a-94b1-6df9084ea4d7
    saved to : .jira-mcp/drafts/71da6ffd-....json

> post it

  jira_post_comment(draftId, approved: true)  ← host prompts; refused unless
                                                 writes were enabled at startup
```

And when the gate holds:

```
Refused: this server is running read-only. Writes require
JIRA_MCP_ALLOW_WRITES=true at startup, which is an operator decision
and cannot be changed from inside a conversation.

Refused: no draft with id 1111...-1111. Stage one with jira_draft_comment first.
```

## Tools

| Tool | Writes? | Notes |
|---|---|---|
| `jira_get_issue` | No | One issue: description, status, type, priority, assignee, labels, components |
| `jira_search_issues` | No | JQL, capped at 50 results |
| `jira_draft_comment` | No | Stages text to disk, returns a draft id |
| `jira_post_comment` | **Yes** | Draft id only, requires `approved: true`, single use |

Reads are not gated on purpose. Gating them would train the reviewer to click
through prompts that never matter, which is how a confirmation step stops being
a control and becomes a reflex.

## The skill

`.claude/skills/analyse-ticket/` turns a ticket into a structured engineering
review: requirement gaps, affected areas, risks, proposed test cases and open
questions. It ends by staging a draft and stopping — posting is left to the
person.

It is instructed to say when a ticket is too thin to analyse rather than padding
it with plausible-sounding findings, because a review that would fit any ticket
is worse than a short honest one.

## Setup

```bash
npm install
npm run build
cp .env.example .env     # then fill in your site, email and API token
```

API token: <https://id.atlassian.com/manage-profile/security/api-tokens>

Register it with Claude Code:

```bash
claude mcp add jira-review-gate -- node /absolute/path/to/dist/index.js
```

Pass the environment through your MCP client config, or export it before
starting. Leave `JIRA_MCP_ALLOW_WRITES` unset until you actually want writes —
read-only is the right default for a project you are still exploring.

**Give the API token the least access that works.** Read on the projects you
analyse; comment permission only if you intend to enable writes at all. The gate
protects against an unreviewed comment, not against a token with more rights
than the job needs.

## Verifying the gate yourself

Don't take the README's word for it:

```bash
# writes disabled — posting is refused outright
JIRA_MCP_ALLOW_WRITES= node dist/index.js

# writes enabled — an unstaged draft id is still refused
JIRA_MCP_ALLOW_WRITES=true node dist/index.js
```

Both paths are exercised by the smoke tests in the commit history, and every
refusal lands in `audit.log` with a reason.

## Scope, deliberately

- **No transitions, no assignment, no field edits.** Comments only. Each extra
  write surface is another thing to reason about; the gate is easier to trust
  when there is one way through it.
- **No code changes.** This reviews tickets. It does not open branches or edit
  files.
- **Jira Cloud only.** Server and Data Center use a different auth model.
- **No caching.** Tickets change; a stale read is a wrong answer.

## Design notes

The pattern here — *propose, persist, let a human read it, then act, and log
everything* — is not specific to Jira. It is the same shape as any system that
automates professional judgment without replacing it: the assistant does the
work, a person owns the decision, and the record shows which was which.

The property of this design worth keeping is that **the safety does not depend
on the model's cooperation.** A prompt that says "ask before posting" is advice.
A tool that cannot accept a comment body is a constraint.

## Licence

MIT.
