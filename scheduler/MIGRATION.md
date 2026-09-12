# Mac-to-Mac handoff

Use repository memory plus a **private encrypted state snapshot**, not an export
of chats or a whole browser/runtime directory. This path supports macOS to macOS
with an existing supported Node runtime (Node 22 or newer), Git and the standard
system tools. Windows/Linux collection and service installation need additional
work and are not supported by this runbook.

## What travels

The allowlist contains confirmed matching facts, intent, explicit ID exclusions,
versioned occupational policy/history, the current review queue with its necessary
source evidence, ledger/read history, machine-independent scheduling settings,
portable last-run/last-publication state, the saved public snapshot and its first
display dates, and one explicitly supplied private-context JSON. At most two
completed source samples are retained: the last collection and the published
snapshot's sample, if different. This is sufficient for the existing captured-data
recovery path without copying every historical run.

`private-context.json` must have `schemaVersion: 1`. It is user-authorized context,
not a script or a replacement for the current structured configuration. Do not
put passwords, key material, browser data or old-machine absolute paths in it.

Not read or exported: browser handles/login/cookies, SSH keys or pinned-host files,
tokens, application authorization, processes/PIDs, locks, plists, installed code,
the publishing clone, logs, old chat transcripts, arbitrary scratch files or all
old raw evidence folders. The current public JSON is read from the checkout and
compared with its locally available confirmed Git publication.

## 1. Export on the source Mac

Update the clean checkout to the current published state first. Preserve local
edits; do not reset them. The exporter does not fetch, collect, push or change
services. It rejects an active run or pending request/publication and acquires
the existing kernel mutex for a consistent capture.

```sh
cd /PATH/TO/job-shortlist
git pull --ff-only

ROOT="$HOME/Library/Application Support/job-shortlist"
BUNDLES="$HOME/Library/Application Support/job-shortlist-transfer/bundles"
KEYS="$HOME/Library/Application Support/job-shortlist-transfer/recovery-keys"

node scheduler/migration.mjs export \
  --root "$ROOT" \
  --context /PRIVATE/approved-private-context.json \
  --bundle "$BUNDLES/handoff.shortlist.enc" \
  --key-file "$KEYS/handoff.shortlist.key"
```

The tool creates missing output directories as `0700` and files as `0600`.
Package and key must be in **different directories outside the repository and
runtime**, and filenames must not already exist. It prints paths and safe
manifest counts, never keys or decrypted content.

Encryption is Node's AES-256-GCM: random 32-byte key, fresh 12-byte nonce,
16-byte authentication tag and versioned additional authenticated data. The
authenticated inner manifest includes export time, code commit, file sizes and
SHA-256 digests. There is no password derivation or unauthenticated fallback.

Keep package and recovery key separately, for example on separate encrypted
removable media. Neither belongs in Git, Gist, email attachments or a cloud
upload. Losing the recovery key makes this package unrecoverable.

**A preparation export does not transfer ownership of the schedule.** For the
actual cutover, explicitly pause the old Mac, let any active work finish, resolve
pending publication, and make a fresh export. Do not enable the new Mac while the
old one still owns automatic publication. The local mutex is not a distributed
lock.

## 2. Clone and restore on the destination Mac

```sh
git clone https://github.com/OWNER/REPO.git
cd REPO
ROOT="$HOME/Library/Application Support/job-shortlist"

node scheduler/migration.mjs inspect \
  --bundle /PRIVATE/handoff.shortlist.enc \
  --key-file /SEPARATE/PRIVATE/handoff.shortlist.key

node scheduler/migration.mjs restore \
  --bundle /PRIVATE/handoff.shortlist.enc \
  --key-file /SEPARATE/PRIVATE/handoff.shortlist.key \
  --target "$ROOT"

node scheduler/migration.mjs verify --root "$ROOT"
```

The target **must not exist**, even as an empty directory. Its parent must exist.
Wrong keys, tampering, unsupported versions, unexpected paths, symlinks, duplicate
files, invalid state and collisions fail rather than overwriting anything.
Decryption, authentication, all manifest checks and state validation finish
before creating the target. Writes are private and no-clobber; a completion
receipt is written last. A handled failure removes only this restore's own files.
An interrupted restore carries `.migration-incomplete` and cannot be installed;
inspect that exact private directory rather than treating it as a successful
restore or rerunning over it.

Restore creates **no runtime executable paths, browser handle, credentials or
LaunchAgents**. `control.json` is paused. It does not load services or log in.
`saved-snapshot.json` is historical data, not permission to overwrite newer Git
data. The imported `private-context.json` is the local entry referenced by
`AGENTS.md`; it is not the complete conversation.

## 3. Rebuild machine-specific prerequisites

Use the destination's Node/Git paths. Create a **new repository-only deploy key**
inside `"$ROOT/keys"`; add only its public key as a write-enabled deploy key on
the correct repository. Recreate `known_hosts` using GitHub's published host key
and verify the documented fingerprint. Keep private key and pinned-host file
`0600` in a `0700` keys directory. Do not copy old machine credentials, use an
app-injected GitHub token or rely on an inherited SSH agent.

Read the restored `migration-settings.json` privately to confirm repository and
mode, then install with those exact values:

```sh
node scheduler/cli.mjs install --mode candidate-feed \
  --root "$ROOT" --repository OWNER/REPO \
  --matching "$ROOT/matching.json" --ledger "$ROOT/ledger.json" \
  --ssh-key "$ROOT/keys/github-deploy-ed25519" \
  --known-hosts "$ROOT/keys/known_hosts" \
  --node "$(command -v node)" --git "$(command -v git)"
```

Use `collection-only` instead if that is the exported mode. A migrated install
validates the saved state, mode and repository; it preserves exclusions, policy,
cursor and observation dates. It refuses a changed public dataset: if the source
continued publishing after export, arrange a fresh one-writer handoff rather
than replacing newer jobs. Existing LaunchAgent conflicts also require explicit
resolution. A **migrated install remains paused and leaves both services unloaded**;
ordinary non-migration installation behavior is unchanged.

Open ordinary Chrome yourself, log in to the source, grant the required macOS
automation and Chrome Apple Events JavaScript permissions, and open a public
job-search page. Never import cookies or bypass login/verification. The task's
own tab is created/discovered on this new Mac; old numeric handles are not reused.

```sh
CLI="$ROOT/app/scheduler/cli.mjs"
NODE="$(command -v node)"
"$NODE" "$CLI" preflight --no-browser
"$NODE" "$CLI" preflight
"$NODE" "$CLI" status
```

Preflight is not collection or publication. Confirm credentials, source access,
private configuration and that the **old Mac is paused/uninstalled**. Only then,
with explicit user authorization:

```sh
"$NODE" "$CLI" resume
"$NODE" "$CLI" status
```

Resume uses the next future Shanghai slot. It does not reset first display dates,
invent a success for missed slots or run every paused historical slot. Keep the
encrypted package as an offline recovery point; revoke obsolete deploy keys
separately after a successful cutover.

## Validation

```sh
node --test tests/migration.test.mjs
```

The tests use synthetic private state and cover authenticated round trips,
malformed/tampered packages, wrong keys, traversal/symlinks, no-overwrite,
rollback, excluded files, historic dates and dormant migrated installation.
Actual exports should also be restored into a new private temporary directory
and verified offline before relying on them. Delete only that known temporary
plaintext restore after comparison; do not delete the source runtime.
