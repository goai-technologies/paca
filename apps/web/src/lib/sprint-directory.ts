import {
	IdDirectory,
	MAX_IDS_PER_LOOKUP,
	useIdDirectory,
} from "./id-directory";
import { listSprints, type Sprint } from "./interaction-api";

/** Resolves sprint ids to sprints without loading the whole sprint list: ids
 *  asked for while rendering are fetched in batches through the sprints `ids`
 *  filter, then cached. */
export class SprintDirectory extends IdDirectory<Sprint> {
	constructor(projectId: string) {
		super(
			async (ids) =>
				(await listSprints(projectId, { ids, pageSize: MAX_IDS_PER_LOOKUP }))
					.items,
			(s) => [s.id],
		);
	}
}

const directories = new Map<string, SprintDirectory>();

export function getSprintDirectory(projectId: string): SprintDirectory {
	let dir = directories.get(projectId);
	if (!dir) {
		dir = new SprintDirectory(projectId);
		directories.set(projectId, dir);
	}
	return dir;
}

/** Call after sprints are created, edited, completed or deleted so cached
 *  names and statuses are fetched again. */
export function invalidateSprintDirectory(projectId: string): void {
	directories.get(projectId)?.invalidate();
}

/** Lazy id → sprint lookup. The returned `getSprint` changes identity whenever
 *  new sprints resolve. */
export function useSprintDirectory(projectId: string | null | undefined) {
	return useIdDirectory(getSprintDirectory(projectId || ""));
}
