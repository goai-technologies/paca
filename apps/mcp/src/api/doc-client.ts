import type {
	CreateFolderInput,
	DocumentActivity,
	DocumentFolder,
	DocumentSearchHit,
	DocumentSnapshot,
	PacaConfig,
	SuccessEnvelope,
	UpdateFolderInput,
} from "../types/index.js";
import { formatApiRequestError, markdownToBlocknote } from "../utils/index.js";
import { fetchAllPages, MAX_LISTED_ITEMS, withPaging } from "./paginate.js";

/**
 * Extended API client for Document features.
 */
/** Most timeline entries a tool call collects (the newest ones). */
const MAX_ACTIVITY_ITEMS = 500;

export class PacaAPIDocClient {
	private config: PacaConfig;

	constructor(config: PacaConfig) {
		this.config = config;
	}

	private async request(
		method: string,
		path: string,
		body?: any,
	): Promise<any> {
		const url = `${this.config.baseURL}${path}`;
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			"X-API-Key": this.config.apiKey,
		};

		const options: RequestInit = {
			method,
			headers,
		};

		if (body) {
			options.body = JSON.stringify(body);
		}

		const response = await fetch(url, options);

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(
				formatApiRequestError(response.status, response.statusText, errorText),
			);
		}

		if (response.status === 204) {
			return undefined;
		}

		const jsonResponse = await response.json();

		// Handle SuccessEnvelope wrapper
		if (
			jsonResponse &&
			typeof jsonResponse === "object" &&
			"success" in jsonResponse
		) {
			const envelope = jsonResponse as SuccessEnvelope<any>;
			if (envelope.success) {
				return envelope.data;
			}
		}

		// Fallback for responses not wrapped in SuccessEnvelope
		return jsonResponse;
	}

	private async get(path: string): Promise<any> {
		return this.request("GET", path);
	}

	private async post(path: string, body: any): Promise<any> {
		return this.request("POST", path, body);
	}

	private async patch(path: string, body: any): Promise<any> {
		return this.request("PATCH", path, body);
	}

	private async delete(path: string): Promise<any> {
		return this.request("DELETE", path);
	}

	// ==================== Document Folders ====================

	async listFolders(projectId: string): Promise<DocumentFolder[]> {
		// The API lists one level of the tree per call, so walk it level by level.
		const all: DocumentFolder[] = [];
		let parents: (string | null)[] = [null];
		while (parents.length > 0 && all.length < MAX_LISTED_ITEMS) {
			const next: string[] = [];
			for (let i = 0; i < parents.length; i += 8) {
				const levels = await Promise.all(
					parents
						.slice(i, i + 8)
						.map((parent) =>
							fetchAllPages<DocumentFolder>((cursor) =>
								this.get(
									withPaging(
										`/api/v1/projects/${projectId}/docs/folders?parent_id=${parent ?? "null"}`,
										cursor,
										200,
									),
								),
							),
						),
				);
				for (const folders of levels) {
					for (const f of folders) {
						all.push(f);
						next.push(f.id);
					}
				}
			}
			parents = next;
		}
		return all;
	}

	async createFolder(
		projectId: string,
		input: CreateFolderInput,
	): Promise<DocumentFolder> {
		return this.post(`/api/v1/projects/${projectId}/docs/folders`, input);
	}

	async updateFolder(
		projectId: string,
		folderId: string,
		input: UpdateFolderInput,
	): Promise<DocumentFolder> {
		return this.patch(
			`/api/v1/projects/${projectId}/docs/folders/${folderId}`,
			input,
		);
	}

	async deleteFolder(projectId: string, folderId: string): Promise<void> {
		await this.delete(`/api/v1/projects/${projectId}/docs/folders/${folderId}`);
	}

	// ==================== Document Snapshots ====================

	async listSnapshots(
		projectId: string,
		docId: string,
	): Promise<DocumentSnapshot[]> {
		// Newest first; list items carry no body (getSnapshot returns it).
		return fetchAllPages(
			(cursor) =>
				this.get(
					withPaging(
						`/api/v1/projects/${projectId}/docs/${docId}/snapshots`,
						cursor,
					),
				),
			MAX_ACTIVITY_ITEMS,
		);
	}

	async getSnapshot(
		projectId: string,
		docId: string,
		snapshotId: string,
	): Promise<DocumentSnapshot> {
		return this.get(
			`/api/v1/projects/${projectId}/docs/${docId}/snapshots/${snapshotId}`,
		);
	}

	// ==================== Document Activities ====================

	async listDocumentActivities(
		projectId: string,
		docId: string,
	): Promise<DocumentActivity[]> {
		// The API pages newest first; callers read the timeline oldest first.
		const newestFirst = await fetchAllPages<DocumentActivity>(
			(cursor) =>
				this.get(
					withPaging(
						`/api/v1/projects/${projectId}/docs/${docId}/activities`,
						cursor,
					),
				),
			MAX_ACTIVITY_ITEMS,
		);
		return newestFirst.reverse();
	}

	// ==================== Document Comments ====================

	async addDocumentComment(
		projectId: string,
		docId: string,
		content: string,
	): Promise<DocumentActivity> {
		const contentBlocks = content ? markdownToBlocknote(content) : null;
		return this.post(`/api/v1/projects/${projectId}/docs/${docId}/comments`, {
			content: contentBlocks,
		});
	}

	async updateDocumentComment(
		projectId: string,
		docId: string,
		commentId: string,
		content: string,
	): Promise<DocumentActivity> {
		const contentBlocks = content ? markdownToBlocknote(content) : null;
		return this.patch(
			`/api/v1/projects/${projectId}/docs/${docId}/comments/${commentId}`,
			{ content: contentBlocks },
		);
	}

	async deleteDocumentComment(
		projectId: string,
		docId: string,
		commentId: string,
	): Promise<void> {
		await this.delete(
			`/api/v1/projects/${projectId}/docs/${docId}/comments/${commentId}`,
		);
	}

	// ==================== Document Files ====================

	async getDocFileDownloadURL(
		projectId: string,
		docId: string,
		fileId: string,
	): Promise<string> {
		const response = await this.get(
			`/api/v1/projects/${projectId}/docs/${docId}/files/${fileId}/download-url`,
		);
		return response.url || response.downloadUrl || "";
	}

	async deleteDocFile(
		projectId: string,
		docId: string,
		fileId: string,
	): Promise<void> {
		await this.delete(
			`/api/v1/projects/${projectId}/docs/${docId}/files/${fileId}`,
		);
	}

	/**
	 * Searches a project's documents by title or body text
	 * (GET /docs/search) — the list endpoint only matches titles.
	 */
	async searchDocuments(
		projectId: string,
		query: string,
		limit = 20,
	): Promise<DocumentSearchHit[]> {
		const response = await this.get(
			`/api/v1/projects/${projectId}/docs/search?q=${encodeURIComponent(query)}&limit=${limit}`,
		);
		if (Array.isArray(response)) return response;
		return response?.items ?? [];
	}
}
