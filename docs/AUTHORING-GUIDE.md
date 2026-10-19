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

### A property a mind works on over several acts should read differently as it moves

This extends the lesson above from what an object may *become* to how it *reads* on the way there.
Declaring the space says which values a property may take; it says nothing about what a mind is shown
while the value travels between them, and when the answer is "nothing but the number", every act on
the way reads the same.

The concrete incident: a world modelled one part whose integrity, worn low enough, made a way out
passable. A model-driven actor wore it down over five turns. Each act was ruled alike, each was answered
with the same outcome sentence and a flat delta ("integrity went from 85 to 70"), and the part's own
description never changed, because nothing in it depended on the value. The world already had the
device that would have fixed this: other objects in the same location carried authored reading bands
-- a line of description chosen by where a value stands -- and read differently as they moved. The
part that the whole game turned on had none. From the actor's side, five turns of real progress looked
like one turn repeated five times, and the only evidence that anything was happening was an integer.

Three lessons:

1. **Author reading bands for any property you expect a mind to move over several acts.** A band is
   a threshold and a line of description: at or below this value, the object also reads *this*. Each
   band is a claim about what the object is now, stated in the object's own words, so the actor sees
   the thing change rather than being told a number changed -- the second lesson in this guide ("say
   so in the words of that action") applied to the steps before the action opens, not only to the
   moment it does.
2. **Author the bands ascending, and silent above the first.** Order them from the lowest threshold up
   if your lookup takes the first band a value falls at or under; authored the other way, the first
   and widest band swallows every value beneath it and the others never read. Above the first band,
   say nothing: an intact object needs no line saying it is intact, and a band that reads "shows no
   damage" is exactly the absence this engine's hard rule 3 makes unconstructable in rendered state --
   say what is, never what is absent. The first acts landing silently is fine; they are arithmetic,
   not texture, and the band that finally reads is worth more for arriving later.
3. **The bands reach every principal that perceives the object, not only the actor.** A band is part
   of the object's description, and the description is what anyone who can see the object is shown.
   Adding bands to a property one character is working on therefore tells every other character who
   can see it how far the work has gone. That is a gameplay change and usually the right one --
   visible damage is visible -- but decide it on purpose: if the world means the work to go unseen,
   the answer is concealment the world models, not a property that silently refuses to read.

Bands are authoring, not mechanism. They need no engine support beyond what the caller already
renders from state, and a world whose values never move over several acts has no reason to declare
any.

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

   - The two that named the **floor** ("scrape down through the floor with the tool", "dig an escape
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

## Lesson: measure a reader on the population that will write to it

The concrete incident: a reader's questions had been validated at high agreement against several
hundred intents, generated by a model that had been shown the reader's own answer-key vocabulary as
part of building that same intent set. When the identical reader was later measured against a
different population -- entries typed by a person at a terminal, and terse paraphrases of the first
set written without that vocabulary in view -- its rate on the intents that stated a method with no
stated aim fell sharply, while its rate on intents that were merely reworded held steady. The gap
tracked exactly the shape the first population could not produce, because the model that wrote it had
already read the reader's own vocabulary and reached for it.

Two lessons:

1. **A number measured on the population that helped build the reader is an upper bound, not an
   estimate.** A model shown the reader's own answer keys -- even indirectly, as background for
   generating a test or training set -- writes toward them: it names an aim because the questions
   reward naming an aim. The population that will actually supply intents once the reader is in
   service writes differently, on purpose: a person writes toward the surrounding prose rather than
   the reader's schema; states the method they used rather than the aim it served ("press the worn
   edge against it," not "wear it down"); elides the object of a reflexive act that a sentence's own
   grammar already implies; and reaches for whatever the world's own description put in front of
   them. None of that is malformed input -- it is what every population outside the one that built
   the reader looks like, and a reader tuned only against the first will silently be worse against the
   second, in a shape you cannot see until you measure it.
2. **Score a disagreement by which layer would fix it, not by whether the reader was "right."** When
   a ruling and an intended reading differ, the cause can be the content an object's description
   offers (rewrite the text), the reading the reader's questions and clauses can express against
   today's text (fix the question), or the world's declared vocabulary (add a key or a property the
   reader had no way to reach for) -- or the honest case where both the ruled answer and the intended
   one are genuinely supported by the object's own words, which is a content ambiguity, not an error.
   Label every disagreement with which of those it is. A confusion matrix that only records
   right/wrong collapses all of them onto the reader, and the reader is only ever responsible for one.

## Lesson: an object's description must not carry another object's name for a thing the actor works on separately, least of all in the plural when one is modelled

This extends "a description that implies more than the world models will be planned around" (above)
from counts to nouns. The concrete incident: the same one-part-of-a-whole shape as that lesson -- one
part, worn down, makes a whole passable -- but this time the count was already correct everywhere the
world's *own* object said so; the leftover plural was sitting in a *different* object's description,
the whole's, which described the part it depended on using a plural noun even though the world
modelled exactly one. An intent named that plural. The reader's target question cites the words of
the intent against every object's own text, found the plural inside the WHOLE's description, and
resolved the whole as the target instead of the part -- and the whole's own passability is gated on
the part it never named, so the ruling refused for a reason the actor had no way to act on.

What makes this a distinct lesson, not a restatement: the part's own description was already correct
in the singular. Fixing "one part, worn down" everywhere the *part itself* is described is not enough
if another object's description still carries that part's name in a form -- a bare plural, an old
draft's phrasing, a synonym -- that a citation can still ground against. **An object's description
should name only itself and objects genuinely distinct from it. It should never carry a different
object's own name, or a plural of one, when your world models exactly one of that other object**,
because the reader's target question will cite whichever object's own words the intent's words match,
without regard to which object *you* meant to own that name.

Two consequences worth checking whenever you fix an instance of this, not only the one you found: (1)
the direction matters -- a part's description naming the whole it belongs to is often necessary and
fine (it may need to explain what it's set into); it's the *whole* carrying the *part's* name, in the
plural or otherwise, that steals the citation. (2) treat one instance as a reason to audit every
object's description in your catalogue for the same shape: a different object's id or name (plural or
singular) sitting in text it does not own, left over from an earlier draft or an author's shorthand.

## Lesson: what one principal perceives of another's act is the attempt; the outcome reaches them through the object

The concrete incident: a world with two principals in one location relayed each principal's act to the
other as one sentence. That sentence was composed from the ruling, *before* the resolution ran, and
the same string was reused three ways: as the sentence the other principal perceived, as the
resolution's own description in the ledger, and as a key in a precedent ledger that matched on exact
text. For most kinds of act the sentence described an attempt ("X works at the part"). For a few it
described an outcome ("X opens the way out"). On four turns the way out stayed shut -- the resolution
refused, or changed something short of opening it -- and the other principal was still told the way
out had been opened. Its mind did what a careful mind should do with a sentence the world handed it:
it wrote the false fact into its own notes, and spoke it. Nothing in the reader, the mechanism or the
model's reasoning was wrong. The world had told a bystander something that never happened, in its own
voice.

Two lessons:

1. **A sentence composed before the resolution can only honestly describe an attempt.** If it is
   built from the ruling, it is built before the world has decided anything, so it must say what the
   actor *tried* ("X works to open the way out", "X works to hide the thing"), never what came of it.
   That holds whether the resolution succeeds or refuses, so compose it so both produce the same
   string -- which also means a refused attempt a bystander could perceive is still relayed. The
   bystander saw the reach whether or not the world let it land.
2. **Let the outcome reach a bystander through the object's own described state.** The world already
   knows what the object is after the resolution, and its description already says so ("It stands
   open now"). A bystander who can see the object reads that on its next look, from state -- which is
   what "the server owns what is true" means, applied to what one principal is told about another.
   Never let a pre-resolution sentence double as an outcome record: the ledger's description of what
   happened, and any key that later decisions are matched against, should be either the same honest
   attempt sentence everywhere or composed after the resolution from its result. A single string
   that is sometimes an attempt and sometimes a claim is a false record waiting for the one turn the
   world says no.

A quick audit for any world that relays one principal's acts to another: for every kind of act, read
the relayed sentence aloud on the assumption that the resolution refused. Any sentence that becomes a
lie under that assumption is describing an outcome, and should be reworded as the attempt.

## Lesson: unlisted is not impossible

The concrete incident: a world whose referee ruled every act against the mechanics the world listed,
and sent every act none of them fit to refusal. A principal under watch dropped to the floor and
feigned a medical collapse, to draw the watcher closer. No mechanic listed feigning anything, so the
ruling came back that the act "reached past what is here" -- and it never happened. Not in the fiction,
not on the timeline, not in what the watcher perceived. The world had no way to say "that happened,
and it moves nothing we measure," so it said the act had not happened at all. A world that refuses
every act its mechanics do not list is a closed world, however open its prose reads, and the player
learns that within a few turns.

"Unlisted" is never "forbidden", and it is never "free". The question at the boundary is *how much*,
not *whether*. Four rulings cover it:

| ruling | when | what happens |
|---|---|---|
| **Listed** | a mechanic fits | resolve it, exactly |
| **Flavour** | the act touches nothing the world measures | it happens in the fiction and is remembered (narrated, and on the timeline); nothing is written |
| **Improvised** | no mechanic fits, but the act plausibly touches someone or something | a small, bounded ruling on a value the author declared `improvisable`, through the engine's `improvisedRulingMechanic`, recorded with its rationale and the act it cites |
| **Impossible** | the act cannot happen in the fiction at all (flying by flapping one's arms) | the *attempt* happens and is narrated failing |

Only the last refuses, and even it does not erase the act: the attempt is real and can be perceived
(see the lesson above on perceiving the attempt). Under these rules the feigned collapse happens; the
watcher perceives someone falling; and, if the author declared the watcher's attention as an
improvisable value, it moves by a small amount toward the one on the floor -- a ruling, not a
mechanic, and the next time the same kind of act happens it can be ruled the same way.

What this asks of the author:

1. **Declare the soft values on purpose.** `declareImprovisableConstraint` (or
   `declare_resource_constraint` with kind `improvisable`) on exactly the values an improvised ruling
   may land on -- one principal's regard for another, an observer's attention, a store's goodwill --
   with an ordered list of tiers, each with a `cap`. The caps are data the engine enforces, not prose
   asking a model to be modest: "+3" is a ruling, "+300" is refused.
2. **Leave the hard values undeclared.** A value without the declaration can never receive an
   improvised ruling, from any input, through any caller; it moves only through listed mechanics. That
   is the whole guarantee, and it is structural. If a value is conserved and you do declare it,
   rulings on it move by transfer between members, so conservation holds.
3. **Keep the largest tier below the worst listed act.** If no improvisation can move a value further
   than the most drastic listed mechanic does, no unlisted act outweighs the rules.
4. **Make the top tier need a second opinion.** Mark it `requiresConfirmation` and have a separate
   call -- not the one proposing the ruling -- confirm it, then pass that call's reference as the
   ruling's `confirmation`. The engine records the reference; it cannot tell whether the confirmation
   was independent, so that is yours to guarantee. A witness is never its own judge.
5. **Have the referee answer in keys.** Value id, tier key, signed amount, a rationale, the verbatim
   words of the act, and optionally a precedent key for "the same kind of act". Never prose for the
   engine to interpret -- it reads none of it, it only records it on the resolution's event.

A quick audit for any world with a referee: write down ten acts a player could type that none of your
mechanics list. For each, say which of the four rulings it gets. If any lands on "impossible" when it
could plainly happen in the fiction, the referee is closing your world, and the fix is a declared
improvisable value or a flavour ruling -- not another listed mechanic for that one act.

## Lesson: a goal is an aim, declared once, that the world's own changes can reach

The concrete incident: a consumer has a model author each world from a short problem text (a situation,
the things to hand, an aim) and checks the aim in code as a declared condition (`conditions_at`). Over
one tuning set, five of its worlds had to be authored again, each for a fault the author could have
avoided, and each was fixed by a one-off note to the author about that one world. The faults fell into
five shapes. Each one made the world measure its author rather than whoever played it:

1. **One thing declared twice.** A ledge out of reach was declared as an object within reach *and* as a
   location beyond it. Two entities for one thing means two sets of properties, two answers to "where is
   it", and two things a citation can land on, and a reader picks whichever one the actor's words happen
   to match. **Declare each thing once,** on one side of whatever line your world draws (within reach or
   beyond it, inside or outside, carried or fixed). Half of this is mechanical: no object and location
   share an id, and code can refuse that. The same thing under two ids is not mechanical, so read for it.
2. **A method stated as the aim.** "The fitting is attached to the wall" for a fitting that had only come
   loose; "the vehicle rests on the road" for getting a vehicle out of a ditch. Each names one way of
   getting there, so every other way, including the one the actor actually takes, fails the goal check
   even when the aim is met. **State the aim, the state of affairs asked for, never a method of reaching
   it.** A join or a location in a goal is a method unless the aim is exactly that. A goal that already
   holds when the world is loaded states no aim at all, and that one code can check.
3. **A goal nothing in the world can reach.** A goal required a heavy object to be somewhere, and nothing
   the actor had, and no mechanic the world listed, could move it there. **Every clause of a goal must be
   reachable by the world's own changes:** a listed mechanic, or a value declared `improvisable` that a
   bounded ruling may move. When the aim really is "the heavy thing gets free", state it as a value on that
   thing that says what it measures, not as where the thing is.
4. **The obstacle declared as a permanent number.** The problem's own obstacle, the reason the situation
   is hard, was declared as a fixed value with no way to change it. Every referee that read it ruled as if
   it were permanent, so nothing the actor tried could work on the one thing the problem is about. **An
   obstacle the actor can work on must be changeable** by something the world declares: a listed mechanic,
   or an `improvisable` declaration with tiers. If it cannot be, leave it out as a number and let the
   description carry it. This does not loosen "unlisted is not impossible" above: the values that decide a
   contest between principals stay undeclared, so an obstacle there must be one a listed mechanic moves.
5. **One aim split into several judged values, at their maximum.** One aim (a route that holds and reaches
   where it goes) was declared as three overlapping values, how complete, how stable and how far, two of
   them required at exactly their maximum. The referee credited the route as reaching and never called it
   complete, so the goal never held though the aim was met. **One aim, one judged value, a reachable
   threshold:** name the value for what it measures, and set the threshold where a few bounded rulings can
   land (`>= 8` on a 0 to 10 scale), never at the exact maximum that only a "perfect" ruling reaches.

The lesson behind the five matters as much as they do: **a correction sent to an author for one world
fixes one world.** Of the six lessons that tuning set taught, the only one that reached the next world was
the one that had become a validator rule and a line in the author's prompt; the five sent as notes did not.
Keep authoring lessons in one ledger that the author prompt is generated from. Give each lesson an
enforcement: a structural check where one is possible, a line on a human audit checklist where it is not.
Let a re-author request cite only ledger entries, so a new correction has to enter the ledger, and so every
later world, first. Keep the structural checks narrow: an id shared by an object and a location, a goal that
holds at load, a threshold at a value's exact maximum, several judged values on one entity. They read ids
and numbers, never prose. The shapes that need reading (a method dressed as an aim, an obstacle that ought
to move) go on the checklist, because a check that guesses at meaning is worse than none.

## Lesson: a condition is a value, and a lesson about prose needs a reader that is not the author

The concrete incident: the same consumer as the lesson above, a later problem set, a new author model, and a
ledger that already held every lesson above. A second model audited a sample of six of the new worlds against
the ledger's checklist. Five of the six broke one line and two broke another, and both lines were checklist
lines only: in the author's prompt, never checked by anything but a person reading a sample. The faults, and
the ones found when every world was then audited:

1. **A condition left in words.** "A deflated ball", "a paddle with a loose handle", "the gloves are soaked",
   "the torch is dim", a location's description saying what has gone wrong. A name or a description never
   changes, so after the actor inflates the ball every later reading still says "deflated", and a rendering
   of the location from its description says it too. Worse, in one world the ring's defects were values the
   world could change while the paddle's and the board's were only words, so one repair path was tracked and
   the others were not. **Every condition the problem gives a thing that an act could change is a value on
   that thing, declared `improvisable`, on every thing that has one; names and descriptions say what a thing
   is, never what state it is in.** A thing's purpose ("for a dog") and a fact no act could undo (a broken
   bottle's sharp edges) are not conditions and may stay in words.
2. **One thing, two entries, in new shapes.** A spill declared as an object *and* as the floor's residue; a
   tree standing at the location *and* its upper part as a place beyond reach. **A spill, stain or mess is a
   property of the surface it is on; a thing with a part out of reach is that place alone.**
3. **An aim to remove something set at its exact minimum.** `== 0` from above is reachable only by a ruling
   that the thing is wholly gone. **Give a removal a threshold a few rulings can reach** (`<= 2` on a 0 to 10
   scale). A harm that starts at none and must stay there may be `== 0`: that keeps it, it does not clear it.
4. **A thing that could reach, span or hang with no length.** A reach mechanic reads a length; an object
   without one reaches nothing, and the actor's sensible plan is refused. **Every object that could reach,
   span, prop or hang something declares a length.**
5. **Distance for what walking closes.** A vehicle "in the ditch, beyond reach" when the ditch is ground the
   actor can step into. **Declare a place beyond reach only for what walking cannot close.**
6. **A field the author fills with no stated meaning.** The prompt said what a property's maximum is and never
   what its minimum is; one author used 0 every time, the next set the minimum equal to the value, and the
   validator refused almost every world. **Say what every field means, in the prompt**, even the one every
   earlier author guessed right.

What made those faults survive was not the author. **A lesson about prose that only a person checks on a
sample is a lesson in name only.** The validator reads ids and structure, rightly, so the prose lessons need
a reader of their own: a model that judges every world against every checklist line, in closed keys (`pass`
or `fail` per line), each fail quoting the world verbatim, which code checks. Three things learned building
it:

- **One audit call is noisy.** Verdicts on a few worlds in two dozen flipped between identical runs. Take
  three independent audits and fail a line only when two of them fail it, so one noisy call neither passes a
  world nor blocks one. Tie each audit to the exact world, ledger and auditor instructions it judged; any
  change makes it stale, and play refuses a world without a current pass.
- **An audit reads the checklist literally, so the checklist wording is now load-bearing.** A line that
  listed "intended" as an example of a forbidden condition failed "a leash intended for a dog"; a line that
  said an obstacle must never be a fixed number failed every fixed distance, the very thing reaching is built
  to close. Each was a wording fault in the lesson, not in the worlds. When an audit fails a world, read the
  quote before re-authoring: if the world is right, fix the line.
- **Lessons can contradict each other.** One lesson said a condition belongs in a value "or the location's
  description"; a later one said descriptions never carry conditions. The author was told both. Read the
  ledger whole when you add to it.

## Checklist before you ship a `createTurnReader` question set

- For every `(effect, property)` combination your effects layer accepts, can you point to the exact
  object and exact words in its description that would grade a citation for it? If the answer is "it
  depends which object the model names," that dependency needs to be resolved by your own code, not
  left to the model to get consistently right across two independent answers.
- Let the model cite by word range (`{sourceId, from, to}`), numbering each source's words for its
  prompt with `sourceWords()` -- the same function the engine rebuilds the quote from -- rather than
  asking it to retype a span. A retyped quote comes back lowercased, elided or re-punctuated and is
  thrown away; a range cannot misquote, and an end that overshoots a short source is clamped rather
  than dropped.
- Before concluding that a model "said nothing" for a question, read the result's `rungs` and that
  answer's `askedOfRungs` and `rejected`: a rung that threw, a rung that offered nothing for the
  question, and an offer discarded on a named conjunct of the citation rule are three different
  problems with three different fixes, and they all fall to the same safe default.
- If two questions must stay consistent with each other, put the constraint in every prompt that
  needs it, and prefer enforcing it in code over the prompt doing the whole job — a prompt sentence is
  a plea; a value your code looks up is a fact.
- Declare, as data, which span of each object's description grounds each property your effects can
  reach, and run `checkGroundings()` over it before play (and in CI): a reachable target with
  `grounded: 0` can never be cited, a span with `occurrences` above 1 picks out no one place, and a
  span whose target is `reachable: false` is prose describing something nothing can act on. It
  checks your declarations with the reader's own citation rule; it never reads the prose for you.
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
- When you validate a `createTurnReader` question set, measure it against a sample drawn from (or
  shaped like) the population that will actually supply intents in production -- not only against
  intents a model generated with the reader's own vocabulary in view. Label every disagreement with
  which layer would fix it -- content, reading, or world (correct / misread / unmodelled / ambiguous)
  -- rather than scoring it only as right or wrong; a plain confusion matrix sends every failure to
  the reader, which owns only one of the four.
- Read each object's description and list every noun in it. For each one: is it the id of another
  object your world declares, or a plural of one? If your world models exactly one of that other
  object, a plural or bare use of its name will out-cite the singular reference you meant to be
  found, and the fix belongs in the text, not the reader.
- If one principal is told of another's act: for every kind of act, is the sentence still true when
  the resolution refuses? If not, it states an outcome; reword it as the attempt, and let the
  object's own described state carry what actually happened.
- For each property a mind is expected to move over several acts, does its object read differently
  at some point along the way, from authored bands ascending and silent above the first? If every act
  on the way reads the same, the actor is working from a number alone.
- If your world has a declared goal: is each thing declared once? Does the goal state the aim and not a
  method, and does it not already hold at load? Can a listed mechanic or an `improvisable` value reach
  every clause? Is the obstacle the actor works on changeable? Is each aim one judged value, with a
  threshold below its maximum? And does a correction to an authored world become a lesson the next world
  is authored under, not a note about this one?
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

```markdown
## Measuring a reader against the right population

A reader's measured accuracy is only as good as the population it was measured against. A number
measured on intents a model wrote with the reader's own answer-key vocabulary in view is an upper
bound, not an estimate of production accuracy -- validate against, or alongside, a sample shaped like
whoever will actually supply intents (methods stated instead of aims, elided reflexive objects,
prose the world's own descriptions put in front of them). Label every disagreement by which layer
would fix it -- content, reading, or world -- rather than scoring only right/wrong. See run-dmcp's
`docs/AUTHORING-GUIDE.md`.
```

```markdown
## An object's description never carries another object's name

Read every object's description and list its nouns. None should be the id of a different object, or
a plural of one, when our world models exactly one of that other object -- a reader's target question
cites whichever object's own words match the intent, and a stray name (plural or otherwise) left in
the wrong object's description will win the citation and send the ruling to the wrong place. See
run-dmcp's `docs/AUTHORING-GUIDE.md`.
```

```markdown
## Perception is the attempt; the object carries the outcome

What one principal is told of another's act describes the attempt ("X works to open the way out"),
never an outcome that may not have happened -- the sentence is composed before the resolution, and a
refused resolution produces the same one. The outcome reaches a bystander through the object's own
described state ("It stands open now"). No pre-resolution sentence doubles as an outcome record in
a ledger or as a key later decisions match against. See run-dmcp's `docs/AUTHORING-GUIDE.md`.
```

```markdown
## A property worked over several acts reads differently as it moves

Any property a mind is meant to move over several acts carries authored reading bands: a threshold
and a line of the object's own description. Bands are authored ascending, and say nothing above the
first (say what is, never what is absent). They reach every principal who perceives the object, which
is a gameplay change we make on purpose. See run-dmcp's `docs/AUTHORING-GUIDE.md`.
```

```markdown
## Unlisted is not impossible

An act none of our mechanics list still happens. It touches nothing and is remembered, or it
receives a bounded improvised ruling (run-dmcp's `improvisedRulingMechanic`) on a value we declared
`improvisable` on purpose, with per-tier caps as data and the top tier needing a confirmation from a
separate call. Only an act that cannot happen in the fiction is refused, and even then the attempt is
narrated. The values that decide the game are never declared improvisable. See run-dmcp's
`docs/AUTHORING-GUIDE.md`.
```

```markdown
## A goal is an aim, declared once, that the world can reach

Each thing in our worlds is declared once, on one side of the reach line. A goal states the aim, never a
method of reaching it, and never already holds at load. A listed mechanic or an `improvisable` value can
reach every clause. The obstacle the actor works on is changeable, or lives only in the description. One aim
is one judged value, with a threshold below its maximum. A correction to an authored world becomes a lesson
in our ledger (prompt text plus a structural check or an audit line) before it goes to the author, never a
one-off note about that world. See run-dmcp's `docs/AUTHORING-GUIDE.md`.
```

```markdown
## Conditions are values, and an automated reader checks the prose lessons

A condition an act could change (deflated, loose, soaked, dim) is an `improvisable` value on the thing,
on every thing that has one; names and descriptions say what a thing is, never its state. A spill is a
property of its surface; a thing with a part out of reach is that place alone. A removal's threshold sits
above its minimum. Anything that can reach, span or hang declares a length. Every world is audited against
every checklist line by a model, three times, a line failing only on a majority, each fail quoting the world
verbatim; play refuses a world without a current pass. When an audit fails a good world, fix the line. See
run-dmcp's `docs/AUTHORING-GUIDE.md`.
```

## Provenance

Sources are named by role, not by name, the way `docs/ARCHITECTURE.md` names consumers: "the
two-principal consumer" is the game with two principals in one location contending over the same
physical state, and the folder above this repository names it.

First entry (2026-09-15), from the two-principal consumer's `docs/OPEN-VARIANT.md` §19 — see that
document for the full, game-specific account (in its own vocabulary, which stays there) and how it
was verified against a live model rather than assumed fixed by inspection alone.

Second entry (2026-09-15), from the same document's §26.1 and §27: a live game with the opposition
removed, run only to check that the way out could be reached at all, found it reached and never taken.

Third entry (2026-09-19), from the two-principal consumer's `docs/WORLD-ELABORATION-DESIGN.md` §3.4.

Fourth entry (2026-09-19, night), from the two-principal consumer's `docs/OPEN-VARIANT.md` §66.6
and §67.5 -- a dig that no reading could name because the floor was prose and not an object -- and its
owner's suggestion the same night that a physical space should declare its surfaces as a matter of
course.

Fourth entry, points 3 and 4 (2026-09-20), from the measurement that tested the entry above instead of
trusting it: three arms over a labelled set, five readings each, with the surface declared, with its
containment authored in words, and with neither. The lesson survived in half: declaring the surface
moved every act that named the surface and not one act that named the thing on top of it, and authoring
the containment moved nothing at all. Point 4's captures -- an act of crouching ruled to open a way out
-- came from the same set. The general finding underneath both, worth more than the surface convention
itself: **a reader choosing from a closed list of objects picks its target from the words of the intent,
and does not reliably answer "none".** Any authoring advice that assumes a description can redirect an
act is wrong for that reason, and this guide has now made that mistake once.

Fifth entry (2026-09-26), from the two-principal consumer's `docs/HUMAN-INTENTS-DESIGN.md` §1, §4, §7
and §8: a serial human-typed game whose reader had been measured only at agreement figures gathered
against a population that had read its own answer keys, and a whole whose description had already
dropped a stray count (per the second entry above) but kept a part's name in the plural, which a human
intent then reached for exactly as predicted.

Sixth entry and the reading-bands subsection of the third (2026-09-27), from the two-principal
consumer's `docs/PLAYTEST-2026-09-27-DESIGN.md` R1 and R7: a human-played game in which the other
principal was told on four turns that a way out had been opened when it had stayed shut, wrote that
into its notes and spoke it; and in which five turns of real work on the one part that mattered each
read exactly the same, while other objects in the same location already read differently as they
moved.

Seventh entry (2026-10-16), from the two-principal consumer's issue #16 -- a feigned collapse ruled
out of existence because nothing listed it -- and from the turn-by-turn signatory's open-world rulings
design (§4, §5 and §7 there), which named the four rulings, placed the improvised one in this engine as
a mechanic over values a game declares `improvisable`, and took the lesson's first line from it.

Eighth entry (2026-10-17), from a consumer that has a model author each world from a short problem text and
checks the world's declared goal in code: five worlds re-authored by one-off notes over its tuning set, and
its owner's observation that only the one lesson made into a rule had reached the next world.

Ninth entry (2026-10-18), from the same consumer: a new problem set and author model, a second model's audit
of a six-world sample that found two checklist lessons broken in five worlds and two, every world then audited
by a model chair, and the chair's own lessons -- its noise across identical runs, and checklist lines whose
wording failed good worlds.

