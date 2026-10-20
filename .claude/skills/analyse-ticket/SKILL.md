---
name: analyse-ticket
description: Pull a Jira ticket and produce a structured engineering review of it — requirement gaps, affected areas, risks and proposed test cases — then stage it as a draft comment for a human to approve. Use when asked to analyse, review, refine or size a Jira ticket, or when someone pastes a ticket key such as ENG-1234.
---

# Analyse a Jira ticket

Turn a ticket into a review an engineer would actually find useful, and stage it
for a person to approve. **Never post to Jira directly.**

## Steps

1. **Read the ticket.** Call `jira_get_issue` with the key. If the user gave a
   sprint or query instead of a key, use `jira_search_issues` first and ask
   which one they mean rather than guessing.

2. **Read related tickets when it helps.** If the description references other
   keys, fetch them. Components and labels are often more informative than the
   description — a ticket tagged with a component nobody has touched in months
   is worth remarking on.

3. **Write the review** using the structure below. Be specific to this ticket.
   A review that would apply equally to any ticket is not worth posting.

4. **Stage it.** Call `jira_draft_comment` with the issue key and the review.
   Tell the user where the draft was written and that nothing has been sent.

5. **Stop.** Do not call `jira_post_comment`. Posting is the user's decision,
   made after they have read the draft file. If they ask you to post, pass the
   draft id and let the host's confirmation prompt do its job.

## Review structure

```
**Summary of what this ticket asks for**
One or two sentences, in your own words. If you cannot state it clearly, that
is itself the first finding.

**Requirement gaps**
What a developer would have to guess at. Be concrete: "the ticket does not say
what happens when the upload exceeds the size limit" beats "requirements are
unclear". If there are none, say so — do not invent them.

**Affected areas**
Components, services or modules this likely touches, and why you think so.
Flag anything that looks like it crosses a boundary the ticket does not mention.

**Risks**
What could go wrong that the ticket does not account for. Prefer failure modes
with consequences: data loss, a silent wrong result, a breaking change for an
existing caller, a migration that cannot be rolled back.

**Proposed test cases**
A short list, including at least one negative case and one boundary case. These
should be specific enough that someone could write them without asking you
follow-up questions.

**Open questions**
Things only a human can answer. Address them to a role if you can tell who —
product, QA, the reporter.
```

## Rules

- **Say what you do not know.** If the description is too thin to analyse, the
  right review says so and lists what is missing. Padding a thin ticket with
  plausible-sounding analysis is worse than a short honest one.
- **Do not invent acceptance criteria** and present them as the ticket's. If
  you propose criteria, label them as proposed.
- **Keep it readable in a Jira comment.** Short paragraphs, no deep nesting.
- **No code changes.** This skill reviews tickets. It does not write branches,
  edit files or open pull requests.
