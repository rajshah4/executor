// Cross-target: policies are user-curated, not write-once — a misaimed rule
// can be re-targeted, partially edited, and removed. The existing policies
// scenario pins create+list; this one closes the lifecycle with the full
// update (pattern + action), the action-only partial update the UI's dropdown
// menu actually sends, and the remove path — all through the typed
// HttpApiClient. The guarantee in plain terms: an admin who fat-fingers a
// pattern, flips an action from the row menu, or revokes a rule recovers
// through the same API the UI calls into, without dropping into the database.
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { PolicyId } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Target } from "../src/services";

const coreApi = composePluginApi([] as const);

scenario(
  "Policies · an existing policy can be re-targeted, partially edited, and removed",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const { client } = yield* Api;
    const identity = yield* target.newIdentity();
    const api = yield* client(coreApi, identity);

    // Selfhost shares one bootstrap-admin identity across scenarios, so the
    // pattern must be unique enough that another scenario's policies can't
    // pollute this one's lookups.
    const suffix = randomBytes(4).toString("hex");
    const initialPattern = `policies-lifecycle-${suffix}.*`;
    const retargetedPattern = `policies-lifecycle-${suffix}.tool.*`;

    // The finalizer needs to reach the policy id whether the body succeeded or
    // failed, so capture it in a holder that the cleanup closure reads.
    let createdId: PolicyId | undefined;

    yield* Effect.ensuring(
      Effect.gen(function* () {
        const created = yield* api.policies.create({
          payload: { owner: "org", pattern: initialPattern, action: "block" },
        });
        createdId = created.id;
        expect(created.action, "the policy is created with the action that was sent").toBe("block");
        expect(created.pattern, "the policy is created with the pattern that was sent").toBe(
          initialPattern,
        );
        // The UI's sort relies on a non-empty fractional-indexing key — a row
        // with an empty position would break the rendered order, so the create
        // response must surface one.
        expect(created.position, "the create response carries a non-empty position key").not.toBe(
          "",
        );

        // Full update: change pattern AND action in one call.
        const retargeted = yield* api.policies.update({
          params: { policyId: created.id },
          payload: { owner: "org", pattern: retargetedPattern, action: "approve" },
        });
        expect(retargeted.id, "update returns the same policy id").toBe(created.id);
        expect(retargeted.pattern, "the pattern was re-targeted").toBe(retargetedPattern);
        expect(retargeted.action, "the action was switched from block to approve").toBe("approve");

        // Partial update: change only the action, as the row's action dropdown
        // does. The pattern from the previous update must survive the call.
        const flipped = yield* api.policies.update({
          params: { policyId: created.id },
          payload: { owner: "org", action: "require_approval" },
        });
        expect(flipped.action, "an action-only update switches just the action").toBe(
          "require_approval",
        );
        expect(flipped.pattern, "an action-only update preserves the existing pattern").toBe(
          retargetedPattern,
        );

        // A re-read sees the latest state, not just the response.
        const afterUpdate = (yield* api.policies.list()).find((p) => p.id === created.id);
        expect(afterUpdate?.pattern, "the re-targeted pattern is what subsequent reads see").toBe(
          retargetedPattern,
        );
        expect(afterUpdate?.action, "the last action set is what subsequent reads see").toBe(
          "require_approval",
        );

        const removed = yield* api.policies.remove({
          params: { policyId: created.id },
          payload: { owner: "org" },
        });
        expect(removed.removed, "remove reports the policy was deleted").toBe(true);

        const afterRemove = (yield* api.policies.list()).map((p) => p.id);
        expect(afterRemove, "the removed policy no longer appears in the list").not.toContain(
          created.id,
        );
        // The body removed the policy itself, so the finalizer has nothing to
        // clean up — clearing the holder signals that to the cleanup closure.
        createdId = undefined;
      }),
      // Bootstrap-admin instance is shared on selfhost — never leak the
      // policy even if a setup or assertion failure aborts the body mid-way.
      Effect.gen(function* () {
        if (createdId !== undefined) {
          yield* api.policies
            .remove({ params: { policyId: createdId }, payload: { owner: "org" } })
            .pipe(Effect.ignore);
        }
      }),
    );
  }),
);
