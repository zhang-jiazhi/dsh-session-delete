/**
 * @local/dsh-session-delete - host half.
 *
 * Permanently deletes a session's whole stored content: every session-owned
 * directory under `~/.dsh/sessions/<workspace>/` (session.jsonl.zstd,
 * session-local files, everything inside), plus the in-memory registry,
 * workspace accounting, projection cache, and archived-state references so
 * the session cannot reappear after a reload/restart.
 *
 * Routes (loopback + same-origin fenced, mirroring dsh-stats-panel):
 *   POST /api/session-delete/delete  { sessionId, force? }
 *   GET  /api/session-delete/list    → session summaries for the manager page
 *
 * Live-session safety: before deleting we best-effort cancel the agent turn
 * and detach the session from every workspace; a running session is refused
 * unless `force` is set.
 */
import { rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** Stable cordis plugin name. */
export const name = 'session-delete';

/** Services required before the routes can mount. */
export const inject = ['webServer'];

/** Sessions storage root. */
const SESSIONS_ROOT = join(homedir(), '.dsh', 'sessions');

const SESSION_PREFIX = 'session-';

/** Grace period for a cancelled agent to reach quiescence before falling back to the direct registry removal. */
const AGENT_IDLE_GRACE_MS = 3000;

/** IPv4 / IPv6 环回判定（含 Node 在 IPv4-over-IPv6 socket 上返回的映射形态）。 */
function isLoopbackAddress(address) {
	return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
		|| (typeof address === 'string' && /^127\./.test(address))
		|| (typeof address === 'string' && /^::ffff:127\./.test(address));
}

/** 主机名字面量是否为环回。 */
function isLoopbackHostname(hostname) {
	return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]'
		|| /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

/**
 * 当前生效的受信主机列表（best-effort）。
 *
 * profile 已配 `web-runtime.trustedHosts: [172.19.81.21, ...]`，但本插件原先
 * **硬编码只认 loopback** —— 于是从 `http://172.19.81.21:3080` 打开 Web GUI 时，
 * 设置页的会话管理器列表/删除全部静默 403，而同族的 dsh-browser-side 用
 * `ctx.get('webRuntime').trustedHosts` 动态判定、同一台机器上"浏览器面板能用、
 * 会话删除不能用"。这里对齐 browser-side 的口径。
 */
function trustedHostsOf(ctx) {
	try {
		const runtime = ctx?.get?.('webRuntime');
		const list = runtime?.trustedHosts;
		return Array.isArray(list) ? list.filter((x) => typeof x === 'string') : [];
	} catch {
		return [];
	}
}

/**
 * 请求是否来自受信来源。
 *
 * 三道闸（Origin / sec-fetch-site / Host）语义与原实现一致，仅把 Host 判定从
 * "只认 loopback" 扩展为 "loopback 或 webRuntime.trustedHosts 命中"：
 *   - remoteAddress 必须是 loopback 或命中受信 IP 字面量条目（否则 LAN 内任意
 *     机器伪造受信 Host 即可删会话）；
 *   - 域名类条目不比对 remoteAddress（一个名字可解析到多机），维持原语义。
 */
function isTrustedRequest(ctx, request) {
	const address = request.socket?.remoteAddress;
	const host = request.headers.host;
	if (typeof host !== 'string' || host === '') return false;
	let hostUrl;
	try {
		hostUrl = new URL(`http://${host}`);
	} catch {
		return false;
	}
	const hostIsLoopback = isLoopbackHostname(hostUrl.hostname);
	const trusted = trustedHostsOf(ctx);
	const entryHit = trusted.some((entry) => {
		let entryUrl;
		try {
			entryUrl = new URL(`http://${entry}`);
		} catch {
			return false;
		}
		const sameHost = entryUrl.host === hostUrl.host || entryUrl.hostname === hostUrl.hostname;
		if (!sameHost) return false;
		// IP 字面量条目：对端地址必须一致。
		if (/^\d{1,3}(\.\d{1,3}){3}$/.test(entryUrl.hostname)) return entryUrl.hostname === address;
		return true;
	});
	if (!hostIsLoopback && !entryHit) return false;
	// 对端校验：loopback Host 要求远端真是 loopback（除非命中受信 IP 条目）。
	if (hostIsLoopback && !isLoopbackAddress(address) && !entryHit) return false;
	if (typeof address !== 'string' || address === '') return false;
	if (request.headers['sec-fetch-site'] === 'cross-site') return false;
	const origin = request.headers.origin;
	if (origin === undefined) return true;
	try {
		return new URL(origin).host === hostUrl.host;
	} catch {
		return false;
	}
}

function writeJson(res, status, body, extraHeaders) {
	// 客户端断开后 ServerResponse 已 end/destroyed，再写会把一次正常取消
	// 升级成 write-after-end 错误。
	if (res.writableEnded || res.destroyed) return false;
	res.writeHead(status, Object.assign({
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-store',
		'referrer-policy': 'no-referrer',
		'x-content-type-options': 'nosniff',
	}, extraHeaders));
	res.end(JSON.stringify(body));
	return true;
}

const MAX_BODY_BYTES = 256 * 1024;

function readBody(request) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		let settled = false;
		const off = (event, listener) => {
			if (typeof request.off === 'function') request.off(event, listener);
			else request.removeListener?.(event, listener);
		};
		const cleanup = () => {
			off('data', onData);
			off('end', onEnd);
			off('error', onError);
		};
		const fail = (error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};
		const onData = (chunk) => {
			if (settled) return;
			// Buffer 拼接：按 chunk 解码字符串会把跨 chunk 的多字节字符截断成乱码。
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			size += buffer.length;
			if (size > MAX_BODY_BYTES) {
				const error = new Error('body too large');
				error.code = 'body-too-large';
				fail(error);
				// 旧实现只 reject 不停读，剩余 body 会继续堆进内存。
				if (typeof request.resume === 'function') request.resume();
				else request.destroy?.();
				return;
			}
			chunks.push(buffer);
		};
		const onEnd = () => {
			if (settled) return;
			settled = true;
			cleanup();
			try {
				const text = Buffer.concat(chunks).toString('utf8');
				resolve(text.length > 0 ? JSON.parse(text) : {});
			} catch (error) {
				reject(error);
			}
		};
		const onError = (error) => fail(error);
		request.on('data', onData);
		request.on('end', onEnd);
		request.on('error', onError);
	});
}

/** Strip the optional `session-` storage prefix from an id. */
function stripSessionPrefix(id) {
	return id.startsWith(SESSION_PREFIX) ? id.slice(SESSION_PREFIX.length) : id;
}

/**
 * Collect every plausible spelling for a session id on disk.
 *
 * Top-level sessions are normally stored as `session-<uuid>`, while subagent
 * sessions are stored as bare `<uuid>`. The UI may send either form, so all
 * candidates are matched when locating directories and clearing registries.
 */
function sessionIdCandidates(sessionId) {
	const set = new Set();
	if (!sessionId) return [];
	set.add(sessionId);
	const bare = stripSessionPrefix(sessionId);
	if (bare) set.add(bare);
	if (bare) set.add(`${SESSION_PREFIX}${bare}`);
	return [...set];
}

/**
 * All on-disk session directories for one session id, across workspaces.
 *
 * Scans every project directory and matches both `session-<id>` and bare
 * `<id>` directory names so deletion works regardless of which spelling the
 * UI supplied.
 */
function findSessionDirs(sessionId) {
	const hits = [];
	if (!existsSync(SESSIONS_ROOT)) return hits;
	const wanted = new Set(sessionIdCandidates(sessionId));
	for (const workspace of readdirSync(SESSIONS_ROOT)) {
		const projectDir = join(SESSIONS_ROOT, workspace);
		let entries;
		try {
			entries = readdirSync(projectDir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (entry.isDirectory() && wanted.has(entry.name)) {
				hits.push(join(projectDir, entry.name));
			}
		}
	}
	return hits;
}

async function listSessions(ctx) {
	// dsh 0.1.2-alpha.1+: the apiProxy service was removed. Build the same
	// summary shape the web client sees, from the services that remain:
	// sessionQuery (records), sessionProjectionCache.cachedSnapshot (title /
	// lastPromptAt / blank), agents (running status).
	try {
		const sessionQuery = ctx.get('sessionQuery');
		if (sessionQuery && typeof sessionQuery.listSessions === 'function') {
			const records = await sessionQuery.listSessions();
			const agents = ctx.get('agents');
			const cache = ctx.get('sessionProjectionCache');
			const items = [];
			for (const record of records) {
				const header = record.header;
				if (header.cwd === void 0) continue;
				const id = header.id;
				let inheritedEventCount = 0;
				if (header.isSeeded === true) {
					try {
						inheritedEventCount = (await sessionQuery.readSession(id))?.inheritedEventCount ?? 0;
					} catch {}
				}
				let values;
				try {
					values = cache?.cachedSnapshot?.(header, inheritedEventCount)?.values;
				} catch {}
				const metadata = values?.sessionListMetadata;
				items.push({
					sessionId: id,
					updatedAt: Math.max(Number(header.createdAt) || 0, Number(metadata?.lastPromptAt) || 0),
					running: agents?.get?.(id)?.status === 'running',
					blank: metadata?.blank === true,
					cwd: header.cwd,
					...(values === void 0 ? {} : { projections: { values } }),
				});
			}
			return items;
		}
	} catch {}
	return [];
}

/**
 * Is any spelling of this session id currently running?
 *
 * The delete path used to answer this by building the whole session list
 * (sessionQuery.listSessions + projection snapshots for every session); the
 * running flag itself only ever came from the agent registry, so ask it
 * directly. Falls back to the full list when the registry is unavailable.
 */
async function isSessionRunning(ctx, ids) {
	try {
		const agents = ctx.get('agents');
		if (typeof agents?.get === 'function') {
			for (const id of ids) {
				if (agents.get(id)?.status === 'running') return true;
			}
			return false;
		}
	} catch {}
	const items = await listSessions(ctx);
	const idSet = new Set(ids);
	return items.some((item) => idSet.has(item.sessionId) && item.running === true);
}

/** Drop matching entries from a Map (in-memory registries/stores). */
function removeFromMap(map, ids, notes, label) {
	if (!(map instanceof Map)) return;
	for (const id of new Set(ids)) {
		if (map.has(id)) {
			map.delete(id);
			notes.push(`${label}:${id}`);
		}
	}
}

/**
 * Wait for an agent to reach quiescence, giving up after `timeoutMs`.
 * Resolves `'idle'` when agent.whenIdle() settles first and `'timeout'` when
 * the grace period elapses; rejects with the whenIdle() failure itself.
 * The timer is unref'd so a hung agent cannot hold the host process open.
 */
function waitForAgentIdle(agent, timeoutMs) {
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (outcome) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			outcome instanceof Error ? reject(outcome) : resolve(outcome);
		};
		const timer = setTimeout(() => finish('timeout'), timeoutMs);
		if (typeof timer.unref === 'function') timer.unref();
		Promise.resolve(agent.whenIdle()).then(() => finish('idle'), (error) => finish(error));
	});
}

/** Best-effort live cleanup: cancel the active turn, then detach from every workspace. */
async function releaseLiveSession(ctx, sessionId) {
	const notes = [];
	const ids = sessionIdCandidates(sessionId);
	const idSet = new Set(ids);

	// Cancel any live turn for every plausible spelling, then give each agent a
	// bounded grace period (agent.cancel + agent.whenIdle per the dsh-agent
	// contract: cancel aborts the active turn, whenIdle resolves once no active
	// driver or maintenance task remains; on an already-idle agent both are
	// no-ops) before the bare registry-entry removal below. This is still
	// best-effort: the host exposes no legitimate plugin-side teardown path
	// (AgentHandle.dispose is owner-only and the web proxy drops its handle
	// right after create/resume), so on timeout or failure we keep going and
	// fall back to the direct store removal; the next host restart fully
	// reclaims whatever is left.
	try {
		const agents = ctx.get('agents');
		for (const id of ids) {
			const agent = agents?.get?.(id);
			if (agent === void 0 || typeof agent.cancel !== 'function') continue;
			try {
				agent.cancel({ kind: 'hook', reason: 'session-delete' });
				notes.push(`cancelled:${id}`);
			} catch (error) {
				notes.push(`cancel-failed:${id}:${error instanceof Error ? error.message : String(error)}`);
				continue;
			}
			if (typeof agent.whenIdle !== 'function') continue;
			try {
				const outcome = await waitForAgentIdle(agent, AGENT_IDLE_GRACE_MS);
				notes.push(outcome === 'idle' ? `idle:${id}` : `idle-timeout:${id}`);
			} catch (error) {
				notes.push(`idle-wait-failed:${id}:${error instanceof Error ? error.message : String(error)}`);
			}
		}
	} catch (error) {
		notes.push(`cancel-access-failed:${error instanceof Error ? error.message : String(error)}`);
	}

	// Remove the session from every workspace's durable accounting.
	try {
		const registry = ctx.get('workspaceRegistry');
		const workspaces = typeof registry?.list === 'function' ? await registry.list() : [];
		for (const workspace of workspaces) {
			if (typeof workspace?.detachSession !== 'function') continue;
			for (const id of ids) {
				try {
					await workspace.detachSession(id);
					notes.push(`detached:${id}`);
				} catch (error) {
					notes.push(`detach-failed:${id}:${error instanceof Error ? error.message : String(error)}`);
				}
			}
		}
	} catch (error) {
		notes.push(`detach-access-failed:${error instanceof Error ? error.message : String(error)}`);
	}

	// Drop in-memory registry entries so `session.list` stops reporting the
	// session immediately. The visible list merges `ctx.sessions` (SessionStore)
	// with persistence; attached rows come from the SessionStore, and the agent
	// lookup reads AgentRegistry. AgentHandle.dispose is owner-only by design
	// and the web proxy drops its handle right after create/resume, so no
	// legitimate teardown path exists for a plugin; removing the bare entries
	// (all durable content already gone) makes the row disappear everywhere,
	// and a host restart fully reclaims the idle scopes.
	try {
		const agents = ctx.get('agents');
		removeFromMap(agents?.store, ids, notes, 'agent-registry-entry-removed');
	} catch (error) {
		notes.push(`agent-registry-remove-failed:${error instanceof Error ? error.message : String(error)}`);
	}
	try {
		const sessions = ctx.get('sessions');
		removeFromMap(sessions?.store, ids, notes, 'session-store-entry-removed');
	} catch (error) {
		notes.push(`session-store-remove-failed:${error instanceof Error ? error.message : String(error)}`);
	}

	// Remove persisted projection-cache checkpoints for this session id so no
	// stale title/stat/context metadata survives the deletion.
	try {
		const cache = ctx.get('sessionProjectionCache');
		const table = cache?.table ?? (typeof cache?.requireTable === 'function' ? cache.requireTable() : undefined);
		if (table && typeof table.delete === 'function') {
			for (const id of ids) {
				try {
					const removed = await table.delete(id);
					if (removed) notes.push(`projection-cache-removed:${id}`);
				} catch (error) {
					notes.push(`projection-cache-remove-failed:${id}:${error instanceof Error ? error.message : String(error)}`);
				}
			}
		} else {
			notes.push('projection-cache-unavailable');
		}
	} catch (error) {
		notes.push(`projection-cache-access-failed:${error instanceof Error ? error.message : String(error)}`);
	}

	// Remove the id from the registry-global archived set when possible.
	// This is best-effort and only runs when no pending workspace mutation
	// would be overwritten.
	try {
		const registry = ctx.get('workspaceRegistry');
		if (typeof registry?.requireState === 'function' && typeof registry?.setState === 'function') {
			const state = registry.requireState();
			if (state && state.pendingMutation === undefined && Array.isArray(state.archivedSessionIds)) {
				const next = state.archivedSessionIds.filter((id) => !idSet.has(id));
				if (next.length !== state.archivedSessionIds.length) {
					// requireState hands out the registry's live state object, so
					// re-read right before writing: if a workspace mutation ran in
					// between (state replaced, or a pendingMutation appeared) our
					// snapshot is stale and setState would clobber it. Abandon this
					// cleanup instead — a leftover archived id is harmless and the
					// next registry mutation rewrites the list anyway.
					const current = registry.requireState();
					if (current === state && current.pendingMutation === undefined && Array.isArray(current.archivedSessionIds)) {
						await registry.setState({
							...state,
							archivedSessionIds: next
						});
						notes.push('archived-session-id-removed');
					} else {
						notes.push('archived-cleanup-skipped:state-changed');
						console.warn('[session-delete] archived-set cleanup skipped: workspace registry state changed while deleting');
					}
				}
			}
		}
	} catch (error) {
		notes.push(`archived-cleanup-failed:${error instanceof Error ? error.message : String(error)}`);
	}

	return notes;
}

function apply(ctx) {
	// Both routes are wrapped in ctx.effect: the host webserver throws on
	// duplicate (kind, path) registrations ("route patterns are a
	// composition-level contract"), and only an effect ties the route to this
	// fiber's lifetime so a plugin reload disposes the previous registration
	// before re-applying instead of colliding — the same pattern dsh-stats-panel
	// uses for its routes.
	ctx.effect(() => ctx.webServer.register({
		kind: 'exact',
		path: '/api/session-delete/list',
		handler: async (req, res) => {
			if (!isTrustedRequest(ctx, req)) return writeJson(res, 403, { ok: false, error: 'forbidden: untrusted request' });
			if (req.method !== 'GET' && req.method !== undefined) return writeJson(res, 405, { ok: false, error: 'GET only' }, { allow: 'GET' });
			const items = await listSessions(ctx);
			writeJson(res, 200, {
				ok: true,
				items: items.map((item) => ({
					sessionId: item.sessionId,
					updatedAt: item.updatedAt,
					running: item.running === true,
					blank: item.blank === true,
					cwd: item.cwd,
					// The title projection's key is `title` (dsh-session-title); the
					// former `session.title` fallback spelled a key no projection
					// ever produced.
					title: item.projections?.values?.title ?? null,
				})),
			});
		},
	}), 'session-delete: list route');

	ctx.effect(() => ctx.webServer.register({
		kind: 'exact',
		path: '/api/session-delete/delete',
		handler: async (req, res) => {
			if (!isTrustedRequest(ctx, req)) return writeJson(res, 403, { ok: false, error: 'forbidden: untrusted request' });
			if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'POST only' });
			let body;
			try {
				body = await readBody(req);
			} catch (error) {
				return writeJson(res, 400, { ok: false, error: `bad body: ${error instanceof Error ? error.message : String(error)}` });
			}
			const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
			const force = body?.force === true;
			if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) return writeJson(res, 400, { ok: false, error: 'invalid sessionId' });

			const ids = sessionIdCandidates(sessionId);

			const wasRunning = await isSessionRunning(ctx, ids);
			if (wasRunning && !force) {
				return writeJson(res, 409, {
					ok: false,
					error: 'session-running',
					message: '会话正在运行，请先停止，或使用强制删除。',
				});
			}

			const notes = await releaseLiveSession(ctx, sessionId);
			// 新版 dsh 已移除 apiProxy，取消接口可能整体不可用；此时强制删除是在和一个
			// 仍在写盘的会话赛跑，必须让调用方看见，而不是静默删掉。
			const stillRunning = wasRunning && await isSessionRunning(ctx, ids);
			const warning = stillRunning
				? '会话在删除时仍处于运行中（未能停止它）：残留写入可能重新生成文件，建议在界面停止该会话后再删一次。'
				: undefined;
			const dirs = findSessionDirs(sessionId);
			if (dirs.length === 0) {
				// A never-persisted (blank) session lives only in the in-memory
				// registry; nothing on disk to remove — that IS the deleted state.
				// The browser hides the row via its deleted-tombstone list because
				// AgentHandle.dispose is owner-only: an attached agent cannot be
				// torn down from a plugin, so the registry row may linger until
				// the next host restart while all stored content is gone.
				return writeJson(res, 200, { ok: true, removed: [], notes, noDiskArtifact: true, ...(warning === undefined ? {} : { warning }) });
			}
			const removed = [];
			try {
				for (const dir of dirs) {
					rmSync(dir, { recursive: true, force: true });
					removed.push(dir);
				}
			} catch (error) {
				return writeJson(res, 500, { ok: false, error: `delete-failed: ${error instanceof Error ? error.message : String(error)}`, removed, notes });
			}
			writeJson(res, 200, { ok: true, removed, notes, runningWas: wasRunning, ...(warning === undefined ? {} : { warning }) });
		},
	}), 'session-delete: delete route');
}

export { apply };
