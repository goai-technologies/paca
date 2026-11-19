import { describe, expect, it } from "vitest";
import { sanitizeRedirect } from "./safe-redirect";

const origin = "https://paca.example.com";

describe("sanitizeRedirect", () => {
	it("keeps a same-origin path with its query and hash", () => {
		expect(
			sanitizeRedirect("/plugins/com.paca.github/cb?code=1&state=2#x", origin),
		).toBe("/plugins/com.paca.github/cb?code=1&state=2#x");
	});

	it.each([
		"https://evil.example.com/",
		"//evil.example.com/path",
		"/\\evil.example.com",
		"javascript:alert(1)",
		"relative/path",
		"",
		undefined,
		42,
	])("rejects %j", (value) => {
		expect(sanitizeRedirect(value, origin)).toBeNull();
	});
});
