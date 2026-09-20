# Authoring a world on run-dmcp

**This is not the spec.** [DESIGN.md](DESIGN.md) is the negotiated, signed protocol and stays that
way. This document is something else: a growing, working catalogue of how to *use* that protocol —
how to describe objects, characters and motivations so a caller's own world holds together the first
time, instead of after a consumer discovers the hard way that it didn't. Add to it as you find things;
do not touch DESIGN.md to do so.

Every example here uses the engine's own placeholder vocabulary (grain, treasury, population,
generic object/property names) on purpose, per root `CLAUDE.md`'s engine boundary: this file lives in
`run-dmcp` and no consumer's own words belong in it, however illustrative. A lesson recorded here
should read the same to someone building a heist, a courtroom drama, or a farm sim.

## The pattern this guide is mostly about

`createTurnReader` (`src/reader/turnReader.ts`) is how a caller turns free text into structured
fact without pattern-matching meaning (root `CLAUDE.md` hard rule 4): the caller declares closed-key
questions and the sources an answer may be cited from, the engine asks a model-backed transport, and
a citation only counts if it is a byte-exact substring of the source it claims. **The caller owns the
questions and what the keys mean; the engine only ever checks "is this exact text present," never
"does it mean that."** Almost every lesson below is really the same warning restated: the engine's
citation check is honest but literal, so the honesty is only as good as whether the *right* words
exist in the *right* place for it to find.

## Lesson: the citation has to live on the object whose property you're changing

The concrete incident this generalises: a game declared two closely related objects — call them
**A**, a mechanism a character directly acts on (worked, pried, forced), and **B**, the thing whose
state actually changes when A gives way (a barrier that becomes passable). The reader's *effect*
question correctly told the model "when the aim is to make B passable, name B as the target, even
when the method works on A" — and the model followed that instruction, because it was right there in
the effect question's own prompt. But the *target* question is a separate question, asked from its
own prompt, which said nothing of the kind. So the model reasonably named A — the object the intent
actually describes touching — as the target. A declares no "passable" property of its own to report,
so whatever property came back next, the ruling could never cohere, and the attempt silently did
nothing. This was not a rare edge case: it was **the only two rulings of that effect kind the game
ever produced**, in two different sessions, months apart.

Two lessons live inside that one incident:

1. **An instruction that lives in only one question's prompt does not propagate to another
   question's answer.** Each `ReaderQuestion` is answered from its own `prompt`, independently — the
   engine never shows one question's prompt to another's, and there is no reason a model answering
   question 1 would re-derive an instruction that only appears in question 3. If two questions in the
   same request must agree on something (the same object, a property implied by an earlier answer),
   say so in **every** prompt that needs it, or — better — don't ask the model to enforce the
   agreement at all: resolve it in your own code from data you already have (see below).
2. **When one interaction conceptually spans two objects, decide up front which one the citation
   grounds against, and make sure that object's own description can actually supply it.** If a
   citation must come from the target's own authored text (a common and reasonable rule — it's what
   keeps "grounding" meaningful rather than decorative), then either author that object's description
   with language that can genuinely ground every property your effects declare for it, or don't ask
   the reader to name that object as the target at all — resolve the *real* target structurally, from
   a mapping your own code already owns (a mechanism-to-consequence table, an exits list, whatever
   your world already tracks), the same way a "leave through an exit" mechanic doesn't ask the model
   to name the destination — it looks it up.

The fix that actually worked was the second half of lesson 1 applied literally: nothing in the
prompts changed. The caller's own effect-resolution code learned the A→B mapping it already had
elsewhere, and stopped asking the target question to make a leap that belonged in code, not in a
sentence one question's prompt happened to contain.

## Lesson: a description that implies more than the world models will be planned around

The concrete incident: a world modelled a barrier as **one** part whose integrity, worn to zero, made
the way through passable. The barrier's own description, and the part's, said it was **one of
several** identical parts. A model-driven character wore the part to zero, then spent every remaining
turn working on "the next one", with the way through open and nothing standing in it. It never tried
to go through. Nothing was wrong with the mechanism, the reader or the model's reasoning: the reasoning
followed the text exactly, and the text described a world that did not exist.

Two lessons:

1. **A model plans from the prose it is shown, not from the state you store.** Counts, sizes and
   "one of several" are claims about the world. If a description says there are five of something and
   your world models one, a careful model will plan for the other four, and the better it reasons the
   more faithfully it will do so. Write every description to say what the world models, including how
   many of a thing actually matter: "one loose plank closes the widest gap; with it gone, a person fits
   through", not "a fence of five planks".
2. **When a state change makes a new action possible, say so in the words of that action.** A number
   reaching zero ("integrity went from 5 to 0") tells a model a value changed; it does not tell it that
   the way through is now open. Render the consequence the mechanism already knows ("the gap can be
   climbed through now"), from the pairing your own code owns, never inferred from prose.

## Lesson: declare the space of what an object may come to be; describe what it is

A description states what's true of an object right now: this granary is two-thirds full, its
timbers sound. That's a claim about the present, and a citation can only ever ground against a claim
that's already in the text. But some worlds also want an object that can acquire a new fact partway
through play — the granary later found to have taken on damp, the treasury later found to hold a
second, hidden ledger — and an acquisition like that has to be authored *somewhere*, or it isn't a
ruling at all, it's improvisation wearing a ruling's clothes.

The fix is to keep two different kinds of authoring apart, because they answer two different
questions. **Describing** an object says what it is now, and only the reader questions asked against
it *today* can cite that text. **Declaring the space** says, up front and separately, what property
vocabulary a reader is even permitted to name for an object of that kind at all (a granary's
condition: sound, damp, infested), what band of effort each value costs to establish, and where
establishing one could lead (damp found in the granary opens a spoilage consequence; a second ledger
found in the treasury opens an audit one). That declaration is authored once, the same way every
other property vocabulary in this guide is, and it is never itself a claim about this particular
granary or this particular treasury — it only says what the *kind* is allowed to become.

Whether a given object actually acquires one of the values in its declared space is play's decision,
not the author's: a reader question grounds it exactly the way every other ruling in this guide
grounds, against whatever the object's description says at the moment it's asked. Once granted, the
new fact joins the object's description going forward the same as any fact authored on day one — it
just arrived mid-game instead of up front. Keeping the two kinds of authoring separate is what makes
"the world gained a fact mid-game" auditable data — a specific ruling, against a specific declared
space, at a specific time — rather than something a transcript merely narrates and nobody could
check.

## Lesson: in a physical space, the surfaces are objects too

The concrete incident: a location was authored as a room with a handful of things in it and two
ways out, and one thing's description mentioned what lay beneath it -- loose grit over packed earth.
Nothing modelled the floor. With both ways out sealed, a model-driven character tried to dig. The
reader's *effect* question, which must name one of the declared effect kinds, filed the dig under the
nearest one -- "look under the thing" -- cited a verifiable span, and ruled it possible; the world then
did nothing a dig would do. A second reading, built specifically to say *"no declared kind names
this"*, could not say it either. Shown the thing's own description, the model described the dig
correctly (grit removed, the hollow deepened) and then mapped that, consistently and with a stated
reason, to *wear* -- damage to whatever the floor is. Which is right. Digging **is** wear on the floor.
The floor just wasn't anything.

Three lessons:

1. **A model reads an act against what the world contains.** If a description mentions a surface --
   a floor of packed earth, a plaster ceiling, a damp wall -- and no object stands behind it, an act
   aimed at that surface has nowhere to land. It falls onto the nearest declared thing, usually
   whatever sits on top of the surface, and there it becomes a different act with a different
   property, and the ruling is sound on its own terms. This is the second lesson in this guide again
   (prose that claims what the world does not model), and it is the largest class of it in any
   enclosed space: every room has surfaces, and few authors declare them.
2. **Declare the enclosure's surfaces as objects whenever they could be acted on.** Floor, ceiling,
   walls -- a small, finite set, which is what makes this a convention rather than per-scenario
   cleverness. Each is an ordinary item owned by the location: described by material and condition
   (packed earth, dressed stone, lath and plaster), carrying the property vocabulary that says what
   could happen to it (`integrity` for anything that can be dug, chipped or broken through), and, where
   a way through could open, the declared route -- the previous lesson's declared space, applied to a
   surface. A surface nobody could act on needs no object; say so in its material (solid bedrock) or
   leave it out. But the one a description *invites* a character to try has to exist before the
   character tries it, because the character will.
3. **Declaring the surface rescues acts that NAME the surface, and nothing else. Measured.**
   This lesson was written from one hand-run probe and then tested properly, and half of it did not
   survive. A floor was declared as an item owned by the location, described by material and condition,
   carrying `integrity`. Four digging intents were read five times each, against the same world with and
   without that object:

   - The two that named the **floor** ("scrape down through the floor with the spoon", "dig an escape
     tunnel") went from having no target at all -- one of them ruled as damage to the *tool* -- to
     `floor` / wear / `integrity`, which is the correct reading and reaches the ordinary
     property-changing path.
   - The two that named the **thing lying on the floor** ("dig under the loose tile") did not move at
     all. Same object, same effect, same property, at full agreement, with and without a floor in the
     world.

   Then the obvious repair was tried and also failed: the floor's description was given the containment
   in words -- the tile is set into this floor, the hollow beneath it is a dip in the same packed earth
   -- and the results were identical, key for key, on every item. So the containment being unstated was
   not the problem either.

   **The reason is structural, and it is the most useful thing in this lesson.** The reader's *target*
   question is answered from the words of the intent, and says so in its own prompt: cite the words that
   name the object. When an intent contains a declared object's id or name, that object wins, whatever
   any description says lies beneath it. No amount of authoring on the surface's side reaches an act
   whose words name something else. One intent made this plain by answering with the floor's property
   while refusing to name the floor as the target: it read the surface, named its property, grounded it
   in the surface's own text, and still would not say the act was aimed there.

   What this changes for an author: **declare the surface, and do not expect it to redirect anything.**
   An act aimed *through* a thing at what lies under it will be ruled on the thing. If the thing cannot
   support that act, the ruling will be wrong and sound at the same time -- which is this guide's second
   lesson again, and the repair belongs on the thing: either declare the property the act will need, or
   stop the description inviting an act the thing cannot support.

4. **A surface nobody declared does not fail safely.** The same probe found the other half of the cost,
   and it is worse than a missed ruling. Acts that named no declared object at all -- a character
   crouching, a character calling out -- were not answered with "nothing here"; they were captured by
   whatever was nearest and ruled to change it, at full agreement and with a verbatim citation. In one
   case an act of crouching down was ruled to *open a way out*. Declaring the things such acts are really
   aimed at (a surface, a character's own body) removed those captures, not by adding a guard but by
   giving the act somewhere to land. **A reader choosing from a closed list does not reliably answer
   "none"; it answers with the nearest member.** That is the strongest argument for declaring the
   obvious, and it is an argument about soundness rather than about richness.

5. **This is authoring, not mechanism, and the engine is the wrong place for it.** In the engine a
   location is a name, a description and properties, and an item is owned by a location or a
   character. A floor is an item. Nothing engine-side is missing, so nothing engine-side should
   grow a noun for it -- and a game with no physical space at all (a board, a ledger, a negotiation)
   has no floor to declare, which is the other reason it is a convention here and not a column.

## Checklist before you ship a `createTurnReader` question set

- For every `(effect, property)` combination your effects layer accepts, can you point to the exact
  object and exact words in its description that would grade a citation for it? If the answer is "it
  depends which object the model names," that dependency needs to be resolved by your own code, not
  left to the model to get consistently right across two independent answers.
- If two questions must stay consistent with each other, put the constraint in every prompt that
  needs it, and prefer enforcing it in code over the prompt doing the whole job — a prompt sentence is
  a plea; a value your code looks up is a fact.
- Write each object's description to literally contain groundable language for every property you
  intend to let effects touch on it. A description that reads well narratively but never mentions the
  thing an effect needs to cite from it will silently refuse that effect forever, and nothing will
  tell you why except a null result you have to go looking for.
- Read each description as a stranger would, and list every quantity or "one of several" claim in it.
  For each one, does your world model it? If not, rewrite the text to match the world, because a model
  will plan around the text.
- For each state change that opens up an action (a way through, a thing now within reach), does the
  actor's outcome name that action, or only the number that changed?
- If your world is a physical space: for every surface a description mentions, or a character could
  plausibly try -- the floor, the ceiling, each wall -- is there an object behind it with the properties
  an attempt would need? A surface that exists in prose and not in the world is the hole every
  model-driven character eventually finds, and the attempt will be filed as something else.
- When you find a case like this, add it here — generalised, in this file's neutral vocabulary — and
  add a pointer to it in your own project's `CLAUDE.md`. Root `CLAUDE.md`'s "cross-repo invariant
  nothing can check" section names where those pointers live today.

## Sample CLAUDE.md entries

Adapt the object/property names to your own game; keep the shape.

```markdown
## Grounding citations against the right object

Every `(effect, property)` pair our effects layer accepts must be citable from the exact object
whose property actually changes — never from a related object the intent happens to describe
touching. When one interaction conceptually spans two objects (a mechanism and the thing it
changes), resolve which one is the real target in our own code, from a mapping we already own —
never rely on one reader question's prompt to redirect a different question's answer. See
run-dmcp's `docs/AUTHORING-GUIDE.md` before adding a new effect or a new class of object.
```

```markdown
## Every declared property needs groundable prose

Before declaring that an object's property (`X`) can be affected by an effect, confirm the
object's own authored description contains words a citation could legitimately quote for it. An
evocative description that never mentions the thing an effect needs is a silent, permanent refusal
of that effect — it will not error, it will just never happen.
```

```markdown
## Descriptions say what the world models

Every object description states only the quantities the world actually models. If one part is the
whole obstacle, the text says one, not "one of several". When a state change opens an action (a way
through becomes passable), the actor's outcome names the action, from our own code's mapping. See
run-dmcp's `docs/AUTHORING-GUIDE.md`.
```

```markdown
## Surfaces are objects

Every enclosed location declares its floor, ceiling and walls as objects when a character could act
on them: described by material and condition, carrying the properties an attempt would need
(`integrity` for anything that can be dug or broken through), and a declared route where one could
open. A surface the prose mentions and the world does not model will be tried, and the attempt will
be filed as something else -- or, worse, captured by whatever is nearest and ruled to change it.

Declaring it rescues the attempts that NAME it. It does not redirect an attempt whose words name the
thing lying on top of it: the reader picks its target from the words of the intent, so an act aimed
through a thing is ruled on that thing, and the repair belongs there. Measured, not assumed. See
run-dmcp's `docs/AUTHORING-GUIDE.md`.
```

## Provenance

First entry (2026-09-15), from `the-prisoner`'s `docs/OPEN-VARIANT.md` §19 — see that document for
the full, game-specific account (in its own vocabulary, which stays there) and how it was verified
against a live model rather than assumed fixed by inspection alone.

Second entry (2026-09-15), from the same document's §26.1 and §27: a live game with the opposition
removed, run only to check that the way out could be reached at all, found it reached and never taken.

Third entry (2026-09-19), from `the-prisoner`'s `docs/WORLD-ELABORATION-DESIGN.md` §3.4.

Fourth entry (2026-09-19, night), from `the-prisoner`'s `docs/OPEN-VARIANT.md` §66.6 and §67.5 -- a
dig that no reading could name because the floor was prose and not an object -- and its owner's
suggestion the same night that a physical space should declare its surfaces as a matter of course.

Fourth entry, points 3 and 4 (2026-09-20), from the measurement that tested the entry above instead of
trusting it: three arms over a labelled set, five readings each, with the surface declared, with its
containment authored in words, and with neither. The lesson survived in half: declaring the surface
moved every act that named the surface and not one act that named the thing on top of it, and authoring
the containment moved nothing at all. Point 4's captures -- an act of crouching ruled to open a way out
-- came from the same set. The general finding underneath both, worth more than the surface convention
itself: **a reader choosing from a closed list of objects picks its target from the words of the intent,
and does not reliably answer "none".** Any authoring advice that assumes a description can redirect an
act is wrong for that reason, and this guide has now made that mistake once.
