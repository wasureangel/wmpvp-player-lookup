# CS2 玩家查询

支持部署到 **Cloudflare Pages + Pages Functions** 的完美平台玩家查询工具。静态页面负责展示；同一项目下的 `/api/*` 负责官方登录和数据请求，无需额外租服务器。仓库为私人项目，Cloudflare 部署由维护者自行操作。

## 保留的功能

- 每次最多 20 个昵称，支持粘贴游戏 `status` 输出；左侧按完整昵称逐行过滤。
- 同名账号有近期对局时，排除已确认无近期对局的账号；全部有或全部无时全部保留。失败项不当作无对局。
- 默认查询最近十场，WE、Rating Pro、爆头率、ADR、K/D、RWS 按逐场均值显示。缺少必要数据时显示 `--`。
- 胜率按胜场数除以总场数，**平局按输计算**；不足十场按实际场数统计。
- Rating Pro 以 1、胜率以 50% 为分界：低于为红色，高于为青蓝色，恰好等于为白色。
- 天梯当前分和历史分配段位图标；2400 分以上统一使用基础青绿色 S。历史分是各赛季 `historyScores` 的最高有效值，不保证覆盖完整生涯。
- 官匹分取近十场里最新的有效 `pvpNormalRank`；无值不显示。七档颜色、双斜杠徽标，与天梯历史、天梯当前靠右排列。
- 页面不显示封禁记录、64 位 ID、平台昵称或分数变化，不提供报告下载。

## 在 Cloudflare Pages 部署

1. 在 Cloudflare 的 **Workers & Pages → 创建 → Pages → 连接 Git** 中选择这个私有 GitHub 仓库。如果看不到仓库，在 GitHub 的 Cloudflare 应用授权中将此仓库加入可访问范围。
2. 使用以下设置：

   | 项目 | 值 |
   |---|---|
   | 生产分支 | `main` |
   | 框架预设 | `None` |
   | 根目录 | 留空，使用仓库根目录 |
   | 构建命令 | `npm run build` |
   | 构建输出目录 | `dist` |
   | Node 版本 | `24`（环境变量 `NODE_VERSION=24`） |

3. 在自己电脑的项目目录执行 `npm run generate:secrets`，生成两个随机值。**不要把输出提交到 GitHub，也不要发给别人。**
4. 在 Pages 项目的 **Settings → Variables and Secrets** 中添加以下两个值，类型都选 **Secret**：

   | 名称 | 用途 |
   |---|---|
   | `SESSION_SECRET` | 64 位十六进制随机字符串，用于加密浏览器会话 |
   | `SITE_PASSWORD` | 至少 16 个字符的站点访问口令；只给允许使用的人 |

5. 为需要使用的 Production / Preview 环境分别配置，保存后重新部署。未配置时接口会拒绝运行，页面提示维护者尚未完成配置。
6. 打开网站，输入访问口令，然后通过完美官方验证码和短信登录，点击“验证战绩权限”，最后查询玩家。

不需要 KV、D1、额外 Worker 或 Cloudflare API Token。不要仅把 `dist` 文件夹拖到静态上传页面：**Functions 也必须随项目一起部署**；使用上述 Git 集成即可自动包含仓库根目录的 `functions/`。

Pages 的静态文件和 Functions 是不同部分。私有 GitHub 仓库并不自动令网站私有；本站接口使用访问口令保护，静态页面外壳仍可公开访问。如果连页面外壳也需要隐藏，可在 Cloudflare 中额外配置 Access。

## 登录与隐私

- 手机号、验证码、官方登录凭据会经过你部署的 Functions 转发给完美官方。**这不是全部在访问者本地执行的纯前端方案。**
- 官方凭据不返回到页面 JavaScript，不写入日志、数据库或 GitHub；它被加密后保存在当前浏览器的 `HttpOnly; Secure; SameSite=Strict` Cookie 中，最多有效 8 小时。
- 不同浏览器互不共用登录状态；历史分缓存只包含公开比赛分数，不包含登录凭据。
- 退出登录清除当前浏览器会话。会话采用无数据库方案；若需要同时撤销所有浏览器的旧会话，修改任一 Secret 并重新部署。官方也可能提前使凭据失效。
- 接口限制同站请求、输入长度和上游目标地址，包含每个运行实例内的请求频率限制。它不是全站统一限额；如果对外开放给大量用户，应额外配置 Cloudflare 的访问与频率规则。
- 官方验证码组件由完美的站点加载。不要在生产环境加入来源不明的脚本。

## 本地开发和检查

需要 Node.js 22 或更高版本，推荐 24：

```sh
npm ci
npm run check
npm test
npm run test:ui
npm run build
```

将 `.dev.vars.example` 复制为 `.dev.vars`，使用自己生成的值替换示例，再运行：

```sh
npm run dev
```

浏览器打开 Wrangler 输出的本地地址。`.dev.vars` 已被忽略，不会上传。GitHub Actions 只做检查和构建，不包含自动部署，也不需要生产秘密。

原来的本机 Python 服务源码也保留在仓库中，使用 `python web_app.py --open` 可在本机 8765 端口运行；该服务只绑定回环地址。Python 文件不会进入 Pages 静态输出。

## 文件结构

```text
web.html / web.js / web.css   界面源码，与本机版本共用
rank-assets/                 完美官方段位图标
functions/api/[[path]].js    Pages 接口入口
server/                      输入检查、统计、平台请求、会话与接口路由
scripts/                     静态构建、检查、秘密生成
tests/                       统计、登录隔离和界面回归检查
wrangler.jsonc               Pages 运行配置
web_app.py / wmpvp_lookup.py 本机 Python 版本
```

## 数据与上线后的验证

平台接口来自现有工具和公开接口资料，不是官方承诺稳定的公共 API。Cloudflare 不同地区的出口可能遇到官方风控、网络限制，验证码也可能受来源域名影响；这些必须在你自己的部署域名上实际验证，不能仅凭本地测试认定已经可用。

部署后至少验证：访问口令、官方验证码、短信登录、战绩权限、含平局玩家的胜率、官匹分和历史分。若上游无法访问，页面应保留失败提示，不会用零值冒充查到的数据。

参考资料：[Pages Functions 路由](https://developers.cloudflare.com/pages/functions/routing/)、[Pages Git 集成](https://developers.cloudflare.com/pages/configuration/git-integration/)、[Pages 配置](https://developers.cloudflare.com/pages/functions/wrangler-configuration/)。平台字段参考 [PerfectWorld API Collection](https://github.com/Redamancy520/PerfectWorld-API-Collection)。段位图标来自完美官方资源，权利归原权利人所有。
