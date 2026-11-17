import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as agentApi from "./agent-api";
import { AgentDirectory } from "./agent-directory";

const agent = (id: string) =>
	({ id, name: `Agent ${id}`, handle: id }) as agentApi.Agent;

const page = (items: agentApi.Agent[]) => ({
	items,
	page_size: 100,
	next_cursor: null,
});

describe("AgentDirectory", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("looks project agents up by id in one batch", async () => {
		const spy = vi
			.spyOn(agentApi, "listAgents")
			.mockResolvedValue(page([agent("a1"), agent("a2")]));
		const dir = new AgentDirectory("p1");

		expect(dir.get("a1")).toBeUndefined();
		expect(dir.get("a2")).toBeUndefined();
		await vi.runAllTimersAsync();

		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy.mock.calls[0][0]).toBe("p1");
		expect(spy.mock.calls[0][1]?.ids).toEqual(["a1", "a2"]);
		expect(dir.get("a1")?.name).toBe("Agent a1");
	});

	it("uses the global chattable list when there is no project", async () => {
		const project = vi.spyOn(agentApi, "listAgents");
		const global = vi
			.spyOn(agentApi, "listChattableAgents")
			.mockResolvedValue(page([agent("g1")]));
		const dir = new AgentDirectory(null);

		dir.get("g1");
		await vi.runAllTimersAsync();

		expect(project).not.toHaveBeenCalled();
		expect(global).toHaveBeenCalledTimes(1);
		expect(dir.get("g1")?.handle).toBe("g1");
	});

	it("remembers ids that are not visible and does not ask again", async () => {
		const spy = vi.spyOn(agentApi, "listAgents").mockResolvedValue(page([]));
		const dir = new AgentDirectory("p1");

		dir.get("gone");
		await vi.runAllTimersAsync();
		expect(dir.get("gone")).toBeUndefined();
		await vi.runAllTimersAsync();
		expect(spy).toHaveBeenCalledTimes(1);
	});
});
