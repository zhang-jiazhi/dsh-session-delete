# dsh-session-delete — 会话永久删除

给 dsh web 的设置页加一个**会话管理器**，支持把会话**含内容永久删除**（不是归档、不是隐藏）。

## 它解决什么

dsh 自带的是归档 / 隐藏，磁盘上的 `~/.dsh/sessions/` 目录仍在。敏感会话需要真正落盘清除时，本插件把"目录删除"这件事做成一步可点、带在跑 agent 优雅收尾的操作。

## 行为

| 环节 | 处理 |
|---|---|
| 定位 | 跨全部 workspace 扫描，同时匹配 `session-<id>` 与裸 `<id>` 两种目录拼写 |
| 在跑会话 | 先 `agent.cancel({kind:'hook'})`，再等 `whenIdle`（3 s 宽限），最后才删目录 |
| 归档集合 | 删除后清理 workspace 注册表里的归档条目；状态在期间变化则跳过（不盲写） |
| 空会话 | 从未落盘的空白会话只有内存行 —— 返回 `noDiskArtifact`，前端按已删除处理 |
| 路由 | `GET /api/session-delete/list`、`POST /api/session-delete/delete` |

**路径安全**：删除路径**只来自 `readdirSync` 枚举出的真实目录名**（精确匹配），请求体从不参与路径拼接。因此形如 `../../../etc`、`..`、`/etc/passwd` 的输入全部返回空匹配，不构成穿越。

## 来源校验

路由直挂 webServer，**不经过**官方 `/api` 桥的鉴权，故自带闸：

- `Host` 必须解析成功，且为回环主机 **或** 命中 `webRuntime.trustedHosts`
- 对端 `socket.remoteAddress` 校验：Host 声称回环时远端必须真为回环
- 受信列表里的 **IP 字面量**条目还要求对端地址与条目一致（否则同 LAN 任意机器伪造受信 Host 即可删会话）
- 拒 `Sec-Fetch-Site: cross-site`；`Origin` 一旦存在必须同源

这样从 LAN 地址打开 Web GUI 时（profile 配了 `trustedHosts`）依然可用，而不是静默 403。

## 安装

```bash
dsh plugin --profile web add github:zhang-jiazhi/dsh-session-delete
```

安装后需重启 dsh。

## 结构

```
lib/index.js     宿主半：两条路由 + 会话定位/取消/目录删除
lib/client.js    客户端半：settings.section 管理器页面
cordis.patch.yml insert 行
```

**无自动化测试**（纯路由 + 文件系统操作，回归靠手工验证）。

## 注意

- 删除是**不可逆**的：文件级 `rmSync(recursive)`，无回收站。设置页有二次确认。
- 已附加到会话的 agent 由宿主 owner 持有，插件无法拆除；注册表行可能残留到下次重启，但磁盘内容已清除（前端用 tombstone 隐藏该行）。

## License

MIT
