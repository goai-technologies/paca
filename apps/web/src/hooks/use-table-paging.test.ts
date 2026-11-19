import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { usePagedSlice, useTablePaging } from "./use-table-paging";

beforeEach(() => localStorage.clear());

describe("useTablePaging", () => {
	it("starts on page 1 with the default size", () => {
		const { result } = renderHook(() => useTablePaging("t1"));
		expect(result.current.page).toBe(1);
		expect(result.current.pageSize).toBe(20);
	});

	it("remembers the chosen size per table and returns to page 1", () => {
		const { result } = renderHook(() => useTablePaging("t2"));
		act(() => result.current.setPage(4));
		act(() => result.current.setPageSize(50));
		expect(result.current.page).toBe(1);
		expect(result.current.pageSize).toBe(50);

		const again = renderHook(() => useTablePaging("t2"));
		expect(again.result.current.pageSize).toBe(50);
		const other = renderHook(() => useTablePaging("other"));
		expect(other.result.current.pageSize).toBe(20);
	});

	it("ignores a stored size that is not an option", () => {
		localStorage.setItem("paca:page-size:t3", "37");
		const { result } = renderHook(() => useTablePaging("t3"));
		expect(result.current.pageSize).toBe(20);
	});
});

describe("usePagedSlice", () => {
	const items = Array.from({ length: 45 }, (_, i) => i + 1);

	it("slices to the current page", () => {
		const { result } = renderHook(() => usePagedSlice("s1", items));
		expect(result.current.pageItems).toHaveLength(20);
		act(() => result.current.paginationProps.onPageChange(3));
		expect(result.current.pageItems).toEqual([41, 42, 43, 44, 45]);
		expect(result.current.paginationProps.totalPages).toBe(3);
	});

	it("clamps the page when rows are removed", () => {
		const { result, rerender } = renderHook(
			({ list }) => usePagedSlice("s2", list),
			{ initialProps: { list: items } },
		);
		act(() => result.current.paginationProps.onPageChange(3));
		rerender({ list: items.slice(0, 25) });
		expect(result.current.paginationProps.page).toBe(2);
		expect(result.current.pageItems).toEqual([21, 22, 23, 24, 25]);
	});
});
