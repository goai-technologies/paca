import { useCallback, useSyncExternalStore } from "react";

// How long a resolved item is served without refreshing it, and how long to
// wait before retrying ids whose lookup failed.
const FRESH_MS = 5 * 60 * 1000;
const RETRY_MS = 15 * 1000;
// Ids requested within this window are fetched together.
const BATCH_DELAY_MS = 10;
/** Most ids one batch lookup asks the server for. */
export const MAX_IDS_PER_LOOKUP = 100;

interface Entry<T> {
	/** null: looked up and not found (deleted, not visible, no longer a member…). */
	item: T | null;
	at: number;
}

/** Resolves ids to records without loading whole lists: ids asked for while
 *  rendering are collected and fetched in batches through a list endpoint's
 *  `ids` filter, then cached.
 *
 *  `get` returns undefined until an id has been resolved (and for ids that
 *  don't exist); subscribers are notified as each batch lands. */
export class IdDirectory<T> {
	private entries = new Map<string, Entry<T>>();
	private failedAt = new Map<string, number>();
	private pending = new Set<string>();
	private inflight = new Set<string>();
	private listeners = new Set<() => void>();
	private version = 0;
	private timer: ReturnType<typeof setTimeout> | undefined;

	private readonly fetchBatch: (ids: string[]) => Promise<T[]>;
	private readonly keysOf: (item: T) => (string | null | undefined)[];

	/**
	 * @param fetchBatch fetches the records for up to MAX_IDS_PER_LOOKUP ids.
	 * @param keysOf every id an item can be looked up by (its own id, an
	 *   alternate id…).
	 */
	constructor(
		fetchBatch: (ids: string[]) => Promise<T[]>,
		keysOf: (item: T) => (string | null | undefined)[],
	) {
		this.fetchBatch = fetchBatch;
		this.keysOf = keysOf;
	}

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	getVersion = (): number => this.version;

	get(id: string | null | undefined): T | undefined {
		if (!id) return undefined;
		const entry = this.entries.get(id);
		const now = Date.now();
		if (!entry || now - entry.at > FRESH_MS) this.request(id, now);
		return entry?.item ?? undefined;
	}

	/** Records items already fetched elsewhere (a picker page, an embedded
	 *  list) so they needn't be asked for again. */
	seed(items: T[]): void {
		const now = Date.now();
		for (const item of items) {
			for (const key of this.keysOf(item)) {
				if (key) this.entries.set(key, { item, at: now });
			}
		}
		if (items.length > 0) this.bump();
	}

	/** Drops everything cached; ids in use are fetched again on next read. */
	invalidate(): void {
		this.entries.clear();
		this.failedAt.clear();
		this.pending.clear();
		this.bump();
	}

	private request(id: string, now: number): void {
		if (this.pending.has(id) || this.inflight.has(id)) return;
		const failed = this.failedAt.get(id);
		if (failed !== undefined && now - failed < RETRY_MS) return;
		this.pending.add(id);
		if (this.timer === undefined) {
			this.timer = setTimeout(() => void this.flush(), BATCH_DELAY_MS);
		}
	}

	private async flush(): Promise<void> {
		this.timer = undefined;
		const ids = [...this.pending];
		this.pending.clear();
		for (const id of ids) this.inflight.add(id);
		for (let i = 0; i < ids.length; i += MAX_IDS_PER_LOOKUP) {
			await this.fetchChunk(ids.slice(i, i + MAX_IDS_PER_LOOKUP));
		}
	}

	private async fetchChunk(chunk: string[]): Promise<void> {
		try {
			const items = await this.fetchBatch(chunk);
			const now = Date.now();
			for (const id of chunk) this.entries.set(id, { item: null, at: now });
			for (const item of items) {
				for (const key of this.keysOf(item)) {
					if (key && this.entries.has(key)) {
						this.entries.set(key, { item, at: now });
					}
				}
			}
			for (const id of chunk) this.failedAt.delete(id);
		} catch {
			const now = Date.now();
			for (const id of chunk) this.failedAt.set(id, now);
		} finally {
			for (const id of chunk) this.inflight.delete(id);
			this.bump();
		}
	}

	private bump(): void {
		this.version++;
		for (const listener of this.listeners) listener();
	}
}

/** Lazy id → item lookup backed by `dir`. The returned function changes
 *  identity whenever new items resolve, so memos and callbacks that depend on
 *  it recompute. */
export function useIdDirectory<T>(dir: IdDirectory<T>) {
	const version = useSyncExternalStore(dir.subscribe, dir.getVersion);
	// biome-ignore lint/correctness/useExhaustiveDependencies: version is the invalidation signal
	return useCallback(
		(id: string | null | undefined) => dir.get(id),
		[dir, version],
	);
}
