<div align="center">

<img src="./logo.png" alt="Cloudflare Workers 工具集 Logo" width="96" />

# Cloudflare Workers 工具集

**EdgeStash 私有云盘 + AccelPro GitHub / Docker 加速代理**

*零服务器成本 · 边缘网络加速 · 单文件 Worker 部署*

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![Cloudflare R2](https://img.shields.io/badge/Cloudflare-R2-F38020?logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/r2/)
[![Cloudflare KV](https://img.shields.io/badge/Cloudflare-KV-F38020?logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/kv/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[仓库简介](#仓库简介) · [已有 Worker](#已有-worker) · [通用部署流程](#通用部署流程) · [详细使用方法](#详细使用方法) · [注意事项](#注意事项)

</div>

---

## 仓库简介

本仓库收录一组可直接部署到 **Cloudflare Workers** 的边缘应用。每个应用都保持单文件 Worker 形态，适合个人自用、小团队工具站、轻量级代理服务或低成本边缘应用部署。

当前包含两类能力：

- **私有云盘**：基于 Cloudflare R2 和 KV 构建个人/团队文件存储入口。
- **网络加速代理**：基于 Cloudflare Workers 为 GitHub 文件和 Docker 镜像拉取提供代理入口。

前端资源已尽量避开 `cdn.jsdelivr.net`，改用更适合国内访问的 CDN / npm 镜像地址，降低页面资源加载失败的概率。

## 已有 Worker

| Worker | 文件 | 依赖绑定 | 简介 |
| :-- | :-- | :-- | :-- |
| **EdgeStash** | `EdgeStash.js` | R2、KV、环境变量 | 私有云盘系统，支持登录鉴权、文件上传、分片上传、文件夹管理、在线预览、分享链接、后台统计和 R2 10GB 免费容量保护。 |
| **AccelPro** | `AccelPro.js` | 无必需绑定 | GitHub 文件和 Docker 镜像加速代理，支持 GitHub Release / Raw / Gist 链接转换、Docker Hub / GHCR 等镜像代理拉取、Docker Token 缓存和 Git Smart HTTP。 |

## 通用部署流程

两个 Worker 都可以通过 Cloudflare Dashboard 手动部署，也可以用 Wrangler 部署。最简单的方式是直接在 Cloudflare 后台粘贴单文件代码。

1. 登录 Cloudflare Dashboard。
2. 进入 **Workers & Pages**。
3. 创建 Worker 应用。
4. 打开在线代码编辑器。
5. 根据要部署的应用，粘贴 `EdgeStash.js` 或 `AccelPro.js` 的完整内容。
6. 按对应 Worker 的说明配置绑定或环境变量。
7. 点击 **Deploy**。
8. 访问 Worker 默认域名或绑定自己的域名使用。

## 详细使用方法

<details>
<summary><strong>EdgeStash：私有云盘详细介绍与使用方法</strong></summary>

### 适用场景

EdgeStash 适合把 Cloudflare R2 作为个人或团队的私有对象存储入口。它不需要自建服务器或数据库，登录、用户、分享、文件夹元数据等轻量数据存储在 KV 中，文件内容存储在 R2 中。

### 核心功能

- 文件上传、拖拽上传和大文件分片上传。
- 文件夹创建、删除、列表展示和空文件夹保存。
- 图片、PDF、文本、Markdown、Word、音频、视频等文件预览。
- 分享链接，可设置密码和有效期。
- 管理后台，可查看分享、用户、访问和下载统计。
- R2 当前用量、10GB 免费额度、剩余容量展示。
- 上传前后检查 R2 免费容量，避免超过免费额度继续写入。
- 中文路径和特殊字符路径编码处理。
- Markdown / Word HTML 预览净化，降低 XSS 风险。

### 需要的 Cloudflare 资源

| 类型 | 绑定名 / 变量名 | 说明 |
| :-- | :-- | :-- |
| R2 Bucket | `R2_BUCKET` | 存放上传文件。 |
| KV Namespace | `KV_STORE` | 存放用户、分享、文件夹和统计元数据。 |
| 环境变量 | `ADMIN_PASSWORD` | 管理员登录密码。 |
| 环境变量 | `JWT_SECRET` | JWT 签名密钥，建议设置为长随机字符串。 |

### 部署步骤

1. 创建 R2 存储桶。
2. 创建 KV 命名空间。
3. 创建 Cloudflare Worker。
4. 将 `EdgeStash.js` 的完整内容粘贴到 Worker 编辑器。
5. 在 Worker 设置里绑定：
   - R2 绑定名：`R2_BUCKET`
   - KV 绑定名：`KV_STORE`
6. 在 Worker 环境变量里添加：
   - `ADMIN_PASSWORD`
   - `JWT_SECRET`
7. 部署 Worker。
8. 访问 Worker 域名，使用管理员密码登录。
9. 进入管理后台添加普通用户，或直接以管理员身份使用云盘。

### 使用入口

| 路径 | 说明 |
| :-- | :-- |
| `/` | 云盘首页。 |
| `/login.html` | 登录页。 |
| `/admin.html` | 管理后台。 |
| `/s/<shareId>` | 文件分享页。 |

### 容量说明

EdgeStash 当前按绑定的 **同一个 R2 Bucket** 扫描计算已用容量。如果其他 Worker 也写入这个 Bucket，会被计入剩余额度；如果其他 Worker 使用不同 Bucket，则无法通过当前绑定精确计算账号级总用量。

</details>

<details>
<summary><strong>AccelPro：GitHub / Docker 加速代理详细介绍与使用方法</strong></summary>

### 适用场景

AccelPro 适合在 GitHub 文件下载慢、Docker 镜像拉取不稳定或需要统一代理入口的场景中使用。它通过 Cloudflare Workers 转发请求，并在前端提供链接和命令转换工具。

### 核心功能

- GitHub Release、Raw、Gist 文件代理下载。
- Docker Hub、GHCR、Quay、GCR 等镜像代理拉取。
- Docker Bearer Token 获取与缓存。
- Git Smart HTTP 支持。
- 转换原始 GitHub 链接为 Worker 加速链接。
- 转换镜像名为 `docker pull <worker-domain>/<image>` 命令。
- 重定向安全检查，阻止不安全跳转。
- 请求体大小限制，避免 Worker 被大请求滥用。

### 部署步骤

1. 创建 Cloudflare Worker。
2. 将 `AccelPro.js` 的完整内容粘贴到 Worker 编辑器。
3. 部署 Worker。
4. 打开 Worker 域名，即可使用前端转换工具。

AccelPro 默认不需要 R2、KV 或环境变量绑定。

### 使用方式

#### GitHub 文件加速

在首页粘贴 GitHub、`raw.githubusercontent.com` 或 Gist 链接，点击生成加速链接。

也可以直接按下面格式访问：

```text
https://<你的Worker域名>/https://github.com/user/repo/releases/download/file.zip
```

#### Docker 镜像加速

在首页输入镜像名，生成拉取命令：

```bash
docker pull <你的Worker域名>/nginx
docker pull <你的Worker域名>/ghcr.io/user/repo:tag
```

Docker 官方镜像会自动补全到 Docker Hub 的 `library` 命名空间。

### 可调整配置

`AccelPro.js` 顶部提供了几个常用配置：

| 配置 | 说明 |
| :-- | :-- |
| `ALLOWED_HOSTS` | 允许代理的上游域名白名单。 |
| `RESTRICT_PATHS` | 是否启用路径关键字限制。 |
| `ALLOWED_PATHS` | 启用路径限制后允许的路径关键字。 |
| `DOCKER_HOSTS` | 识别 Docker 仓库请求的域名列表。 |
| `MAX_REDIRECTS` | 最大重定向次数。 |
| `MAX_PROXY_BODY_BYTES` | 允许代理的最大请求体大小。 |

</details>

## 注意事项

- 请妥善保管 `ADMIN_PASSWORD` 和 `JWT_SECRET`。
- EdgeStash 的 R2 免费容量保护只基于当前绑定 Bucket 计算，不等同于 Cloudflare 账号级账单保护。
- AccelPro 默认是公开代理入口，建议结合 Cloudflare WAF、访问规则、速率限制或路径白名单控制滥用风险。
- 如果部署到自定义域名，请优先使用 HTTPS。
- 前端依赖 CDN 可根据你的网络环境继续替换，但需要确认真实资源路径返回 `200`，避免页面资源加载失败。
