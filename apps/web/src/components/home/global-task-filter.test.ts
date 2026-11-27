import { describe, expect, it } from "vitest";

import {
	DEFAULT_GLOBAL_SEARCH,
	draftToSearchOptions,
	EMPTY_GLOBAL_FILTER,
	type GlobalTaskFilterDraft,
	groupByCanonicalName,
	shouldAutoStartGlobalSearch,
} from "./global-task-filter";

describe("groupByCanonicalName", () => {
	it("dedupes same names across projects and keeps distinct customs", () => {
		const groups = groupByCanonicalName([
			{ id: "t1", name: "Epic" },
			{ id: "t2", name: "epic" },
			{ id: "t3", name: "Bug" },
			{ id: "t4", name: "Waiting on Legal" },
			{ id: "t5", name: "  Bug  " },
		]);
		expect(groups).toEqual([
			{ key: "bug", label: "Bug", ids: ["t3", "t5"] },
			{ key: "epic", label: "Epic", ids: ["t1", "t2"] },
			{ key: "waiting on legal", label: "Waiting on Legal", ids: ["t4"] },
		]);
	});
});

describe("draftToSearchOptions", () => {
	it("returns empty options for an empty draft", () => {
		expect(draftToSearchOptions(EMPTY_GLOBAL_FILTER)).toEqual({
			sortBy: "created",
		});
		expect(DEFAULT_GLOBAL_SEARCH).toEqual({ sortBy: "created" });
	});

	it("maps importance, priority, QA and date filters", () => {
		const draft: GlobalTaskFilterDraft = {
			...EMPTY_GLOBAL_FILTER,
			projectIds: ["p1"],
			assigneeUserIds: ["u1"],
			importanceBuckets: [3],
			priorityValues: ["High"],
			tags: " alpha , beta ",
			createdAfter: "2026-01-01",
			createdBefore: "2026-01-31",
			qaByUserIds: ["u2", "u3"],
			devCompletedAfter: "2026-02-01",
			qaStartBefore: "2026-03-01",
		};
		const opts = draftToSearchOptions(draft, {
			memberLabelsById: {
				u2: "Jane",
				u3: "Alex",
			},
		});
		expect(opts.projectIds).toEqual(["p1"]);
		expect(opts.assigneeUserIds).toEqual(["u1"]);
		expect(opts.importanceRanges).toEqual([{ min: 50, max: 99 }]);
		expect(opts.tags).toEqual(["alpha", "beta"]);
		expect(opts.createdAfter).toBe("2026-01-01");
		expect(opts.createdBefore).toBe("2026-01-31");
		expect(opts.customFieldFilters?.priority).toEqual({ values: ["High"] });
		expect(opts.customFieldFilters?.qa_by).toEqual({
			values: ["Jane", "Alex"],
		});
		expect(opts.customFieldFilters?.dev_completion_date).toEqual({
			after: "2026-02-01",
			before: undefined,
		});
		expect(opts.customFieldFilters?.qa_start_date).toEqual({
			after: undefined,
			before: "2026-03-01",
		});
	});

	it("expands canonical status/type keys to all matching project ids", () => {
		const draft: GlobalTaskFilterDraft = {
			...EMPTY_GLOBAL_FILTER,
			statusIds: ["backlog", "waiting on legal"],
			taskTypeIds: ["epic", "bug"],
		};
		const opts = draftToSearchOptions(draft, {
			statusIdsByKey: {
				backlog: ["s-a", "s-b"],
				"waiting on legal": ["s-custom"],
			},
			taskTypeIdsByKey: {
				epic: ["ty-a", "ty-b"],
				bug: ["ty-c"],
			},
		});
		expect(opts.statusIds).toEqual(["s-a", "s-b", "s-custom"]);
		expect(opts.taskTypeIds).toEqual(["ty-a", "ty-b", "ty-c"]);
	});

	it("omits qa_by when selected user ids have no labels", () => {
		const draft: GlobalTaskFilterDraft = {
			...EMPTY_GLOBAL_FILTER,
			qaByUserIds: ["missing"],
		};
		expect(draftToSearchOptions(draft).customFieldFilters).toBeUndefined();
	});

	it("still accepts a plain member-label map as the second argument", () => {
		const draft: GlobalTaskFilterDraft = {
			...EMPTY_GLOBAL_FILTER,
			qaByUserIds: ["u2"],
		};
		expect(
			draftToSearchOptions(draft, { u2: "Jane" }).customFieldFilters?.qa_by,
		).toEqual({ values: ["Jane"] });
	});
});

describe("shouldAutoStartGlobalSearch", () => {
	it("starts for admins with projects when nothing applied yet", () => {
		expect(
			shouldAutoStartGlobalSearch({
				canAccessAdmin: true,
				projectCount: 2,
				cleared: false,
				current: null,
			}),
		).toBe(true);
	});

	it("does not start for non-admins, zero projects, cleared, or already applied", () => {
		expect(
			shouldAutoStartGlobalSearch({
				canAccessAdmin: false,
				projectCount: 2,
				cleared: false,
				current: null,
			}),
		).toBe(false);
		expect(
			shouldAutoStartGlobalSearch({
				canAccessAdmin: true,
				projectCount: 0,
				cleared: false,
				current: null,
			}),
		).toBe(false);
		expect(
			shouldAutoStartGlobalSearch({
				canAccessAdmin: true,
				projectCount: 2,
				cleared: true,
				current: null,
			}),
		).toBe(false);
		expect(
			shouldAutoStartGlobalSearch({
				canAccessAdmin: true,
				projectCount: 2,
				cleared: false,
				current: DEFAULT_GLOBAL_SEARCH,
			}),
		).toBe(false);
	});
});
