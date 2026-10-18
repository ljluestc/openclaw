// Connect capability order tests keep connect bootstraps from installing before validating the candidate (#127251).
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "../..");

const CAPABILITY_PROBE = /\bconnect --help\b/;
const INSTALLER_RUN = /(?:install-cli\.sh|\$\{?INSTALLER_PATH\b).*--version\b/;

/** Returns 1-based lines where a script activates an installer before its first connect probe. */
function findInstallBeforeCapabilityProbe(source: string): number | undefined {
  const lines = source.split("\n");
  const probe = lines.findIndex((line) => CAPABILITY_PROBE.test(line));
  if (probe === -1) {
    return undefined;
  }
  const install = lines.findIndex(
    (line) => !line.trimStart().startsWith("#") && INSTALLER_RUN.test(line),
  );
  return install !== -1 && install < probe ? install + 1 : undefined;
}

function listShellScripts(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "node_modules" ? [] : listShellScripts(path);
    }
    return entry.name.endsWith(".sh") ? [path] : [];
  });
}

describe("connect bootstrap capability order", () => {
  it("flags installing the candidate before probing its connect capabilities", () => {
    // Shape of the removed scripts/connect.sh: the installer replaced the CLI, then the probe rejected it.
    const installFirst = [
      'bash "$INSTALLER_PATH" --version "$VERSION" --prefix "$PREFIX" --no-onboard',
      'CONNECT_HELP="$("$OPENCLAW_BIN" connect --help 2>&1)"',
    ].join("\n");
    expect(findInstallBeforeCapabilityProbe(installFirst)).toBe(1);
  });

  it("allows probing a staged candidate before activating it", () => {
    const probeFirst = [
      'CONNECT_HELP="$("$STAGED_BIN" connect --help 2>&1)"',
      'bash "$INSTALLER_PATH" --version "$VERSION" --prefix "$PREFIX" --no-onboard',
      'CONNECT_HELP="$("$OPENCLAW_BIN" connect --help 2>&1)"',
    ].join("\n");
    expect(findInstallBeforeCapabilityProbe(probeFirst)).toBeUndefined();
  });

  it("keeps repository scripts from installing before the connect capability probe", () => {
    const violations = listShellScripts(join(repoRoot, "scripts")).flatMap((path) => {
      const line = findInstallBeforeCapabilityProbe(readFileSync(path, "utf8"));
      return line === undefined ? [] : [`${relative(repoRoot, path)}:${line}`];
    });
    expect(violations).toEqual([]);
  });
});
