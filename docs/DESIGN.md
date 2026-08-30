# run-dmcp — design

> **Status: ACCEPTED — v1.0, 2026-08-18.** Both sides have signed §15's twelve decisions; no row was
> refused. One substantive fix and three editorial ones from the acceptance round are applied.
> Nothing has been built: Phase 0 (§11) is the next step, and it touches no client.
> Nothing has been built. This supersedes the brink-side extraction plan of 2026-08-16 and folds in
> the timeline proposal *"Run-DMCP: World State as a Timeline"* of 2026-08-18, and the music-video
> side's replies *"The Degenerate Client"* (round 2) and *"One Hop of Causality"* (round 3), same day.
> This document lives in brink only because run-dmcp does not exist yet; it moves to that repository
> the day it is born.

## 0. Provenance: how this document got here

Three rounds, two sides, one name. The blocks below are the running record of what each round
changed — kept so either side can verify its contributions survived, and so the reasoning behind a
settled decision is recoverable without re-reading three artifacts. **The body of the document (§1
onward) is the design itself and reads on its own; this section is history.**

**One thing the acceptance round verified that is worth recording:** every figure quoted from the
music-video side was checked against its source after three rounds of restatement — 5 of 10, 37 of
80, 3.5× → 0.72×, the phrase rejected at n=3, 7 boundaries moving 11 chunk spans, the two-line fix.
Nothing had drifted. In a document assembled by restating other people's measurements, that is the
property most worth checking and the easiest to lose.

### The merge, so nobody has to diff two documents

Two proposals arrived independently, under the same name, describing different engines.

- **The brink side** said run-dmcp is about **authority**: the server owns what is true, and the
  narrator receives an authoritative payload it may not contradict.
- **The timeline side** said run-dmcp is about **time**: the server owns *when* things were true —
  `replay(t)`, interval-versioned facts, irreversibility.

Neither is wrong and they are not competing. They are two axes of one sentence (§1). What follows
adopts both, and resolves the places where adopting both forces a choice.

**Taken from the timeline proposal, essentially intact:** the timeline core and `replay(t)` (§5.1),
irreversibility (§5.3), the frozen-artifact boundary (§6), positive concrete nouns and the removal of
`negativePrompt` (§7), timeline export (§6), the core-versus-RPG-layer split (§8), the music-video
case study (§9), and its migration checkpoint (§11).

**Taken from the brink plan:** the authority contract (§5.2), provenance and license (§2), why this
is a fork rather than more pull requests (§3), the vocabulary hygiene test (§10), the seams (§12) and
the stop conditions (§13).

**Genuinely new, because merging forced it:** the single-substrate decision (§5.4) — the one open
question that must be answered before either plan proceeds past its additive phase — plus a sharper
core/layer line (§8), a rule-5 hazard in how positive nouns get enforced (§7), and a sequencing rule
that keeps the first client from shaping the core (§11).

**Three corrections to the timeline proposal**, none structural: SQLite has no materialized views
(§5.1); the predecessor is `shawnrushefsky/dmcp`, not `JavaDerek/dmcp` (§2); and the RPG-layer split
must leave factions, relationships, secrets and resources in the core or brink cannot consume the
package at all (§8).

### Round 2 — what the music-video side's reply changed

All three corrections were accepted, two of them independently verified rather than taken on trust
(§2). Both of §14's questions are now answered, and one requirement arrived that neither document
had:

- **§5.2 splits in two.** That client needs *no* adjudication — nothing in it is uncertain, there are
  no dice and no player — but its central failure mode is a narration-constraint violation. So the
  protocol has one consumer and the constraint has two, and they separate cleanly.
- **The constraint must be expressible as DATA, not only as a live exchange** — that client enforces
  as a lint over a finished file, hours after generation, with no model in the loop. brink's already
  is data, which makes this nearly free (§5.2b).
- **`changes_within(t0, t1)`** — a range query beside `replay(t)`, because every unit that client
  renders has *duration* (§5.5). Invisible from a turn-based consumer; the clearest vindication yet
  of having two unlike ones.
- **`t` is sharpened** from "opaque ordinal" to a testable property: the axis invariant under
  re-segmentation of the client's own units (§14).

**Raised from this side in round 2:** the prohibition half of a narration constraint must be
*derived and structural*, never an authored list of phrases — otherwise §7's `negativePrompt` returns
wearing a different hat (§5.2b).

### Round 3 — three corrections returned, all accepted

Round 3 answered the last question addressed to that side and returned three problems, two of them
errors introduced by this document rather than by either original:

- **Causality: one hop, and it is already in the schema.** A rejected claim carries the contradicted
  fact, its `valid_from_t`, and the `events.id` that opened it — not a trace of the engine's
  reasoning (§5.2c). The evidence is the strongest argument in the whole exchange for a feature that
  looked like a nicety.
- **§8's core-membership rule was wrong.** It read "everything both consumers need", while §5.2a had
  just established that the resolve protocol has one consumer and belongs in core anyway. Round 2's
  split made *generic* and *needed-by-both* come apart, and the rule was still using the second as
  its test. Repaired to **"generic, with at least one real caller"** (§8).
- **§7, §8 and §10 could not all hold.** A positive-noun vocabulary rich enough to render a world
  contains *mill wheel* or *treasury*; §8 put the projection in core; §10 fails CI on client-specific
  language in the engine. Resolved explicitly: **the mechanism is core, the vocabulary is injected**
  (§7, §10).
- **The §9 table overclaimed and this document propagated it.** One of the three defects was never
  the engine's to catch. Corrected in §9 and §11.

Conceded on that side: the prohibition half, with a note worth keeping — the forbidden-phrase form
arrived *while writing the argument against it*, which is §7's thesis demonstrating itself.

---

## 1. Thesis

**run-dmcp is a successor to [DMCP](https://github.com/shawnrushefsky/dmcp): an MCP server for
LLM-run interactive fiction where the server owns what is true — including when it was true.**

Both halves of that sentence are deliberate reversals of DMCP's founding premise, which is that the
LLM has full adjudication discretion (`games.rules` is opaque JSON that nothing enforces) over a
world that only ever stores *now*.

> The LLM classifies and narrates. The server resolves, remembers, and can say what the world looked
> like at any point in its history. The narrator may be as florid as it likes about *the how*; it can
> never lie about *the what*, or about *the when*.

---

## 2. Provenance, license, and what stays where

- **The predecessor is `shawnrushefsky/dmcp`** — MIT, ~170 tools, SQLite, last commit `f112a74`
  (2026-01-06). Independently verified in round 2: root commit `460364b`, Shawn Rushefsky,
  2025-12-30; `LICENSE` reads `Copyright (c) 2025 Shawn Rushefsky`; `JavaDerek/dmcp` reports
  `isFork: true` with parent `shawnrushefsky/dmcp`. `JavaDerek/dmcp` is *our fork*, which exists only to carry four open pull requests,
  and is not the ancestor. The distinction matters because Shawn Rushefsky's copyright notice travels
  with the code.
- **MIT, notice retained.** brink's `LICENSE` already carries his notice alongside Derek Ferguson's;
  run-dmcp inherits that file unchanged but for the project name. It is MIT's one real obligation and
  it is also just correct.
- **Full git history**, back to `f112a74`. Keeping the ancestor legible is a stated goal, so a
  squashed root would be a strange way to begin.
- **Standalone, not a GitHub fork** — same reasoning `docs/PUBLISHING.md` applied to brink's public
  repo: a repository inside someone else's fork network is discoverable only as "a fork of" and
  cannot own its issue tracker.
- **`JavaDerek/dmcp` stays as it is**, carrying the four offers. They cost nothing and remain
  mergeable. run-dmcp neither depends on nor waits for them.
  *(Superseded 2026-08-23: the four PRs were closed unmerged on 2026-08-18 and the fork was then
  deleted. Nothing was lost — each offer head is an ancestor of `main` here (`fa35cfb`, `8950364`,
  `043b132`, `4fb2002`), and GitHub retains the diffs at `refs/pull/6..9/head` in
  `shawnrushefsky/dmcp`.)*

```
  Balance of Power (1985)
        └── BalanceOfTerror ── brink ─────────── depends on ──────┐
                                                                  │
  music video pipeline ─────────────────────── depends on ────────┤
                                                                  │
  DMCP (dormant since 2026-01-06) ─────── continued as ─────── run-dmcp
```

Two consumers, deliberately unlike each other. Neither may become the reason the engine exists.

---

## 3. Why this is a fork and not more pull requests

Four offers stand open against DMCP — atomicity, declarative constraints, conserved resource sets,
on-expiry consequences. They were offerable precisely because they fit *inside* DMCP's design:
`withTransaction()` was already in the tree and merely unwired, and the rest are opt-in.

Neither half of §1 fits on those terms. A pull request saying "the server now returns an
authoritative outcome the narrator may not contradict" — or "current state is now a projection of an
event log" — does not extend DMCP; it asks its author to abandon the premise the project rests on
while he is not there to be asked. That is a fork, and naming it one is better than filing something
that could only be declined.

---

## 4. The two halves are one engine

It is worth showing that these were converging before they met, because it is the strongest evidence
the merge is not a compromise:

| brink side | timeline side | what they are together |
|---|---|---|
| `resolve_only` — a value only the referee may write | `facts` are closed and reopened, never overwritten | one audited write path, versioned |
| `monotonic` — a value that may only move one way | `irreversible` — a fact later events may not contradict | the same constraint family, one across values and one across time (§5.3) |
| `NarrationConstraint.mustHonor` — facts the narrator must not contradict | `replay(t)` — the state a renderer must depict | one outbound contract: *here is what is true; depict it, do not argue with it* |
| Pillar 0: say what **is**, never the raw value | §4.3: say what **is**, never the absence | the same rule, learned twice, on different surfaces (§7) |

---

## 5. The core model

### 5.1 Timeline

```
entities  (id, kind, name, created_at_t, destroyed_at_t NULL)
facts     (id, entity_id, key, value, valid_from_t, valid_to_t NULL, irreversible BOOL)
events    (id, at_t, kind, description, causes JSON)
```

- `t` is **story time**, client-defined, and chosen by one rule — **§14's**: it must be the axis that
  stays invariant when the client re-segments its own units. A song timestamp in seconds qualifies; so
  does a campaign turn counter. **A chapter index, a chunk index and a scene number do not** — editing
  re-cuts them, and the index shifts while the story does not. Choosing wrong raises no error: it
  silently attaches one unit's content to another's, which is why §14 states this as a property rather
  than a type. An opaque ordinal with a declared comparator — never a datetime.
- `facts` are interval-versioned. Setting a key closes the previous row's `valid_to_t` and opens a
  new one. Nothing is overwritten.
- **`replay(t)` returns a full world snapshot** — every entity alive at `t` with every fact valid at
  `t`. DMCP has no such query anywhere in `world.ts` or `time.ts`; the concept is simply absent. This
  is the whole feature.

The entity model this builds on is *already* general, which is what makes it viable: `locations` has
no `exits` column and no graph, `items` is polymorphic over `owner_type`. Verified in the tree, not
assumed.

**Correction to the original proposal: SQLite has no materialized views.** `CREATE VIEW` is
non-materialized and cannot be indexed, so "flip `locations`/`items` to materialized views of
`replay(now)`" has to mean *real tables kept in sync* — by triggers, or by the application writing
both inside one transaction. That is a meaningful and currently-invisible chunk of migration cost,
and it is the step most likely to be underestimated. It does not change the design; it changes the
estimate.

### 5.2 Authority, in two separable halves

Round 2 established that this is not one feature. The inbound and outbound halves have different
consumers, and conflating them would have made the engine unusable by one of them.

| half | shape | consumers |
|---|---|---|
| **5.2a resolve protocol** | propose → adjudicate → outcome | brink |
| **5.2b narration constraint** | facts that hold at `t`, and what may not be asserted against them | brink **and** the video client |

#### 5.2a The protocol

The shape of a resolve call and its result. The engine enforces the protocol — resolution happens
before narration, writes go through the audited path, declared constraints are checked — without
knowing what any particular mechanic *means*. brink registers eight mechanics; `ARMED_STRIKE` is a
name the engine never learns.

**One consumer, and that is fine.** The video client has no adjudication anywhere in it: nothing is
uncertain, there are no dice, no opposed actions, no player proposing anything. The song already
decided what happens. A protocol with one consumer should be scrutinised, and it has been; it
survives because brink's entire reason for needing an engine lives here.

#### 5.2b The constraint, which must be data

Its failure mode is the one the video client actually has: a lyric establishes at 6:26 that the
island is gone, and at 6:48 the prose stage writes a lush, turning water wheel. Nothing held the
fact, so nothing could object. That is *"here is what is true; depict it, do not argue with it"* —
and it is the thing that client most needs from the engine.

**The condition that decides whether it can use it at all: the constraint must be serializable
data, not a handshake inside a live call.** brink enforces during a session, resolution preceding
narration in one conversation. The video client cannot: its narrator output is generated once,
reviewed by a human, committed as a file, and rendered hours later by a process that must never call
a model. Enforcement there is **a lint over a finished artifact**, at a different point in time from
generation entirely.

**And it does not need to.** "Resolution preceded narration" was never the guarantee on offer there;
the guarantee is *a human approved this artifact before anything rendered* — a different property, at
a different point, by a different authority, whose provenance is the commit rather than the protocol.
The asymmetry below is therefore a real loss for brink and no loss at all for that client, and nobody
should build a proof obligation for a consumer that does not have one.

This is nearly free, because brink's constraint is *already* data — `{ tone, mustHonor:
NarrationFact[] }`, no protocol state — and `resolve.ts:170` already carries the comment that "a
future automated check can walk `mustHonor` and verify narration against it." Two enforcement points,
one structure.

**But the prohibition half does not exist yet, and must not be built the obvious way.** brink has
only `mustHonor`. Round 2 asks additionally for "assertions that must not be made", and an authored
list of forbidden phrases is precisely `negativePrompt` returning in a new costume — the same
mistake §7 exists to kill, one layer up.

> **Prohibitions are derived, not authored, and structural, not lexical.** If fact F holds at `t`,
> any assertion contradicting F is prohibited; if F is `irreversible`, it is prohibited for all
> `t' > t`. The check compares a claim against the facts, never text against a word list. Nothing
> needs a second field, and nothing needs anyone to remember to populate it.

#### 5.2c One hop of causality

A serialized constraint carries, for each fact it asserts: **the fact, its `valid_from_t`, and the
`events.id` that opened it.** `events.causes` already exists in §5.1, so serializing that edge costs
nothing. One hop — never a trace of how the engine reached a verdict, which rules were consulted, or
in what order.

**Why this is not a UX nicety.** A reviewer at a fired check has exactly one decision to make:
*is the fact wrong, or is the claim wrong?* That is undecidable without knowing what made the fact
true. Round 3 documented what happens when it is missing, twice and expensively: one revision round
rewrote **5 of 10** deliberately-authored lines back to what a heuristic preferred, destroying the
human approval that preceded it; a check keying on stemmed tokens rewrote **37 of 80** shot lines in
a single pass. In both, the correction loop optimised against the checker rather than against the
world — because the checker's output could not be argued with, only complied with.

> **A check that cannot be overridden on evidence gets satisfied instead of understood.**

brink reached the same depth independently, which is the argument that one hop is the right amount:
issue #89 made the DEFCON ladder record *what took each rung* — cause and seat, written inside the
same transaction as the rung itself — precisely so the value on the wall and the account of how it
got there could never disagree. One hop, both times, arrived at from opposite ends.

**One asymmetry to state plainly, because it limits what the artifact form can promise.** "Resolution
preceded narration" is a *protocol* property with no data equivalent — a serialized constraint can
carry what is true and what would contradict it, but it cannot prove the order in which they were
produced. brink keeps enforcing that at the live seam; the lint verifies consistency, never
provenance. Both are worth having; they are not the same guarantee.

### 5.3 The constraint family, now including time

The engine has declarative, opt-in constraints: `bounded`, `monotonic`, and conserved sets with
atomic transfer. (`resolve_only` belongs to the same family and was written in brink but never
extracted — brink #31. It lands here alongside the resolve protocol in Phase 4, since a value that
may move only through adjudication needs the adjudicator to exist first.) **`irreversible` joins them as a fourth.**

That is the neatest result of the merge. Irreversibility is not a new subsystem; it is the temporal
member of a family that already exists, declared the same way, enforced at the same choke point. An
island that was destroyed cannot quietly exist again for the same reason prestige cannot quietly stop
summing to a constant.

And it is worth restating why this one earns its place: **it is the single most common continuity
failure in long-form narrative, and it is mechanically checkable** — which is true of almost nothing
else about narrative.

### 5.4 THE OPEN DECISION: one versioning substrate

*This is the question that must be answered before either plan proceeds past its additive phase, and
neither original document addresses it.*

There are now two mechanisms for "what did this value used to be": `resource_history` and
`relationship_history` on one side, `facts` with `valid_from_t`/`valid_to_t` on the other. Both are
versioning. Shipping both is how a codebase acquires four disconnected write paths — which is
precisely the defect brink's own `CLAUDE.md` already warns about, having been bitten by it.

Three ways out:

- **(A) `facts` is the source of truth; `resources` and `relationships` become projections.** Purest.
  Cost: every invariant-bearing write in brink reroutes, and conservation/bounds enforcement moves to
  fact-writing time.
- **(B) They coexist, split by role** — invariant-bearing numbers in `resources`, descriptive and
  renderable state in `facts`. Cheapest today. **Recommended against:** it is the two-systems trap
  wearing a sensible-sounding rule, and the boundary will be argued about forever.
- **(C) `resources` becomes a constrained *kind* of fact.** Numeric facts whose keys are declared
  constrained, written through one choke point; `resource_history` disappears because interval
  versioning *is* the history.

**DECIDED: (C)**, sequenced late. Made by brink's owner on 2026-08-18, after both rounds in which the
music-video side declined to vote — correctly, having no stake in these invariants; a vote from a
consumer that never touches them would be noise dressed as consensus. The choice sits where the
consequences land.

It is the honest generalisation rather than a replacement, it preserves the single-choke-point
discipline that was expensive to win, and it avoids (B)'s trap. It is feasible *because* of that
discipline: brink already funnels every invariant-bearing number through one function, so there is
exactly one writer to re-point.

Sequenced late means: not until `replay(t)` has been proved to reproduce current state (§11 step 3).
Until then both mechanisms coexist by necessity, with (C) as the declared destination so nobody
builds anything that assumes otherwise.

### 5.5 `changes_within(t0, t1)` — because units have duration

`replay(t)` is a point query. Every unit the video client renders is an **interval**, `[t0, t1)`, five
to fifteen seconds long, and its style contract mandates one continuous unbroken take with no cuts
inside a shot. It follows that **a fact changing inside a single interval is itself a defect** — the
unit is being asked to depict two different worlds in one continuous shot.

```
changes_within(t0, t1) → [events and fact transitions in the half-open interval]
```

Cheap once the timeline exists: a range scan over `events` and `facts.valid_from_t`. It converts a
whole class of continuity defect into something detectable before any expensive rendering.

**The engine provides the query; the client declares the policy.** "A change inside a unit is a
defect" is true of a continuous-take renderer and false of most other consumers — brink wants exactly
the opposite reading, since "what changed between the player's last turn and now" is the same query
used to *build* a briefing rather than to fail one. Same primitive, opposite verdicts, which is how
you can tell it belongs in the core.

**And it returns transitions, never a verdict.** No `is_clean` boolean, no severity, no "this
interval is contiguous". The moment the query returns a judgement it has baked one client's policy
into the engine — and it would be the *first* client's policy, which is the exact capture §9 and §10
exist to prevent. Return the rows; let each caller decide what they mean. This is the same rule as
§14's "the engine records the decision, it does not make it", arriving at the level of a single
query.

Worth recording why this requirement was invisible until now: it cannot occur to a consumer whose
world advances one turn at a time and reads state at the turn boundary. It appears only when a
consumer's units have duration. Two unlike consumers, arriving on schedule, doing exactly the job
§2 says they are there for.

---

## 6. The boundary that keeps both systems honest

> **Conversational authoring lives upstream of a frozen artifact. Deterministic consumers depend on
> the artifact, never on the live server.**

The temptation, once an MCP server holds the world, is to let consumers query it at runtime. Resist
it. A consumer that calls a conversational service at runtime loses reproducibility, loses
resumability after a crash, and acquires a per-run cost that scales with how often it asks.

```
  [ interactive session ]           [ frozen ]            [ consumers ]
   model plays DM,           →   timeline export   →   renderers, games,
   world evolves, human           (a committed          static sites, tools
   reviews and steers             file)                 — all deterministic
```

**Timeline export is therefore a core requirement, not a convenience**: a client must be able to
freeze the entire timeline — every entity, every fact interval, every event — into a file it owns.
Not a live query. Not a session handle. A file.

The interactive part is where the value and the judgement are. The artifact is where the guarantees
are. Separating them by an export step lets the engine be as conversational and non-deterministic as
it likes without infecting anything downstream.

---

## 7. Rendering state: positive concrete nouns

When the engine renders state back into text, it must say what **is** true, not what is absent. *"The
mill wheel is split and silted, the channel dry"* — never *"the mill is no longer turning"*.

This is not a style preference, and the evidence is unusually good. In a single-variable A/B at an
identical seed, a prompt clause reading `avoid = [..., "harnesses or safety gear"]` put a climbing
harness, carabiners and a trailing rope onto a character who was not climbing. In the same pipeline,
*"the character performs silently, no lyric to sing"* produced a character mouthing words through
every instrumental passage — because the tokens actually present were *lyric* and *sing*. Downstream
image and video models render the nouns they are given and have no mechanism to subtract.

brink reached the same rule from the other end (Pillar 0: state what is, never the raw value), which
is why it belongs in the engine rather than in either client.

**Corollary: drop `negativePrompt`.** DMCP's `image-prompt.ts` emits one, and it is worse than the
original proposal noted — line 203 hardcodes a default of `"low quality, blurry, distorted,
deformed"` whenever a template supplies none, so the footgun fires even for callers who never asked
for it. Any model with a single conditioning channel either ignores the field or concatenates and
renders it.

**A hazard worth naming, from brink's hard rule 5.** The obvious way to enforce this is to scan
generated text for negation — "no longer", "without", "avoid" — and fail. **Do not.** That is a word
list doing language understanding, and brink lost a DEFCON rung and ~600 lines to exactly that
mistake. Enforce it at *construction* instead: the renderer emits from a positive-noun vocabulary and
has no way to express absence, so negation is unconstructable rather than detected. A check for a
token *we* defined in output *we* generated is fine; a check for English negation is not.

Round 2 supplied independent evidence from the other side: a keyword lint that justified itself at
3.5× separation on a partial sample scored **0.72× on the finished corpus** — noise — while the one
phrase that did separate had already been measured and rejected earlier at n=3. A word list doing
language understanding fails in both directions at once, and it stops announcing that it is a
hypothesis the moment it ships. Two projects, two independent failures, one rule.

A third instance arrived in round 2 and is worth keeping because of *where* it came from: the request
for "assertions that must not be made" is a forbidden-phrase list, written into the reply that argued
against forbidden-phrase lists. Negation is simply how English expresses these constraints, so it
will keep arriving — from careful people, mid-argument, in good faith. **The defence has to be
structural, because vigilance has now failed four times in two codebases.**

**What "construction" means concretely, because §8 and §10 constrain it:** the engine owns the
constructor that cannot express absence; **each client injects the nouns it can render**. A
vocabulary rich enough for a real world contains *mill wheel* or *treasury*, and either of those
sitting in the engine would fail §10's hygiene test on day one — correctly. Mechanism in core,
vocabulary at the boundary.

**Scope, recorded now because it is exactly the kind of thing misread in six months:** this binds *the
engine's state-to-text projection*. It does not bind a client's own prose stage — shot lines,
dialogue and narration are free English written by a model, and could never be constructed from a
closed vocabulary. The rule governs what the engine emits when it renders state; what a client writes
downstream of that is the client's own business, subject to the constraint (§5.2b) rather than to the
vocabulary.

---

## 8. Core, layers, and clients

The ~170-tool RPG surface should be a **layer above the core**, not part of it — a video client, a
static-site client or a novel-continuity checker should depend on entities/facts/events/replay
without any of it.

**The test for core membership is "generic, with at least one real caller"** — *not* "needed by both
consumers". Round 2's split made those two come apart: the resolve protocol has exactly one consumer
and belongs in core anyway, because it is entirely generic and brink's whole reason for needing an
engine lives there. The dual-consumer test was a useful *proxy* for genericity while there was only
one axis; it stopped being one the moment a generic thing legitimately had a single caller. The
"at least one real caller" half is what still keeps fog of war out (§13: nothing enters the core
without a real caller) and what keeps this from becoming a licence to build for imagined clients.

**And the line has to be drawn more carefully than "RPG things go up":**

| Layer | Contains | Why |
|---|---|---|
| **Core** | entities, facts, events, `replay(t)`, `changes_within(t0,t1)`, the constraint family, the resolve protocol and constraint, timeline export, the turn reader, the state-to-text projection *mechanism* | Generic, with at least one real caller. Not narrative furniture. |
| **Core, and this is the correction** | factions, relationships-with-history, secrets, resources, locations, items | brink's spine. If these go up into the RPG layer, brink cannot consume the package without dragging the RPG layer with it — which defeats the split. They are entity/property concepts, not RPG ones. |
| **RPG layer** | dice, combat, abilities, status effects, random tables, quests | Genuinely game-shaped. Optional dependency. |
| **brink** | the eight mechanics, prestige, DEFCON, flashpoints, cohesion, crises, compellence, accords, occupation, seats, GM persona, situation room, refresh pipeline | Geopolitical content. Never in the engine. |

**Deferred:** per-seat visibility / fog of war. Not built (brink #16). It lands when **a real caller**
makes the requirement concrete rather than being designed against an imagined one.

*Erratum, and it matters more than a word.* This line previously read "when a second consumer" — a
stricter bar than the rule stated four paragraphs above it, and stricter in a way that was not
deferral but permanent refusal: the video-side consumer **structurally cannot** want fog of war (§9 —
one traversal, no player, nobody to hide anything from), so a bar requiring two consumers is one no
caller can ever clear no matter what it builds. The bar is the same as every other core entry: one
real caller.

**Admission criterion, both halves required.** A real caller needs it, *and* its principal **resolves
to an entity the engine already has**. "Resolves to", not "is": a caller's principal may carry
attributes of its own — a controller, an index, a display name — and still be admissible, so long as
identity lands on an existing entity. What is refused is a principal that can only be *named* in the
caller's own vocabulary, which belongs in that caller's layer and which §10's CI gate will say so
about. And the check the feature must be stated as is structural, in §5.2b's existing shape — *if
fact F is not visible to principal P at `t`, a claim asserting F in a payload built for P is
prohibited* — derived from the facts, never an authored list of what may not be said, which would be
§5.2b's rule wearing a costume.

---

## 9. Case study: a music video is a degenerate interactive fiction

One traversal, no player, entirely known in advance. Everything a DM engine must handle that a video
does not — branching, arbitrary player queries, uncertainty about where attention goes next — is
strictly more. The video is a proper special case, which makes it an unusually good early client: it
exercises the timeline hard and the world model not very hard at all.

It also has **eighty data points and known-wrong outcomes**, which beats a synthetic campaign. Three
defects from a real 8:32 render, all catchable before any GPU time:

| observed | what happened | what it shows |
|---|---|---|
| "the island is no longer" sung at 6:26; a barren island at 6:38; a **lush** water wheel at 6:48; green mountains at 7:11 | a destroyed entity came back, twice | **the engine would have caught it** — §5.3 irreversibility |
| a mushroom cloud levels everything, then the world looks normal again | the world's description was one constant string for the whole runtime | **the engine would have caught it** — §5.1 `replay(t)` |
| a character mouths words through every instrumental passage | the "don't sing" instruction was a prohibition with no channel to live in | **evidence for a rule, not a catch** — a hardcoded string in that client's own prompt composer, on a code path that will never call run-dmcp. Fixed there on 2026-08-18 in two lines and a regression test. It is the best evidence §7's rule is real, from a surface brink does not share; it is not a defect the engine would have prevented. |

The video client's brutal constraint — *every fact must survive being rendered as something you could
photograph* — is a good forcing function. A world model that can emit "the state of the world at `t`,
as concrete visual nouns" is better at being a DM than one that emits prose.

**And the risk that comes with it, which is why §11 is ordered as it is:** this client exercises no
adjudication at all. If it is the first consumer, the core gets shaped by a client with no player, no
uncertainty and no rules to enforce — and brink's needs arrive second, against a settled API.

**Round 2 resolved this, and the mitigation falls straight out of §5.2's split:** that client
exercises *only* the outbound contract and the timeline, so it validates the data shape of those and
brink drives the resolve protocol alone. A consumer cannot shape what it does not use. The remaining
care needed is narrow: 5.2b's data shape now has a lint-over-artifact consumer, so brink should check
that a constraint serialized for offline checking still carries everything a live session needs — the
asymmetry in §5.2b is the known limit.

---

## 10. How the line stays honest

brink has `src/__tests__/publishHygiene.test.ts`, which fails CI when a machine name or LAN address
reaches the published tree. It works because it is a test, not a checklist.

run-dmcp gets the same device pointed at vocabulary: **a test that fails when client-specific language
appears anywhere in the engine** — DEFCON, prestige, flashpoint, cohesion, seat names, mechanic names;
and equally song titles, character names, chunk ids, shot numbers. Fixtures use grain, treasury,
population — **a throwaway vocabulary for testing the mechanism, never a starter set anyone should
build on** (§7). Agreed by both sides in round 2: the test treats each client as adversarially as the
other, on the same CI gate.

This is the single most important artifact here after the thesis, because it is the only thing that
prevents "engine with two consumers" from decaying into "one client's library with a second client
bolted on".

---

## 11. Sequencing

The ordering rule that falls out of §5.4 and §9: **every additive step from both plans lands before
any opinionated step from either.** Additive steps are independently valuable and foreclose nothing.

**Phase 0 — birth.** Standalone repo from DMCP's full history; merge `offer/conserved` and
`offer/expiry-effects` (stacked, so those two carry all four offers); rename the package; `LICENSE`
keeps both notices; README states the thesis; CI on four gates; publish `0.1.0` (`run-dmcp` is
available on npm — plain `dmcp` is taken at v0.0.14). **Touches no client.**

**Phase 1 — the timeline, additively.** Add `entities`/`facts`/`events` alongside existing tables;
dual-write from existing tools; implement `replay(t)`.
**Checkpoint, and it is a real one:** verify `replay(t)` reproduces the live tables at `t = now` for a
real campaign. If it cannot, the event log is lossy and nothing above it can be trusted. Stop and fix
before anything else.

**Phase 2 — irreversibility and export.** `irreversible` joins the constraint family; timeline export
lands. **Two of the video client's three defects become preventable here** (the third was never the
engine's to prevent — §9), so it is the earliest phase that pays a consumer back. Note that the
state-to-text projection carrying §7's positive-noun rule does not land until Phase 6, so that rule
lives in each client until then.

**Phase 3 — the substrate decision executed** — §5.4's option (C), decided 2026-08-18, now that
replay is proved.

**Phase 4 — the authority contract.** The resolve protocol with neutral-fixture tests; brink's
`resolve.ts` shrinks to eight registered mechanics.

**Phase 5 — the plumbing switch.** brink deletes its 66 inherited files and imports them from the
package. Mechanically the largest change, behaviourally none.

**Phase 6 — turn reader, state-to-text projection, core/RPG split.**

**Deferred —** fog of war, when a consumer needs it.

**Meanwhile, and deliberately outside this sequence:** never let a downstream need wait on an upstream
engine. The video client's continuity bug was real, and its tactical half has already shipped in that
client's own repository — two lines and a regression test. What remains is the small event-sourced
world model in its authoring layer, roughly 200 lines, built *shaped like* §5.1 so it is a working
prototype of the core rather than throwaway scaffolding and can be swapped behind the same seam
later. **That build is the single commitment this design asks of that side**; everything else in this
section is brink's.

---

## 12. The seams that will hurt

1. **`resolve.ts`** — 2,889 lines naming DEFCON/prestige/flashpoint/cohesion **293 times**. The
   generic contract is buried inside the most brink-specific file in that repo.
2. **Schema ownership** — brink's 12 tables and DMCP's 27 share one SQLite file and one
   `initializeSchema()`. The engine must expose a migration hook before any client can consume it as
   a package. Prerequisite of Phase 5, not a refinement.
3. **The turn reader's questions** — machinery is generic (one call per turn, answers in keys, every
   claim cited against the source, three rungs of fallback); the questions are brink's. The citation
   rule moves as a *rule*, not a convention: uncited, a 14B model read *"I ignore Korea and talk to
   Beijing about trade"* as engagement with the South China Sea.
4. **Fact granularity** — too coarse and `replay(t)` returns prose that cannot be checked; too fine
   and authoring becomes data entry. Driven by what the checks need, not by what is describable.

---

## 13. Risks and stop conditions

| Risk | Response |
|---|---|
| **The contract cannot be expressed without client concepts** | **Stop condition.** If Phase 4's neutral-fixture tests cannot be written without saying DEFCON, the cut line is wrong. Reconsider rather than ship a hollow engine. |
| **`replay(t)` cannot reproduce current state** | **Stop condition** (Phase 1 checkpoint). A lossy event log invalidates everything above it. |
| **Two versioning substrates ship** | §5.4 is decided — (C), executed at Phase 3. Both mechanisms coexist until the replay checkpoint by necessity, with the destination declared so nothing is built assuming otherwise. |
| **The first client shapes the core** | Resolved in round 2 by §5.2's split: each consumer uses a different half, and cannot shape what it does not use. Additive-first sequencing and the vocabulary hygiene test still apply. |
| Scope absorbs arbitrary effort | Nothing enters the core without a real caller. Fog of war deferred for exactly this reason. |
| Two repos, one maintainer | 0.x, publish often, pin exactly. |
| brink's velocity drops during Phases 4–5 | Do them between playtests, never during. The game staying playable outranks the extraction. |
| Upstream wakes mid-extraction | Nothing breaks; the four PRs remain valid and run-dmcp absorbs whatever merges. |

---

## 14. Open questions

- **RESOLVED — what is `t`?** An opaque client-defined ordinal with a declared comparator remains the
  right *type*, but round 2 sharpened it into a property that can actually be tested:

  > **`t` is the axis that remains invariant under re-segmentation of the client's own units.**

  The video client's answer is song time in seconds — a float, `0.0` to `512.08` — and the instructive
  part is the negative: its ~80 chunks have integer ids and **the chunk index is the obvious wrong
  answer**. Two days before that reply, a change moved 7 chunk boundaries and altered the spans of 11
  chunks while total length and both track edges stayed invariant by construction. Song time was
  untouched; every chunk index after a moved boundary silently named a different span than it had the
  day before. That failure raises no error — it attaches one shot's direction to another shot's audio.

  brink's `world_clock` tick satisfies the property, but *trivially*: brink never re-cuts its units,
  so nothing there tests the rule. It is load-bearing for one consumer and free for the other, which
  is an argument for stating it as a property rather than as brink's precedent.
- **Who decides what changes when?** The engine records the decision; it does not make it. Worth being
  explicit, because a world engine can look like it will solve narrative problems and it will not — it
  makes them *checkable*, which is different and more achievable.
- **Does `cadence_state` belong to the engine?** A jittered world clock is arguably generic; its
  particular design is brink's. Currently brink's — revisit at Phase 6.
- **Do `overnight_work`, `retirement_signals`, `persona_names` generalise** to "a session has beats
  between turns"? Possibly. Not on evidence from one client.
- **RESOLVED — does the video client need the resolve contract?** Half of it. No adjudication
  whatsoever; the outbound constraint is the thing it most needs. See §5.2's split, which is the
  largest structural change round 2 produced.
- **Still open, and now brink's alone to call:** §5.4's substrate decision. The video side recorded
  that it has no stake and declined to vote on someone else's invariants, which is the right call and
  leaves the choice where the consequences land.
- **RESOLVED — causality in the serialized constraint?** Yes: one hop (§5.2c). The contradicted fact,
  its `valid_from_t`, and the event that opened it — never a trace of the engine's own reasoning. The
  reviewer's question is *is the fact wrong or is the claim wrong*, which is undecidable without it.

---

## 15. What acceptance means

This section exists so that "yes" is a specific act rather than a nod. Accepting this document means
accepting the twelve decisions below — each one binding on the engine, each traceable to the round
that settled it.

**A "no" names a row and a reason.** Anything not named is taken as agreed, and the design is then
settled enough to begin Phase 0.

| # | Decision | Where | Settled in |
|---|---|---|---|
| 1 | The engine owns what is true, **including when it was true**. The narrator may not contradict it. | §1 | merge |
| 2 | Standalone repo, DMCP's full history, MIT with Shawn Rushefsky's notice retained; `JavaDerek/dmcp` stays as the PR carrier. | §2 | merge, verified round 2 |
| 3 | Timeline core: `entities` / `facts` / `events`, interval-versioned, with **`replay(t)`** as the load-bearing query. | §5.1 | timeline proposal |
| 4 | `t` is **the axis invariant under re-segmentation of the client's own units** — a property, not a type. | §5.1, §14 | round 2 |
| 5 | **§5.2 splits**: the resolve protocol (one consumer) is distinct from the narration constraint (two). | §5.2a/b | round 2 |
| 6 | The constraint is **serializable data**, enforceable both at a live seam and as a lint over a frozen artifact. Prohibitions are **derived and structural**, never an authored list of phrases. | §5.2b | round 2, conceded round 3 |
| 7 | A rejected claim carries **one hop of causality** — the contradicted fact, its `valid_from_t`, and the event that opened it. Never a trace of the engine's reasoning. | §5.2c | round 3 |
| 8 | **`irreversible`** joins `bounded` / `monotonic` / `resolve_only` as the temporal member of one constraint family. | §5.3 | timeline proposal |
| 9 | **`changes_within(t0, t1)`** returns transitions, **never a verdict**. The engine provides the query; the client declares the policy. | §5.5 | round 2, sharpened round 3 |
| 10 | Conversational authoring upstream of a **frozen artifact**; deterministic consumers depend on the file, never the live server. Timeline export is core. | §6 | timeline proposal |
| 11 | Positive concrete nouns, enforced **at construction** — mechanism in core, **vocabulary injected by each client**. `negativePrompt` is removed. Negation is never detected by scanning text. | §7 | merge, repaired round 3 |
| 12 | Core membership is **"generic, with at least one real caller"** — not "needed by both". The layer table in §8 follows from it. | §8 | round 3 |

**Also binding, but procedural rather than architectural:** the vocabulary hygiene test treats both
clients as adversarially as each other on the same CI gate (§10); the phase order is additive-first
so neither client shapes the core (§11); and two stop conditions can halt the project outright —
a resolve contract that cannot be expressed without client vocabulary, and a `replay(t)` that cannot
reproduce current state (§13).

### What acceptance does *not* ask of the music-video side

- **Not §5.4.** The substrate decision is brink's, made, and recorded — that side declined to vote
  twice, correctly, and is not being asked to ratify it now.
- **Not engineering time.** The only commitment already made from that side is the one it proposed
  itself: ship the tactical continuity fix in its own repo, shaped like §5.1 so it is swappable
  later. Everything else in §11 is brink's to build.
- **Not a schedule.** No phase carries a date.

### Still genuinely open, and not blocking

**Fact granularity** (§12.4) — too coarse and `replay(t)` returns prose that cannot be checked, too
fine and authoring becomes data entry. It resolves once there are real checks to drive it, which is
Phase 2 at the earliest. Recorded rather than guessed at.

---

**Accepted by:**

- **brink** — Derek Ferguson, 2026-08-18
- **music-video side** — Derek Ferguson, 2026-08-18 — all twelve rows accepted, no row refused

**The commitment this acceptance carries from the music-video side:** one build — the small
event-sourced world model in its authoring layer, shaped like §5.1 so it is swappable behind the same
seam later (§11). The tactical continuity fix has already shipped. Everything else in §11 is brink's.

**§5.4 remains brink's**, unratified by that side by design.

