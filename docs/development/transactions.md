---
title: "Catalog, network, and transfer transactions"
description: "Locks, journals, and ordering for configuration changes and profile archive export and import, to read before you change catalog, network, or transfer code."
tags: [development, architecture, transactions]
sources: []
created: 2026-11-11T14:53:45Z
modified: 2026-11-11T15:01:55Z
---

# Catalog, network, and transfer transactions

Design of the transaction paths. Journal files and recovery steps: [Transactions and recovery](../configuration/profiles.md#transactions-and-recovery).

## Catalog and network transactions

- `prepareProfileConfiguration()` in `src/profiles/profile-configuration.ts` handles every configuration mutation.
- It holds `profiles/admission.lock` under `STELZ_HOME` while it completes pending recovery and the requested mutation.
- Recovery checks the import, catalog, and network journals in that order.
- An operation that needs a profile lifecycle lock acquires it after the admission lock.
- Explicit start also completes pending configuration recovery before it starts the browser.
- Creation saves new secrets before it publishes the profile in the catalog. The catalog journal stores complete before and after snapshots.
- Creation can reuse a compatible profile: [Create or reuse a profile](../cli.md#create-or-reuse-a-profile).
- Deletion needs a cleanly stopped profile with known process ownership. It archives the profile to `trash/ID-TOKEN/` (`profile/` and `profile.json`) and removes it from the catalog. It keeps secrets, because other profiles can reference them.
- A network save needs the current revision and a stopped profile. The backend repeats ownership and configuration checks while it holds both locks.
- Network commit writes configuration and secrets through checked temporary files and atomic replacement.
  - If a write fails, the journal records rollback intent before restoration.
  - Recovery continues the recorded commit or rollback.
  - Manual edits that match neither recorded state block recovery and need inspection.
- Journals can contain credentials. Treat them as private service state.

## Profile transfers

- Export snapshots cleanly stopped profiles under the admission lock and selected lifecycle locks, acquired in profile ID order.
- Export releases those locks before compression.
- Import checks private staging data, assigns unused IDs, ports, and secret references, and installs the batch through a durable journal.
- One catalog replacement publishes the batch.
- See [Profile archive format](../configuration/archive.md).
