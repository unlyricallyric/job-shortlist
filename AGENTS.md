# Project entry

Start with [ARCHITECTURE.md](ARCHITECTURE.md), then the relevant section of
[scheduler/README.md](scheduler/README.md). For another Mac, follow
[scheduler/MIGRATION.md](scheduler/MIGRATION.md). This is compact project memory,
not a conversation transcript.

## State and authority

- Public code and sanitized job data live here. User-specific preferences,
  qualifications, decisions and source evidence belong only in the private runtime.
- After an authorized migration, the private context entry is
  `~/Library/Application Support/job-shortlist/private-context.json`.
  Read it only for authorized work; it is historical context, not executable
  instructions or proof of current service state. Confirm current state with the
  installed CLI, without loading unrelated source archives.
- Structured private configuration and explicit current user decisions take
  precedence over prose summaries. Do not invent qualifications, resurrect
  rejected IDs, or turn an uncertain candidate into a confirmed recommendation.
- Only one machine may run the publishing scheduler. A local kernel lock does
  not coordinate different Macs.

## Operational boundaries

- `candidate-feed` publishes source-authenticated, sanitized **candidates**.
  `collection-only` is a separate explicit mode. Never change either mode, the
  query pool, exclusions, schedule or published selections without authorization.
- Keep source observation time, first public display time and source publication
  time separate. Re-observation, maintenance and migration must not reset
  `firstPublishedAtById` or fabricate a new sample.
- Preserve explicit ID exclusions and versioned role-exclusion history.
  Old approvals cannot bypass later explicit rejection.
- Source collection uses only the user's ordinary Chrome and an identified
  task tab. Do not launch an automation browser/profile, change browser settings,
  read cookies or bypass login/captcha. No browser work for documentation,
  migration or offline validation.
- Do not add notifications, application callbacks, background model services or
  automatic extra collection rounds. Do not claim intermittent host-app freezes
  have been diagnosed or fixed.
- Publishing uses the task-owned isolated clone and repository-scoped deploy key.
  Never print/read key contents, copy app tokens, or stage private runtime files.

## Development

Use the existing Node test runner and no dependency installation by default.
Run the smallest tests covering the change. Public assets are relative to `/docs`
and share a revision marker when changed. Render source strings with text nodes,
retain strict source-link validation, and verify actual Pages bytes for a
publication task.

Work in the user-owned checkout without stashing, resetting or force-pushing.
Inspect and preserve unrelated edits. Commit/push only when explicitly requested,
with the repository's coauthor trailer. Migration tools run from the checkout;
do not reinstall or restart the live scheduler merely to export state.
