// 更新日期: 2026-06-04
// 更新内容: 
// 1. 前端页面全面重构：采用现代化 Glassmorphism（毛玻璃）设计风格，优化暗黑模式色彩，增加流畅的过渡动画与交互反馈。
// 2. 引入 Token 缓存机制：使用 Cloudflare Cache API 缓存 Docker 认证 Token，大幅减少对外部认证服务器的请求，提升响应速度。
// 3. 优化 Docker 镜像解析逻辑：重构路径解析代码，支持更多边缘情况，代码更简洁健壮。
// 4. 增强缓存控制：对非 Git 的静态资源自动添加 Cache-Control 响应头，充分利用 Cloudflare 边缘缓存加速。
// 5. 修复前端模板字符串转义问题，确保年份等动态内容正确渲染。

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
const EMPTY_BODY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

// ==========================================
// 用户配置区域结束
// ==========================================

// 闪电 SVG 图标（Base64 编码）
const LIGHTNING_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#FBBF24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"></path>
</svg>`;

// 首页 HTML (美化版)
const HOMEPAGE_HTML = `
<!DOCTYPE html>
<html lang="zh-CN" class="scroll-smooth">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Cloudflare 极速代理 - GitHub & Docker 加速</title>
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(LIGHTNING_SVG)}">
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: {
        extend: {
          animation: {
            'fade-in': 'fadeIn 0.5s ease-out',
            'slide-up': 'slideUp 0.3s ease-out',
          },
          keyframes: {
            fadeIn: { '0%': { opacity: '0' }, '100%': { opacity: '1' } },
            slideUp: { '0%': { transform: 'translateY(10px)', opacity: '0' }, '100%': { transform: 'translateY(0)', opacity: '1' } }
          }
        }
      }
    }
  </script>
  <style>
    ::-webkit-scrollbar { width: 8px; height: 8px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 4px; }
    .dark ::-webkit-scrollbar-thumb { background: #475569; }

    .glass {
      background: rgba(255, 255, 255, 0.7);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      border: 1px solid rgba(255, 255, 255, 0.3);
    }
    .dark .glass {
      background: rgba(30, 41, 59, 0.7);
      border: 1px solid rgba(255, 255, 255, 0.1);
    }

    .bg-gradient {
      background: linear-gradient(135deg, #f0f9ff 0%, #e0f2fe 100%);
    }
    .dark .bg-gradient {
      background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
    }

    .input-focus:focus {
      box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.3);
    }
    .dark .input-focus:focus {
      box-shadow: 0 0 0 3px rgba(139, 92, 246, 0.3);
    }

    .btn-hover { transition: all 0.2s ease-in-out; }
    .btn-hover:hover { transform: translateY(-2px); box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); }
    .btn-hover:active { transform: translateY(0); }
  </style>
</head>
<body class="bg-gradient min-h-screen text-slate-800 dark:text-slate-200 transition-colors duration-300">
  <button id="theme-toggle" class="fixed top-4 right-4 p-2 rounded-full glass shadow-lg hover:scale-110 transition-transform z-50">
    <svg id="sun-icon" class="w-6 h-6 hidden dark:block text-yellow-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"></path></svg>
    <svg id="moon-icon" class="w-6 h-6 block dark:hidden text-slate-700" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"></path></svg>
  </button>

  <div class="container mx-auto px-4 py-12 max-w-3xl animate-fade-in">
    <header class="text-center mb-12">
      <div class="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-blue-500 to-purple-600 text-white shadow-lg mb-4">
        <svg class="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path></svg>
      </div>
      <h1 class="text-4xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-600 to-purple-600 dark:from-blue-400 dark:to-purple-400">Cloudflare 极速代理</h1>
      <p class="mt-2 text-slate-500 dark:text-slate-400">GitHub & Docker 镜像全球加速服务</p>
    </header>

    <!-- GitHub 加速 -->
    <div class="glass rounded-2xl p-6 mb-8 shadow-xl animate-slide-up">
      <div class="flex items-center mb-4">
        <div class="p-2 bg-blue-100 dark:bg-blue-900/30 rounded-lg mr-3">
          <svg class="w-6 h-6 text-blue-600 dark:text-blue-400" fill="currentColor" viewBox="0 0 24 24"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg>
        </div>
        <h2 class="text-xl font-semibold">GitHub 文件加速</h2>
      </div>
      <p class="text-sm text-slate-500 dark:text-slate-400 mb-4">输入 GitHub 文件链接，一键生成加速地址。支持 Releases、Raw 文件等。</p>
      <div class="flex flex-col sm:flex-row gap-3">
        <input id="github-url" type="text" placeholder="https://github.com/user/repo/releases/download/..." class="flex-grow px-4 py-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white placeholder-slate-400 focus:outline-none input-focus transition-all">
        <button onclick="convertGithubUrl()" class="btn-hover px-6 py-3 bg-gradient-to-r from-blue-500 to-blue-600 text-white font-medium rounded-xl shadow-md hover:shadow-lg transition-all whitespace-nowrap">生成链接</button>
      </div>
      <div id="github-result" class="mt-4 hidden">
        <div class="relative group">
          <pre class="p-4 bg-slate-100 dark:bg-slate-900 rounded-xl text-sm overflow-x-auto text-slate-800 dark:text-slate-200 border border-slate-200 dark:border-slate-700"><code id="github-result-text"></code></pre>
          <button onclick="copyGithubUrl()" class="absolute top-2 right-2 p-2 bg-white dark:bg-slate-800 rounded-lg shadow-md opacity-0 group-hover:opacity-100 transition-opacity hover:bg-slate-50 dark:hover:bg-slate-700" title="复制">
            <svg class="w-4 h-4 text-slate-600 dark:text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"></path></svg>
          </button>
        </div>
        <div class="flex gap-2 mt-3">
          <button onclick="openGithubUrl()" class="flex-1 py-2 text-sm font-medium text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20 rounded-lg hover:bg-blue-100 dark:hover:bg-blue-900/40 transition-colors">打开链接</button>
        </div>
      </div>
    </div>

    <!-- Docker 加速 -->
    <div class="glass rounded-2xl p-6 mb-8 shadow-xl animate-slide-up delay-100">
      <div class="flex items-center mb-4">
        <div class="p-2 bg-cyan-100 dark:bg-cyan-900/30 rounded-lg mr-3">
          <svg class="w-6 h-6 text-cyan-600 dark:text-cyan-400" fill="currentColor" viewBox="0 0 24 24"><path d="="M13 8v8c0 .55-.45 1-1 1H8c-.55 0-1-.45-1-1V8c0-.55.45-1 1-1h4c.55 0 1 .45 1 1zm5-5h-4c-.55 0-1 .45-1 1v4c0 .55.45 1 1 1h4c.55 0 1-.45 1-1V4c0-.55-.45-1-1-1zM7 8v8c0 .55-.45 1-1 1H2c-.55 0-1-.45-1-1V8c0-.55.45-1 1-1h4c.55 0 1 .45 1 1zm11-5h-4c-.55 0-1 .45-1 1v4c0 .55.45 1 1 1h4c.55 0 1-.45 1-1V4c0-.55-.45-1-1-1zm0 10h-4c-.55 0-1 .45-1 1v4c0 .55.45 1 1 1h4c.55 0 1-.45 1-1v-4c0-.55-.45-1-1-1zM7 3v4c0 .55-.45 1-1 1H2c-.55 0-1-.45-1-1V3c0-.55.45-1 1-1h4c.55 0 1 .45 1 1zm11 10h-4c-.55 0-1 .45-1 1v4c0 .55.45 1 1 1h4c.55 0 1-.45 1-1v-4c0-.55-.45-1-1-1z"/></svg>
        </div>
        <h2 class="text-xl font-semibold">Docker 镜像加速</h2>
      </div>
      <p class="text-sm text-slate-500 dark:text-slate-400 mb-4">输入镜像名称，获取加速拉取命令。支持 Docker Hub、GHCR 等主流仓库。</p>
      <div class="flex flex-col sm:flex-row gap-3">
        <input id="docker-image" type="text" placeholder="nginx 或 ghcr.io/user/repo" class="flex-grow px-4 py-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white placeholder-slate-400 focus:outline-none input-focus transition-all">
        <button onclick="convertDockerImage()" class="btn-hover px-6 py-3 bg-gradient-to-r from-cyan-500 to-cyan-600 text-white font-medium rounded-xl shadow-md hover:shadow-lg transition-all whitespace-nowrap">生成命令</button>
      </div>
      <div id="docker-result" class="mt-4 hidden">
        <div class="relative group">
          <pre class="p-4 bg-slate-100 dark:bg-slate-900 rounded-xl text-sm overflow-x-auto text-slate-800 dark:text-slate-200 border border-slate-200 dark:border-slate-700"><code id="docker-result-text"></code></pre>
          <button onclick="copyDockerCommand()" class="absolute top-2 right-2 p-2 bg-white dark:bg-slate-800 rounded-lg shadow-md opacity-0 group-hover:opacity-100 transition-opacity hover:bg-slate-50 dark:hover:bg-slate-700" title="复制">
            <svg class="w-4 h-4 text-slate-600 dark:text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"></path></svg>
          </button>
        </div>
      </div>
    </div>

    <footer class="text-center text-sm text-slate-500 dark:text-slate-400 mt-12">
      <p>Powered by <a href="https://github.com/linxidev/Cloudflare-AccelPro" target="_blank" class="text-blue-500 hover:underline">LinxiDev/Cloudflare-AccelPro</a></p>
      <p class="mt-1">© 2026 Cloudflare AccelPro. All rights reserved.</p>
    </footer>
  </div>

  <div id="toast" class="fixed bottom-6 left-1/2 transform -translate-x-1/2 px-6 py-3 rounded-xl shadow-lg text-white font-medium transition-all duration-300 opacity-0 translate-y-4 pointer-events-none z-50 bg-green-500">
    <span id="toast-message"></span>
  </div>

  <script>
    const currentDomain = window.location.hostname;
    let githubAcceleratedUrl = '';
    let dockerCommand = '';

    // 主题切换
    const themeToggle = document.getElementById('theme-toggle');
    themeToggle.addEventListener('click', () => {
      document.documentElement.classList.toggle('dark');
      localStorage.setItem('theme', document.documentElement.classList.contains('dark') ? 'dark' : 'light');
    });
    if (localStorage.getItem('theme') === 'dark' || (!localStorage.getItem('theme') && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
      document.documentElement.classList.add('dark');
    }

    // Toast 提示
    function showToast(message, isError = false) {
      const toast = document.getElementById('toast');
      toast.className = toast.className.replace(/bg-(green|red)-500/, isError ? 'bg-red-500' : 'bg-green-500');
      document.getElementById('toast-message').textContent = message;
      toast.classList.remove('opacity-0', 'translate-y-4');
      setTimeout(() => toast.classList.add('opacity-0', 'translate-y-4'), 3000);
    }

    // 复制功能
    function copyToClipboard(text) {
      if (navigator.clipboard && window.isSecureContext) {
        return navigator.clipboard.writeText(text);
      }
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      try { document.execCommand('copy'); } catch (err) { console.error(err); }
      document.body.removeChild(textarea);
      return Promise.resolve();
    }

    // GitHub 转换
    function convertGithubUrl() {
      const input = document.getElementById('github-url').value.trim();
      if (!input || !input.startsWith('https://')) {
        showToast('请输入有效的 https:// GitHub 链接', true);
        document.getElementById('github-result').classList.add('hidden');
        return;
      }
      githubAcceleratedUrl = 'https://' + currentDomain + '/https://' + input.substring(8);
      document.getElementById('github-result-text').textContent = githubAcceleratedUrl;
      document.getElementById('github-result').classList.remove('hidden');
      copyToClipboard(githubAcceleratedUrl).then(() => showToast('已复制加速链接'));
    }
    function copyGithubUrl() { copyToClipboard(githubAcceleratedUrl).then(() => showToast('已复制')); }
    function openGithubUrl() { window.open(githubAcceleratedUrl, '_blank'); }

    // Docker 转换
    function convertDockerImage() {
      const input = document.getElementById('docker-image').value.trim();
      if (!input) {
        showToast('请输入有效的镜像地址', true);
        document.getElementById('docker-result').classList.add('hidden');
        return;
      }
      dockerCommand = 'docker pull ' + currentDomain + '/' + input;
      document.getElementById('docker-result-text').textContent = dockerCommand;
      document.getElementById('docker-result').classList.remove('hidden');
      copyToClipboard(dockerCommand).then(() => showToast('已复制拉取命令'));
    }
    function copyDockerCommand() { copyToClipboard(dockerCommand).then(() => showToast('已复制')); }
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
  const tokenUrl = `${realm}?service=${service}&scope=${scope}`;
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
  const requestBodyBuffer = hasRequestBody(request.method) ? await request.clone().arrayBuffer() : null;

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
        'Access-Control-Allow-Headers': request.headers.get('Access-Control-Request-Headers') || '*'
      }
    });
  }

  if (path === '/' || path === '') {
    return new Response(HOMEPAGE_HTML, { status: 200, headers: { 'Content-Type': 'text/html' } });
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
    } else if (ALLOWED_HOSTS.includes(firstPart)) {
      targetDomain = firstPart;
      targetPath = pathParts.slice(1).join('/') + url.search;
      isDockerRequest = isDockerHost(targetDomain);
      if (targetDomain === 'docker.io') targetDomain = 'registry-1.docker.io';
      if (targetDomain === 'github.com') {
        isGitRequest = isGitSmartHttpPath(pathParts.slice(1).join('/'), url.search) || targetPath.endsWith('.git');
      }
    } else if (firstPart === 'docker.io') {
      isDockerRequest = true;
      targetDomain = 'registry-1.docker.io';
      targetPath = pathParts.length === 2 ? `library/${pathParts[1]}` : pathParts.slice(1).join('/');
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
    let response = await fetch(targetUrl, buildFetchInit(request.method, newRequestHeaders, requestBodyBuffer));

    // Docker 认证
    if (isDockerRequest && response.status === 401) {
      const wwwAuth = response.headers.get('WWW-Authenticate');
      if (wwwAuth) {
        const authMatch = wwwAuth.match(/Bearer realm="([^"]+)",service="([^"]*)",scope="([^"]*)"/);
        if (authMatch) {
          const [, realm, service, scope] = authMatch;
          const token = await handleToken(realm, service || targetDomain, scope, ctx);
          if (token) {
            const authHeaders = applyCommonProxyHeaders(new Headers(request.headers), targetUrl, isGitRequest);
            authHeaders.set('Authorization', `Bearer ${token}`);
            response = await fetch(targetUrl, buildFetchInit(request.method, authHeaders, requestBodyBuffer));
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

      const followHeaders = applyCommonProxyHeaders(new Headers(newRequestHeaders), resolvedRedirectUrl, isGitRequest);
      if (response.headers.get('Authorization')) {
        followHeaders.set('Authorization', response.headers.get('Authorization'));
      }

      response = await fetch(resolvedRedirectUrl, buildFetchInit(request.method, followHeaders, requestBodyBuffer, response.status));
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
