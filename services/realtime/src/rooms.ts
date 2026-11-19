// Room membership for one project.

import {
	type EventNamespace,
	hasAction,
	NAMESPACE_PERMISSIONS,
	projectRoomName,
} from "./permissions.ts";

interface Rooms {
	join(room: string): unknown;
	leave(room: string): unknown;
}

// syncProjectRooms puts the socket into the namespace rooms of `projectId` that
// its effective actions allow and takes it out of the others. `perms` null
// means the account is not a member, so it leaves them all. Returns the
// namespaces the socket is in afterwards.
export function syncProjectRooms(
	socket: Rooms,
	projectId: string,
	perms: Record<string, boolean> | null,
): EventNamespace[] {
	const joined: EventNamespace[] = [];
	for (const [ns, required] of Object.entries(NAMESPACE_PERMISSIONS)) {
		const room = projectRoomName(projectId, ns as EventNamespace);
		if (perms && hasAction(perms, required)) {
			socket.join(room);
			joined.push(ns as EventNamespace);
		} else {
			socket.leave(room);
		}
	}
	return joined;
}
