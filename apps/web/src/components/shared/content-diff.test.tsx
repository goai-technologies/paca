import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ContentDiff } from "./content-diff";

function documentWithLink(text: string) {
	return [
		{
			type: "paragraph",
			content: [
				{
					type: "link",
					href: "https://example.com/docs",
					content: [{ type: "text", text, styles: {} }],
				},
			],
		},
	];
}

describe("ContentDiff link labels", () => {
	it("shows changed labels instead of reporting no differences", () => {
		const { container } = render(
			<ContentDiff
				oldContent={documentWithLink("Old guide")}
				newContent={documentWithLink("New guide")}
			/>,
		);
		expect(screen.getByText("Old guide")).toBeInTheDocument();
		expect(screen.getByText("New guide")).toBeInTheDocument();
		expect(container.textContent).toContain("-");
		expect(container.textContent).toContain("+");
	});

	it("shows deleted linked text", () => {
		render(
			<ContentDiff
				oldContent={documentWithLink("删除这段说明")}
				newContent={[]}
			/>,
		);
		expect(screen.getByText("删除这段说明")).toBeInTheDocument();
	});
});
