# Browser storage rename

`rename.webStorage` defaults to `off`; only literal `observe` and `on` enable
observation or migration. This rollout setting currently applies to **one browser
and origin only**. Server distribution is a separate follow-up before the PM turns
it on. The module exports `readStorageMode` / `setStorageMode`; the equivalent
operator console command is `localStorage.setItem("rename.webStorage", "observe")`
(or `"on"` / `"off"`), followed by reload. `boot.js` reads the same setting and
exposes the parsed value as `window.__flokaStorageMode` for diagnostics.

The compatibility authority is always `cstra` / `cstra_*`, including absence.
`floka` / `floka_*` are mirrors, never fallback sources. A conflicting or new-only
mirror entry loses to the live legacy value (or deletion); identifiers are reported
without values. This deliberately avoids resurrecting revoked state after an old
page changes or deletes a record. HttpOnly pairing cookies are not browser-storage
records and are never read, copied or renamed here.

Machine access runs the migrator; module startup also migrates localStorage when
IDB is unavailable. Observe only reads and reports: it creates no databases,
markers, journals or LS entries. Ordinary user edits still save to the legacy keys
in off/observe mode. On commits machine/current state to legacy first and then
mirrors the latest snapshot in one IDB transaction. Completion waits for the
transaction's `oncomplete`, not individual request success. Aborted mirrors report
`interrupted`; reads continue using legacy and the next access retries the complete
mirror, including deletions. No sticky completion bit or old snapshot is replayed.
The old DB is retained. Existing Service Workers and boot scripts continue reading
legacy. Concurrent old pages cannot participate in a new cross-database lock, so
reads always consult legacy and repair the mirror on each access. Each mirror commit
is checked against legacy again; continuous overlapping edits return `interrupted`
after three reconciliation passes, rather than claiming the mirror is current.

The IDB read path never upgrades a database: it enumerates first, then aborts any
creation upgrade if the DB disappeared in between. Engines lacking enumeration
refuse observe without probing; ordinary reads abort creation upgrades when absent.
No filesystem transaction journal is reused or imported into the browser.

Theme/current-machine writes use both localStorage keys in on mode. All `cstra_*`
localStorage entries are reconciled on startup and machine access; preferences
outside this card may still write legacy only between reconciliations. Pairing
pending state is sessionStorage: no history migration; new on-mode writes/deletes
update both keys, and reads use only the legacy key. A denied/quota-limited mirror
cannot turn a deleted legacy value back into a valid pairing.

`migrateDatabase` and `migrateLocalStorage` accept source `origin` and
`targetOrigin`; different origins return `cross-origin` before any access. Runtime
wiring uses only this page's browser storage. This code does not change domains or
try to transfer storage across domains.
