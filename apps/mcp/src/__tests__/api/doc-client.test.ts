import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../utils/index.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../utils/index.js")>();
	return {
		...actual,
		markdownToBlocknote: vi.fn((md: string) => [
			{ type: "paragraph", content: [{ type: "text", text: md }] },
		]),
	};
});

import { PacaAPIDocClient } from "../../api/doc-client.js";

const CONFIG = { baseURL: "https://api.example.com", apiKey: "key123" };

function okEnvelope(data: any) {
	return {
		ok: true,
		json: async () => ({ success: true, data }),
		text: async () => "",
	};
}

function rawOk(data: any) {
	return { ok: true, json: async () => data, text: async () => "" };
}

function errorResponse(status = 400, body = "Bad Request") {
	return {
		ok: false,
		status,
		statusText: body,
		text: async () => body,
		json: async () => ({}),
	};
}

function noContentResponse() {
	return {
		ok: true,
		status: 204,
		text: async () => "",
		json: async () => {
			throw new SyntaxError("Unexpected end of JSON input");
		},
	};
}

describe("PacaAPIDocClient", () => {
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		fetchMock = vi.fn().mockResolvedValue(okEnvelope([]));
		vi.stubGlobal("fetch", fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("searchDocuments hits /docs/search with an encoded query and limit", async () => {
		fetchMock.mockResolvedValue(okEnvelope({ items: [{ id: "d1" }] }));
		const hits = await new PacaAPIDocClient(CONFIG).searchDocuments(
			"p1",
			"a&b c",
			5,
		);
		expect(fetchMock.mock.calls[0][0]).toBe(
			"https://api.example.com/api/v1/projects/p1/docs/search?q=a%26b%20c&limit=5",
		);
		expect(hits).toEqual([{ id: "d1" }]);
	});

	// ---------------------------------------------------------------------------
	// Basic request behaviour
	// ---------------------------------------------------------------------------

	it("includes X-API-Key header", async () => {
		const client = new PacaAPIDocClient(CONFIG);
		await client.listFolders("p1");
		expect(fetchMock.mock.calls[0][1].headers["X-API-Key"]).toBe("key123");
	});

	it("throws on non-OK response", async () => {
		fetchMock.mockResolvedValue(errorResponse(503, "Service Unavailable"));
		const client = new PacaAPIDocClient(CONFIG);
		await expect(client.listFolders("p1")).rejects.toThrow("503");
	});

	it("resolves on 204 No Content without parsing JSON", async () => {
		fetchMock.mockResolvedValue(noContentResponse());
		const client = new PacaAPIDocClient(CONFIG);
		await expect(client.deleteFolder("p1", "f1")).resolves.toBeUndefined();
	});

	it("returns raw JSON when not a SuccessEnvelope", async () => {
		fetchMock
			.mockResolvedValueOnce(
				rawOk({ items: [{ id: "f1" }], next_cursor: null }),
			)
			.mockResolvedValueOnce(rawOk({ items: [], next_cursor: null }));
		const client = new PacaAPIDocClient(CONFIG);
		const result = await client.listFolders("p1");
		expect(result).toEqual([{ id: "f1" }]);
	});

	// ---------------------------------------------------------------------------
	// Document Folders
	// ---------------------------------------------------------------------------

	describe("listFolders", () => {
		it("walks the folder tree one level per request", async () => {
			const client = new PacaAPIDocClient(CONFIG);
			fetchMock
				// root level
				.mockResolvedValueOnce(
					okEnvelope({ items: [{ id: "f1" }], next_cursor: null }),
				)
				// children of f1
				.mockResolvedValueOnce(
					okEnvelope({ items: [{ id: "f2" }], next_cursor: null }),
				)
				// children of f2
				.mockResolvedValueOnce(okEnvelope({ items: [], next_cursor: null }));
			const result = await client.listFolders("p1");
			const urls = fetchMock.mock.calls.map((c) => c[0] as string);
			expect(urls[0]).toContain("/docs/folders?parent_id=null&page_size=200");
			expect(urls[1]).toContain("parent_id=f1");
			expect(urls[2]).toContain("parent_id=f2");
			expect(result).toEqual([{ id: "f1" }, { id: "f2" }]);
		});

		it("follows next_cursor within a level", async () => {
			const client = new PacaAPIDocClient(CONFIG);
			fetchMock
				.mockResolvedValueOnce(
					okEnvelope({ items: [{ id: "f1" }], next_cursor: "c2" }),
				)
				.mockResolvedValueOnce(
					okEnvelope({ items: [{ id: "f2" }], next_cursor: null }),
				)
				.mockResolvedValue(okEnvelope({ items: [], next_cursor: null }));
			const result = await client.listFolders("p1");
			expect(fetchMock.mock.calls[1][0]).toContain("cursor=c2");
			expect(result).toEqual([{ id: "f1" }, { id: "f2" }]);
		});
	});

	describe("createFolder", () => {
		it("calls POST /api/v1/projects/:id/docs/folders", async () => {
			const client = new PacaAPIDocClient(CONFIG);
			fetchMock.mockResolvedValue(okEnvelope({ id: "f2", name: "New Folder" }));
			const result = await client.createFolder("p1", { name: "New Folder" });
			expect(fetchMock.mock.calls[0][1].method).toBe("POST");
			expect(result).toEqual({ id: "f2", name: "New Folder" });
		});

		it("includes parent_id when provided", async () => {
			const client = new PacaAPIDocClient(CONFIG);
			fetchMock.mockResolvedValue(okEnvelope({ id: "f3" }));
			await client.createFolder("p1", { name: "Sub", parent_id: "f1" });
			const body = JSON.parse(fetchMock.mock.calls[0][1].body);
			expect(body.parent_id).toBe("f1");
		});
	});

	describe("updateFolder", () => {
		it("calls PATCH /api/v1/projects/:id/docs/folders/:folderId", async () => {
			const client = new PacaAPIDocClient(CONFIG);
			fetchMock.mockResolvedValue(okEnvelope({ id: "f1", name: "Renamed" }));
			await client.updateFolder("p1", "f1", { name: "Renamed" });
			expect(fetchMock.mock.calls[0][0]).toContain("/docs/folders/f1");
			expect(fetchMock.mock.calls[0][1].method).toBe("PATCH");
		});
	});

	describe("deleteFolder", () => {
		it("calls DELETE /api/v1/projects/:id/docs/folders/:folderId", async () => {
			const client = new PacaAPIDocClient(CONFIG);
			fetchMock.mockResolvedValue(okEnvelope(null));
			await client.deleteFolder("p1", "f1");
			expect(fetchMock.mock.calls[0][0]).toContain("/docs/folders/f1");
			expect(fetchMock.mock.calls[0][1].method).toBe("DELETE");
		});
	});

	// ---------------------------------------------------------------------------
	// Document Snapshots
	// ---------------------------------------------------------------------------

	describe("listSnapshots", () => {
		it("calls GET /api/v1/projects/:id/docs/:docId/snapshots", async () => {
			const client = new PacaAPIDocClient(CONFIG);
			fetchMock.mockResolvedValue(okEnvelope([{ id: "snap1" }]));
			const result = await client.listSnapshots("p1", "doc1");
			expect(fetchMock.mock.calls[0][0]).toContain("/docs/doc1/snapshots");
			expect(result).toEqual([{ id: "snap1" }]);
		});

		it("follows next_cursor across pages", async () => {
			const client = new PacaAPIDocClient(CONFIG);
			fetchMock
				.mockResolvedValueOnce(
					okEnvelope({ items: [{ id: "s2" }], next_cursor: "older" }),
				)
				.mockResolvedValueOnce(
					okEnvelope({ items: [{ id: "s1" }], next_cursor: null }),
				);
			const result = await client.listSnapshots("p1", "doc1");
			expect(fetchMock.mock.calls[1][0]).toContain("cursor=older");
			expect(result).toEqual([{ id: "s2" }, { id: "s1" }]);
		});
	});

	describe("getSnapshot", () => {
		it("calls GET /api/v1/projects/:id/docs/:docId/snapshots/:snapshotId", async () => {
			const client = new PacaAPIDocClient(CONFIG);
			fetchMock.mockResolvedValue(okEnvelope({ id: "snap1" }));
			const result = await client.getSnapshot("p1", "doc1", "snap1");
			expect(fetchMock.mock.calls[0][0]).toContain("/snapshots/snap1");
			expect(result).toEqual({ id: "snap1" });
		});
	});

	// ---------------------------------------------------------------------------
	// Document Activities
	// ---------------------------------------------------------------------------

	describe("listDocumentActivities", () => {
		it("calls GET /api/v1/projects/:id/docs/:docId/activities", async () => {
			const client = new PacaAPIDocClient(CONFIG);
			fetchMock.mockResolvedValue(
				okEnvelope({ items: [{ id: "act1" }], next_cursor: null }),
			);
			const result = await client.listDocumentActivities("p1", "doc1");
			expect(fetchMock.mock.calls[0][0]).toContain(
				"/docs/doc1/activities?page_size=100",
			);
			expect(result).toEqual([{ id: "act1" }]);
		});

		it("pages the newest-first timeline and returns it oldest first", async () => {
			const client = new PacaAPIDocClient(CONFIG);
			fetchMock
				.mockResolvedValueOnce(
					okEnvelope({ items: [{ id: "b" }], next_cursor: "older" }),
				)
				.mockResolvedValueOnce(
					okEnvelope({ items: [{ id: "a" }], next_cursor: null }),
				);
			const result = await client.listDocumentActivities("p1", "doc1");
			expect(result.map((a: { id: string }) => a.id)).toEqual(["a", "b"]);
		});
	});

	// ---------------------------------------------------------------------------
	// Document Comments
	// ---------------------------------------------------------------------------

	describe("addDocumentComment", () => {
		it("calls POST /api/v1/projects/:id/docs/:docId/comments with content converted to blocknote blocks", async () => {
			const client = new PacaAPIDocClient(CONFIG);
			fetchMock.mockResolvedValue(okEnvelope({ id: "c1" }));
			await client.addDocumentComment("p1", "doc1", "Hello world");
			expect(fetchMock.mock.calls[0][0]).toContain("/docs/doc1/comments");
			expect(fetchMock.mock.calls[0][1].method).toBe("POST");
			const body = JSON.parse(fetchMock.mock.calls[0][1].body);
			expect(body.content).toEqual([
				{ type: "paragraph", content: [{ type: "text", text: "Hello world" }] },
			]);
		});
	});

	describe("updateDocumentComment", () => {
		it("calls PATCH /api/v1/projects/:id/docs/:docId/comments/:commentId with content converted to blocknote blocks", async () => {
			const client = new PacaAPIDocClient(CONFIG);
			fetchMock.mockResolvedValue(okEnvelope({ id: "c1" }));
			await client.updateDocumentComment("p1", "doc1", "c1", "Updated");
			expect(fetchMock.mock.calls[0][0]).toContain("/comments/c1");
			expect(fetchMock.mock.calls[0][1].method).toBe("PATCH");
			const body = JSON.parse(fetchMock.mock.calls[0][1].body);
			expect(body.content).toEqual([
				{ type: "paragraph", content: [{ type: "text", text: "Updated" }] },
			]);
		});
	});

	describe("deleteDocumentComment", () => {
		it("calls DELETE /api/v1/projects/:id/docs/:docId/comments/:commentId", async () => {
			const client = new PacaAPIDocClient(CONFIG);
			fetchMock.mockResolvedValue(okEnvelope(null));
			await client.deleteDocumentComment("p1", "doc1", "c1");
			expect(fetchMock.mock.calls[0][0]).toContain("/comments/c1");
			expect(fetchMock.mock.calls[0][1].method).toBe("DELETE");
		});
	});

	// ---------------------------------------------------------------------------
	// Document Files
	// ---------------------------------------------------------------------------

	describe("getDocFileDownloadURL", () => {
		it("returns .url from response", async () => {
			const client = new PacaAPIDocClient(CONFIG);
			fetchMock.mockResolvedValue(
				okEnvelope({ url: "https://cdn.example.com/doc.pdf" }),
			);
			const result = await client.getDocFileDownloadURL("p1", "doc1", "file1");
			expect(result).toBe("https://cdn.example.com/doc.pdf");
		});

		it("returns .downloadUrl as fallback", async () => {
			const client = new PacaAPIDocClient(CONFIG);
			fetchMock.mockResolvedValue(
				okEnvelope({ downloadUrl: "https://cdn.example.com/doc2.pdf" }),
			);
			const result = await client.getDocFileDownloadURL("p1", "doc1", "file1");
			expect(result).toBe("https://cdn.example.com/doc2.pdf");
		});

		it("returns empty string when no url fields present", async () => {
			const client = new PacaAPIDocClient(CONFIG);
			fetchMock.mockResolvedValue(okEnvelope({}));
			const result = await client.getDocFileDownloadURL("p1", "doc1", "file1");
			expect(result).toBe("");
		});
	});

	describe("deleteDocFile", () => {
		it("calls DELETE /api/v1/projects/:id/docs/:docId/files/:fileId", async () => {
			const client = new PacaAPIDocClient(CONFIG);
			fetchMock.mockResolvedValue(okEnvelope(null));
			await client.deleteDocFile("p1", "doc1", "file1");
			expect(fetchMock.mock.calls[0][0]).toContain("/docs/doc1/files/file1");
			expect(fetchMock.mock.calls[0][1].method).toBe("DELETE");
		});
	});
});
