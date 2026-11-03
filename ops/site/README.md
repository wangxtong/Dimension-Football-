# 独立站点部署（不依赖阿里云、不依赖 CI）

## 为什么单独做这一套

| 痛点 | 阿里云现状 | 这套 |
| --- | --- | --- |
| 改配置 | 需要 ECS 登录，agent 无密钥 | `SITE_PASS=… bash ops/site/install.sh` |
| 站点凭据 | 登录页由另一份代码提供，vip/666888 返回 401 | 本套的账号由 `SITE_PASS` 当场生成 |
| 部署链路 | Actions 无 runner、无部署 workflow，站点是人工拷上去的 | 脚本跑完即生效，systemd 守护 |
| 数据来源 | 远端 R2 | 本地 `/var/lib/dimension-site`，按 reportId 不可变存放 |

## 两台命令

```bash
git clone https://github.com/wangxtong/Dimension-Football-.git && cd Dimension-Football-
SITE_PASS='你的密码' SITE_USER=vip SITE_ORIGIN='https://你的域名' bash ops/site/install.sh
```

要求：Node >= 24、systemd、root。脚本会：构建静态资源 → 生成 PBKDF2 鉴权（明文密码不落盘）→ 安装日报 → 装 systemd 服务 → 用 `scripts/verify-site-login.sh` 自检。

## 换域名 / 换服务器

DNS 现在在阿里云万网（`dns9/dns10.hichina.com`），`football` 是一条 A 记录指向 `8.218.6.246`。迁走只需把那条 A 记录改成新服务器 IP（或 CNAME 到托管商），TTL 当前 600 秒。

## 已验证（2026-11-04 07:45 北京，本机实测）

```
POST /login vip/666888 → 303 + Set-Cookie
GET  /api/research-daily → reportId c23a698f823c，beijingDay 2026-11-03
     prospective.sevenDays: scored 4, brier 0.8265282518511182
     prospective.thirtyDays: hitRate 0, logLoss 1.3214
POST /login 错误密码 → 401
```

即：**账号登录与真实账本读数同时成立**，退出码与响应码均可复现。

## 还没做的

- 公网 443 与证书：建议前面挂 Caddy/Nginx 反代到 `127.0.0.1:${SITE_PORT}`，或直接用托管商自带 HTTPS。
- 每日 10:10 的产报与推送仍走 `scripts/push-daily-research.sh`，与本站点解耦；站点只读 `SITE_DATA` 下的日报。
