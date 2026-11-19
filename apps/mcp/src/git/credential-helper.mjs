#!/usr/bin/env node
// Paca git credential helper.
//
// git runs this as `credential.helper` and speaks its credential protocol on
// stdin/stdout. `get` asks the one-command broker the MCP process opened (its
// unix socket path is in PACA_GIT_SOCK) for a credential and prints it for git
// to use for that single invocation. `store` and `erase` do nothing, so no
// credential is ever persisted anywhere. If the broker declines (wrong host or
// repository, expired, unreachable) this exits silently with no output, which
// makes git fail cleanly; combined with GIT_TERMINAL_PROMPT=0 it never prompts.
//
// Dependency-free on purpose: it is copied verbatim into the published package.
import http from "node:http";

if (process.argv[2] !== "get") process.exit(0);

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	input += chunk;
});
process.stdin.on("end", () => {
	const kv = {};
	for (const line of input.split("\n")) {
		const i = line.indexOf("=");
		if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1);
	}
	const sock = process.env.PACA_GIT_SOCK;
	if (!sock) process.exit(0);

	const body = JSON.stringify({
		protocol: kv.protocol,
		host: kv.host,
		path: kv.path,
	});
	const req = http.request(
		{ socketPath: sock, path: "/credential", method: "POST", timeout: 15000 },
		(res) => {
			let out = "";
			res.setEncoding("utf8");
			res.on("data", (chunk) => {
				out += chunk;
			});
			res.on("end", () => {
				if (res.statusCode !== 200) process.exit(0);
				try {
					const c = JSON.parse(out);
					process.stdout.write(`username=${c.username}\npassword=${c.secret}\n`);
				} catch {
					process.exit(0);
				}
			});
		},
	);
	req.on("error", () => process.exit(0));
	req.on("timeout", () => {
		req.destroy();
		process.exit(0);
	});
	req.end(body);
});
