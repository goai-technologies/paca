import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useActorAvatar } from "./use-actor-avatar";

const bot = {
	id: "m1",
	user_id: "u1",
	full_name: "Bot",
	username: "bot",
	member_type: "agent",
	agent_type: "llm",
	agent_llm_provider: "openai",
};

vi.mock("@/lib/member-directory", () => ({
	useMemberDirectory: () => (id?: string | null) =>
		id === "m1" || id === "u1" ? bot : undefined,
}));

describe("useActorAvatar", () => {
	it("resolves a member by member id or account id", () => {
		const { result } = renderHook(() => useActorAvatar("p1"));
		expect(result.current({ id: "m1" }).type).toBe("agent");
		expect(result.current({ id: "u1" }).type).toBe("agent");
	});

	it("falls back to a human identity for a former member", () => {
		const { result } = renderHook(() => useActorAvatar("p1"));
		expect(
			result.current({ id: "gone", name: "Ex", avatarUrl: "https://x/a.png" }),
		).toEqual({ name: "Ex", type: "human", avatarUrl: "https://x/a.png" });
	});
});
