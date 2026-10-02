# i28-C6 round 3 repair evidence

- `prepared` and interrupted `gating` batches can be aborted locally. The migration lock remains held while the mode file is restored under the ledger writer lock and the journal is marked `aborted`. A fresh batch can then select the feature again.
- Entering `committing` still requires the center receipt path. An aborted batch cannot later commit or activate; replaying its revoke does not change a newer batch's gate.
- The member attempting an import control action gets `403 forbidden`; an unknown bearer gets `403 not_member`.
- `focused.log`: 26 passing tests across the C6 migration, members, control, start, gate-window, and prepare suites. The loopback center used a temporary port printed in the log; polling timers, server, and both temporary member state directories were removed by test cleanup.
- `bun run typecheck` and `bun run guard` passed. Full `bun run check` was attempted; unrelated full-suite tests timed out or failed under local load, then the run was interrupted. PR CI remains the full-suite gate.
- Per PM's later decision, `empty-db` and the staged-proj/manual-block P2 items remain for later nodes. No deployment or machine service was changed.
