// AccelPro.js - GitHub 和 Docker 加速代理服务器
// 更新日期: 2026-06-12
// 更新内容:
// 1. 前端首页基于 Vue3、Element Plus、Tailwind CSS 和 HTML 重新美化，统一现代化工具页风格。
// 2. 接入 Iconify 图标库，优化 GitHub 与 Docker 加速转换区域的图标、卡片和交互反馈。
// 3. 使用用户 Logo 转换后的 PNG 路由作为 favicon 和页面品牌标识。
// 4. 通过 s4.zstatic.net 加载 Vue、Element Plus、Tailwind CSS、Iconify，并保留深浅色主题切换。
// 5. 保持原有 GitHub、Docker 代理与缓存逻辑不变，并补强重定向安全、请求体限制和 Docker Bearer 解析。
// 6. 优化首页布局，并修复 docker.io/nginx 这类 Docker Hub 官方镜像路径解析。

// ==========================================
// 用户配置区域开始
// ==========================================

// ALLOWED_HOSTS: 定义允许代理的域名列表（默认白名单）。
const ALLOWED_HOSTS = [
  'quay.io',
  'gcr.io',
  'k8s.gcr.io',
  'registry.k8s.io',
  'ghcr.io',
  'docker.cloudsmith.io',
  'registry-1.docker.io',
  'docker.io',
  'github.com',
  'api.github.com',
  'raw.githubusercontent.com',
  'gist.github.com',
  'gist.githubusercontent.com'
];

// RESTRICT_PATHS: 控制是否限制 GitHub 和 Docker 请求的路径。
const RESTRICT_PATHS = false;

// ALLOWED_PATHS: 定义 GitHub 和 Docker 的允许路径关键字（仅当 RESTRICT_PATHS = true 时生效）。
const ALLOWED_PATHS = [
  'library',
  'user-id-1',
  'user-id-2',
];

// DOCKER_HOSTS: 用于判断是否为 Docker 仓库请求的域名列表。
const DOCKER_HOSTS = [
  'quay.io',
  'gcr.io',
  'k8s.gcr.io',
  'registry.k8s.io',
  'ghcr.io',
  'docker.cloudsmith.io',
  'registry-1.docker.io',
  'docker.io'
];

const GIT_SMART_SERVICES = ['git-upload-pack', 'git-receive-pack'];
const MAX_REDIRECTS = 8;
const MAX_PROXY_BODY_BYTES = 25 * 1024 * 1024;
const EMPTY_BODY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

// ==========================================
// 用户配置区域结束
// ==========================================

const APP_LOGO_DATA_URL = 'data:image/png;base64,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';

const APP_LOGO_SRC = '/logo.png';
const ASSET_CDN_BASE_URL = 'https://s4.zstatic.net/ajax/libs';
const NPM_CDN_BASE_URL = 'https://s4.zstatic.net/npm';
const MATERIAL_ICON_BASE_URL = 'https://npm.onmicrosoft.cn/material-icon-theme@5.27.0/icons/';

function imageDataUrlResponse(dataUrl) {
  const [meta, base64] = dataUrl.split(',');
  const contentType = (meta.match(/^data:([^;]+)/) || [])[1] || 'application/octet-stream';
  const cleanBase64 = (base64 || '').replace(/\s/g, '');
  const binary = atob(cleanBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Response(bytes, {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=31536000, immutable'
    }
  });
}

const HOMEPAGE_HTML = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AccelPro - GitHub & Docker 加速</title>
  <link rel="icon" type="image/png" href="${APP_LOGO_SRC}">
  <link rel="preconnect" href="https://s4.zstatic.net">
  <link rel="preconnect" href="https://npm.onmicrosoft.cn">
  <link rel="stylesheet" href="${ASSET_CDN_BASE_URL}/element-plus/2.11.4/index.min.css">
  <script src="${ASSET_CDN_BASE_URL}/tailwindcss-browser/4.1.13/index.global.min.js"></script>
  <script>
    window.tailwind = window.tailwind || {};
    tailwind.config = {
      darkMode: 'class',
      corePlugins: { preflight: false },
      theme: {
        extend: {
          colors: {
            brand: { 500: '#0ea5e9', 600: '#2563eb' }
          },
          boxShadow: {
            panel: '0 24px 80px rgba(33, 51, 77, .16)'
          }
        }
      }
    };
  </script>
  <script src="${ASSET_CDN_BASE_URL}/vue/3.5.22/vue.global.prod.min.js"></script>
  <script src="${ASSET_CDN_BASE_URL}/element-plus/2.11.4/index.full.min.js"></script>
  <script src="${NPM_CDN_BASE_URL}/iconify-icon@3.0.1/dist/iconify-icon.min.js"></script>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f8fb;
      --surface: rgba(255,255,255,.9);
      --surface-strong: #ffffff;
      --border: #dbe3ef;
      --text: #102033;
      --muted: #65748b;
      --brand: #0ea5e9;
      --brand-strong: #2563eb;
      --ok: #059669;
      --shadow: 0 18px 54px rgba(33, 51, 77, .14);
    }
    .dark {
      color-scheme: dark;
      --bg: #10151f;
      --surface: rgba(23,31,44,.9);
      --surface-strong: #17202d;
      --border: rgba(148,163,184,.22);
      --text: #edf4ff;
      --muted: #9aa9bd;
      --brand: #22d3ee;
      --brand-strong: #60a5fa;
      --ok: #34d399;
      --shadow: 0 18px 54px rgba(0, 0, 0, .34);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background:
        linear-gradient(180deg, #f8fafc 0%, #eef6f8 100%);
      color: var(--text);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .dark body { background: linear-gradient(135deg, #0d121a, #111827); }
    [v-cloak] { display: none; }
    .page { min-height: 100vh; padding: 28px; }
    .shell { width: min(1360px, 100%); max-width: 1360px; margin: 0 auto; }
    .topbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 18px; padding: 8px 0; }
    .brand { display: flex; align-items: center; gap: 12px; min-width: 0; }
    .brand-logo { width: 46px; height: 46px; border-radius: 8px; object-fit: cover; box-shadow: 0 12px 30px rgba(37,99,235,.24); border: 1px solid rgba(255,255,255,.7); background: #fff; }
    .brand-title { font-size: 18px; font-weight: 850; letter-spacing: 0; }
    .brand-subtitle { color: var(--muted); font-size: 13px; margin-top: 2px; }
    .hero {
      display: grid !important;
      grid-template-columns: 1fr;
      gap: 18px;
      align-items: stretch;
    }
    .hero-main, .tool-panel, .status-panel {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      box-shadow: var(--shadow);
      backdrop-filter: blur(16px);
      transition: transform .18s, border-color .18s, box-shadow .18s, background .18s;
    }
    .hero-main:hover, .tool-panel:hover { border-color: color-mix(in srgb, var(--brand-strong) 44%, var(--border)); box-shadow: 0 18px 48px rgba(21, 40, 70, .16); }
    .hero-main { position: relative; overflow: hidden; padding: 30px; display: grid; grid-template-columns: minmax(0, 1fr) minmax(300px, .58fr); gap: 24px; align-items: end; min-height: auto; }
    .hero-main::before { content: ""; position: absolute; inset: 0 0 auto; height: 3px; background: linear-gradient(90deg, var(--brand-strong), #14b8a6); }
    .eyebrow { display: inline-flex; align-items: center; gap: 8px; color: var(--brand-strong); font-weight: 750; font-size: 13px; margin-bottom: 18px; }
    h1 { font-size: 40px; line-height: 1.12; margin: 0; letter-spacing: 0; max-width: 820px; }
    .lead { color: var(--muted); font-size: 15px; line-height: 1.7; max-width: 760px; margin: 16px 0 0; }
    .metrics { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin-top: 0; }
    .metric { border: 1px solid var(--border); border-radius: 8px; padding: 15px; background: var(--surface-strong); }
    .metric strong { display: block; font-size: 23px; line-height: 1.1; }
    .metric span { color: var(--muted); font-size: 12px; }
    .side { display: grid !important; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; align-items: stretch; }
    .tool-panel { padding: 22px; min-height: 276px; }
    .panel-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
    .panel-title { display: flex; align-items: center; gap: 10px; font-size: 16px; font-weight: 800; }
    .panel-icon { display: inline-flex; width: 34px; height: 34px; align-items: center; justify-content: center; border-radius: 8px; background: rgba(14,165,233,.12); color: var(--brand-strong); }
    .panel-icon iconify-icon { font-size: 22px; }
    .material-panel-icon { width: 23px; height: 23px; object-fit: contain; display: block; filter: drop-shadow(0 6px 12px rgba(21,40,70,.12)); }
    .dark .material-panel-icon { filter: drop-shadow(0 6px 14px rgba(0,0,0,.32)); }
    .hint { color: var(--muted); font-size: 13px; line-height: 1.65; margin: 0 0 14px; }
    .result { margin-top: 14px; padding: 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-strong); }
    .result code { display: block; color: var(--ok); white-space: pre-wrap; word-break: break-all; font-family: "SFMono-Regular", Consolas, monospace; font-size: 13px; line-height: 1.6; }
    .result-actions { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
    .status-panel { grid-column: 1 / -1; padding: 16px 18px; }
    .status-grid { display: grid !important; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
    .status-item { display: flex; align-items: center; gap: 10px; color: var(--muted); font-size: 13px; }
    .status-item iconify-icon { color: var(--brand-strong); font-size: 20px; }
    .el-button iconify-icon { font-size: 18px; }
    .el-input__wrapper { border-radius: 8px; }
    .footer { color: var(--muted); font-size: 13px; text-align: center; margin-top: 26px; }
    @media (max-width: 900px) {
      .page { padding: 18px; }
      .hero { grid-template-columns: 1fr; }
      .hero-main { grid-template-columns: 1fr; padding: 24px; }
      .side { grid-template-columns: 1fr; }
      .status-panel { grid-column: auto; }
      .status-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .metrics { margin-top: 4px; }
      h1 { font-size: 36px; }
    }
    @media (max-width: 560px) {
      .topbar { align-items: flex-start; }
      .metrics, .status-grid { grid-template-columns: 1fr; }
      .brand-subtitle { display: none; }
      .hero-main, .tool-panel, .status-panel { padding: 16px; }
      h1 { font-size: 32px; }
    }
  </style>
</head>
<body>
  <div id="app" class="page min-h-screen px-[18px] py-7 sm:px-7 text-slate-950 dark:text-slate-50" :class="{ dark: isDark }" v-cloak>
    <div class="shell">
      <header class="topbar flex items-center justify-between gap-4">
        <div class="brand flex min-w-0 items-center gap-3">
          <img class="brand-logo ring-1 ring-white/70 dark:ring-white/10" src="${APP_LOGO_SRC}" alt="AccelPro Logo">
          <div>
            <div class="brand-title">AccelPro</div>
            <div class="brand-subtitle">GitHub 与 Docker 边缘代理加速</div>
          </div>
        </div>
        <el-button circle @click="toggleTheme" :title="isDark ? '切换浅色主题' : '切换深色主题'">
          <iconify-icon :icon="isDark ? 'solar:sun-2-bold-duotone' : 'solar:moon-bold-duotone'"></iconify-icon>
        </el-button>
      </header>

      <main class="hero">
        <section class="hero-main relative overflow-hidden transition-colors duration-300">
          <div>
            <div class="eyebrow">
              <iconify-icon icon="solar:bolt-bold-duotone"></iconify-icon>
              Cloudflare Workers 极速代理
            </div>
            <h1>GitHub 文件和 Docker 镜像 CF加速。</h1>
            <p class="lead">输入原始地址或镜像名，AccelPro 会生成当前 Worker 域名下的加速下载、Raw 文件访问和容器镜像拉取。</p>
          </div>
          <div class="metrics grid gap-3">
            <div class="metric transition duration-200 hover:-translate-y-0.5 hover:border-sky-300 dark:hover:border-sky-500"><strong>2</strong><span>加速场景</span></div>
            <div class="metric transition duration-200 hover:-translate-y-0.5 hover:border-sky-300 dark:hover:border-sky-500"><strong>0</strong><span>前端构建步骤</span></div>
            <div class="metric transition duration-200 hover:-translate-y-0.5 hover:border-sky-300 dark:hover:border-sky-500"><strong>Edge</strong><span>边缘代理转发</span></div>
          </div>
        </section>

        <section class="side">
          <div class="tool-panel transition duration-200 hover:-translate-y-0.5">
            <div class="panel-head">
              <div class="panel-title">
                <span class="panel-icon"><iconify-icon icon="mdi:github"></iconify-icon></span>
                GitHub 文件加速
              </div>
              <el-tag effect="plain">Release / Raw</el-tag>
            </div>
            <p class="hint">粘贴 GitHub、raw.githubusercontent.com 或 gist 链接，生成可复制的 Worker 代理地址。</p>
            <el-input v-model="githubInput" size="large" clearable placeholder="https://github.com/user/repo/releases/download/...">
              <template #prefix><iconify-icon icon="solar:link-bold-duotone"></iconify-icon></template>
            </el-input>
            <el-button type="primary" size="large" style="width:100%; margin-top: 12px;" @click="convertGithubUrl">
              <iconify-icon icon="solar:wand-magic-bold-duotone"></iconify-icon>
              生成加速链接
            </el-button>
            <div v-if="githubResult" class="result">
              <code>{{ githubResult }}</code>
              <div class="result-actions">
                <el-button size="small" @click="copyText(githubResult)"><iconify-icon icon="solar:copy-bold-duotone"></iconify-icon>复制</el-button>
                <el-button size="small" type="primary" plain @click="openUrl(githubResult)"><iconify-icon icon="solar:external-link-bold-duotone"></iconify-icon>打开</el-button>
              </div>
            </div>
          </div>

          <div class="tool-panel transition duration-200 hover:-translate-y-0.5">
            <div class="panel-head">
              <div class="panel-title">
                <span class="panel-icon"><iconify-icon icon="mdi:docker"></iconify-icon></span>
                Docker 镜像加速
              </div>
              <el-tag type="success" effect="plain">Docker Pull</el-tag>
            </div>
            <p class="hint">输入镜像名或仓库路径，生成通过当前 Worker 域名拉取的 docker pull 命令。</p>
            <el-input v-model="dockerInput" size="large" clearable placeholder="nginx 或 ghcr.io/user/repo">
              <template #prefix><iconify-icon icon="solar:box-bold-duotone"></iconify-icon></template>
            </el-input>
            <el-button type="success" size="large" style="width:100%; margin-top: 12px;" @click="convertDockerImage">
              <iconify-icon icon="solar:terminal-bold-duotone"></iconify-icon>
              生成拉取命令
            </el-button>
            <div v-if="dockerResult" class="result">
              <code>{{ dockerResult }}</code>
              <div class="result-actions">
                <el-button size="small" @click="copyText(dockerResult)"><iconify-icon icon="solar:copy-bold-duotone"></iconify-icon>复制</el-button>
              </div>
            </div>
          </div>

          <div class="status-panel transition-colors duration-300">
            <div class="status-grid">
              <div class="status-item"><iconify-icon icon="solar:shield-check-bold-duotone"></iconify-icon><span>白名单域名代理</span></div>
              <div class="status-item"><iconify-icon icon="solar:cloud-bolt-bold-duotone"></iconify-icon><span>Cloudflare 边缘缓存</span></div>
              <div class="status-item"><iconify-icon icon="solar:key-minimalistic-bold-duotone"></iconify-icon><span>Docker Token 缓存</span></div>
              <div class="status-item"><iconify-icon icon="solar:code-scan-bold-duotone"></iconify-icon><span>Git Smart HTTP 支持</span></div>
            </div>
          </div>
        </section>
      </main>

      <footer class="footer">Powered by Cloudflare Workers · AccelPro</footer>
    </div>
  </div>

  <script>
    const { createApp } = Vue;
    const app = createApp({
      data() {
        return {
          logo: '${APP_LOGO_SRC}',
          isDark: localStorage.getItem('accelpro-theme') === 'dark' || (!localStorage.getItem('accelpro-theme') && window.matchMedia('(prefers-color-scheme: dark)').matches),
          githubInput: '',
          dockerInput: '',
          githubResult: '',
          dockerResult: ''
        };
      },
      watch: {
        isDark(value) {
          document.documentElement.classList.toggle('dark', value);
          localStorage.setItem('accelpro-theme', value ? 'dark' : 'light');
        }
      },
      mounted() {
        document.documentElement.classList.toggle('dark', this.isDark);
      },
      methods: {
        toggleTheme() {
          this.isDark = !this.isDark;
        },
        convertGithubUrl() {
          const input = this.githubInput.trim();
          if (!input || !input.startsWith('https://')) {
            this.githubResult = '';
            this.$message.error('请输入有效的 https:// 链接');
            return;
          }
          this.githubResult = window.location.origin + '/https://' + input.slice(8);
          this.copyText(this.githubResult, '已生成并复制加速链接');
        },
        convertDockerImage() {
          let input = this.dockerInput.trim();
          if (!input) {
            this.dockerResult = '';
            this.$message.error('请输入有效的镜像地址');
            return;
          }
          input = input.replace(/^docker\\s+pull\\s+/i, '');
          this.dockerResult = 'docker pull ' + window.location.hostname + '/' + input;
          this.copyText(this.dockerResult, '已生成并复制拉取命令');
        },
        async copyText(text, message) {
          if (!text) return;
          try {
            if (navigator.clipboard && window.isSecureContext) {
              await navigator.clipboard.writeText(text);
            } else {
              const textarea = document.createElement('textarea');
              textarea.value = text;
              textarea.style.position = 'fixed';
              textarea.style.opacity = '0';
              document.body.appendChild(textarea);
              textarea.select();
              document.execCommand('copy');
              document.body.removeChild(textarea);
            }
            this.$message.success(message || '已复制');
          } catch (error) {
            this.$message.error('复制失败: ' + error.message);
          }
        },
        openUrl(url) {
          window.open(url, '_blank', 'noopener,noreferrer');
        }
      }
    });
    app.config.compilerOptions.isCustomElement = (tag) => tag === 'iconify-icon';
    app.use(ElementPlus);
    app.mount('#app');
  </script>
</body>
</html>
`;

// ================= 工具函数 =================

function isAmazonS3(url) {
  try { return new URL(url).hostname.includes('amazonaws.com'); } catch { return false; }
}

function buildAmzDate() {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, -5) + 'Z';
}

function isDockerHost(hostname) { return DOCKER_HOSTS.includes(hostname); }

function hasRequestBody(method) { return !['GET', 'HEAD'].includes((method || 'GET').toUpperCase()); }

function isPrivateHostname(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const parts = host.split('.').map(Number);
    return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 169 && parts[1] === 254);
  }
  if (host === '[::1]' || host === '::1') return true;
  return false;
}

function isSafeRedirectUrl(redirectUrl) {
  try {
    const next = new URL(redirectUrl);
    return next.protocol === 'https:' && !isPrivateHostname(next.hostname);
  } catch {
    return false;
  }
}

function stripCrossOriginSensitiveHeaders(headers, fromUrl, toUrl) {
  try {
    if (new URL(fromUrl).origin === new URL(toUrl).origin) return headers;
  } catch {}
  ['authorization', 'cookie', 'proxy-authorization', 'x-api-key', 'x-auth-token'].forEach(h => headers.delete(h));
  return headers;
}

function parseBearerChallenge(header) {
  const match = String(header || '').match(/Bearer\s+(.+)/i);
  if (!match) return null;
  const params = {};
  const parts = match[1].match(/(?:[^,"]+|"[^"]*")+/g) || [];
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    params[key] = value;
  }
  return params.realm ? params : null;
}

function shouldChangeMethodToGet(status, method) {
  const upperMethod = (method || 'GET').toUpperCase();
  return status === 303 || ((status === 301 || status === 302) && upperMethod === 'POST');
}

function isGitSmartHttpPath(pathname = '', search = '') {
  const lowerPath = pathname.toLowerCase();
  const lowerSearch = search.toLowerCase();
  return (
    lowerPath.endsWith('/info/refs') || lowerPath.endsWith('/git-upload-pack') ||
    lowerPath.endsWith('/git-receive-pack') || lowerPath.includes('/info/lfs') ||
    lowerPath.endsWith('/objects/info/packs') ||
    GIT_SMART_SERVICES.some(service => lowerSearch.includes(`service=${service}`))
  );
}

function normalizeGitHubPath(pathname = '') {
  const normalized = pathname.replace(/^\/+/, '');
  if (!normalized) return normalized;
  if (normalized.startsWith('https://') || normalized.startsWith('http://')) return normalized;
  if (normalized.startsWith('gh/')) return normalized.slice(3);
  if (normalized.startsWith('github.com/')) return normalized.slice('github.com/'.length);
  return normalized;
}

function applyCommonProxyHeaders(headers, targetUrl, isGitRequest = false) {
  try { headers.set('Host', new URL(targetUrl).hostname); } catch {}
  
  ['cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor', 'x-forwarded-proto', 
   'x-forwarded-host', 'x-real-ip', 'x-amz-content-sha256', 'x-amz-date', 
   'x-amz-security-token', 'x-amz-user-agent'].forEach(h => headers.delete(h));

  if (isAmazonS3(targetUrl)) {
    headers.set('x-amz-content-sha256', EMPTY_BODY_SHA256);
    headers.set('x-amz-date', buildAmzDate());
  }

  if (isGitRequest) {
    const ua = headers.get('user-agent') || '';
    if (!/\bgit\//i.test(ua)) headers.set('User-Agent', 'git/2.45.2');
    if (!headers.has('Git-Protocol')) headers.set('Git-Protocol', 'version=2');
  }
  return headers;
}

function buildFetchInit(method, headers, bodyBuffer, redirectStatus = null) {
  const nextMethod = redirectStatus && shouldChangeMethodToGet(redirectStatus, method) ? 'GET' : method;
  return { method: nextMethod, headers, body: hasRequestBody(nextMethod) ? bodyBuffer : null, redirect: 'manual' };
}

// ================= 核心逻辑 =================

async function handleToken(realm, service, scope, ctx) {
  const tokenRequestUrl = new URL(realm);
  if (service) tokenRequestUrl.searchParams.set('service', service);
  if (scope) tokenRequestUrl.searchParams.set('scope', scope);
  const tokenUrl = tokenRequestUrl.toString();
  const cacheKey = new Request(tokenUrl, { method: 'GET' });
  const cache = caches.default;
  
  // 尝试从缓存获取 Token
  const cachedResponse = await cache.match(cacheKey);
  if (cachedResponse) {
    console.log('Token cache hit');
    const data = await cachedResponse.json();
    return data.token || data.access_token;
  }

  try {
    const tokenResponse = await fetch(tokenUrl, { method: 'GET', headers: { 'Accept': 'application/json' } });
    if (!tokenResponse.ok) return null;
    
    const tokenData = await tokenResponse.json();
    const token = tokenData.token || tokenData.access_token;
    if (!token) return null;

    // 缓存 Token 5 分钟
    if (ctx && ctx.waitUntil) {
      const tokenCacheResponse = new Response(JSON.stringify(tokenData), {
        headers: { 'Cache-Control': 'max-age=300', 'Content-Type': 'application/json' }
      });
      ctx.waitUntil(cache.put(cacheKey, tokenCacheResponse));
    }
    return token;
  } catch (error) {
    console.log(`Error fetching token: ${error.message}`);
    return null;
  }
}

async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);
  let path = url.pathname;
  const method = (request.method || 'GET').toUpperCase();

  if (method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
        'Access-Control-Allow-Headers': request.headers.get('Access-Control-Request-Headers') || '*'
      }
    });
  }

  const contentLengthHeader = request.headers.get('content-length');
  const contentLength = Number(contentLengthHeader || 0);
  if (hasRequestBody(method) && !contentLengthHeader) {
    return new Response('Content-Length required for proxied request bodies.\n', { status: 411 });
  }
  if (hasRequestBody(method) && contentLength > MAX_PROXY_BODY_BYTES) {
    return new Response(`Request body too large. Limit is ${MAX_PROXY_BODY_BYTES} bytes.\n`, { status: 413 });
  }
  const requestBodyBuffer = hasRequestBody(method) ? await request.clone().arrayBuffer() : null;

  if (path === '/logo.png' || path === '/favicon.png' || path === '/favicon.ico') {
    return imageDataUrlResponse(APP_LOGO_DATA_URL);
  }

  if (path === '/' || path === '') {
    return new Response(HOMEPAGE_HTML, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  // 解析 V2 API
  let isV2Request = false, v2RequestType = null, v2RequestTag = null;
  if (path.startsWith('/v2/')) {
    isV2Request = true;
    path = path.replace('/v2/', '');
    const pathSegments = path.split('/').filter(part => part);
    if (pathSegments.length >= 3) {
      v2RequestType = pathSegments[pathSegments.length - 2];
      v2RequestTag = pathSegments[pathSegments.length - 1];
      path = pathSegments.slice(0, pathSegments.length - 2).join('/');
    }
  }

  const pathParts = path.split('/').filter(part => part);
  if (pathParts.length < 1) {
    return new Response('Invalid request: target domain or path required\n', { status: 400 });
  }

  let targetDomain, targetPath, isDockerRequest = false, isGitRequest = false;
  const fullPath = path.startsWith('/') ? path.substring(1) : path;

  // 重构的镜像/路径解析逻辑
  if (fullPath.startsWith('https://') || fullPath.startsWith('http://')) {
    const urlObj = new URL(fullPath);
    targetDomain = urlObj.hostname;
    targetPath = urlObj.pathname.substring(1) + (urlObj.search || url.search);
    isDockerRequest = isDockerHost(targetDomain);
    if (targetDomain === 'docker.io') targetDomain = 'registry-1.docker.io';
    if (targetDomain === 'github.com') {
      isGitRequest = isGitSmartHttpPath(urlObj.pathname, urlObj.search) || targetPath.endsWith('.git');
    }
  } else {
    const firstPart = pathParts[0];
    if (firstPart === 'gh') {
      isGitRequest = true;
      targetDomain = 'github.com';
      targetPath = normalizeGitHubPath(pathParts.slice(1).join('/')) + url.search;
    } else if (firstPart === 'docker.io' || firstPart === 'registry-1.docker.io') {
      isDockerRequest = true;
      targetDomain = 'registry-1.docker.io';
      targetPath = pathParts.length === 2 ? `library/${pathParts[1]}` : pathParts.slice(1).join('/');
    } else if (ALLOWED_HOSTS.includes(firstPart)) {
      targetDomain = firstPart;
      targetPath = pathParts.slice(1).join('/') + url.search;
      isDockerRequest = isDockerHost(targetDomain);
      if (targetDomain === 'github.com') {
        isGitRequest = isGitSmartHttpPath(pathParts.slice(1).join('/'), url.search) || targetPath.endsWith('.git');
      }
    } else {
      // 默认视为 Docker Hub 镜像
      isDockerRequest = true;
      targetDomain = 'registry-1.docker.io';
      targetPath = pathParts.length === 1 ? `library/${pathParts[0]}` : pathParts.join('/');
    }
  }

  // 白名单检查
  if (!ALLOWED_HOSTS.includes(targetDomain)) {
    return new Response(`Error: Invalid target domain: ${targetDomain}\n`, { status: 400 });
  }

  if (RESTRICT_PATHS) {
    const checkPath = isDockerRequest ? targetPath : (targetPath || path);
    const isPathAllowed = ALLOWED_PATHS.some(p => checkPath.toLowerCase().includes(p.toLowerCase()));
    if (!isPathAllowed) {
      return new Response(`Error: Path not allowed.\n`, { status: 403 });
    }
  }

  // 构建目标 URL
  let targetUrl;
  if (isDockerRequest && isV2Request && v2RequestType && v2RequestTag) {
    targetUrl = `https://${targetDomain}/v2/${targetPath}/${v2RequestType}/${v2RequestTag}`;
  } else {
    targetUrl = `https://${targetDomain}/${isV2Request ? 'v2/' : ''}${targetPath}`;
  }

  const newRequestHeaders = applyCommonProxyHeaders(new Headers(request.headers), targetUrl, isGitRequest);

  try {
    let activeRequestHeaders = newRequestHeaders;
    let response = await fetch(targetUrl, buildFetchInit(method, activeRequestHeaders, requestBodyBuffer));

    // Docker 认证
    if (isDockerRequest && response.status === 401) {
      const wwwAuth = response.headers.get('WWW-Authenticate');
      if (wwwAuth) {
        const authParams = parseBearerChallenge(wwwAuth);
        if (authParams) {
          const token = await handleToken(authParams.realm, authParams.service || targetDomain, authParams.scope || '', ctx);
          if (token) {
            const authHeaders = applyCommonProxyHeaders(new Headers(request.headers), targetUrl, isGitRequest);
            authHeaders.set('Authorization', `Bearer ${token}`);
            activeRequestHeaders = authHeaders;
            response = await fetch(targetUrl, buildFetchInit(method, authHeaders, requestBodyBuffer));
          }
        }
      }
    }

    // 递归处理重定向
    let redirects = 0;
    while ([301, 302, 303, 307, 308].includes(response.status) && redirects < MAX_REDIRECTS) {
      const redirectUrl = response.headers.get('Location');
      if (!redirectUrl) break;
      redirects++;

      let resolvedRedirectUrl;
      try { resolvedRedirectUrl = new URL(redirectUrl, targetUrl).toString(); } catch { break; }
      if (!isSafeRedirectUrl(resolvedRedirectUrl)) {
        return new Response(`Unsafe redirect blocked: ${resolvedRedirectUrl}\n`, { status: 502 });
      }

      const followHeaders = applyCommonProxyHeaders(new Headers(activeRequestHeaders), resolvedRedirectUrl, isGitRequest);
      stripCrossOriginSensitiveHeaders(followHeaders, targetUrl, resolvedRedirectUrl);

      response = await fetch(resolvedRedirectUrl, buildFetchInit(method, followHeaders, requestBodyBuffer, response.status));
      activeRequestHeaders = followHeaders;
      targetUrl = resolvedRedirectUrl;
      
      if (response.status >= 400) return new Response(response.body, response);
    }

    // 返回响应
    const newResponse = new Response(response.body, response);
    newResponse.headers.set('Access-Control-Allow-Origin', '*');
    newResponse.headers.set('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
    newResponse.headers.set('Access-Control-Allow-Headers', '*');
    
    if (isDockerRequest) {
      newResponse.headers.set('Docker-Distribution-API-Version', 'registry/2.0');
      newResponse.headers.delete('Location');
    }
    
    if (isGitRequest) {
      newResponse.headers.set('Cache-Control', 'no-store');
    } else if (response.status === 200) {
      // 对静态资源添加缓存
      newResponse.headers.set('Cache-Control', 'public, max-age=14400');
    }

    return newResponse;
  } catch (error) {
    return new Response(`Error fetching from ${targetDomain}: ${error.message}\n`, { status: 500 });
  }
}

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  }
};
