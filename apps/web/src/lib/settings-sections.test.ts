import { describe, expect, it } from "vitest";
import { pluginSectionId, resolveSectionFromHash } from "./settings-sections";

const builtin = ["general", "roles", "task-statuses"];
const tabs = [
	{ pluginId: "com.paca.github", component: "GitHubSettingsTab" },
	{ pluginId: "com.paca.github", component: "GitHubOther" },
	{ pluginId: "com.paca.checklist", component: "ChecklistSettings" },
];

describe("resolveSectionFromHash", () => {
	it("opens a built-in tab by id, with or without the #", () => {
		expect(resolveSectionFromHash("#roles", builtin, tabs)).toBe("roles");
		expect(resolveSectionFromHash("task-statuses", builtin, tabs)).toBe(
			"task-statuses",
		);
	});

	it("opens one specific plugin tab", () => {
		expect(
			resolveSectionFromHash(
				"#plugin:com.paca.github:GitHubOther",
				builtin,
				tabs,
			),
		).toBe(pluginSectionId(tabs[1]));
	});

	it("opens a plugin's first tab from the short form", () => {
		expect(
			resolveSectionFromHash("#plugin:com.paca.github", builtin, tabs),
		).toBe(pluginSectionId(tabs[0]));
	});

	it("accepts a percent-encoded hash", () => {
		expect(
			resolveSectionFromHash("#plugin%3Acom.paca.checklist", builtin, tabs),
		).toBe(pluginSectionId(tabs[2]));
	});

	it.each([
		"",
		"#",
		"#nope",
		"#danger", // a built-in the caller is not allowed to see is simply not passed in
		"#plugin:com.unknown",
		"#plugin:com.paca.github:Missing",
		"#%E0%A4%A", // malformed encoding
	])("ignores %j", (hash) => {
		expect(resolveSectionFromHash(hash, builtin, tabs)).toBeNull();
	});

	it("never opens a plugin tab that is not in the visible list", () => {
		expect(
			resolveSectionFromHash("#plugin:com.paca.github", builtin, []),
		).toBeNull();
	});
});
