// Cross-target (browser): the first time an admin opens /policies they land
// on a page that EXPLAINS what policies do and offers an obvious way to add
// one. The empty state is the doc — silently rendering nothing (or an
// indefinite loader) would leave the admin guessing whether the catalog is
// gated, broken, or simply unused. The product guarantees three things on a
// zero-policy workspace:
//
//   1. The page identifies itself as "Policies" with a short rationale.
//   2. The "Active policies" stack carries an explainer ("No policies yet.
//      Tools fall back to their plugin's default approval behavior.") so the
//      reader knows that absence-of-rule is the resolved default, not a
//      loading state.
//   3. The add-policy form is reachable from the same view, with its pattern
//      input and submit button visible — no extra clicks to discover.
//
// Authoring rules from the tool tree is covered by policies-ui.test.ts; this
// scenario only pins the landing surface for a fresh identity.
import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Browser, Target } from "../src/services";

scenario(
  "Policies · a fresh workspace lands on an explainer empty state with an add affordance",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const identity = yield* target.newIdentity();

    yield* browser.session(identity, async ({ page, step }) => {
      await step("Open the policies page", async () => {
        await page.goto("/policies", { waitUntil: "networkidle" });
        await page.getByRole("heading", { name: "Policies", exact: true }).waitFor();
      });

      await step("The page explains what policies are for", async () => {
        await page
          .getByText(/Override default approval behavior for tools/i)
          .first()
          .waitFor();
      });

      await step("The empty state spells out the no-rule fallback", async () => {
        await page.getByText("Active policies").first().waitFor();
        const emptyCopy = page.getByText(
          "No policies yet. Tools fall back to their plugin's default approval behavior.",
          { exact: true },
        );
        await emptyCopy.waitFor();
        expect(
          await emptyCopy.isVisible(),
          "the empty-state explainer is rendered, not just present",
        ).toBe(true);
      });

      await step("The add-policy form is reachable from the same view", async () => {
        const patternInput = page.getByPlaceholder("vercel.dns.* or *");
        await patternInput.waitFor();
        const addButton = page.getByRole("button", { name: "Add policy", exact: true });
        await addButton.waitFor();
        // Pattern is empty by default, so the submit button advertises the
        // form's gated state rather than letting an empty rule through.
        expect(
          await addButton.isDisabled(),
          "Add policy is disabled until a pattern is typed",
        ).toBe(true);
      });
    });
  }),
);
