/**
 * Deep links into the project settings page.
 *
 * The page keeps its open tab in the URL hash, so a tab can be linked to,
 * survives a reload, and can be returned to after leaving the app (for
 * example an external setup flow that sends the browser back):
 *
 *   #general | #roles | #task-statuses | …     a built-in tab, by id
 *   #plugin:<pluginId>:<component>             one specific plugin tab
 *   #plugin:<pluginId>                         a plugin's first tab
 */

const PLUGIN_PREFIX = "plugin:";

export interface PluginTabRef {
	pluginId: string;
	component: string;
}

/** The section id the page uses internally for a plugin tab. */
export function pluginSectionId(tab: PluginTabRef): string {
	return `${PLUGIN_PREFIX}${tab.pluginId}:${tab.component}`;
}

/**
 * Maps a URL hash (with or without the leading "#") to a section the caller
 * may open, or null when it names nothing available — an unknown id, a tab the
 * member lacks permission for, or a plugin tab whose plugin isn't loaded (yet).
 * Pass only the built-in ids and plugin tabs the member can actually see, so
 * a hash can never open a section the page would not have listed.
 */
export function resolveSectionFromHash(
	hash: string,
	builtinIds: readonly string[],
	pluginTabs: readonly PluginTabRef[],
): string | null {
	let raw = hash.replace(/^#/, "");
	try {
		raw = decodeURIComponent(raw);
	} catch {
		return null;
	}
	if (!raw) return null;
	if (builtinIds.includes(raw)) return raw;
	if (!raw.startsWith(PLUGIN_PREFIX)) return null;

	const rest = raw.slice(PLUGIN_PREFIX.length);
	const tab =
		pluginTabs.find((t) => `${t.pluginId}:${t.component}` === rest) ??
		pluginTabs.find((t) => t.pluginId === rest);
	return tab ? pluginSectionId(tab) : null;
}
