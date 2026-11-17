import { useQueries } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import {
	existingMemberIdsQueryOptions,
	PROJECT_MEMBERS_MAX_IDS,
} from "@/lib/project-api";

// Fixed chunk boundaries (in the order candidates are listed) keep earlier
// chunks' cache entries valid as a paginated candidate list grows.
const CHUNK_SIZE = PROJECT_MEMBERS_MAX_IDS;

/** Works out which of `candidateIds` are already members of the project by
 *  asking the server about just those ids, instead of loading the whole team.
 *  `resolvedIds` holds the candidates whose answer has arrived, so callers can
 *  hold back rows until they know whether to hide them. */
export function useExistingMemberIds(
	projectId: string,
	candidateIds: string[],
	enabled: boolean,
): { existingIds: Set<string>; resolvedIds: Set<string> } {
	const chunks = useMemo(() => {
		const out: string[][] = [];
		for (let i = 0; i < candidateIds.length; i += CHUNK_SIZE) {
			out.push(candidateIds.slice(i, i + CHUNK_SIZE));
		}
		return out;
	}, [candidateIds]);

	// A stable combine keeps the returned sets referentially stable until a
	// lookup actually changes.
	const combine = useCallback(
		(results: { isSuccess: boolean; isError: boolean; data?: string[] }[]) => {
			const existingIds = new Set<string>();
			const resolvedIds = new Set<string>();
			results.forEach((result, i) => {
				// A failed lookup resolves its chunk as "no known members": the
				// add request itself still rejects a duplicate.
				if (!result.isSuccess && !result.isError) return;
				for (const id of chunks[i] ?? []) resolvedIds.add(id);
				for (const id of result.data ?? []) existingIds.add(id);
			});
			return { existingIds, resolvedIds };
		},
		[chunks],
	);

	return useQueries({
		queries: chunks.map((ids) => ({
			...existingMemberIdsQueryOptions(projectId, ids),
			enabled,
		})),
		combine,
	});
}
