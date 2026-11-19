// A socket never outlives the access token it connected with.
//
// The handshake is the only time the token is looked at; after that the
// socket would otherwise keep receiving events for as long as the connection
// stays up, however long ago the token expired or the session was revoked.
// So shortly before the token's exp the server asks the client to reauthenticate
// ("reauth": refresh the session, then reconnect so the handshake carries the
// new cookie), and at exp it disconnects. The client reconnects on a
// server-initiated disconnect, so a client that ignores "reauth" still ends up
// with a fresh handshake, just with a short gap.
//
// One shared scan does this for every socket. A timer per socket (two, with
// the reauth) would mean tens of thousands of live timers for a busy server,
// and a token's expiry does not need millisecond precision: the per-event
// check refuses an expired token anyway.

export const REAUTH_LEAD_MS = 60_000;
export const SCAN_INTERVAL_MS = 5_000;

interface ExpiringSocket {
	emit(event: "reauth"): unknown;
	disconnect(close?: boolean): unknown;
}

interface Watched {
	socket: ExpiringSocket;
	expiresAt: number;
	reauthSent: boolean;
}

export class ExpiryWatcher {
	private readonly watched = new Set<Watched>();
	private timer: ReturnType<typeof setInterval> | undefined;

	constructor(
		private readonly leadMs = REAUTH_LEAD_MS,
		private readonly scanMs = SCAN_INTERVAL_MS,
	) {}

	// watch tracks a socket until its token expires or the returned function
	// is called (when the socket disconnects). A token with no known expiry is
	// not tracked.
	watch(socket: ExpiringSocket, expiresAt: number | undefined): () => void {
		if (expiresAt === undefined) return () => {};
		const entry: Watched = { socket, expiresAt, reauthSent: false };
		this.watched.add(entry);
		return () => {
			this.watched.delete(entry);
		};
	}

	// scan acts on every tracked socket that is due. Exposed for tests; the
	// interval started by start() calls it.
	scan(now = Date.now()): void {
		for (const entry of this.watched) {
			if (now >= entry.expiresAt) {
				this.watched.delete(entry);
				entry.socket.disconnect(true);
			} else if (!entry.reauthSent && now >= entry.expiresAt - this.leadMs) {
				entry.reauthSent = true;
				entry.socket.emit("reauth");
			}
		}
	}

	start(): void {
		this.timer = setInterval(() => this.scan(), this.scanMs);
		this.timer.unref();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
	}
}
