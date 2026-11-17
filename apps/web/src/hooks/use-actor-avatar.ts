import { useCallback } from "react";
import { useMemberDirectory } from "@/lib/member-directory";
import { type AvatarIdentity, memberAvatar } from "@/lib/provider-logos";

interface ActorRef {
	/** A project member id or the account (user/agent/service account) id. */
	id?: string | null;
	name?: string | null;
	username?: string | null;
	/** The avatar the payload itself carried, used when the actor is no
	 * longer a member of the project. */
	avatarUrl?: string | null;
}

/**
 * Feeds (activity logs, comment threads) only carry an actor's name and
 * uploaded avatar, not whether the actor is a human, an agent or a service
 * account — and so can't pick the right default avatar. This resolves the
 * actor against the project's members, looked up by id on demand (see
 * member-directory) rather than from a full team list; an actor that isn't a
 * member any more — or isn't resolved yet — falls back to a plain human
 * identity.
 */
export function useActorAvatar(projectId: string) {
	const getMember = useMemberDirectory(projectId);
	return useCallback(
		(actor: ActorRef): AvatarIdentity => {
			const member = getMember(actor.id);
			if (member) return memberAvatar(member);
			return {
				name: actor.name || actor.username || "",
				type: "human",
				avatarUrl: actor.avatarUrl,
			};
		},
		[getMember],
	);
}
