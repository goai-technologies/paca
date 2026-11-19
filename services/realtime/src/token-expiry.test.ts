import { describe, expect, it } from "bun:test";

import { ExpiryWatcher } from "./token-expiry.ts";

function fakeSocket() {
	const log: string[] = [];
	return {
		log,
		emit: (e: "reauth") => log.push(`emit:${e}`),
		disconnect: (close?: boolean) => log.push(`disconnect:${close}`),
	};
}

describe("ExpiryWatcher", () => {
	it("asks to reauthenticate inside the lead window, once, then disconnects at expiry", () => {
		const w = new ExpiryWatcher(60_000);
		const s = fakeSocket();
		w.watch(s, 1_000_000);
		w.scan(900_000);
		expect(s.log).toEqual([]);
		w.scan(940_000);
		w.scan(950_000);
		expect(s.log).toEqual(["emit:reauth"]);
		w.scan(1_000_000);
		expect(s.log).toEqual(["emit:reauth", "disconnect:true"]);
		w.scan(1_100_000);
		expect(s.log.length).toBe(2); // no longer tracked
	});

	it("acts at once for a token that is already expired", () => {
		const w = new ExpiryWatcher();
		const s = fakeSocket();
		w.watch(s, 1);
		w.scan(1_000);
		expect(s.log).toEqual(["disconnect:true"]);
	});

	it("leaves a cancelled socket, or one with no expiry, alone", () => {
		const w = new ExpiryWatcher();
		const s = fakeSocket();
		w.watch(s, 1_000)();
		w.watch(s, undefined);
		w.scan(10_000);
		expect(s.log).toEqual([]);
	});

	it("serves many sockets from one interval", () => {
		const w = new ExpiryWatcher(10);
		const sockets = Array.from({ length: 1000 }, fakeSocket);
		sockets.forEach((s, i) => {
			w.watch(s, 100 + i);
		});
		w.scan(105);
		expect(
			sockets.filter((s) => s.log.includes("disconnect:true")).length,
		).toBe(6);
	});
});
