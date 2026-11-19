import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Pagination } from "./pagination";

describe("Pagination", () => {
	it("renders nothing for a single page", () => {
		const { container } = render(
			<Pagination page={1} totalPages={1} onPageChange={vi.fn()} />,
		);

		expect(container).toBeEmptyDOMElement();
	});

	it("renders nothing when there are no pages", () => {
		const { container } = render(
			<Pagination page={1} totalPages={0} onPageChange={vi.fn()} />,
		);

		expect(container).toBeEmptyDOMElement();
	});

	it("shows the current page and total", () => {
		render(<Pagination page={2} totalPages={5} onPageChange={vi.fn()} />);

		expect(screen.getByText("Page 2 of 5")).toBeInTheDocument();
	});

	it("renders every page number when the range is short", () => {
		render(<Pagination page={1} totalPages={5} onPageChange={vi.fn()} />);

		for (const n of [1, 2, 3, 4, 5]) {
			expect(
				screen.getByRole("button", { name: `Page ${n}` }),
			).toBeInTheDocument();
		}
	});

	it("collapses a long range with ellipses around the current page", () => {
		render(<Pagination page={10} totalPages={20} onPageChange={vi.fn()} />);

		expect(screen.getByRole("button", { name: "Page 1" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Page 20" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Page 9" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Page 11" })).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Page 5" }),
		).not.toBeInTheDocument();
	});

	it("disables Previous on the first page and Next on the last page", () => {
		const { rerender } = render(
			<Pagination page={1} totalPages={3} onPageChange={vi.fn()} />,
		);
		expect(
			screen.getByRole("button", { name: "Previous page" }),
		).toBeDisabled();
		expect(screen.getByRole("button", { name: "Next page" })).toBeEnabled();

		rerender(<Pagination page={3} totalPages={3} onPageChange={vi.fn()} />);
		expect(screen.getByRole("button", { name: "Previous page" })).toBeEnabled();
		expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
	});

	it("calls onPageChange with the target page when a page number is clicked", async () => {
		const onPageChange = vi.fn();
		render(<Pagination page={1} totalPages={5} onPageChange={onPageChange} />);

		await userEvent.click(screen.getByRole("button", { name: "Page 3" }));

		expect(onPageChange).toHaveBeenCalledWith(3);
	});

	it("calls onPageChange with page - 1 / page + 1 for Previous/Next", async () => {
		const onPageChange = vi.fn();
		render(<Pagination page={2} totalPages={5} onPageChange={onPageChange} />);

		await userEvent.click(
			screen.getByRole("button", { name: "Previous page" }),
		);
		expect(onPageChange).toHaveBeenCalledWith(1);

		await userEvent.click(screen.getByRole("button", { name: "Next page" }));
		expect(onPageChange).toHaveBeenCalledWith(3);
	});

	it("marks the current page button with aria-current", () => {
		render(<Pagination page={2} totalPages={5} onPageChange={vi.fn()} />);

		expect(screen.getByRole("button", { name: "Page 2" })).toHaveAttribute(
			"aria-current",
			"page",
		);
		expect(screen.getByRole("button", { name: "Page 3" })).not.toHaveAttribute(
			"aria-current",
		);
	});
});

describe("Pagination with a rows-per-page menu", () => {
	function setup(over: Partial<React.ComponentProps<typeof Pagination>> = {}) {
		const props = {
			page: 2,
			totalPages: 5,
			total: 95,
			pageSize: 20,
			onPageChange: vi.fn(),
			onPageSizeChange: vi.fn(),
			...over,
		};
		render(<Pagination {...props} />);
		return props;
	}

	it("shows the visible row range and the total", () => {
		setup();
		expect(screen.getByText("21–40 of 95")).toBeInTheDocument();
	});

	it("clamps the range on the last, partial page", () => {
		setup({ page: 5 });
		expect(screen.getByText("81–95 of 95")).toBeInTheDocument();
	});

	it("reports a new page size", async () => {
		const user = userEvent.setup();
		const props = setup();
		await user.selectOptions(screen.getByRole("combobox"), "50");
		expect(props.onPageSizeChange).toHaveBeenCalledWith(50);
	});

	it("stays on a single page so the size can be changed back", () => {
		setup({ page: 1, totalPages: 1, total: 15, pageSize: 50 });
		expect(screen.getByRole("combobox")).toBeInTheDocument();
		expect(screen.getByText("1–15 of 15")).toBeInTheDocument();
	});

	it("still shows the rows-per-page menu for a short list, without page buttons", () => {
		render(
			<Pagination
				page={1}
				totalPages={1}
				total={8}
				pageSize={10}
				onPageChange={vi.fn()}
				onPageSizeChange={vi.fn()}
			/>,
		);
		expect(screen.getByRole("combobox")).toBeInTheDocument();
		expect(screen.getByText("1–8 of 8")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Next page" }),
		).not.toBeInTheDocument();
	});

	it("renders nothing when there are no rows", () => {
		const { container } = render(
			<Pagination
				page={1}
				totalPages={1}
				total={0}
				pageSize={20}
				onPageChange={vi.fn()}
				onPageSizeChange={vi.fn()}
			/>,
		);
		expect(container).toBeEmptyDOMElement();
	});
});
