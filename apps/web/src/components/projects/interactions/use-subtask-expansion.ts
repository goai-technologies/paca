import { useCallback, useSyncExternalStore } from "react";
import type { ViewConfig } from "@/lib/interaction-api";

export type SubtaskMode = NonNullable<ViewConfig["subtask_mode"]>;

/** How a view shows subtasks; unset means nested and collapsed. */
export function resolveSubtaskMode(config?: ViewConfig): SubtaskMode {
	const mode = config?.subtask_mode;
	return mode === "expanded" || mode === "hidden" ? mode : "collapsed";
}

/**
 * Per-user, per-view record of the rows the user opened or closed by hand,
 * on top of the view's default (collapsed or expanded, see SubtaskMode).
 * Kept in localStorage so one person's choices never alter a shared view,
 * and in a module-level store so every consumer of a view stays in sync.
 */
type Overrides = Readonly<Record<string, boolean>>;

const EMPTY: Overrides = {};
const states = new Map<string, Overrides>();
const listeners = new Set<() => void>();

const storageKey = (scope: string) => `paca:subtask-overrides:${scope}`;

function load(scope: string): Overrides {
	try {
		const raw = localStorage.getItem(storageKey(scope));
		const parsed: unknown = raw ? JSON.parse(raw) : {};
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Overrides;
		}
	} catch {
		// storage unavailable — defaults apply for this session
	}
	return EMPTY;
}

function getState(scope: string): Overrides {
	let state = states.get(scope);
	if (!state) {
		state = load(scope);
		states.set(scope, state);
	}
	return state;
}

function setState(scope: string, next: Overrides) {
	states.set(scope, next);
	try {
		localStorage.setItem(storageKey(scope), JSON.stringify(next));
	} catch {
		// storage unavailable — the choice lasts for this session
	}
	for (const l of listeners) l();
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** Test helper: forget cached state so the next read reloads from storage. */
export function resetSubtaskViewState() {
	states.clear();
	for (const l of listeners) l();
}

export function useSubtaskExpansion(
	projectId: string,
	viewKey: string,
	defaultExpanded: boolean,
) {
	const scope = `${projectId}:${viewKey}`;
	const overrides = useSyncExternalStore(
		subscribe,
		() => getState(scope),
		() => getState(scope),
	);

	const isExpanded = useCallback(
		(taskId: string) => overrides[taskId] ?? defaultExpanded,
		[overrides, defaultExpanded],
	);

	const toggle = useCallback(
		(taskId: string) => {
			const current = getState(scope);
			const next = !(current[taskId] ?? defaultExpanded);
			// Back at the default: drop the entry so the record doesn't grow.
			const { [taskId]: _dropped, ...rest } = current;
			setState(
				scope,
				next === defaultExpanded ? rest : { ...rest, [taskId]: next },
			);
		},
		[scope, defaultExpanded],
	);

	return { isExpanded, toggle };
}
