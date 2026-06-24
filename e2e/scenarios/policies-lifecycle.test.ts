// Cross-target: policies are user-curated, not write-once — a misaimed rule
// can be re-targeted and an obsolete rule can be removed. The existing
// policies scenario pins create+list; this one closes the lifecycle with
// update and remove through the typed HttpApiClient. The guarantee in plain
// terms: an admin who fat-fingers a pattern or changes their mind about an
// action recovers without dropping into the database.
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";

import { scenario } from "../src/scenario";
import { Api, Target } from "../src/services";

const coreApi = composePluginApi([] as const);

scenario(
  "Policies · an existing policy can be re-targeted and removed",
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

    const created = yield* api.policies.create({
      payload: { owner: "org", pattern: initialPattern, action: "block" },
    });
    expect(created.action, "the policy is created with the action that was sent").toBe("block");
    expect(created.pattern, "the policy is created with the pattern that was sent").toBe(
      initialPattern,
    );

    yield* Effect.ensuring(
      Effect.gen(function* () {
        const updated = yield* api.policies.update({
          params: { policyId: created.id },
          payload: { owner: "org", pattern: retargetedPattern, action: "approve" },
        });
        expect(updated.id, "update returns the same policy id").toBe(created.id);
        expect(updated.pattern, "the pattern was re-targeted").toBe(retargetedPattern);
        expect(updated.action, "the action was switched from block to approve").toBe("approve");
        expect(updated.updatedAt, "updatedAt advances on a write").toBeGreaterThanOrEqual(
          created.updatedAt,
        );

        // A re-read sees the change, not just the response.
        const afterUpdate = (yield* api.policies.list()).find((p) => p.id === created.id);
        expect(afterUpdate?.pattern, "the re-targeted pattern is what subsequent reads see").toBe(
          retargetedPattern,
        );
        expect(afterUpdate?.action, "the switched action is what subsequent reads see").toBe(
          "approve",
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
      }),
      // Bootstrap-admin instance is shared on selfhost — never leak the
      // policy even if the lifecycle assertions fail mid-way.
      api.policies
        .remove({ params: { policyId: created.id }, payload: { owner: "org" } })
        .pipe(Effect.ignore),
    );
  }),
);
