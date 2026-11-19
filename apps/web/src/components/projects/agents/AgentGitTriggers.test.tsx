import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));

vi.mock("@/lib/api-client", () => ({
	apiClient: { instance: { get: h.get, put: h.put } },
}));

import { AgentGitTriggers } from "./AgentGitTriggers";

const trig = (
	kind: string,
	enabled: boolean,
	over: Record<string, unknown> = {},
) => ({
	kind,
	enabled,
	explicit: false,
	supported: true,
	config: {},
	...over,
});

let triggers: unknown[] = [];

function renderTriggers(canWrite = true) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<AgentGitTriggers projectId="p1" agentId="a1" canWrite={canWrite} />
		</QueryClientProvider>,
	);
}

describe("AgentGitTriggers", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		triggers = [
			trig("mention", true),
			trig("own_cr_feedback", true),
			trig("ci_failure", true, { supported: false }),
			trig("auto_review", false),
		];
		h.get.mockImplementation(async () => ({ data: { data: triggers } }));
		h.put.mockImplementation(async () => ({ data: { data: triggers } }));
	});

	it("groups triggers and shows the ones no provider can deliver as unavailable", async () => {
		renderTriggers();
		expect(
			await screen.findByRole("switch", { name: "Mentioned" }),
		).toBeChecked();
		expect(
			screen.getByRole("switch", { name: "Feedback on its pull request" }),
		).toBeChecked();
		expect(
			screen.getByRole("switch", { name: "Review every pull request" }),
		).not.toBeChecked();
		expect(
			screen.getByRole("heading", { name: "Respond to requests" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("heading", {
				name: "Follow up on its own pull requests",
			}),
		).toBeInTheDocument();
		const ci = screen.getByRole("switch", {
			name: "CI failure on its pull request",
		});
		expect(ci).toHaveAttribute("aria-disabled", "true");
		expect(ci).not.toBeChecked();
		expect(
			screen.getAllByText(/not supported by the connected git platforms/i),
		).toHaveLength(1);
	});

	it("switches a trigger on", async () => {
		const user = userEvent.setup();
		renderTriggers();
		await user.click(
			await screen.findByRole("switch", { name: "Review every pull request" }),
		);
		await waitFor(() =>
			expect(h.put).toHaveBeenCalledWith(
				"/projects/p1/agents/a1/git/triggers/auto_review",
				{ enabled: true, config: undefined },
			),
		);
	});

	it("edits auto-review filters and sends them as lists", async () => {
		triggers = [
			trig("auto_review", true, {
				explicit: true,
				config: { branches: ["main"] },
			}),
		];
		const user = userEvent.setup();
		renderTriggers();
		const branches = await screen.findByLabelText(
			/only these target branches/i,
		);
		expect(branches).toHaveValue("main");
		await user.clear(branches);
		await user.type(branches, "main, release/1 ,");
		await user.type(
			screen.getByLabelText(/only these authors/i),
			"alice,  dependabot[[bot]",
		);
		await user.click(screen.getByRole("button", { name: /save filters/i }));
		await waitFor(() =>
			expect(h.put).toHaveBeenCalledWith(
				"/projects/p1/agents/a1/git/triggers/auto_review",
				{
					enabled: true,
					config: {
						branches: ["main", "release/1"],
						authors: ["alice", "dependabot[bot]"],
					},
				},
			),
		);
	});

	it("cannot be changed without agents:write", async () => {
		renderTriggers(false);
		expect(
			await screen.findByRole("switch", { name: "Mentioned" }),
		).toHaveAttribute("aria-disabled", "true");
	});

	it("keeps unsupported triggers visible but off", async () => {
		triggers = [trig("mention", true, { supported: false })];
		renderTriggers();
		const sw = await screen.findByRole("switch", { name: "Mentioned" });
		expect(sw).not.toBeChecked();
		expect(sw).toHaveAttribute("aria-disabled", "true");
	});

	it("renders nothing when the triggers could not be loaded", async () => {
		h.get.mockRejectedValue(new Error("boom"));
		const { container } = renderTriggers();
		await waitFor(() => expect(h.get).toHaveBeenCalled());
		await waitFor(() => expect(container).toBeEmptyDOMElement());
	});
});
