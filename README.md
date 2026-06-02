<div align="center">

# 📦 EdgeStash

**基于 Cloudflare Workers 的现代化网盘解决方案**

*零服务器成本 · 无限存储潜力 · 极致的边缘速度*

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![Cloudflare R2](https://img.shields.io/badge/Cloudflare-R2-F38020?logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/r2/)
[![Cloudflare KV](https://img.shields.io/badge/Cloudflare-KV-F38020?logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/kv/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](http://makeapullrequest.com)

[🌟 特性](#-特性) • [🚀 快速部署](#-快速部署) • [⚙️ 配置说明](#️-配置说明) • [🛠️ 技术架构](#️-技术架构)

</div>

---

## 📖 简介

**EdgeStash** 是一个完全运行在 Cloudflare 边缘网络上的私有网盘系统。无需购买服务器、无需搭建数据库，仅需一个 Cloudflare 账号即可拥有功能齐全、性能卓越的个人/团队云存储。

得益于 Cloudflare 全球 300+ 个边缘节点，无论用户身处何地，都能享受极致的访问速度。

## ✨ 特性

### 🗂️ 核心功能
- ✅ **智能分片上传** — 自动识别大文件，5MB 分片上传，突破 100MB 限制，支持 GB 级文件
- ✅ **断点续传支持** — 上传中途可取消，下次上传自动续传（R2 Multipart API）
- ✅ **拖拽上传** — 直接将文件拖入浏览器即可上传
- ✅ **文件预览** — 支持图片、PDF、视频、音频、Markdown、Word、代码文件在线预览
- ✅ **分享链接** — 生成带密码保护 + 有效期的分享链接
- ✅ **同名文件自动重命名** — 上传冲突自动加 `(1)` `(2)` 后缀，杜绝覆盖丢失

### 🎨 用户体验
- ✅ **现代极简 UI** — 参考 Linear/Vercel 设计语言，细腻动效
- ✅ **深色模式** — 一键切换，自动跟随系统，记忆用户偏好
- ✅ **右键上下文菜单** — 桌面端右键/移动端长按呼出，符合直觉
- ✅ **文件排序** — 按名称/大小/时间排序，状态本地持久化
- ✅ **实时进度条** — 上传进度实时反馈，支持多文件队列显示

### 🛡️ 安全与性能
- ✅ **JWT 鉴权** — 管理员 + 普通用户多角色体系
- ✅ **SHA-256 密码哈希** — 密码不明文存储
- ✅ **URL 编码透明处理** — 完美支持中文路径，自动迁移历史污染数据
- ✅ **CDN 缓存优化** — 分享链接自动缓存，节省 R2 读取费用
- ✅ **KV 元数据管理** — 文件夹注册表独立存储，R2 保持纯净

### 🌐 部署优势
- 🚀 **零服务器成本** — 完全基于 Cloudflare 免费/低价资源
- 🌍 **全球边缘加速** — 300+ 节点就近访问
- ⚡ **毫秒级响应** — Worker 冷启动 < 5ms
- 💾 **廉价对象存储** — R2 存储成本约 AWS S3 的 1/10


## 🚀 快速部署

部署 EdgeStash 非常简单，全程在 Cloudflare Dashboard 中完成。

### 前置要求

- 一个 Cloudflare 账户。
- 已开通 R2 和 Workers 、 KV 服务。

### 部署步骤

| 配置   | 变量名          | 说明              |
| :----- | :----------------------------- | :------------------------- |
| `R2` | `R2_BUCKET` | 存放文件的地方，名称随意|
| `KV` | `KV_STORE`| 存放链接的地方，名称随意|
| `管理员密码` | `ADMIN_PASSWORD`| 你想设置什么都行  |
| `JWT_SECRET` | `JWT_SECRET`| 你想设置什么都行  |


1.  **创建 R2 存储桶**
    - 登录 Cloudflare -> R2 -> 创建存储桶。
    - 记下您的存储桶名称（例如 `edgestash-files`）。

2.  **创建 KV 命名空间**
    - 登录 Cloudflare -> Workers 和 Pages -> KV -> 创建命名空间。
    - 记下您的命名空间名称（例如 `edgestash-kv`）。

3.  **创建 Worker**
    - 登录 Cloudflare -> Workers 和 Pages -> 创建应用程序 -> 创建 Worker。
    - 为您的 Worker 命名（例如 `edgestash`），然后点击 **部署**。

4.  **上传代码**
    - 在 Worker 页面，点击 **编辑代码**。
    - 将本项目提供的 `worker.js` 文件内容完整粘贴进去。
    - 点击 **部署**。

5.  **配置绑定**
    - 返回 Worker 概览页面，点击 **设置** -> **变量和机密**。
    - **配置环境变量**：
        - `ADMIN_PASSWORD`：设置您的管理员登录密码。
    - **配置 R2 绑定**：
        - 变量名称：`R2_BUCKET`
        - R2 存储桶：选择您在第 1 步创建的存储桶。
    - **配置 KV 绑定**：
        - 变量名称：`KV_STORE`
        - KV 命名空间：选择您在第 2 步创建的命名空间。

6.  **完成！**
    - 访问您的 Worker URL (`https://<worker-name>.<subdomain>.workers.dev`) 即可开始使用！
7.  **绑定你自己的域名！**
