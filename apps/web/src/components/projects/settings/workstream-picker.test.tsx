import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { readWorkstream, WorkstreamPicker } from "./workstream-picker";

describe("WorkstreamPicker", () => {
	it("labels the platform workstream PPE but still stores platform", async () => {
		const onChange = vi.fn();
		const user = userEvent.setup();
		render(<WorkstreamPicker value="internal" onChange={onChange} />);

		const radios = screen.getAllByRole("radio");
		expect(radios.map((r) => r.textContent)).toEqual([
			"Delivery",
			"PPE",
			"Internal",
		]);
		expect(screen.queryByText("Platform")).not.toBeInTheDocument();

		await user.click(screen.getByRole("radio", { name: "PPE" }));
		expect(onChange).toHaveBeenCalledWith("platform");
	});

	it("marks a stored platform value as the PPE option", () => {
		render(
			<WorkstreamPicker
				value={readWorkstream({ default_workstream: "platform" })}
				onChange={vi.fn()}
			/>,
		);

		expect(screen.getByRole("radio", { name: "PPE" })).toHaveAttribute(
			"aria-checked",
			"true",
		);
	});
});
