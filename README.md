# CS2 玩家查询 · Node.js 网页版

桌面和 Ubuntu 服务器共用 Node.js 查询引擎。运行需要 **Node.js 22.13 或更新版本**。HTTP 连接、SQLite、加密 Cookie 和静态文件服务均使用 Node.js 内置模块。网页服务没有第三方运行时依赖。

## 本机启动

在项目目录执行 `npm start`，浏览器访问 `http://127.0.0.1:8765/`。Windows 也可以双击 `启动网页版.cmd`。桌面模式只监听回环地址，每个浏览器独立登录，重启时会重新生成会话密钥。

## 更新现有 Ubuntu 多用户部署

此流程适用于已运行的 `wmpvp-multi-eaed139.service`，工作目录为 `/opt/wmpvp-multi-eaed139`，Nginx 转发到本机 18766。升级沿用服务器现有的 `listen.mjs`、systemd 环境、站点口令、会话密钥和 IP 入口。无需安装 Python 或执行 npm install。

在保存源码的 Git 仓库中运行。以下命令使用已合并的 main：

```bash
cd ~/wmpvp-player-lookup
git switch main && git pull --ff-only origin main && sudo bash deploy/ubuntu/update.sh install
```

脚本先确认 18766 属于目标服务并核对已知模块指纹。构建完成后才短暂停服，备份原来的 server、dist 和自定义静态文件。切换时比对部署目录里的 HTML、JS、CSS 与本次构建的 SHA-256，再向 18766 发送 `POST /api/health` 检查新版查询接口。Nginx 可以独立提供静态文件。任一步切换检查失败都会尝试恢复原版本。升级后刷新原来的网页，仍可使用原站点口令和有效登录会话。可在系统日志查看查询耗时：

```bash
journalctl -u wmpvp-multi-eaed139.service -n 50 --no-pager
```

需要回到上一次部署时，在同一源码目录执行：

```bash
sudo bash deploy/ubuntu/update.sh rollback
```

每次切换的备份在部署目录的 `.query-releases/`。自动检查仅覆盖服务运行和静态文件，实际登录、短信、反向代理和平台限流以服务器上的结果为准。

## 新建服务器实例

设置 `WMPVP_PUBLIC_ORIGIN` 为浏览器使用的完整 HTTPS 来源，`WMPVP_PORT` 为监听端口，`SITE_PASSWORD` 为至少 16 字符的访问口令，`SESSION_SECRET` 为随机生成的 64 位十六进制密钥。用服务管理器保管这些设置并运行 `node listen.mjs`。Node 只监听 127.0.0.1，由 HTTPS 反向代理转发到该端口。已有的 Ubuntu 实例按上方升级流程继续使用原入口。

## 查询功能

- 每次最多 20 个昵称，按行输入，也可粘贴游戏控制台 `status` 输出。
- 过滤名单按完整昵称匹配，**查询前直接跳过**，不请求这些玩家的战绩和历史分数。修改名单不隐藏已有结果，下次查询生效。
- 同名账号中有近期对局时，排除已确认无对局的账号；全部有或全部无时都显示。查询失败的账号保留提示，模糊匹配由用户确认。
- 展示最近十场逐场战绩：日期、类型、胜败、比分、K/D/A、ADR、RWS、Rating Pro、WE、级别、高光。移除了旧的场均统计圆环，不再计算汇总胜率、爆头率及 K/D。
- 日期优先显示结束时间，比分采用客户端截图的队伍 2 : 队伍 1 顺序；胜败根据该玩家所在队伍判断，平局显示“平”。缺失数值显示 `--`。
- Rating Pro 低于 1 显示红色，高于 1 显示青色，等于 1 保持原色。
- 顶部显示当前天梯分、历史分及对应图标；超过 2400 分统一使用基础青绿色 S。历史分取各赛季 `historyScores` 的最高有效值，不保证完整生涯覆盖。
- 官匹分只取最近十场比赛列表里最新的有效 `pvpNormalRank`，全部为空不显示；不会用详情里的默认零覆盖空值。
- 保留黄色方形 MVP，以及“准、狙、突、残、闪、助”高光图标，不显示 SVP。
- 页面不展示封禁记录、64 位 ID、平台昵称或分数变化，不提供报告下载；网页版不请求封禁记录。

## 查询过程与性能

所有玩家共用 Node 原生 fetch 的连接池和同一个优先队列，并发上限由 `WMPVP_CONCURRENCY` 设置，默认 6。查询先取昵称和近期列表，确认同名账号后再补各场高光和历史分。卡片按输入顺序保留位置，各字段独立更新。取消批次会中止无人等待的上游请求，旧响应不能覆盖新卡片。

SQLite 默认写入 `.lookup-cache/node.sqlite3`，可用 `WMPVP_CACHE_PATH` 指定文件。比赛按 matchId 缓存，赛季按 SteamID 与赛季编号缓存。已结束比赛和赛季保存 180 天，当前赛季 5 分钟，近期列表 60 秒。近期列表按登录凭据和查看者隔离。同一数据有多个等待者时共用一次请求。日志记录接口类别、耗时、次数、命中率、重试、失败类别及浏览器显示时间。遇到限流时同主机的请求共同遵守 Retry-After。登录和短信只发送一次。

### 浏览器实测

桌面 Chrome、10 名玩家、100 条战绩，每次模拟接口响应延迟 120 ms，每人 25 个赛季，有一场比赛为十人共享。下表为点击查询到画面首次显示、十人基础表齐全、全部补完的实测秒数。

| Node.js 场景 | 首张战绩表 | 十人基础战绩 | 全部补完 |
|---|---:|---:|---:|
| 冷缓存 | 0.303 | 0.541 | 7.613 |
| 热缓存 | 0.179 | 0.286 | 0.286 |

该组使用模拟上游。真实完美平台响应取决于服务器出口、登录状态和限流。维护者可在装有 Chrome 的机器安装开发工具 `npm install --no-save --package-lock=false playwright-core`，运行 `node scripts/benchmark.cjs --fixture` 复测。要测真实平台，运行 `node scripts/benchmark.cjs 访问地址 names.txt`，在弹出的浏览器内完成登录；文件每行一个昵称，共十名。

## 高光来源与限制

优先合并比赛列表及该玩家详情中的明确高光标记。部分完美官匹 Pro 比赛的整场 `honor` 都为空，此时仅在完整十人数据可用时补全：

| 图标 | 详情字段 | 含义 |
|---|---|---|
| 准 | `headShot` | 爆头次数最多 |
| 狙 | `snipeNum` | 狙击击杀最多 |
| 突 | `entryKill` | 首杀最多 |
| 残 | `endGame` | 残局获胜最多 |
| 闪 | `flashSuccess` | 闪白成功最多 |
| 助 | `assist` | 助攻最多 |

各项取正数最高值，并列时取接口记录顺序的第一位。这个补全方式与用户提供的八场客户端截图相符，尚不能保证覆盖客户端所有特殊规则；缺失数据不会当成零推算。悬停补全图标可查看来源说明。MVP 使用平台已有标记，不通过以上规则生成。

## 登录和会话

站点解锁、官方人机验证、短信与 SteamID 验证沿用原多用户协议。每个浏览器的凭据由 AES-GCM 加密保存在 HttpOnly Cookie 中，有效期最长 8 小时。服务端从已验证的 Cookie 确定批次所属会话，检查每一次读取和取消请求。请求体中的账号凭据和会话标识不能更改批次归属。

## 开发检查

```sh
npm run check
npm test
npm run build
```

构建生成 dist/ 静态资源。部署回滚回归用例使用旧版本的 Git 对象，可在具有完整仓库历史的环境执行 `node --test tests/node-release.test.mjs`。原 Python 工具和原回归用例保留在 `legacy/python/`，作为旧版本兼容入口。当前网页版的启动、构建、查询和升级均由 Node.js 完成。

接口参考：[PerfectWorld API Collection](https://github.com/Redamancy520/PerfectWorld-API-Collection)。段位图标来自完美官方资源，权利归原权利人所有。
