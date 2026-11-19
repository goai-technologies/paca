import { afterEach, describe, expect, it, vi } from "vitest";
import { copyToClipboard } from "./clipboard";

function stubExecCommand(result: boolean | Error) {
	const exec = vi.fn(() => {
		if (result instanceof Error) throw result;
		return result;
	});
	Object.defineProperty(document, "execCommand", {
		value: exec,
		configurable: true,
		writable: true,
	});
	return exec;
}

describe("copyToClipboard", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		Reflect.deleteProperty(document, "execCommand");
		document.body.innerHTML = "";
	});

	it("uses navigator.clipboard when available", async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		vi.stubGlobal("navigator", { clipboard: { writeText } });
		expect(await copyToClipboard("hi")).toBe(true);
		expect(writeText).toHaveBeenCalledWith("hi");
	});

	it("falls back to execCommand when navigator.clipboard is unavailable", async () => {
		vi.stubGlobal("navigator", {});
		const exec = stubExecCommand(true);
		expect(await copyToClipboard("hi")).toBe(true);
		expect(exec).toHaveBeenCalledWith("copy");
		expect(document.querySelector("textarea")).toBeNull();
	});

	it("falls back when writeText rejects, and reports failure", async () => {
		vi.stubGlobal("navigator", {
			clipboard: { writeText: vi.fn().mockRejectedValue(new Error("no")) },
		});
		stubExecCommand(false);
		expect(await copyToClipboard("hi")).toBe(false);
	});

	it("removes the textarea and restores focus when execCommand throws", async () => {
		vi.stubGlobal("navigator", {});
		stubExecCommand(new Error("boom"));
		const button = document.createElement("button");
		document.body.appendChild(button);
		button.focus();
		expect(await copyToClipboard("hi")).toBe(false);
		expect(document.querySelector("textarea")).toBeNull();
		expect(document.activeElement).toBe(button);
	});

	it("mounts the textarea inside the active dialog to stay within its focus trap", async () => {
		vi.stubGlobal("navigator", {});
		const dialog = document.createElement("div");
		dialog.setAttribute("role", "dialog");
		const button = document.createElement("button");
		dialog.appendChild(button);
		document.body.appendChild(dialog);
		button.focus();
		let parent: Element | null | undefined;
		Object.defineProperty(document, "execCommand", {
			value: vi.fn(() => {
				parent = document.querySelector("textarea")?.parentElement;
				return true;
			}),
			configurable: true,
			writable: true,
		});
		expect(await copyToClipboard("hi")).toBe(true);
		expect(parent).toBe(dialog);
	});
});
