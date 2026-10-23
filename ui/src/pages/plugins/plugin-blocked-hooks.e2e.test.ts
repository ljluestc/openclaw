import type { Locator, Page } from "playwright";
import { afterAll, beforeAll, expect, it, onTestFinished } from "vitest";
import {
  calendarInspection,
  calendarPlugin,
  captureScreenshot,
  describeControlUiE2e,
  installMockGateway,
  inventory,
  newContext,
  pluginMethodResponses,
  pluginMethods,
  server,
  setupPluginsE2e,
  teardownPluginsE2e,
} from "./plugins.e2e.test-support.ts";

function role(root: Page | Locator, kind: Parameters<Page["getByRole"]>[0], name: string) {
  return root.getByRole(kind, { name, exact: true });
}

const objectSchema = (properties: Record<string, unknown>) => ({ type: "object", properties });
const blockedPlugin = {
  ...calendarPlugin,
  id: "lossless-claw",
  name: "Lossless Claw",
  runtime: {
    state: "active",
    blockedHooks: [
      {
        hookName: "before_prompt_build",
        reason: "conversation-access-missing",
        configPath: "plugins.entries.lossless-claw.hooks.allowConversationAccess",
      },
    ],
  },
};
const config = { plugins: { entries: { "lossless-claw": { enabled: true } } } };

describeControlUiE2e("Plugin blocked hook diagnostics", () => {
  beforeAll(setupPluginsE2e);
  afterAll(teardownPluginsE2e);

  it("leads from a blocked hook to its permission and clears only when the runtime applies it", async () => {
    const context = await newContext();
    onTestFinished(() => context.close());
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: [...pluginMethods, "config.get", "config.schema", "config.set"],
      operatorScopes: ["operator.read", "operator.admin"],
      methodResponses: {
        ...pluginMethodResponses(),
        "plugins.list": inventory([blockedPlugin]),
        "plugins.inspect": {
          ...calendarInspection,
          plugin: blockedPlugin,
          grants: {
            hooks: {
              allowPromptInjection: { effective: true },
              allowConversationAccess: { effective: false },
            },
          },
        },
        "config.get": {
          config,
          raw: JSON.stringify(config),
          hash: "lossless-config",
          appliedConfigHash: "lossless-config",
          valid: true,
          issues: [],
        },
        "config.schema": {
          schema: objectSchema({
            plugins: objectSchema({
              entries: objectSchema({
                "lossless-claw": objectSchema({
                  hooks: {
                    ...objectSchema({
                      allowPromptInjection: { type: "boolean" },
                      allowConversationAccess: { type: "boolean" },
                    }),
                    additionalProperties: false,
                  },
                }),
              }),
            }),
          }),
          uiHints: {},
          version: "lossless-schema",
          generatedAt: "2026-10-23T00:00:00Z",
        },
      },
    });

    await page.goto(`${server.baseUrl}settings/plugins`);
    const row = page.locator('[data-plugin-id="lossless-claw"]');
    const summary = row.locator(".plugins-row-message--warning");
    await summary.waitFor();
    expect(await summary.textContent()).toBe(
      "Access blocked: some plugin hooks are not running. Review permissions",
    );
    expect(await row.locator('[data-plugin-state="enabled"]').count()).toBe(1);
    await captureScreenshot(page, "blocked-hooks-inventory.png");

    await role(summary, "link", "Review permissions").click();
    await expect
      .poll(() => new URL(page.url()).search)
      .toBe("?view=settings&setting=hooks.allowConversationAccess");
    const permissionRow = page.locator('[data-setting="hooks.allowConversationAccess"]');
    await permissionRow.waitFor();
    await expect.poll(() => permissionRow.getAttribute("data-focus-target")).toBe("");
    const permission = role(permissionRow, "checkbox", "Read conversation context");
    await expect
      .poll(() => permission.evaluate((node) => node === document.activeElement))
      .toBe(true);
    expect(await permission.isChecked()).toBe(false);
    const detailNotice = page.locator(".plugins-row-message--warning");
    expect(await detailNotice.textContent()).toBe(
      "These hooks need permission to read conversation context, so they are not running: before_prompt_build. Review permissions",
    );
    await captureScreenshot(page, "blocked-hooks-review.png", "viewport");

    await permission.press("Space");
    await expect.poll(async () => (await gateway.getRequests("config.set")).length).toBe(1);
    // Saving is not applying: the notice follows the runtime's plugin record.
    expect(await detailNotice.count()).toBe(1);

    await gateway.setMethodResponse(
      "plugins.list",
      inventory([{ ...blockedPlugin, runtime: { state: "active" } }]),
    );
    await page.reload();
    await permissionRow.waitFor();
    expect(await page.locator(".plugins-row-message--warning").count()).toBe(0);
    await captureScreenshot(page, "blocked-hooks-applied.png", "viewport");
  });
});
