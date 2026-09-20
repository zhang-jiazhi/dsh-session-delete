window.__ModuleLoader__.load({
	id: "@local/dsh-session-delete",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		//#region shared
		const inject = ["slots"];
		const LIST_URL = "/api/session-delete/list";
		const DELETE_URL = "/api/session-delete/delete";
		const STYLE_ID = "sdl-style";
		const styles = `
.sdl-page{font-family:system-ui,-apple-system,sans-serif;font-size:13px;line-height:1.6;padding:14px 16px;max-width:760px}
.sdl-page h3{margin:0 0 6px;font-size:14px}
.sdl-hint{color:var(--theme-text-secondary,#999);font-size:12px;margin:0 0 12px}
.sdl-toolbar{display:flex;gap:10px;align-items:center;margin-bottom:10px}
.sdl-btn{background:var(--theme-accent,#4a9eff);color:#fff;border:none;border-radius:6px;padding:5px 12px;cursor:pointer;font-size:12px}
.sdl-btn.ghost{background:transparent;border:1px solid var(--theme-border,#444);color:var(--theme-text,#ccc)}
.sdl-btn.danger{background:transparent;border:1px solid #d33;color:#d33}
.sdl-btn:hover{filter:brightness(1.08)}
.sdl-list{list-style:none;margin:0;padding:0}
.sdl-item{display:flex;align-items:center;gap:8px;padding:7px 10px;border:1px solid var(--theme-border,#333);border-radius:8px;margin-bottom:5px}
.sdl-item .t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sdl-item .st{font-size:10px;padding:2px 6px;border-radius:10px;white-space:nowrap}
.sdl-item .st.run{background:rgba(255,193,7,.15);color:#f1c40f}
.sdl-item .st.idle{background:rgba(46,204,113,.12);color:#2ecc71}
`;
		function ensureStyles() {
			if (document.getElementById(STYLE_ID)) return;
			const style = document.createElement("style");
			style.id = STYLE_ID;
			style.textContent = styles;
			document.head.appendChild(style);
		}
		function fetchJson(url, init) {
			return fetch(url, { headers: { "content-type": "application/json" }, ...init }).then(async (r) => {
				const body = await r.json().catch(() => ({}));
				return { status: r.status, body };
			});
		}
		function fmtTime(ts) {
			if (!ts) return "-";
			const d = new Date(ts);
			const p = (n) => String(n).padStart(2, "0");
			return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
		}
		function shortId(id) {
			return String(id || "").replace(/^session-/, "").slice(0, 8);
		}
		const TOMBSTONE_KEY = "sdl-deleted:v1";
		function tombstones() {
			try {
				const raw = window.localStorage.getItem(TOMBSTONE_KEY);
				const list = raw === null ? [] : JSON.parse(raw);
				return Array.isArray(list) ? new Set(list) : new Set();
			} catch {
				return new Set();
			}
		}
		/** 墓碑表只用于隐藏"已删但注册表还没散场"的行，保留最近若干条即可。 */
		const TOMBSTONE_MAX = 200;
		function tombstoneAdd(sessionId) {
			try {
				const set = tombstones();
				const key = String(sessionId);
				// 先 delete 再 add：让刚删除的会话排到表尾，slice(-200) 的
				// "最近 200 条"语义才按最近一次删除来淘汰。
				set.delete(key);
				set.add(key);
				const list = [...set];
				window.localStorage.setItem(TOMBSTONE_KEY, JSON.stringify(list.slice(-TOMBSTONE_MAX)));
			} catch {}
		}
		async function deleteSession(sessionId, force) {
			const { status, body } = await fetchJson(DELETE_URL, {
				method: "POST",
				body: JSON.stringify({ sessionId, force })
			});
			return { status, body: body ?? {} };
		}
		//#endregion
		//#region settings page (React component)
		function SessionManagerSection() {
			const [items, setItems] = (0, react.useState)(null);
			const [error, setError] = (0, react.useState)("");
			const [notice, setNotice] = (0, react.useState)("");
			const [busyId, setBusyId] = (0, react.useState)(null);
			const forceRef = (0, react.useRef)(null);
			const mountedRef = (0, react.useRef)(true);
			const refresh = (0, react.useCallback)(async () => {
				setError("");
				try {
					const res = await fetch(LIST_URL);
					if (!res.ok) throw new Error(`HTTP ${res.status}`);
					const body = await res.json();
					if (!body?.ok) throw new Error(body?.error ?? "unknown error");
					const hidden = tombstones();
					// 卸载后 fetch 才返回：不再 setState，避免对已卸载组件写入。
					if (!mountedRef.current) return;
					setItems((Array.isArray(body.items) ? body.items : []).filter((s) => !hidden.has(s.sessionId)));
				} catch (e) {
					if (!mountedRef.current) return;
					setError(e instanceof Error ? e.message : String(e));
					setItems([]);
				}
			}, []);
			(0, react.useEffect)(() => {
				ensureStyles();
				refresh();
				return () => { mountedRef.current = false; };
			}, [refresh]);
			/** host 返回的强删 warning 必须跟着"已删除"一起展示，不能静默吞掉。 */
			const deletedNotice = (body) => {
				const base = body.noDiskArtifact
					? `已删除 ${shortId(body.sessionId ?? "")}（该会话没有已保存的内容）`
					: `已删除 ${shortId(body.sessionId ?? "")}`;
				return typeof body.warning === "string" && body.warning !== "" ? `${base}\n警告：${body.warning}` : base;
			};
			const onDelete = async (s) => {
				const label = s.title ? `「${String(s.title)}」` : `会话 ${shortId(s.sessionId)}`;
				if (!window.confirm(`确定永久删除会话 ${label} ？\n\n将删除该会话的全部内容，且无法恢复。`)) return;
				setBusyId(s.sessionId);
				setNotice("");
				try {
					let { body } = await deleteSession(s.sessionId, forceRef.current?.checked === true);
					if (!mountedRef.current) return;
					if (body?.ok) {
						tombstoneAdd(s.sessionId);
						setNotice(deletedNotice({ ...body, sessionId: s.sessionId }));
						await refresh();
					} else if (body?.error === "session-running") {
						// 用户在强删确认框点"取消"：未确认即放弃，静默返回，不当失败横幅。
						if (!window.confirm((body.message ?? "会话正在运行") + "\n\n强制删除？")) return;
						({ body } = await deleteSession(s.sessionId, true));
						if (!mountedRef.current) return;
						if (body?.ok) {
							tombstoneAdd(s.sessionId);
							setNotice(deletedNotice({ ...body, sessionId: s.sessionId }));
							await refresh();
						} else throw new Error(body?.message ?? body?.error ?? "failed");
					} else {
						throw new Error(body?.message ?? body?.error ?? "failed");
					}
				} catch (e) {
					if (!mountedRef.current) return;
					setError(e instanceof Error ? e.message : String(e));
				} finally {
					if (mountedRef.current) setBusyId(null);
				}
			};
			const h = (0, react.createElement);
			const rows = items ?? [];
			return h("div", { className: "sdl-page" },
				h("h3", void 0, "会话管理（删除）"),
				h("p", { className: "sdl-hint" }, "删除会话会永久移除其全部内容（对话记录等），不可恢复。"),
				h("div", { className: "sdl-toolbar" },
					h("button", { className: "sdl-btn ghost", onClick: refresh }, items === null ? "加载中…" : "刷新列表"),
					h("label", { style: { fontSize: 12, color: "var(--theme-text-secondary,#999)", display: "flex", alignItems: "center", gap: 4 } },
						h("input", { type: "checkbox", ref: forceRef }), "强制删除运行中的会话")),
				error !== "" && h("div", { style: { color: "#d66", fontSize: 12, margin: "4px 0 8px", whiteSpace: "pre-wrap" } }, error),
				notice !== "" && h("div", { style: { color: "#2ecc71", fontSize: 12, margin: "4px 0 8px", whiteSpace: "pre-wrap" } }, notice),
				items === null
					? h("div", null, "加载中…")
					: rows.length === 0
						? h("div", null, "（没有会话）")
						: h("ul", { className: "sdl-list", style: { listStyle: "none", margin: 0, padding: 0 } },
							[...rows].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)).map((s) =>
								h("li", {
									key: s.sessionId,
									className: "sdl-item",
									style: { display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", border: "1px solid var(--theme-border,#333)", borderRadius: 8, marginBottom: 5 }
								},
									h("span", {
										className: "t",
										title: s.sessionId + (s.cwd ? "\n" + s.cwd : ""),
										style: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }
									}, s.title ? String(s.title) : `会话 ${shortId(s.sessionId)}${s.cwd ? " · " + s.cwd : ""}`),
									h("span", {
										className: "st " + (s.running ? "run" : "idle"),
										style: { fontSize: 10, padding: "2px 6px", borderRadius: 10, whiteSpace: "nowrap" }
									}, s.running ? "运行中" : fmtTime(s.updatedAt)),
									h("button", {
										className: "sdl-btn danger",
										disabled: busyId === s.sessionId,
										onClick: () => onDelete(s)
									}, busyId === s.sessionId ? "删除中…" : "删除")))));
		}
		//#endregion
		function apply(ctx) {
			ctx.effect(() => ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "session-delete-manager",
				order: 32,
				label: () => "会话管理"
			}, SessionManagerSection)), "session-delete: settings page");
		}
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
