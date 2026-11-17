// Valkey-backed session store.
//
// Each connected socket has a session record stored as a JSON string in Valkey
// under the key  "realtime:session:<socketId>".
//
// Session lifetime is bounded by SESSION_TTL_SECONDS.  The access token TTL
// configured in the API is 15 minutes by default; the session TTL is set to
// 20 minutes so that a connection established near a token boundary is not
// evicted before the client has time to reconnect with a fresh token.
//
// The session payload includes a projectPermissions cache that callers may
// populate and reuse across requests while the session record exists.  This
// module only persists that cached data; whether permissions are read from the
// session or refreshed from the API is determined by the calling code.

import type Redis from "ioredis";

// SESSION_TTL_SECONDS is the Valkey key expiry for a session record.
const SESSION_TTL_SECONDS = 20 * 60;

const KEY_PREFIX = "realtime:session:";

// Session is the data persisted per connected socket.
export interface Session {
	userId: string;
	username: string;
	role: string;
	// globalPermissions contains the permission strings returned by
	// GET /api/v1/users/me/global-permissions.
	globalPermissions: string[];
	// projectPermissions caches the permission map returned by
	// GET /api/v1/projects/:projectId/members/me/permissions.
	// Key: projectId (UUID string)
	// Value: permission key → boolean (e.g. "tasks:read" → true)
	projectPermissions: Record<string, Record<string, boolean>>;
}

function sessionKey(socketId: string): string {
	return `${KEY_PREFIX}${socketId}`;
}

// saveSession writes (or overwrites) a session record with a rolling TTL.
export async function saveSession(
	redis: Redis,
	socketId: string,
	session: Session,
): Promise<void> {
	await redis.set(
		sessionKey(socketId),
		JSON.stringify(session),
		"EX",
		SESSION_TTL_SECONDS,
	);
}

// getSession fetches a session record.  Returns null when the session has
// expired or was never created, or when the stored value is malformed.
export async function getSession(
	redis: Redis,
	socketId: string,
): Promise<Session | null> {
	const raw = await redis.get(sessionKey(socketId));
	if (!raw) return null;
	try {
		return JSON.parse(raw) as Session;
	} catch {
		await redis.del(sessionKey(socketId));
		return null;
	}
}

// getSessionsBatch fetches multiple sessions in a single Valkey round-trip
// using MGET.  Entries for missing/expired sessions are null.  Entries whose
// stored value is malformed JSON are treated as null; all corrupt keys are
// removed in a single DEL call after parsing.
export async function getSessionsBatch(
	redis: Redis,
	socketIds: string[],
): Promise<Array<Session | null>> {
	if (socketIds.length === 0) return [];
	const keys = socketIds.map(sessionKey);
	const values = await redis.mget(...keys);
	const corruptKeys: string[] = [];
	const results = values.map((v, i) => {
		const key = keys[i];
		if (!v) return null;
		try {
			return JSON.parse(v) as Session;
		} catch {
			if (key) corruptKeys.push(key);
			return null;
		}
	});
	if (corruptKeys.length > 0) {
		void redis.del(...corruptKeys);
	}
	return results;
}

// setProjectPermissions merges the project permission map into the existing
// session and resets the TTL.  A no-op if the session no longer exists.
export async function setProjectPermissions(
	redis: Redis,
	socketId: string,
	projectId: string,
	permissions: Record<string, boolean>,
): Promise<void> {
	const session = await getSession(redis, socketId);
	if (!session) return;
	session.projectPermissions ??= {};
	session.projectPermissions[projectId] = permissions;
	await saveSession(redis, socketId, session);
}

// deleteSession removes the session record immediately (called on disconnect).
export async function deleteSession(
	redis: Redis,
	socketId: string,
): Promise<void> {
	await redis.del(sessionKey(socketId));
}
