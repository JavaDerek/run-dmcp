import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as resourceTools from "../tools/resource.js";
import * as constraintTools from "../tools/constraint.js";
import { LIMITS } from "../utils/validation.js";
import { ANNOTATIONS } from "../utils/tool-annotations.js";
import { errors, formatErrorResponse } from "../utils/errors.js";

export function registerResourceTools(server: McpServer) {
  server.registerTool(
    "create_resource",
    {
      description: "Create a new resource (currency, reputation, counter, etc.)",
      inputSchema: {
        gameId: z.string().max(100).describe("The game ID"),
        ownerType: z.enum(["game", "character", "faction", "location"]).describe("Owner type: 'game' for party/global resources, 'character' for personal resources, 'faction' or 'location' for resources owned by one of those entities"),
        ownerId: z.string().max(100).optional().describe("Character ID if ownerType is 'character' (omit for game-level resources)"),
        name: z.string().min(1).max(LIMITS.NAME_MAX).describe("Resource name (e.g., 'Gold', 'Sanity', 'Thieves Guild Reputation')"),
        description: z.string().max(LIMITS.DESCRIPTION_MAX).optional().describe("Resource description"),
        category: z.string().max(100).optional().describe("Category for grouping (e.g., 'currency', 'reputation', 'pool', 'counter')"),
        value: z.number().optional().describe("Initial value (default: 0)"),
        minValue: z.number().optional().describe("Minimum bound (null for unbounded)"),
        maxValue: z.number().optional().describe("Maximum bound (null for unbounded)"),
      },
      annotations: ANNOTATIONS.CREATE,
    },
    async (params) => {
      const resource = resourceTools.createResource(params);
      return {
        content: [{ type: "text", text: JSON.stringify(resource, null, 2) }],
      };
    }
  );

  server.registerTool(
    "get_resource",
    {
      description: "Get resource details",
      inputSchema: {
        resourceId: z.string().max(100).describe("The resource ID"),
      },
      annotations: ANNOTATIONS.READ_ONLY,
    },
    async ({ resourceId }) => {
      const resource = resourceTools.getResource(resourceId);
      if (!resource) {
        return {
          content: [{ type: "text", text: "Resource not found" }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(resource, null, 2) }],
      };
    }
  );

  server.registerTool(
    "update_resource",
    {
      description: "Update resource metadata (name, description, category, bounds)",
      inputSchema: {
        resourceId: z.string().max(100).describe("The resource ID"),
        name: z.string().max(LIMITS.NAME_MAX).optional().describe("New name"),
        description: z.string().max(LIMITS.DESCRIPTION_MAX).optional().describe("New description"),
        category: z.string().max(100).nullable().optional().describe("New category (null to clear)"),
        minValue: z.number().nullable().optional().describe("New minimum bound (null for unbounded)"),
        maxValue: z.number().nullable().optional().describe("New maximum bound (null for unbounded)"),
      },
      annotations: ANNOTATIONS.UPDATE,
    },
    async ({ resourceId, ...updates }) => {
      try {
        const resource = resourceTools.updateResource(resourceId, updates);
        if (!resource) {
          return {
            content: [{ type: "text", text: "Resource not found" }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: JSON.stringify(resource, null, 2) }],
        };
      } catch (error) {
        if (error instanceof constraintTools.ConstraintViolationError) {
          return formatErrorResponse(errors.constraintViolation(error.resourceId, error.message));
        }
        return {
          content: [{ type: "text", text: (error as Error).message }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "delete_resource",
    {
      description: "Delete a resource and its history",
      inputSchema: {
        resourceId: z.string().max(100).describe("The resource ID"),
      },
      annotations: ANNOTATIONS.DESTRUCTIVE,
    },
    async ({ resourceId }) => {
      try {
        const success = resourceTools.deleteResource(resourceId);
        return {
          content: [{ type: "text", text: success ? "Resource deleted" : "Resource not found" }],
          isError: !success,
        };
      } catch (error) {
        if (error instanceof constraintTools.ConstraintViolationError) {
          return formatErrorResponse(errors.constraintViolation(error.resourceId, error.message));
        }
        return {
          content: [{ type: "text", text: (error as Error).message }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "list_resources",
    {
      description: "List resources in a game",
      inputSchema: {
        gameId: z.string().max(100).describe("The game ID"),
        ownerType: z.enum(["game", "character", "faction", "location"]).optional().describe("Filter by owner type"),
        ownerId: z.string().max(100).optional().describe("Filter by owner ID (for character resources)"),
        category: z.string().max(100).optional().describe("Filter by category"),
      },
      annotations: ANNOTATIONS.READ_ONLY,
    },
    async ({ gameId, ownerType, ownerId, category }) => {
      const resources = resourceTools.listResources(gameId, { ownerType, ownerId, category });
      return {
        content: [{ type: "text", text: JSON.stringify(resources, null, 2) }],
      };
    }
  );

  // ============================================================================
  // UPDATE RESOURCE VALUE - CONSOLIDATED (replaces modify_resource + set_resource)
  // ============================================================================
  server.registerTool(
    "update_resource_value",
    {
      description: "Update a resource's value. Use mode 'delta' to add/subtract, or 'set' to set an absolute value. Changes are logged to history.",
      inputSchema: {
        resourceId: z.string().max(100).describe("The resource ID"),
        mode: z.enum(["delta", "set"]).describe("'delta' to add/subtract, 'set' to set absolute value"),
        value: z.number().describe("Amount to add/subtract (for delta) or absolute value (for set)"),
        reason: z.string().max(LIMITS.DESCRIPTION_MAX).optional().describe("Reason for the change (logged to history)"),
      },
      annotations: ANNOTATIONS.UPDATE,
    },
    async ({ resourceId, mode, value, reason }) => {
      try {
        const result = resourceTools.updateResourceValue({ resourceId, mode, value, reason });
        if (!result) {
          return {
            content: [{ type: "text", text: "Resource not found" }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        if (error instanceof constraintTools.ConstraintViolationError) {
          return formatErrorResponse(errors.constraintViolation(error.resourceId, error.message));
        }
        return {
          content: [{ type: "text", text: (error as Error).message }],
          isError: true,
        };
      }
    }
  );

  // ============================================================================
  // TRANSFER RESOURCE VALUE - the only write path for a 'conserved' member
  // ============================================================================
  server.registerTool(
    "transfer_resource_value",
    {
      description:
        "Move an amount from one resource to another, atomically, keeping their combined total unchanged. " +
        "This is the ONLY way to change the value of a resource that belongs to a declared 'conserved' constraint -- " +
        "update_resource_value rejects direct writes to such resources because a single-resource write can't say " +
        "where the offsetting change should come from. fromResourceId and toResourceId must both already be members " +
        "of the SAME declared 'conserved' constraint (see declare_resource_constraint). amount must be >= 0; swap " +
        "fromResourceId/toResourceId to reverse direction. Never clamps -- if either side would cross its own " +
        "minValue/maxValue, the whole transfer is rejected rather than applying an uneven amount to each side.",
      inputSchema: {
        fromResourceId: z.string().max(100).describe("Resource to subtract the amount from"),
        toResourceId: z.string().max(100).describe("Resource to add the amount to"),
        amount: z.number().min(0).describe("Amount to move (must be >= 0)"),
        reason: z.string().max(LIMITS.DESCRIPTION_MAX).optional().describe("Reason for the transfer (logged to history on both sides)"),
      },
      annotations: ANNOTATIONS.UPDATE,
    },
    async ({ fromResourceId, toResourceId, amount, reason }) => {
      try {
        const result = resourceTools.transferResourceValue({ fromResourceId, toResourceId, amount, reason });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        if (error instanceof constraintTools.ConstraintViolationError) {
          return formatErrorResponse(errors.constraintViolation(error.resourceId, error.message));
        }
        return {
          content: [{ type: "text", text: (error as Error).message }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "get_resource_history",
    {
      description: "Get change history for a resource",
      inputSchema: {
        resourceId: z.string().max(100).describe("The resource ID"),
        limit: z.number().optional().describe("Maximum number of entries to return"),
      },
      annotations: ANNOTATIONS.READ_ONLY,
    },
    async ({ resourceId, limit }) => {
      const history = resourceTools.getResourceHistory(resourceId, limit);
      return {
        content: [{ type: "text", text: JSON.stringify(history, null, 2) }],
      };
    }
  );

  // ============================================================================
  // RESOURCE CONSTRAINTS - optional, server-enforced invariants (opt-in; a
  // resource with no declared constraint is unaffected -- see src/tools/constraint.ts)
  // ============================================================================
  server.registerTool(
    "declare_resource_constraint",
    {
      description:
        "Declare a server-enforced invariant on one or more resources, so update_resource_value cannot write a value that violates it. " +
        "'bounded': the resource must already have minValue and/or maxValue set (via create_resource/update_resource) -- once declared, writes outside those bounds are REJECTED instead of the default silent clamp. " +
        "'monotonic': the resource's value may only move in one direction ('increasing' = never decreases, 'decreasing' = never increases); holding steady is always allowed. " +
        "'conserved': declares a set of 2+ resources that must always sum to a fixed total -- the members' current values must already sum to `total` (this does not rewrite them to match). Once declared, update_resource_value REJECTS direct writes to any member (ambiguous -- it can't know where the offsetting change comes from); use transfer_resource_value to move value between two members of the set atomically instead. A resource can belong to at most one 'conserved' set at a time. " +
        "'resolve_only': every DIRECT write to the given fact key is refused -- both update_resource_value and transfer_resource_value -- so it can move only through an adjudicating call. Scoped to one fact key (factKey, default 'value'); a resource can hold a separate 'resolve_only' declaration per fact key.",
      inputSchema: {
        gameId: z.string().max(100).describe("The game ID"),
        kind: z.enum(["bounded", "monotonic", "conserved", "resolve_only"]).describe("Constraint kind"),
        resourceId: z.string().max(100).optional().describe("Required for 'bounded', 'monotonic' or 'resolve_only': the resource to constrain"),
        resourceIds: z.array(z.string().max(100)).optional().describe("Required for 'conserved': 2 or more resource IDs that must sum to `total`"),
        direction: z.enum(["increasing", "decreasing"]).optional().describe("Required for 'monotonic': the only direction the value may move"),
        total: z.number().optional().describe("Required for 'conserved': the fixed sum the resource set must maintain"),
        factKey: z.string().max(100).optional().describe("For 'resolve_only' only: the fact key the constraint governs, defaulting to 'value'"),
      },
      annotations: ANNOTATIONS.CREATE,
    },
    async ({ gameId, kind, resourceId, resourceIds, direction, total, factKey }) => {
      try {
        let constraint;
        if (kind === "bounded") {
          if (!resourceId) throw new Error("resourceId is required for a 'bounded' constraint");
          constraint = constraintTools.declareBoundedConstraint({ gameId, resourceId });
        } else if (kind === "monotonic") {
          if (!resourceId || !direction) {
            throw new Error("resourceId and direction are required for a 'monotonic' constraint");
          }
          constraint = constraintTools.declareMonotonicConstraint({ gameId, resourceId, direction });
        } else if (kind === "resolve_only") {
          if (!resourceId) throw new Error("resourceId is required for a 'resolve_only' constraint");
          constraint = constraintTools.declareResolveOnlyConstraint({ gameId, resourceId, factKey });
        } else {
          if (!resourceIds || total === undefined) {
            throw new Error("resourceIds and total are required for a 'conserved' constraint");
          }
          constraint = constraintTools.declareConservedConstraint({ gameId, resourceIds, total });
        }
        return {
          content: [{ type: "text", text: JSON.stringify(constraint, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: (error as Error).message }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "list_resource_constraints",
    {
      description: "List declared resource constraints for a game, optionally filtered to those governing one resource.",
      inputSchema: {
        gameId: z.string().max(100).describe("The game ID"),
        resourceId: z.string().max(100).optional().describe("Filter to constraints governing this resource"),
      },
      annotations: ANNOTATIONS.READ_ONLY,
    },
    async ({ gameId, resourceId }) => {
      const constraints = constraintTools.listConstraints(gameId, resourceId);
      return {
        content: [{ type: "text", text: JSON.stringify(constraints, null, 2) }],
      };
    }
  );

  server.registerTool(
    "remove_resource_constraint",
    {
      description: "Remove a declared resource constraint by id. The resource(s) it governed revert to unconstrained (default clamp) behavior.",
      inputSchema: {
        constraintId: z.string().max(100).describe("The constraint ID"),
      },
      annotations: ANNOTATIONS.DESTRUCTIVE,
    },
    async ({ constraintId }) => {
      const success = constraintTools.removeConstraint(constraintId);
      return {
        content: [{ type: "text", text: success ? "Constraint removed" : "Constraint not found" }],
        isError: !success,
      };
    }
  );
}
