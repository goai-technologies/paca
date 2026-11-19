import { useQuery } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import {
	buildNavItems,
	buildRegistryMap,
	type ExtensionPointId,
	type PluginNavRegistration,
	type PluginNavScope,
	type PluginRegistration,
	pluginsQueryOptions,
} from "@/lib/plugin-api";

// ── Context ───────────────────────────────────────────────────────────────────

interface PluginRegistryContextValue {
	/** Ordered registrations for a given extension point. */
	getRegistrations: (point: ExtensionPointId) => PluginRegistration[];
	/** Sidebar nav items contributed by enabled plugins for the given scope. */
	getNavItems: (scope: PluginNavScope) => PluginNavRegistration[];
	isLoading: boolean;
}

const PluginRegistryContext = createContext<PluginRegistryContextValue>({
	getRegistrations: () => [],
	getNavItems: () => [],
	isLoading: false,
});

// ── Provider ──────────────────────────────────────────────────────────────────

export function PluginRegistryProvider({ children }: { children: ReactNode }) {
	const { data: plugins = [], isLoading } = useQuery(pluginsQueryOptions);

	const registryMap = useMemo(() => buildRegistryMap(plugins), [plugins]);
	const projectNavItems = useMemo(
		() => buildNavItems(plugins, "project"),
		[plugins],
	);
	const adminNavItems = useMemo(
		() => buildNavItems(plugins, "admin"),
		[plugins],
	);
	const appNavItems = useMemo(() => buildNavItems(plugins, "app"), [plugins]);

	const value = useMemo<PluginRegistryContextValue>(
		() => ({
			getRegistrations: (point) => registryMap.get(point) ?? [],
			getNavItems: (scope) =>
				scope === "project"
					? projectNavItems
					: scope === "admin"
						? adminNavItems
						: appNavItems,
			isLoading,
		}),
		[registryMap, projectNavItems, adminNavItems, appNavItems, isLoading],
	);

	return (
		<PluginRegistryContext.Provider value={value}>
			{children}
		</PluginRegistryContext.Provider>
	);
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function usePluginRegistry() {
	return useContext(PluginRegistryContext);
}
