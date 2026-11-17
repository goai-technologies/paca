import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { useDebouncedCallback } from "@/hooks/use-debounced-callback";
import {
	environmentFoldersInfiniteQueryOptions,
	environmentsInfiniteQueryOptions,
} from "@/lib/environment-api";

function useDebouncedQuery() {
	const [query, setQuery] = useState("");
	const [debouncedQuery, setDebouncedQuery] = useState("");
	const applyQuery = useDebouncedCallback(setDebouncedQuery, 250);
	return {
		query,
		debouncedQuery,
		onQueryChange: (value: string) => {
			setQuery(value);
			applyQuery(value);
		},
	};
}

/** Server-side searchable, cursor-paged environment list for pickers. Nothing
 *  is fetched until `enabled`; typing re-queries the server after a short
 *  pause while the pages already loaded stay on screen. */
export function useEnvironmentSearch(projectId: string, enabled: boolean) {
	const { query, debouncedQuery, onQueryChange } = useDebouncedQuery();
	const result = useInfiniteQuery({
		...environmentsInfiniteQueryOptions(projectId, debouncedQuery),
		enabled: enabled && !!projectId,
		placeholderData: keepPreviousData,
	});
	const environments = useMemo(
		() => result.data?.pages.flatMap((p) => p.items) ?? [],
		[result.data],
	);
	return {
		query,
		onQueryChange,
		environments,
		isLoading: result.isLoading,
		hasMore: !!result.hasNextPage,
		isLoadingMore: result.isFetchingNextPage,
		isError: result.isFetchNextPageError,
		onLoadMore: () => void result.fetchNextPage(),
	};
}

/** Same as {@link useEnvironmentSearch}, for one environment's folders. */
export function useEnvironmentFolderSearch(
	projectId: string,
	environmentId: string,
	enabled: boolean,
) {
	const { query, debouncedQuery, onQueryChange } = useDebouncedQuery();
	const result = useInfiniteQuery({
		...environmentFoldersInfiniteQueryOptions(
			projectId,
			environmentId,
			debouncedQuery,
		),
		enabled: enabled && !!projectId && !!environmentId,
		placeholderData: keepPreviousData,
	});
	const folders = useMemo(
		() => result.data?.pages.flatMap((p) => p.items) ?? [],
		[result.data],
	);
	return {
		query,
		onQueryChange,
		folders,
		isLoading: result.isLoading,
		hasMore: !!result.hasNextPage,
		isLoadingMore: result.isFetchingNextPage,
		isError: result.isFetchNextPageError,
		onLoadMore: () => void result.fetchNextPage(),
	};
}
