# Central business asks and scope approvals

`createAsksDomain(ports)` implements the frozen `V2DomainModule<AskCommand, AskOutcome>`.
It accepts ask.create/answer/cancel/expire, authorization.check and dag.propose/decide.
Strict X0 parsing rejects terminal permissions, model permissions and chat AUQ kinds.
No V1 implementation, frozen contract, real entrypoint or capability toggle is changed.

X12 integration: **只加一行接入，由 X12 执行** at each existing schema/dispatch/read hook:
register `asksSchema` / `asksStatements` in `createTransactionOwner`, call
`domain.installSchema(schemaContext)`, then `domain.applyInTransaction(context, command)`.
Adapt `readAsk`, `readAsks`, `readProposals`, `readAskAudit` to the scoped snapshot/read paths.
Use `readAsk` for X5's `IntentPorts.readAsk`; `authorizationDigest` is exactly X5's
full-bind `v2ObjectDigest` algorithm. All SQL is pre-registered, scoped and scalar-bound.

Ports are mandatory synchronous composition-root adapters, using this same transaction:

- `authorize`: current membership, registered person/instance binding, service action/order
  scope, command/home permissions, mode/capability and current central generation/boot/epoch.
  The domain also validates the command against context scope/fence and actor.actions.
- `isOwner`: current project owner lookup for the supplied personId. The X0 actor contains
  no role, so it is never inferred from instance ownership or representedPersonId.
  All answers follow X0's owner policy; services cannot sign on an owner's behalf.
- `readFeature/readTask/readWorkflow/readDag/readTasks`: live central readers. readTasks
  returns the complete feature task set, including unbound tasks. The proposal stores its
  complete id/rev set and feature rev; adding/removing/changing any card invalidates it.
- `replaceDag`: X14 graph/cancellation CAS writer; validate completed-node inheritance
  and task cancellation policy here. It receives the freshly checked feature and graph.
  No database handle, asynchronous effects or independent transaction are permitted.
- `appendEvent`: allocate the shared central serverSeq and append the supplied X0 event.
  The domain saves immutable per-revision ask/proposal audit snapshots with this sequence,
  actor and answer. Revocation/expiry clears answer fields as X0 requires; audit retains them.

X12 performs requestId deduplication and immutable command receipt insertion in the same
outer transaction as these writes. It must reauthorize before replaying a write receipt.
`authorization.check` always checks current authority; a historical successful check must
never grant a new action. Failed gates throw frozen errors; the owner rolls back everything,
including graph writes, events and receipts. There is no local authorization cache.

Digest definitions (canonical `v2ObjectDigest`, no alternative hash algorithm):

- `authorizationDigest` / authorize ask `bindDigest`: the complete parsed bind object.
- Non-authorize ask `bindDigest`: `v2ObjectDigest(null)` (the frozen bind is explicitly null).
- `baseDigest`: the complete current frozen DAG DTO, including bindings.
- `proposalDigest`: complete dag.propose payload except proposalDigest itself, including
  featureId, expectedRev, baseVersion, nodes, cancellations, reason, baseDigest and expiry.
  `proposalDigest(payload)` exports that calculation for composition/client adapters.

A proposal creates its own scope.change ask. Its original/shared/action digests refer to
that same canonical proposal payload: this domain does not redact or claim to hold an
unshared original document. General authorizations preserve distinct original/shared
hashes and actionDigest/redactionVersion. Any changed field requires a new approval.
Artifact-share-only binds may approve a new spec/report copy before it is installed as
the task's shared copy; X3 must compare the uploaded bytes and original/copy hashes to
that exact approved bind. Report content is not required to equal the task specification. Combining
artifact.share with an execution action does not bypass current task content checks.

One pending proposal per feature is enforced both by a scoped query and unique SQL index.
`dag.decide` can sign its open ask and install the graph atomically, or consume a separately
approved ask. In both cases it rechecks the exact proposal/base/expiry, current DAG digest,
feature rev and every related task rev. Drift throws conflict; expiry throws
authorization_expired. The graph and existing pending record remain unchanged on failure;
the owner can cancel/reject or expire the ask, freeing the pending slot for a fresh proposal.
An ask rejection, cancellation or expiry also terminalizes its pending proposal.
Revoked, expired, rejected, member-signed or mismatched approvals cannot install a graph.
