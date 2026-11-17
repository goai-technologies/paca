import { describe, expect, it } from "vitest";
import {
	type CommitmentCatalogItem,
	commitmentMatchesSearch,
	partitionCommitmentsByProject,
} from "./commitment-api";

const item = (
	id: string,
	overrides: Partial<CommitmentCatalogItem> = {},
): CommitmentCatalogItem => ({
	id,
	project_id: "proj-commitments",
	task_id_prefix: "COM",
	task_number: 1,
	ref: "COM-1",
	title: "Launch the customer portal",
	is_closed: false,
	custom_fields: {},
	...overrides,
});

describe("partitionCommitmentsByProject", () => {
	it("splits by home project and keeps the catalog order within each group", () => {
		const items = [
			item("a", { home_project_id: "p2" }),
			item("b", { home_project_id: "p1" }),
			item("c"),
			item("d", { home_project_id: "p1" }),
		];
		const { thisProject, otherProjects } = partitionCommitmentsByProject(
			items,
			"p1",
		);
		expect(thisProject.map((c) => c.id)).toEqual(["b", "d"]);
		expect(otherProjects.map((c) => c.id)).toEqual(["a", "c"]);
	});
});

describe("commitmentMatchesSearch", () => {
	const c = item("a", {
		ref: "COM-12",
		title: "Single sign-on",
		home_project_name: "Customer portal",
		home_project_task_id_prefix: "OPS",
	});

	it("matches everything on an empty query", () => {
		expect(commitmentMatchesSearch(c, "  ")).toBe(true);
	});

	it("matches the ref, title, project name and project prefix, ignoring case", () => {
		expect(commitmentMatchesSearch(c, "com-12")).toBe(true);
		expect(commitmentMatchesSearch(c, "SIGN-ON")).toBe(true);
		expect(commitmentMatchesSearch(c, "portal")).toBe(true);
		expect(commitmentMatchesSearch(c, "ops")).toBe(true);
	});

	it("does not match unrelated text or a missing project", () => {
		expect(commitmentMatchesSearch(c, "billing")).toBe(false);
		expect(
			commitmentMatchesSearch(item("b", { title: "Invoice export" }), "portal"),
		).toBe(false);
	});
});
