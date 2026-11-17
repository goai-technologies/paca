import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { LoadMoreSentinel } from "./load-more-sentinel";

describe("LoadMoreSentinel", () => {
	it("renders nothing when there are no more pages", () => {
		const { container } = render(
			<LoadMoreSentinel
				hasMore={false}
				isLoadingMore={false}
				onLoadMore={vi.fn()}
			/>,
		);
		expect(container).toBeEmptyDOMElement();
	});

	it("loads the next page on click", async () => {
		const onLoadMore = vi.fn();
		render(
			<LoadMoreSentinel
				hasMore
				isLoadingMore={false}
				onLoadMore={onLoadMore}
			/>,
		);
		await userEvent.click(screen.getByRole("button", { name: /load more/i }));
		expect(onLoadMore).toHaveBeenCalledTimes(1);
	});

	it("disables the button while a page is loading", () => {
		render(<LoadMoreSentinel hasMore isLoadingMore onLoadMore={vi.fn()} />);
		expect(screen.getByRole("button")).toBeDisabled();
	});

	it("loads when the sentinel scrolls into view", () => {
		let trigger: (entries: { isIntersecting: boolean }[]) => void = () => {};
		vi.stubGlobal(
			"IntersectionObserver",
			class {
				constructor(cb: typeof trigger) {
					trigger = cb;
				}
				observe() {}
				disconnect() {}
			},
		);
		const onLoadMore = vi.fn();
		render(
			<LoadMoreSentinel
				hasMore
				isLoadingMore={false}
				onLoadMore={onLoadMore}
			/>,
		);
		trigger([{ isIntersecting: true }]);
		expect(onLoadMore).toHaveBeenCalledTimes(1);
		vi.unstubAllGlobals();
	});
});
