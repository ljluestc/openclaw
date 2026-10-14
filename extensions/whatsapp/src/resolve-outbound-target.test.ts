import { describe, expect, it } from "vitest";
import { resolveWhatsAppOutboundTarget } from "./resolve-outbound-target.js";

type ResolveParams = Parameters<typeof resolveWhatsAppOutboundTarget>[0];

const PRIMARY_TARGET = "+11234567890";
const SECONDARY_TARGET = "+19876543210";

describe("resolveWhatsAppOutboundTarget", () => {
  it.each([null, "   ", "invalid"])("rejects missing or invalid target %j", (to) => {
    expect(resolveWhatsAppOutboundTarget({ to, allowFrom: undefined, mode: undefined })).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Delivering to WhatsApp requires target <E.164|group JID|newsletter JID>",
      }),
    });
  });

  it.each([
    ["120363123456789@g.us", "implicit"],
    ["120363123456789@newsletter", "implicit"],
  ])("does not apply DM allowFrom to %s in %s mode", (to, mode) => {
    expect(resolveWhatsAppOutboundTarget({ to, allowFrom: [SECONDARY_TARGET], mode })).toEqual({
      ok: true,
      to,
    });
  });

  it.each<[string, ResolveParams["allowFrom"], ResolveParams["mode"]]>([
    ["wildcard", ["*"], "implicit"],
    ["empty allowFrom", [], "implicit"],
    ["numeric target beside invalid entry", [11234567890, "invalid"], "implicit"],
    ["whitespace in allowFrom", [`  ${PRIMARY_TARGET}  `], undefined],
    ["no policy in null mode", undefined, null],
  ])("allows %s", (_label, allowFrom, mode) => {
    expect(resolveWhatsAppOutboundTarget({ to: PRIMARY_TARGET, allowFrom, mode })).toEqual({
      ok: true,
      to: PRIMARY_TARGET,
    });
  });

  it("denies an unlisted target with its normalized address", () => {
    expect(
      resolveWhatsAppOutboundTarget({
        to: "  +1 (123) 456-7890  ",
        allowFrom: [SECONDARY_TARGET],
        mode: "heartbeat",
      }),
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: `Target "${PRIMARY_TARGET}" is not listed in the configured WhatsApp allowFrom policy.`,
      }),
    });
  });

  it.each<[string, ResolveParams["allowFrom"], number]>([
    ["one invalid entry", ["typo!!!"], 1],
    ["several invalid entries", ["typo!!!", "not-a-number"], 2],
    ["invalid entries beside blanks", ["  ", "typo!!!"], 1],
  ])("fails closed when allowFrom has only %s", (_label, allowFrom, count) => {
    expect(
      resolveWhatsAppOutboundTarget({ to: PRIMARY_TARGET, allowFrom, mode: "implicit" }),
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: `WhatsApp allowFrom has ${count} configured ${
          count === 1 ? "entry" : "entries"
        }, but none are valid WhatsApp targets; refusing to send to "${PRIMARY_TARGET}".`,
      }),
    });
  });

  it("trims the resolved target", () => {
    expect(
      resolveWhatsAppOutboundTarget({
        to: `  ${PRIMARY_TARGET}  `,
        allowFrom: undefined,
        mode: undefined,
      }),
    ).toEqual({ ok: true, to: PRIMARY_TARGET });
  });
});
