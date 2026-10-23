import type { RouteLocation } from "@openclaw/uirouter";

export type InstalledPluginDetailTab = "readme" | "configuration";

export function installedPluginDetailTabFromHash(hash: string): InstalledPluginDetailTab {
  return hash === "#configuration" ? "configuration" : "readme";
}

export function pluginDetailLocation(
  location: Pick<RouteLocation, "pathname" | "search"> | undefined,
  settings: boolean,
) {
  const search = new URLSearchParams(location?.search);
  // A permission review target applies to the navigation that requested it.
  search.delete("setting");
  if (settings) {
    search.set("view", "settings");
  } else {
    search.delete("view");
  }
  return { pathname: location?.pathname, search: search.size ? `?${search}` : "", hash: "" };
}
