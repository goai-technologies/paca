import { describe, expect, it } from "vitest";
import {
	agentAvatar,
	memberAvatar,
	notificationActorAvatar,
	resolveAvatarSrc,
	serviceAccountAvatar,
} from "./provider-logos";

describe("resolveAvatarSrc", () => {
	it("prefers an uploaded avatar for every kind of account", () => {
		const agent = { agentType: "llm", llmProvider: "openai" };
		expect(resolveAvatarSrc("agent", "https://x/a.png", agent)).toBe(
			"https://x/a.png",
		);
		expect(resolveAvatarSrc("service_account", "https://x/a.png")).toBe(
			"https://x/a.png",
		);
		expect(resolveAvatarSrc("human", "https://x/a.png")).toBe(
			"https://x/a.png",
		);
	});

	it("falls back to the provider logo for an agent without an upload", () => {
		expect(
			resolveAvatarSrc("agent", null, {
				agentType: "llm",
				llmProvider: "OpenAI",
			}),
		).toBe("/provider-logos/openai.svg");
		expect(
			resolveAvatarSrc("agent", undefined, {
				agentType: "acp",
				acpProvider: "claude-code",
			}),
		).toBe("/provider-logos/claude-code.svg");
		expect(
			resolveAvatarSrc("agent", undefined, {
				agentType: "provider_cli",
				cliProvider: "codex",
			}),
		).toBe("/provider-logos/codex.svg");
	});

	it("returns no image for an unmapped provider, a service account or a human", () => {
		// EntityAvatar renders the Paca mark / initials for these.
		expect(
			resolveAvatarSrc("agent", null, {
				agentType: "llm",
				llmProvider: "custom",
			}),
		).toBeUndefined();
		expect(resolveAvatarSrc("service_account", null)).toBeUndefined();
		expect(resolveAvatarSrc("human", null)).toBeUndefined();
	});
});

describe("avatar adapters", () => {
	it("maps member_type onto the avatar subject", () => {
		const base = { full_name: "A", username: "a" };
		expect(memberAvatar({ ...base, member_type: "agent" }).type).toBe("agent");
		expect(memberAvatar({ ...base, member_type: "service_account" }).type).toBe(
			"service_account",
		);
		expect(memberAvatar({ ...base, member_type: "human" }).type).toBe("human");
		expect(memberAvatar(base).type).toBe("human");
	});

	it("keeps provider logos out of avatarUrl so uploads stay removable", () => {
		const identity = agentAvatar({
			name: "Bot",
			avatar_url: null,
			avatar_thumb_url: null,
			agent_type: "llm",
			llm_provider: "openai",
		} as Parameters<typeof agentAvatar>[0]);
		expect(identity.avatarUrl).toBeNull();
		expect(serviceAccountAvatar({ name: "CI" }).type).toBe("service_account");
	});

	it("maps a notification actor, including provider_cli agents", () => {
		const identity = notificationActorAvatar({
			actor_full_name: "",
			actor_username: "bot",
			actor_avatar_thumb_url: null,
			actor_member_type: "agent",
			actor_agent_type: "provider_cli",
			actor_agent_cli_provider: "codex",
		} as Parameters<typeof notificationActorAvatar>[0]);
		expect(identity.name).toBe("bot");
		expect(identity.type).toBe("agent");
		expect(
			resolveAvatarSrc(identity.type, identity.avatarUrl, identity.agent),
		).toBe("/provider-logos/codex.svg");
	});
});
