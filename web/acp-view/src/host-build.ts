// A pane's view host keeps the agents CLI it started with: an update replaces the view on disk,
// which the host serves to every page it loads, but the host's own code runs on until the agent
// starts again. The view knows the build it came with (the meta tag scripts/build-binary.ts writes
// into a release's index.html) and asks the host for its own (/api/diagnostics), so a new view
// on an older host says so and offers to bring the host up to date.

export const VIEW_BUILD_META = "agents-cli-build";

/** The agents CLI build this view came with, e.g. 1.0.0+4f90f234d36f; none for a view built
 *  apart from a release (npm run build:web). */
export function viewBuild(doc: Pick<Document, "querySelector"> | undefined = typeof document === "undefined" ? undefined : document): string | undefined {
  const value = doc?.querySelector(`meta[name="${VIEW_BUILD_META}"]`)?.getAttribute("content")?.trim();
  return value ? value : undefined;
}

/** Whether the host runs another agents CLI than the view: a host that started before the CLI
 *  was updated. A build that is not known (a development host says "dev") is never outdated. */
export function hostOutdated(view: string | undefined, host: string | undefined): boolean {
  if (!view || !host || host === "dev") return false;
  return view !== host;
}

export type OutdatedHostAction =
  /** Codex: its host starts again on its own, the agent keeps running. */
  | "restart-host"
  /** Codex, once its restart did not bring the host up to date, or while the agent is busy. */
  | "offer-host-restart"
  /** A hand-off agent: it starts again on its session, under the new host. */
  | "offer-agent-restart"
  /** Outside Agents Next, which alone can restart a pane's agent. */
  | "say";

/** What the view does about an outdated host. `mode` is the host's (live: Codex shares its
 *  session; handoff: the others); `idle` is no turn running and nothing typed in the field;
 *  `tried` is a restart already asked for this host build, which did not bring it up to date. */
export function outdatedHostAction(input: { mode: string | undefined; inApp: boolean; idle: boolean; tried: boolean }): OutdatedHostAction {
  if (!input.inApp) return "say";
  if (input.mode === "live") return input.idle && !input.tried ? "restart-host" : "offer-host-restart";
  return "offer-agent-restart";
}

/** The key that remembers, for the page's lifetime in its tab, a restart asked for a host build. */
export function triedKey(host: string): string {
  return `agents-host-restart:${host}`;
}
