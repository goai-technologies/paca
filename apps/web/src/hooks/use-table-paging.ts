import { useCallback, useMemo, useState } from "react";

import { PAGE_SIZE_OPTIONS } from "@/components/ui/pagination";

const DEFAULT_PAGE_SIZE = 20;

function storageKey(key: string) {
	return `paca:page-size:${key}`;
}

function readPageSize(key: string, fallback: number): number {
	try {
		const raw = Number(localStorage.getItem(storageKey(key)));
		if ((PAGE_SIZE_OPTIONS as readonly number[]).includes(raw)) return raw;
	} catch {
		/* storage unavailable: use the default */
	}
	return fallback;
}

/** Page number and rows-per-page for a table. The page size is remembered per
 *  table (`key`) in this browser; changing it returns to the first page. */
export function useTablePaging(
	key: string,
	defaultPageSize = DEFAULT_PAGE_SIZE,
) {
	const [page, setPage] = useState(1);
	const [pageSize, setPageSizeState] = useState(() =>
		readPageSize(key, defaultPageSize),
	);
	const setPageSize = useCallback(
		(size: number) => {
			setPageSizeState(size);
			setPage(1);
			try {
				localStorage.setItem(storageKey(key), String(size));
			} catch {
				/* not persisted */
			}
		},
		[key],
	);
	return { page, pageSize, setPage, setPageSize };
}

/** `useTablePaging` over a list already held in memory (small, bounded lists
 *  such as a project's statuses): slices it to the current page and clamps the
 *  page when rows are removed. Returns the props for `<Pagination>`. */
export function usePagedSlice<T>(key: string, items: T[]) {
	const { page, pageSize, setPage, setPageSize } = useTablePaging(key);
	const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
	const current = Math.min(page, totalPages);
	const pageItems = useMemo(
		() => items.slice((current - 1) * pageSize, current * pageSize),
		[items, current, pageSize],
	);
	return {
		pageItems,
		paginationProps: {
			page: current,
			totalPages,
			onPageChange: setPage,
			total: items.length,
			pageSize,
			onPageSizeChange: setPageSize,
		},
	};
}
