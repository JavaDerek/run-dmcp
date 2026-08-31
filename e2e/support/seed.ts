// Populates a fresh database with one of everything, through the project's
// own tool functions -- never a hand-written INSERT. That constraint is not
// stylistic: an acceptance suite that seeded its fixtures by writing rows
// directly would be testing a database shape, not the tool surface real
// callers (and the game-master consumers of this engine) actually use, and a
// change to a create* function's own invariants could silently stop being
// exercised by the very suite meant to catch it.
//
// Imports come from `../../dist/`, never `../../src/` -- the acceptance
// suite exists to accept the BUILT artifact (see globalSetup.ts and
// handshake.ts's own doc comments), and importing source here would let this
// file typecheck against code the suite never actually runs.
//
// Preconditions, owned by the caller (serverProcess.ts): DMCP_DB_PATH is
// already pointed at a fresh temp database, and initializeSchema() has
// already run against it. This function only seeds; it does not open or
// migrate anything.
import { createGame } from "../../dist/tools/game.js";
import { declareTimeAxis } from "../../dist/timeline/clock.js";
import { createLocation, connectLocations } from "../../dist/tools/world.js";
import { createCharacter } from "../../dist/tools/character.js";
import { createFaction } from "../../dist/tools/faction.js";
import { createQuest } from "../../dist/rpg/tools/quest.js";
import { createItem } from "../../dist/tools/inventory.js";
import { createNote } from "../../dist/tools/notes.js";
import { createTimer } from "../../dist/tools/timers.js";
import { createSecret } from "../../dist/tools/secrets.js";
import { createAbility } from "../../dist/rpg/tools/ability.js";
import { logEvent } from "../../dist/tools/narrative.js";
import { createResource } from "../../dist/tools/resource.js";
import { declareBoundedConstraint, declareConservedConstraint } from "../../dist/tools/constraint.js";
import { setCalendar, scheduleEvent } from "../../dist/tools/time.js";
import type { Seeded } from "./handshake.js";

export function seedWorld(): Seeded {
  const game = createGame({
    name: "The Millhouse Ledger",
    setting: "a farm town keeping its books straight",
    style: "pastoral",
  });
  const gameId = game.id;

  // A timeline clock is required before any constrained write (bounded,
  // conserved) can land -- writeConstrainedValue (src/timeline/constrained.ts)
  // needs a game's current `t` to attach a transition to, and a no-op write
  // has nowhere else to get one from. `createGame`'s own INSERT already
  // bootstrapped a clock row on the default `sequence` axis (games is itself
  // a projected table, src/timeline/projection.ts), so this call is a real
  // axis declaration, not a bootstrap -- `startAt` is left unset and floors
  // at the sequence clock's current position, per declareTimeAxis's own
  // documented limit (src/timeline/clock.ts).
  declareTimeAxis({ gameId, axis: { kind: "counter", unit: "tick" } });

  // A concrete starting time gives scheduleEvent's trigger a real "future" to
  // sit in, and lets the seeded game show up with a populated gameTime on the
  // read surface rather than null.
  setCalendar(gameId, {}, { year: 1, month: 0, day: 0, hour: 8, minute: 0 });

  const mill = createLocation({
    gameId,
    name: "the mill",
    description: "A working gristmill, wheel turning on the millrace.",
  });
  const granary = createLocation({
    gameId,
    name: "the granary",
    description: "A dry stone granary behind the mill, sacks stacked to the rafters.",
  });
  connectLocations({
    fromLocationId: mill.id,
    toLocationId: granary.id,
    fromDirection: "east",
    toDirection: "west",
    description: "a short covered walkway",
  });

  const player = createCharacter({
    gameId,
    name: "the miller's apprentice",
    isPlayer: true,
    locationId: mill.id,
  });
  const miller = createCharacter({
    gameId,
    name: "the miller",
    isPlayer: false,
    locationId: mill.id,
  });

  const faction = createFaction({
    gameId,
    name: "the millers' guild",
    description: "Sets the toll every mill in the valley charges to grind.",
  });

  const quest = createQuest({
    gameId,
    name: "settle the granary count",
    description: "Reconcile what the granary holds against what the ledger claims.",
    objectives: [{ description: "count every sack in the granary", completed: false }],
  });

  const item = createItem({
    gameId,
    ownerId: player.id,
    ownerType: "character",
    name: "a dog-eared ledger",
  });

  const note = createNote({
    gameId,
    title: "toll schedule",
    content: "One sack in twenty, paid at the wheel, no exceptions.",
  });

  const timer = createTimer({
    gameId,
    name: "millrace freeze watch",
    timerType: "countdown",
    currentValue: 10,
    triggerAt: 0,
  });

  const secret = createSecret({
    gameId,
    name: "the short count",
    description: "The granary has been quietly under-reporting its own stock for a season.",
    relatedEntityId: granary.id,
    relatedEntityType: "location",
  });

  const ability = createAbility({
    gameId,
    ownerType: "character",
    ownerId: player.id,
    name: "true measure",
    description: "Weigh a sack and know its count to the grain.",
  });

  const narrativeEvent = logEvent({
    gameId,
    eventType: "scene",
    content: "The apprentice opens the ledger to a fresh page and starts the count.",
  });

  // A plain, unconstrained resource -- the control case a bounded/conserved
  // write is contrasted against.
  const grain = createResource({
    gameId,
    ownerType: "game",
    name: "grain",
    value: 500,
  });

  // Bounded: minValue/maxValue set at creation, then a declared `bounded`
  // constraint so an out-of-range write is REJECTED rather than clamped
  // (src/tools/constraint.ts's declareBoundedConstraint requires at least
  // one bound to already be set).
  const populationBounds = { minValue: 0, maxValue: 200 };
  const population = createResource({
    gameId,
    ownerType: "game",
    name: "population",
    value: 80,
    minValue: populationBounds.minValue,
    maxValue: populationBounds.maxValue,
  });
  declareBoundedConstraint({ gameId, resourceId: population.id });

  // Conserved: two resources whose values already sum to `total`, then a
  // declared `conserved` constraint over both -- from that point on, the
  // only legal way to move value between them is transfer_resource_value.
  const conservedTotal = 1000;
  const northTreasury = createResource({
    gameId,
    ownerType: "game",
    name: "north treasury",
    category: "treasury",
    value: 600,
  });
  const southTreasury = createResource({
    gameId,
    ownerType: "game",
    name: "south treasury",
    category: "treasury",
    value: 400,
  });
  const conservedConstraint = declareConservedConstraint({
    gameId,
    resourceIds: [northTreasury.id, southTreasury.id],
    total: conservedTotal,
  });

  // A scheduled event carrying an on-expiry consequence, pointed at the
  // PLAIN resource (grain) rather than a constrained one -- advanceTime()
  // applies a consequence through updateResourceValue (src/tools/time.ts),
  // which is exactly the single-resource write a bounded/conserved
  // constraint would reject; aiming this at grain keeps the fixture honest
  // about what an on-expiry consequence can actually target today. The
  // trigger time (day 10) sits after the calendar's seeded current time (day
  // 0), so nothing has fired it by the time seeding finishes -- nothing in
  // this function ever calls advanceTime.
  const scheduledEvent = scheduleEvent({
    gameId,
    name: "the harvest toll comes due",
    description: "The guild collects its share of the season's grind.",
    triggerTime: { year: 1, month: 0, day: 10, hour: 8, minute: 0 },
    consequence: { resourceId: grain.id, delta: -25 },
  });

  return {
    gameId,
    gameName: game.name,
    playerCharacterId: player.id,
    millerCharacterId: miller.id,
    millLocationId: mill.id,
    granaryLocationId: granary.id,
    factionId: faction.id,
    questId: quest.id,
    itemId: item.id,
    noteId: note.id,
    timerId: timer.id,
    secretId: secret.id,
    abilityId: ability.id,
    grainResourceId: grain.id,
    populationResourceId: population.id,
    populationBounds,
    conserved: {
      constraintId: conservedConstraint.id,
      total: conservedTotal,
      northTreasuryId: northTreasury.id,
      southTreasuryId: southTreasury.id,
    },
    scheduledEventId: scheduledEvent.id,
    narrativeEventId: narrativeEvent.id,
  };
}
