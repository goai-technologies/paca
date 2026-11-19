import { afterEach, describe, expect, it } from "vitest";
import {
	ACTIVITY_WIDTH_DEFAULT,
	ACTIVITY_WIDTH_MAX,
	ACTIVITY_WIDTH_MIN,
	ACTIVITY_WIDTH_STORAGE_KEY,
	clampActivityWidth,
	maxActivityWidth,
	readStoredActivityWidth,
	storeActivityWidth,
} from "./activity-pane-width";

afterEach(() => localStorage.clear());

describe("maxActivityWidth", () => {
	it("is capped at the hard maximum on wide windows", () => {
		expect(maxActivityWidth(3000)).toBe(ACTIVITY_WIDTH_MAX);
	});
	it("is half the window on narrower windows", () => {
		expect(maxActivityWidth(1200)).toBe(600);
	});
	it("never drops below the minimum", () => {
		expect(maxActivityWidth(400)).toBe(ACTIVITY_WIDTH_MIN);
	});
});

describe("clampActivityWidth", () => {
	it("clamps to min and max and rounds", () => {
		expect(clampActivityWidth(10, 2000)).toBe(ACTIVITY_WIDTH_MIN);
		expect(clampActivityWidth(5000, 2000)).toBe(ACTIVITY_WIDTH_MAX);
		expect(clampActivityWidth(400.6, 2000)).toBe(401);
	});
	it("respects the 50% window cap", () => {
		expect(clampActivityWidth(700, 1200)).toBe(600);
	});
});

describe("stored width", () => {
	it("falls back to the default when nothing or junk is stored", () => {
		expect(readStoredActivityWidth(2000)).toBe(ACTIVITY_WIDTH_DEFAULT);
		localStorage.setItem(ACTIVITY_WIDTH_STORAGE_KEY, "abc");
		expect(readStoredActivityWidth(2000)).toBe(ACTIVITY_WIDTH_DEFAULT);
		localStorage.setItem(ACTIVITY_WIDTH_STORAGE_KEY, "-5");
		expect(readStoredActivityWidth(2000)).toBe(ACTIVITY_WIDTH_DEFAULT);
	});
	it("round-trips and clamps against the current window", () => {
		storeActivityWidth(500);
		expect(readStoredActivityWidth(2000)).toBe(500);
		expect(readStoredActivityWidth(800)).toBe(400);
	});
});
