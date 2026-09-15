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

## Provenance

First entry (2026-09-15), from `the-prisoner`'s `docs/OPEN-VARIANT.md` §19 — see that document for
the full, game-specific account (in its own vocabulary, which stays there) and how it was verified
against a live model rather than assumed fixed by inspection alone.

Second entry (2026-09-15), from the same document's §26.1 and §27: a live game with the opposition
removed, run only to check that the way out could be reached at all, found it reached and never taken.
