// Cross-target (browser): the UI side of connection health checks, the feature
// that answers "has this credential expired?" (the Google 7-day dev-token case)
// and, optionally, "whose account is this?". These scenarios pin the redesign:
//
//  1. Edit sheet, WITH identity: the operation and identity-field pickers are
//     comboboxes (the identity options are the operation's typed response
//     fields). A live preview probes a pasted key and shows the actual response
//     (path -> value rows) plus "Resolves to: <identity>". The saved check then
//     drives "Check now" on a live connection: healthy, then expired once the
//     upstream revokes the key.
//  2. Edit sheet, NO identity: picking "None - health check only" leaves a pure
//     alive/expired probe. The preview still shows the response sample but no
//     "Resolves to" line; the persisted spec carries no identity field.
//  3. Add screen: the same check is configurable while adding the integration,
//     and it persists.
//  4. Connect modal: key-first. The credential field comes before the display
//     name; a valid key auto-fills the name from the resolved identity (and for
//     a no-identity integration leaves the name for the user).
//
// The upstream API is a real node:http server on 127.0.0.1 that gates `GET /me`
// on a bearer token AND a mutable "live" flag, so revoking the key mid-session
// (off camera) reproduces the real "the dev token got revoked" transition on a
// single saved connection. The probe runs server-side, so the in-process server
// is reachable from the dev server on the same host.
//
// These scenarios skip on targets without a browser surface (selfhost today).
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

import { Effect } from "effect";
import { expect } from "@effect/vitest";
import type { HttpApiClient } from "effect/unstable/httpapi";
import type { Page } from "playwright";
import { composePluginApi } from "@executor-js/api/server";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Browser, Target } from "../src/services";

const api = composePluginApi([openApiHttpPlugin()] as const);
type Client = HttpApiClient.ForApi<typeof api>;

const TEMPLATE = AuthTemplateSlug.make("apiKey");
const IDENTITY = "alice@example.com";

const newSlug = (prefix: string) =>
  IntegrationSlug.make(`${prefix}-${randomBytes(4).toString("hex")}`);

/** OpenAPI 3 spec with an auth-gated identity GET (`/me`, the obvious health
 *  check) plus a destructive POST so the candidate ranking has something to sort
 *  the GET ahead of. The title is parameterizable so the add screen (which mints
 *  the slug from the title) gets a collision-free integration per run. */
const identitySpec = (baseUrl: string, title = "Identity API"): string =>
  JSON.stringify({
    openapi: "3.0.3",
    info: { title, version: "1.0.0" },
    servers: [{ url: baseUrl }],
    paths: {
      "/me": {
        get: {
          operationId: "getMe",
          summary: "The current account",
          responses: {
            "200": {
              description: "The authenticated account",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      email: { type: "string" },
                      login: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/messages": {
        post: {
          operationId: "sendMessage",
          summary: "Send a message",
          responses: { "201": { description: "created" } },
        },
      },
    },
  });

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

/** A real node:http identity API on 127.0.0.1. `GET /me` returns the account
 *  JSON only while `live` is true AND the bearer token matches; otherwise a 401
 *  (the health check classifies that as expired). `revoke()` flips `live` off so
 *  a saved connection's previously-good key stops working mid-session. Closed by
 *  the scope's finalizer. */
const serveMutableIdentityApi = (validToken: string) =>
  Effect.acquireRelease(
    Effect.callback<{
      readonly url: string;
      readonly revoke: () => void;
      readonly close: () => void;
    }>((resume) => {
      let live = true;
      const server = createServer((request, response) => {
        const authorized = live && request.headers["authorization"] === `Bearer ${validToken}`;
        if (request.method === "GET" && (request.url ?? "").startsWith("/me")) {
          if (!authorized) {
            response.writeHead(401, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: "invalid_token" }));
            return;
          }
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ email: IDENTITY, login: "alice" }));
          return;
        }
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "not_found" }));
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        resume(
          Effect.succeed({
            url: `http://127.0.0.1:${port}`,
            revoke: () => {
              live = false;
            },
            close: () => {
              server.close();
              server.closeAllConnections();
            },
          }),
        );
      });
    }),
    (server) => Effect.sync(server.close),
  );

/** Register the identity integration against `baseUrl` with a bearer-token auth
 *  method (single `token` input → connection `value`). */
const registerIdentityIntegration = (
  client: Client,
  slug: IntegrationSlug,
  baseUrl: string,
  title?: string,
) =>
  client.openapi.addSpec({
    payload: {
      spec: { kind: "blob", value: identitySpec(baseUrl, title) },
      slug,
      baseUrl,
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

/** The stored operation name for the GET identity probe (openapi prefixes it by
 *  tag, e.g. `me.getMe`), discovered the same way the editor does: from the
 *  ranked candidate list. This is the value the on-camera operation picker holds. */
const getMeOperation = (client: Client, slug: IntegrationSlug) =>
  Effect.gen(function* () {
    const candidates = yield* client.integrations.healthCheckCandidates({
      params: { slug },
    });
    const getMe = candidates.find((candidate) => candidate.method === "get");
    if (!getMe) return yield* Effect.die("identity spec exposed no GET candidate");
    return getMe.operation;
  });

// ---------------------------------------------------------------------------
// Combobox driver. The pickers are base-ui `FreeformCombobox`es whose popup is
// PORTALED to document.body (so option queries are page-level, not dialog-scoped)
// and whose list is NOT re-filtered by a programmatic Playwright `fill`. Clicking
// a portaled option is a pointer-down OUTSIDE the Radix edit sheet and would
// dismiss it, and a blind ArrowDown over the unfiltered list overshoots the
// target. So we identify the target option by its visible text, ArrowDown until
// base-ui marks it `data-highlighted`, then commit with Enter, which (unlike
// Escape or an outside click) leaves a surrounding Radix sheet open.
// ---------------------------------------------------------------------------

/** Select the combobox option whose visible text contains `optionText`. Works
 *  inside the edit sheet (keyboard only) and on the add screen alike. For the
 *  identity picker, "None" targets the leading "None - health check only" option
 *  (a pure health check). */
const selectComboboxOption = async (page: Page, inputId: string, optionText: string) => {
  const input = page.locator(`#${inputId}`);
  await input.click();
  const target = page.getByRole("option").filter({ hasText: optionText }).first();
  await target.waitFor({ timeout: 10_000 });
  // base-ui highlights the selected option (or the first) on open; arrow onto the
  // target wherever it sits in the unfiltered list, then commit it.
  for (let i = 0; i < 16; i++) {
    if ((await target.getAttribute("data-highlighted")) !== null) break;
    await input.press("ArrowDown");
  }
  await input.press("Enter");
};

// ===========================================================================
// 1. Edit sheet, WITH identity: combobox pickers + live preview showing the
//    response, then healthy -> expired on a live connection.
// ===========================================================================

scenario(
  "Health checks (UI) · edit sheet with identity: preview the response, then healthy then expired",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const browser = yield* Browser;
      const { client: makeClient } = yield* Api;
      const identity = yield* target.newIdentity();
      const client = yield* makeClient(api, identity);
      const goodToken = `gk_${randomBytes(8).toString("hex")}`;
      const server = yield* serveMutableIdentityApi(goodToken);
      const slug = newSlug("hc-ui-id");
      const name = ConnectionName.make("main");

      yield* Effect.ensuring(
        Effect.gen(function* () {
          // Off camera: stand up the integration and a saved connection holding
          // the live key. The SAME identity drives the API client and the
          // browser cookies, so the browser sees what we just created. The
          // health check itself is configured ON camera in the editor below.
          yield* registerIdentityIntegration(client, slug, server.url);
          const operation = yield* getMeOperation(client, slug);
          yield* client.connections.create({
            payload: {
              owner: "org",
              name,
              integration: slug,
              template: TEMPLATE,
              value: goodToken,
            },
          });

          yield* browser.session(identity, async ({ page, step }) => {
            const connections = page.locator("section").filter({
              has: page.getByRole("heading", { level: 3, name: "Connections" }),
            });
            const menuTrigger = connections.locator('button[aria-haspopup="menu"]');

            await step("Open the integration's connections", async () => {
              await page.goto(`/integrations/${slug}`, { waitUntil: "networkidle" });
              await connections.getByText("main", { exact: true }).waitFor();
              // The health-check editor only renders once the integration's
              // candidate operations have loaded.
              await page.getByRole("heading", { level: 3, name: "Health check" }).waitFor();
            });

            await step("Pick the GET identity call and its email identity field", async () => {
              await page.getByRole("button", { name: "Set up" }).click();
              // The pickers are comboboxes; the identity options are the
              // operation's typed response fields, so set the operation first.
              await selectComboboxOption(page, "health-check-operation", operation);
              await selectComboboxOption(page, "health-check-identity", "email");
            });

            await step(
              "Live preview a pasted key: status, the response, and the identity",
              async () => {
                const sheet = page.getByRole("dialog");
                await page.locator("#health-check-preview-key").fill(goodToken);
                await sheet.getByRole("button", { name: "Preview", exact: true }).click();
                // The probe returns the real body, so the preview shows the
                // response sample and the field the identity resolves from.
                await sheet.getByText("Response", { exact: true }).waitFor({ timeout: 30_000 });
                await sheet.getByText("Resolves to:").waitFor();
                await sheet.getByText(IDENTITY).first().waitFor();
              },
            );

            await step("Save the health check", async () => {
              await page.getByRole("button", { name: "Save", exact: true }).click();
              // Saving closes the sheet (the operation picker leaves the DOM).
              await page.locator("#health-check-operation").waitFor({ state: "hidden" });
            });

            await step("Check the live connection: healthy, and whose account it is", async () => {
              await menuTrigger.click();
              await page.getByRole("menuitem", { name: "Check now" }).click();
              // The probe derived the account from the response body, so the row
              // now labels itself with the live identity and shows a green dot.
              await connections.getByText(IDENTITY).waitFor({ timeout: 30_000 });
              await connections.getByLabel("Status: Healthy").waitFor();
            });

            await step(
              "The upstream revokes the key: the same connection reads expired",
              async () => {
                // Off camera: the stored key stops working upstream (the Google
                // 7-day dev-token expiry, reproduced).
                server.revoke();
                await menuTrigger.click();
                await page.getByRole("menuitem", { name: "Check now" }).click();
                await connections
                  .getByText("Expired", { exact: true })
                  .waitFor({ timeout: 30_000 });
                await connections.getByLabel("Status: Expired").waitFor();
              },
            );
          });

          // The configured check is persisted exactly as drafted: the GET
          // operation plus the chosen identity field, no pinned args.
          const stored = yield* client.integrations.healthCheckGet({ params: { slug } });
          expect(stored).toEqual({ operation, identityField: "email" });
        }),
        Effect.gen(function* () {
          yield* client.connections
            .remove({ params: { owner: "org", integration: slug, name } })
            .pipe(Effect.ignore);
          yield* client.openapi.removeSpec({ params: { slug } }).pipe(Effect.ignore);
        }),
      );
    }),
  ),
);

// ===========================================================================
// 2. Edit sheet, NO identity: "None - health check only" -> pure alive/expired
//    probe. The preview still shows the response, but there is no "Resolves to".
// ===========================================================================

scenario(
  "Health checks (UI) · edit sheet without identity: pure health check still shows the response",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const browser = yield* Browser;
      const { client: makeClient } = yield* Api;
      const identity = yield* target.newIdentity();
      const client = yield* makeClient(api, identity);
      const goodToken = `gk_${randomBytes(8).toString("hex")}`;
      const server = yield* serveMutableIdentityApi(goodToken);
      const slug = newSlug("hc-ui-noid");
      const name = ConnectionName.make("main");

      yield* Effect.ensuring(
        Effect.gen(function* () {
          yield* registerIdentityIntegration(client, slug, server.url);
          const operation = yield* getMeOperation(client, slug);
          yield* client.connections.create({
            payload: {
              owner: "org",
              name,
              integration: slug,
              template: TEMPLATE,
              value: goodToken,
            },
          });

          yield* browser.session(identity, async ({ page, step }) => {
            const connections = page.locator("section").filter({
              has: page.getByRole("heading", { level: 3, name: "Connections" }),
            });
            const menuTrigger = connections.locator('button[aria-haspopup="menu"]');

            await step("Open the health-check editor", async () => {
              await page.goto(`/integrations/${slug}`, { waitUntil: "networkidle" });
              await connections.getByText("main", { exact: true }).waitFor();
              await page.getByRole("heading", { level: 3, name: "Health check" }).waitFor();
              await page.getByRole("button", { name: "Set up" }).click();
            });

            await step("Pick the operation, leave identity as None", async () => {
              await selectComboboxOption(page, "health-check-operation", operation);
              // The leading option is "None - health check only" (value ""):
              // picking it keeps the check identity-free.
              await selectComboboxOption(page, "health-check-identity", "None");
            });

            await step("Live preview: status and the response, but no identity line", async () => {
              const sheet = page.getByRole("dialog");
              await page.locator("#health-check-preview-key").fill(goodToken);
              await sheet.getByRole("button", { name: "Preview", exact: true }).click();
              await sheet.getByText("Response", { exact: true }).waitFor({ timeout: 30_000 });
              // A pure health check resolves no identity, so there is no
              // "Resolves to" line even though the probe succeeded.
              expect(await sheet.getByText("Resolves to:").count()).toBe(0);
            });

            await step("Save the pure health check", async () => {
              await page.getByRole("button", { name: "Save", exact: true }).click();
              await page.locator("#health-check-operation").waitFor({ state: "hidden" });
            });

            await step("Check now reports status only, with no account email", async () => {
              await menuTrigger.click();
              await page.getByRole("menuitem", { name: "Check now" }).click();
              await connections.getByLabel("Status: Healthy").waitFor({ timeout: 30_000 });
              // No identity field configured, so the row never surfaces the email.
              expect(await connections.getByText(IDENTITY).count()).toBe(0);
            });
          });

          // The persisted spec is the operation alone: no identity field.
          const stored = yield* client.integrations.healthCheckGet({ params: { slug } });
          expect(stored?.operation).toBe(operation);
          expect(stored?.identityField).toBeUndefined();
        }),
        Effect.gen(function* () {
          yield* client.connections
            .remove({ params: { owner: "org", integration: slug, name } })
            .pipe(Effect.ignore);
          yield* client.openapi.removeSpec({ params: { slug } }).pipe(Effect.ignore);
        }),
      );
    }),
  ),
);

// ===========================================================================
// 3. Add screen: configure the health check while adding the integration, and
//    confirm it persisted.
// ===========================================================================

scenario(
  "Health checks (UI) · add screen: configure the check while adding the integration",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const browser = yield* Browser;
      const { client: makeClient } = yield* Api;
      const identity = yield* target.newIdentity();
      const client = yield* makeClient(api, identity);
      // The add screen mints the slug from the spec title, so make it unique and
      // capture the real slug from the URL after the add completes. No live
      // probe here, so a static base URL is enough.
      const title = `Identity API ${randomBytes(4).toString("hex")}`;
      const spec = identitySpec("https://identity.example.com", title);

      let createdSlug = "";
      yield* Effect.ensuring(
        Effect.gen(function* () {
          yield* browser.session(identity, async ({ page, step }) => {
            await step("Open the Add OpenAPI source form", async () => {
              await page.goto("/integrations/add/openapi", { waitUntil: "networkidle" });
              await page.getByPlaceholder("https://api.example.com/openapi.json").waitFor();
            });

            await step("Paste the spec; the health-check section appears", async () => {
              await page.getByPlaceholder("https://api.example.com/openapi.json").fill(spec);
              // The form auto-analyzes (debounced); the optional health-check
              // section renders once candidates are derived from the preview.
              await page
                .getByRole("heading", { name: "Health check (optional)" })
                .waitFor({ timeout: 20_000 });
            });

            await step("Configure the check: GET operation + email identity field", async () => {
              // The add-screen toolPath isn't known a-priori, so pick the GET by
              // its label text; the identity field is then a typed combobox.
              await selectComboboxOption(page, "add-health-check-operation", "getMe");
              await selectComboboxOption(page, "add-health-check-identity", "email");
            });

            await step("Add the integration and land on its detail page", async () => {
              await page.getByRole("button", { name: "Add integration" }).click();
              await page.waitForURL(/\/integrations\/[^/?#]+$/, { timeout: 30_000 });
              const match = page.url().match(/\/integrations\/([^/?#]+)/);
              createdSlug = match?.[1] ?? "";
            });
          });

          expect(createdSlug.length).toBeGreaterThan(0);
          const slug = IntegrationSlug.make(createdSlug);
          // The drafted check persisted against the freshly created integration,
          // with the same toolPath the registration assigned the GET operation.
          const operation = yield* getMeOperation(client, slug);
          const stored = yield* client.integrations.healthCheckGet({ params: { slug } });
          expect(stored).toEqual({ operation, identityField: "email" });
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

// ===========================================================================
// 4. Connect modal: key-first. Credential before display name; a valid key
//    auto-fills the name from the resolved identity (and a no-identity
//    integration leaves the name blank for the user).
// ===========================================================================

scenario(
  "Health checks (UI) · connect modal is key-first: a valid key names the connection",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const browser = yield* Browser;
      const { client: makeClient } = yield* Api;
      const identity = yield* target.newIdentity();
      const client = yield* makeClient(api, identity);
      const goodToken = `gk_${randomBytes(8).toString("hex")}`;
      const server = yield* serveMutableIdentityApi(goodToken);
      const withId = newSlug("hc-ui-connect-id");
      const noId = newSlug("hc-ui-connect-noid");

      yield* Effect.ensuring(
        Effect.gen(function* () {
          // Two integrations against the same live upstream: one with an identity
          // field configured, one a pure health check.
          yield* registerIdentityIntegration(client, withId, server.url);
          yield* registerIdentityIntegration(client, noId, server.url);
          const withIdOp = yield* getMeOperation(client, withId);
          const noIdOp = yield* getMeOperation(client, noId);
          yield* client.integrations.healthCheckSet({
            params: { slug: withId },
            payload: { spec: { operation: withIdOp, identityField: "email" } },
          });
          yield* client.integrations.healthCheckSet({
            params: { slug: noId },
            payload: { spec: { operation: noIdOp } },
          });

          yield* browser.session(identity, async ({ page, step }) => {
            const openConnectModal = async (slug: IntegrationSlug) => {
              await page.goto(`/integrations/${slug}`, { waitUntil: "networkidle" });
              await page.getByRole("button", { name: "Add connection", exact: true }).click();
              await page.getByRole("heading", { name: /Add connection/ }).waitFor();
            };

            await step(
              "Identity integration: credential comes before the display name",
              async () => {
                await openConnectModal(withId);
                const dialog = page.getByRole("dialog");
                const credential = dialog.getByPlaceholder("paste the value / token");
                const displayName = dialog.locator("#connection-name");
                await credential.waitFor();
                await displayName.waitFor();
                const credBox = await credential.boundingBox();
                const nameBox = await displayName.boundingBox();
                expect(credBox).not.toBeNull();
                expect(nameBox).not.toBeNull();
                // Key-first: the credential field sits above the derived name.
                expect(credBox!.y).toBeLessThan(nameBox!.y);
              },
            );

            await step("A valid key validates healthy and names the connection", async () => {
              const dialog = page.getByRole("dialog");
              await dialog.getByPlaceholder("paste the value / token").fill(goodToken);
              await dialog.getByRole("button", { name: "Validate key" }).click();
              await dialog.getByText("Healthy").waitFor({ timeout: 30_000 });
              // The probed identity auto-fills the display name.
              await page.waitForFunction(
                (expected) =>
                  (document.querySelector("#connection-name") as HTMLInputElement | null)?.value ===
                  expected,
                IDENTITY,
                { timeout: 10_000 },
              );
            });

            await step(
              "No-identity integration: validates healthy but leaves the name blank",
              async () => {
                await openConnectModal(noId);
                const dialog = page.getByRole("dialog");
                await dialog.getByPlaceholder("paste the value / token").fill(goodToken);
                await dialog.getByRole("button", { name: "Validate key" }).click();
                await dialog.getByText("Healthy").waitFor({ timeout: 30_000 });
                // Nothing to derive the name from, so the user names it themselves.
                expect(await dialog.locator("#connection-name").inputValue()).toBe("");
              },
            );
          });
        }),
        Effect.gen(function* () {
          yield* client.openapi.removeSpec({ params: { slug: withId } }).pipe(Effect.ignore);
          yield* client.openapi.removeSpec({ params: { slug: noId } }).pipe(Effect.ignore);
        }),
      );
    }),
  ),
);

// ===========================================================================
// 5. Large spec: the operation picker is a combobox over EVERY operation, so on
//    a big spec it must filter as you type. This pins that typing narrows the
//    list (the popup otherwise renders a capped slice of hundreds of options).
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
// 6. Add screen, large spec: the operation picker is fed by the bounded spec
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
