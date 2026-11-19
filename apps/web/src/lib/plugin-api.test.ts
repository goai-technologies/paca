import { describe, expect, it } from "vitest";
import { buildNavItems, buildRegistryMap, type Plugin } from "./plugin-api";

function makePlugin(overrides: Partial<Plugin> = {}): Plugin {
	return {
		id: "uuid-1",
		name: "com.paca.example",
		version: "1.0.0",
		enabled: true,
		installed_at: "2026-01-01T00:00:00Z",
		updated_at: "2026-01-01T00:00:00Z",
		manifest: {
			id: "com.paca.example",
			displayName: "Example",
			version: "1.0.0",
			frontend: {
				remoteEntryUrl: "https://example.test/remoteEntry.js",
				extensionPoints: [
					{ point: "project.settings.tab", component: "SettingsTab" },
				],
			},
		},
		...overrides,
	};
}

describe("buildRegistryMap", () => {
	it("carries requiredPermission through from the manifest to the registration", () => {
		const plugin = makePlugin({
			manifest: {
				id: "com.paca.example",
				displayName: "Example",
				version: "1.0.0",
				frontend: {
					remoteEntryUrl: "https://example.test/remoteEntry.js",
					extensionPoints: [
						{
							point: "project.settings.tab",
							component: "SettingsTab",
							requiredPermission: "projects:write",
						},
					],
				},
			},
		});

		const registry = buildRegistryMap([plugin]);
		const regs = registry.get("project.settings.tab");

		expect(regs).toHaveLength(1);
		expect(regs?.[0].requiredPermission).toBe("projects:write");
	});

	it("leaves requiredPermission undefined when the manifest omits it", () => {
		const registry = buildRegistryMap([makePlugin()]);
		const regs = registry.get("project.settings.tab");

		expect(regs).toHaveLength(1);
		expect(regs?.[0].requiredPermission).toBeUndefined();
	});

	it("excludes registrations from disabled plugins", () => {
		const registry = buildRegistryMap([makePlugin({ enabled: false })]);
		expect(registry.get("project.settings.tab")).toBeUndefined();
	});
});

describe("buildNavItems", () => {
	function appPagePlugin(): Plugin {
		return makePlugin({
			manifest: {
				id: "com.paca.example",
				displayName: "Example",
				version: "1.0.0",
				frontend: {
					remoteEntryUrl: "https://example.test/remoteEntry.js",
					extensionPoints: [{ point: "app.page", component: "CallbackPage" }],
					navItems: [
						{
							scope: "app",
							slug: "callback",
							label: "Callback",
							component: "CallbackPage",
							requiredPermission: "example:manage",
						},
					],
				},
			},
		});
	}

	it("routes an app-scope nav item to its app.page registration", () => {
		const items = buildNavItems([appPagePlugin()], "app");

		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({
			pluginId: "com.paca.example",
			scope: "app",
			slug: "callback",
			requiredPermission: "example:manage",
		});
		expect(items[0].registration.component).toBe("CallbackPage");
	});

	it("keeps app pages out of the project and admin sidebars", () => {
		const plugin = appPagePlugin();
		expect(buildNavItems([plugin], "project")).toEqual([]);
		expect(buildNavItems([plugin], "admin")).toEqual([]);
	});

	it("skips an app nav item that has no app.page registration", () => {
		const plugin = appPagePlugin();
		plugin.manifest.frontend = {
			...plugin.manifest.frontend,
			extensionPoints: [],
		};
		expect(buildNavItems([plugin], "app")).toEqual([]);
	});
});
