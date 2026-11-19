import { describe, expect, it } from "vitest";
import { pickSubtaskMode } from "./view-settings-panel";

describe("pickSubtaskMode", () => {
	it("stores expanded and hidden as chosen", () => {
		expect(pickSubtaskMode("expanded", {})).toBe("expanded");
		expect(pickSubtaskMode("hidden", {})).toBe("hidden");
	});

	it("leaves collapsed unset when the team default is already collapsed", () => {
		expect(pickSubtaskMode("collapsed", {})).toBeUndefined();
		expect(
			pickSubtaskMode("collapsed", { subtask_mode: "collapsed" }),
		).toBeUndefined();
	});

	it("stores collapsed explicitly so it can override another team default", () => {
		expect(pickSubtaskMode("collapsed", { subtask_mode: "expanded" })).toBe(
			"collapsed",
		);
		expect(pickSubtaskMode("collapsed", { subtask_mode: "hidden" })).toBe(
			"collapsed",
		);
	});
});
