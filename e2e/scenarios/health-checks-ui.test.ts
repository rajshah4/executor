// Cross-target (browser): the UI side of connection health checks, the feature
// that answers "has this credential expired?" (the Google 7-day dev-token case).
// These scenarios pin the operation picker, the part that lets a user choose
// WHICH call the probe runs:
//
//  1. Edit sheet, large spec: typing into the operation combobox filters a
//     hundreds-long candidate list down to the one match, and committing it
//     stores the real operation (not the freeform text typed to find it).
//  2. Add screen, large spec: the same picker is fed by the bounded spec
//     preview, so typing must reach an operation ranked well past the preview's
//     top slice.
//
// These scenarios skip on targets without a browser surface (selfhost today).
import { randomBytes } from "node:crypto";

import { Effect } from "effect";
import { expect } from "@effect/vitest";
import { composePluginApi } from "@executor-js/api/server";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import { IntegrationSlug } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Browser, Target } from "../src/services";

const api = composePluginApi([openApiHttpPlugin()] as const);

const newSlug = (prefix: string) =>
  IntegrationSlug.make(`${prefix}-${randomBytes(4).toString("hex")}`);

// A distinctive operation buried in a large spec, found by its unique summary
// (which no filler operation shares) so the filter test can search for it.
const PROBE_TOKEN = "ztarget";
const PROBE_SUMMARY = `Health probe candidate ${PROBE_TOKEN}`;

/** An OpenAPI 3 spec with ~250 GET operations plus one distinctive probe. The
 *  candidate list is far longer than the popup renders at once, so the operation
 *  picker only surfaces a given operation when typing actually filters the list.
 *  The title is parameterizable so the add screen (which mints the slug from the
 *  title) gets a collision-free integration per run. */
const largeSpec = (baseUrl: string, title = "Big API"): string => {
  const okJson = {
    "200": {
      description: "ok",
      content: {
        "application/json": { schema: { type: "object", properties: { id: { type: "string" } } } },
      },
    },
  };
  const paths: Record<string, unknown> = {};
  for (let index = 0; index < 250; index++) {
    paths[`/things/item${index}`] = {
      get: { operationId: `getThing${index}`, summary: `Thing number ${index}`, responses: okJson },
    };
  }
  paths["/probe/target"] = {
    get: { operationId: "probeTarget", summary: PROBE_SUMMARY, responses: okJson },
  };
  return JSON.stringify({
    openapi: "3.0.3",
    info: { title, version: "1.0.0" },
    servers: [{ url: baseUrl }],
    paths,
  });
};

// ===========================================================================
// 1. Edit sheet, large spec: typing filters the operation picker to the match.
// ===========================================================================

scenario(
  "Health checks (UI) · large spec: typing filters the operation picker down to the match",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const browser = yield* Browser;
      const { client: makeClient } = yield* Api;
      const identity = yield* target.newIdentity();
      const client = yield* makeClient(api, identity);
      const slug = newSlug("hc-ui-large");

      yield* Effect.ensuring(
        Effect.gen(function* () {
          yield* client.openapi.addSpec({
            payload: {
              spec: { kind: "blob", value: largeSpec("https://big.example.com") },
              slug,
              baseUrl: "https://big.example.com",
              authenticationTemplate: [
                {
                  slug: "apiKey",
                  type: "apiKey",
                  headers: {
                    authorization: ["Bearer ", { type: "variable", name: "token" }],
                  },
                },
              ],
            },
          });
          // The toolPath the registration assigned the distinctive probe op,
          // matched by its unique summary, so the read-back asserts exactly the
          // operation the on-camera filter-then-pick selected.
          const candidates = yield* client.integrations.healthCheckCandidates({ params: { slug } });
          const probe = candidates.find((candidate) => candidate.summary === PROBE_SUMMARY);
          if (!probe) return yield* Effect.die("large spec is missing its probe operation");
          const probeOperation = probe.operation;
          // Sanity: the spec really is large, so the picker can't just show them all.
          expect(candidates.length).toBeGreaterThan(100);

          yield* browser.session(identity, async ({ page, step }) => {
            const input = page.locator("#health-check-operation");
            const options = page.getByRole("option");

            await step("Open the health-check editor over the large spec", async () => {
              await page.goto(`/integrations/${slug}`, { waitUntil: "networkidle" });
              await page.getByRole("heading", { level: 3, name: "Health check" }).waitFor();
              await page.getByRole("button", { name: "Set up" }).click();
              await input.waitFor();
            });

            await step("A broad query still surfaces many operations", async () => {
              await input.click();
              // Real keystrokes (base-ui filters on the input value, not a
              // programmatic set): a shared summary prefix matches the fillers.
              await input.selectText();
              await input.pressSequentially("Thing number", { delay: 10 });
              await options.filter({ hasText: "Thing number" }).first().waitFor();
              // The popup caps how many it renders, but a broad match fills it.
              expect(await options.count()).toBeGreaterThan(20);
            });

            await step("A distinctive query narrows the list to the one match", async () => {
              await input.selectText();
              await input.pressSequentially(PROBE_TOKEN, { delay: 10 });
              const match = options.filter({ hasText: PROBE_SUMMARY }).first();
              await match.waitFor({ timeout: 10_000 });
              // Typing actually filters: the hundreds collapse to the single
              // matching operation (plus the freeform echo of the typed text).
              expect(await options.count()).toBeLessThanOrEqual(3);
            });

            await step("Select the filtered operation and save", async () => {
              const match = options.filter({ hasText: PROBE_SUMMARY }).first();
              // base-ui pre-highlights the freeform echo; arrow onto the real op.
              for (let i = 0; i < 8; i++) {
                if ((await match.getAttribute("data-highlighted")) !== null) break;
                await input.press("ArrowDown");
              }
              await input.press("Enter");
              await page.getByRole("button", { name: "Save", exact: true }).click();
              await input.waitFor({ state: "hidden" });
            });
          });

          // The picker committed the real operation behind the matched summary,
          // not the freeform text that was typed to find it.
          const stored = yield* client.integrations.healthCheckGet({ params: { slug } });
          expect(stored?.operation).toBe(probeOperation);
        }),
        Effect.gen(function* () {
          yield* client.openapi.removeSpec({ params: { slug } }).pipe(Effect.ignore);
        }),
      );
    }),
  ),
);

// ===========================================================================
// 2. Add screen, large spec: the operation picker is fed by the bounded spec
//    preview, so it must carry enough of a big spec that typing reaches an
//    operation ranked well past the preview's top slice (the Vercel "user"
//    case: searching found nothing because the op wasn't in the top few).
// ===========================================================================

scenario(
  "Health checks (UI) · add screen large spec: typing reaches an operation beyond the preview's top slice",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const browser = yield* Browser;
      const { client: makeClient } = yield* Api;
      const identity = yield* target.newIdentity();
      const client = yield* makeClient(api, identity);
      // The add screen mints the slug from the title, so make it unique. Search
      // for an operation whose toolPath sorts far past the old top-10 cap.
      const title = `Big API ${randomBytes(4).toString("hex")}`;
      const spec = largeSpec("https://big.example.com", title);
      const targetSummary = "Thing number 137";

      let createdSlug = "";
      yield* Effect.ensuring(
        Effect.gen(function* () {
          yield* browser.session(identity, async ({ page, step }) => {
            const input = page.locator("#add-health-check-operation");
            const options = page.getByRole("option");

            await step("Open the Add form and paste the large spec", async () => {
              await page.goto("/integrations/add/openapi", { waitUntil: "networkidle" });
              await page.getByPlaceholder("https://api.example.com/openapi.json").fill(spec);
              await page
                .getByRole("heading", { name: "Health check (optional)" })
                .waitFor({ timeout: 20_000 });
            });

            await step("Type to reach an operation past the preview's top slice", async () => {
              await input.click();
              // Real keystrokes; the operation isn't in the first handful, so it
              // is reachable only because the preview now carries the whole spec.
              await input.selectText();
              await input.pressSequentially(targetSummary, { delay: 10 });
              // The real option carries the GET label + toolPath; the freeform
              // echo is just the typed text, so "GET" disambiguates them.
              const match = options.filter({ hasText: targetSummary }).filter({ hasText: "GET" });
              await match.first().waitFor({ timeout: 10_000 });
            });

            await step("Select the found operation and add the integration", async () => {
              const match = options.filter({ hasText: targetSummary }).filter({ hasText: "GET" });
              for (let i = 0; i < 8; i++) {
                if ((await match.first().getAttribute("data-highlighted")) !== null) break;
                await input.press("ArrowDown");
              }
              await input.press("Enter");
              await page.getByRole("button", { name: "Add integration" }).click();
              await page.waitForURL(/\/integrations\/[^/?#]+$/, { timeout: 30_000 });
              const url = page.url().match(/\/integrations\/([^/?#]+)/);
              createdSlug = url?.[1] ?? "";
            });
          });

          expect(createdSlug.length).toBeGreaterThan(0);
          const slug = IntegrationSlug.make(createdSlug);
          // The drafted check persisted the operation behind the matched summary,
          // proving the add-screen search reached past the preview's top slice.
          const candidates = yield* client.integrations.healthCheckCandidates({ params: { slug } });
          const expected = candidates.find((candidate) => candidate.summary === targetSummary);
          if (!expected) return yield* Effect.die("created integration is missing the target op");
          const stored = yield* client.integrations.healthCheckGet({ params: { slug } });
          expect(stored?.operation).toBe(expected.operation);
        }),
        Effect.gen(function* () {
          if (createdSlug.length > 0) {
            yield* client.openapi
              .removeSpec({ params: { slug: IntegrationSlug.make(createdSlug) } })
              .pipe(Effect.ignore);
          }
        }),
      );
    }),
  ),
);
