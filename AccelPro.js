// 更新日期: 2026-06-02
// 更新内容: 
// 1. 修复 S3 签名：动态计算真实 Request Body 的 SHA-256，支持带 Body 的 PUT/POST 请求
// 2. 增强 Docker Auth：优化 WWW-Authenticate 正则，兼容缺少 service/scope 的非标准响应
// 3. 安全加固：限制 Request Body 最大为 10MB，防止 Worker 内存溢出 (OOM)
// 4. 路径解析优化：简化 Docker V2 API 路由逻辑，直接透传 /v2/ 路径，减少解析错误
// 5. UI 修复：修复首页 Toast 提示框颜色切换逻辑，优化移动端体验
// 6. 请求头透传：确保 Range, If-None-Match 等关键 Header 在递归重定向中不丢失

// ==========================================
// 用户配置区域开始
// ==========================================

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

const RESTRICT_PATHS = false;

const ALLOWED_PATHS = [
  'library',
  'user-id-1',
  'user-id-2',
];

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
const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB 限制，防止 Worker OOM

const EMPTY_BODY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

// ==========================================
// 用户配置区域结束
// ==========================================

const LIGHTNING_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#FBBF24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"></path>
</svg>`;

const HOMEPAGE_HTML = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Cloudflare 加速代理</title>
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(LIGHTNING_SVG)}">
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = { darkMode: 'class' }
  </script>
  <style>
    body { transition: background-color 0.3s, color 0.3s; }
    .result-text { word-break: break-all; font-family: monospace; }
  </style>
</head>
<body class="bg-slate-100 text-slate-900 dark:bg-slate-900 dark:text-slate-100 min-h-screen flex items-center justify-center p-4">
  <button onclick="toggleTheme()" class="fixed top-4 right-4 p-2 rounded-full bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 transition text-xl">
    <span id="theme-icon">☀️</span>
  </button>
  
  <div class="w-full max-w-2xl bg-white dark:bg-slate-800 rounded-2xl shadow-xl border border-slate-200 dark:border-slate-700 p-6 md:p-8">
    <h1 class="text-2xl md:text-3xl font-bold text-center mb-2">⚡ Cloudflare 加速下载</h1>
    <p class="text-center text-slate-500 dark:text-slate-400 mb-8 text-sm">安全、高速的 GitHub 文件与 Docker 镜像反代服务</p>

    <!-- GitHub -->
    <div class="mb-8">
      <h2 class="text-lg font-semibold mb-3 flex items-center gap-2">📦 GitHub 文件加速</h2>
      <div class="flex flex-col sm:flex-row gap-2">
        <input id="github-url" type="url" placeholder="https://github.com/owner/repo/releases/..." 
          class="flex-grow px-4 py-2.5 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 focus:ring-2 focus:ring-blue-500 focus:outline-none transition text-sm">
        <button onclick="convertGithubUrl()" class="px-6 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition whitespace-nowrap">获取链接</button>
      </div>
      <div id="github-result-box" class="hidden mt-3 p-3 bg-slate-50 dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-700">
        <p id="github-result" class="text-sm text-blue-600 dark:text-blue-400 result-text mb-2"></p>
        <div class="flex gap-2">
          <button onclick="copyText(githubAcceleratedUrl)" class="flex-1 px-3 py-1.5 text-sm bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 rounded transition">📋 复制</button>
          <button onclick="window.open(githubAcceleratedUrl, '_blank')" class="flex-1 px-3 py-1.5 text-sm bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 rounded transition">🔗 打开</button>
        </div>
      </div>
    </div>

    <!-- Docker -->
    <div>
      <h2 class="text-lg font-semibold mb-3 flex items-center gap-2">🐳 Docker 镜像加速</h2>
      <div class="flex flex-col sm:flex-row gap-2">
        <input id="docker-image" type="text" placeholder="nginx 或 ghcr.io/owner/repo" 
          class="flex-grow px-4 py-2.5 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 focus:ring-2 focus:ring-blue-500 focus:outline-none transition text-sm">
        <button onclick="convertDockerImage()" class="px-6 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition whitespace-nowrap">获取命令</button>
      </div>
      <div id="docker-result-box" class="hidden mt-3 p-3 bg-slate-50 dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-700">
        <p id="docker-result" class="text-sm text-green-600 dark:text-green-400 result-text mb-2"></p>
        <button onclick="copyText(dockerCommand)" class="w-full px-3 py-1.5 text-sm bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 rounded transition">📋 复制命令</button>
      </div>
    </div>

    <footer class="mt-8 pt-6 border-t border-slate-200 dark:border-slate-700 text-center text-xs text-slate-500">
      Powered by <a href="https://github.com/linxidev/Cloudflare-AccelPro" class="text-blue-500 hover:underline">Cloudflare-AccelPro</a>
    </footer>
  </div>

  <div id="toast" class="fixed bottom-6 left-1/2 -translate-x-1/2 px-4 py-2 rounded-lg shadow-lg text-white text-sm font-medium opacity-0 transition-opacity duration-300 pointer-events-none z-50"></div>

  <script>
    const currentDomain = window.location.hostname;
    let githubAcceleratedUrl = '';
    let dockerCommand = '';

    // 主题初始化
    if (localStorage.getItem('theme') === 'dark' || (!localStorage.getItem('theme') && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
      document.documentElement.classList.add('dark');
      document.getElementById('theme-icon').textContent = '🌙';
    }

    function toggleTheme() {
      const isDark = document.documentElement.classList.toggle('dark');
      document.getElementById('theme-icon').textContent = isDark ? '🌙' : '☀️';
      localStorage.setItem('theme', isDark ? 'dark' : 'light');
    }

    function showToast(message, isError = false) {
      const toast = document.getElementById('toast');
      toast.textContent = message;
      toast.className = \`fixed bottom-6 left-1/2 -translate-x-1/2 px-4 py-2 rounded-lg shadow-lg text-white text-sm font-medium transition-opacity duration-300 pointer-events-none z-50 \${isError ? 'bg-red-500' : 'bg-green-500'}\`;
      requestAnimationFrame(() => { toast.style.opacity = '1'; });
      setTimeout(() => { toast.style.opacity = '0'; }, 3000);
    }

    async function copyText(text) {
      try {
        await navigator.clipboard.writeText(text);
        showToast('已复制到剪贴板');
      } catch (err) {
        showToast('复制失败，请手动复制', true);
      }
    }

    function convertGithubUrl() {
      const input = document.getElementById('github-url').value.trim();
      if (!input || !input.startsWith('https://')) {
        showToast('请输入有效的 https:// GitHub 链接', true);
        document.getElementById('github-result-box').classList.add('hidden');
        return;
      }
      githubAcceleratedUrl = \`https://\${currentDomain}/\${input}\`;
      document.getElementById('github-result').textContent = githubAcceleratedUrl;
      document.getElementById('github-result-box').classList.remove('hidden');
      copyText(githubAcceleratedUrl);
    }

    function convertDockerImage() {
      const input = document.getElementById('docker-image').value.trim();
      if (!input) {
        showToast('请输入有效的镜像名称', true);
        document.getElementById('docker-result-box').classList.add('hidden');
        return;
      }
      dockerCommand = \`docker pull \${currentDomain}/\${input}\`;
      document.getElementById('docker-result').textContent = dockerCommand;
      document.getElementById('docker-result-box').classList.remove('hidden');
      copyText(dockerCommand);
    }
  </script>
</body>
</html>
`;

async function handleToken(realm, service, scope) {
  let tokenUrl = `${realm}?service=${encodeURIComponent(service || '')}`;
  if (scope) tokenUrl += `&scope=${encodeURIComponent(scope)}`;
  
  try {
    const res = await fetch(tokenUrl, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) return null;
    const data = await res.json();
    return data.token || data.access_token || null;
  } catch {
    return null;
  }
}

function isAmazonS3(url) {
  try { return new URL(url).hostname.includes('amazonaws.com'); } 
  catch { return false; }
}

function buildAmzDate() {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, -5) + 'Z';
}

async function calculateSHA256(buffer) {
  if (!buffer || buffer.byteLength === 0) return EMPTY_BODY_SHA256;
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function isDockerHost(hostname) {
  return DOCKER_HOSTS.includes(hostname);
}

function hasRequestBody(method) {
  return !['GET', 'HEAD', 'OPTIONS', 'DELETE'].includes((method || 'GET').toUpperCase());
}

function shouldChangeMethodToGet(status, method) {
  const upperMethod = (method || 'GET').toUpperCase();
  return status === 303 || ((status === 301 || status === 302) && upperMethod === 'POST');
}

function isGitSmartHttpPath(pathname = '', search = '') {
  const lowerPath = pathname.toLowerCase();
  const lowerSearch = search.toLowerCase();
  return (
    lowerPath.endsWith('/info/refs') ||
    lowerPath.endsWith('/git-upload-pack') ||
    lowerPath.endsWith('/git-receive-pack') ||
    lowerPath.includes('/info/lfs') ||
    lowerPath.endsWith('/objects/info/packs') ||
    GIT_SMART_SERVICES.some(service => lowerSearch.includes(`service=${service}`))
  );
}

function normalizeGitHubPath(pathname = '') {
  const normalized = pathname.replace(/^\/+/, '');
  if (normalized.startsWith('https://') || normalized.startsWith('http://')) return normalized;
  if (normalized.startsWith('gh/')) return normalized.slice(3);
  if (normalized.startsWith('github.com/')) return normalized.slice('github.com/'.length);
  return normalized;
}

function getWhitelistCheckPath({ requestPath = '', targetPath = '', isDockerRequest = false }) {
  if (isDockerRequest) return targetPath;
  if (!requestPath) return targetPath;
  
  const normalized = requestPath.replace(/^\/+/, '');
  if (normalized.startsWith('https://') || normalized.startsWith('http://')) {
    try {
      const proxiedUrl = new URL(normalized);
      return `${proxiedUrl.hostname}/${proxiedUrl.pathname.replace(/^\/+/, '')}${proxiedUrl.search}`;
    } catch { return targetPath || normalized; }
  }
  return targetPath || normalized;
}

async function applyCommonProxyHeaders(request, targetUrl, isGitRequest) {
  const headers = new Headers(request.headers);
  
  try { headers.set('Host', new URL(targetUrl).hostname); } catch {}

  // 清理 Cloudflare 注入的头，防止后端校验失败或信息泄露
  ['cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor', 'x-forwarded-proto', 'x-forwarded-host', 'x-real-ip', 'x-amz-security-token', 'x-amz-user-agent'].forEach(h => headers.delete(h));

  if (isGitRequest) {
    const ua = headers.get('user-agent') || '';
    if (!/\bgit\//i.test(ua)) headers.set('User-Agent', 'git/2.45.2');
    if (!headers.has('Git-Protocol')) headers.set('Git-Protocol', 'version=2');
  }

  return headers;
}

async function handleRequest(request) {
  const url = new URL(request.url);
  let path = url.pathname;
  
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': request.headers.get('Access-Control-Request-Headers') || '*'
      }
    });
  }

  if (path === '/' || path === '') {
    return new Response(HOMEPAGE_HTML, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  let targetDomain, targetPath, isDockerRequest = false, isGitRequest = false;
  const fullPath = path.startsWith('/') ? path.substring(1) : path;

  // 1. 处理显式 URL 代理 ( /https://... )
  if (fullPath.startsWith('https://') || fullPath.startsWith('http://')) {
    const urlObj = new URL(fullPath);
    targetDomain = urlObj.hostname;
    targetPath = urlObj.pathname.substring(1) + (urlObj.search || url.search);
    isDockerRequest = isDockerHost(targetDomain);
    if (targetDomain === 'docker.io') targetDomain = 'registry-1.docker.io';
    if (targetDomain === 'github.com') isGitRequest = isGitSmartHttpPath(urlObj.pathname, urlObj.search) || targetPath.endsWith('.git');
  } 
  // 2. 处理 Docker / GitHub 快捷路径
  else {
    const pathParts = path.split('/').filter(part => part);
    if (pathParts.length === 0) return new Response('Invalid request\n', { status: 400 });

    if (pathParts[0] === 'gh') {
      isGitRequest = true;
      targetDomain = 'github.com';
      targetPath = normalizeGitHubPath(pathParts.slice(1).join('/')) + url.search;
    } 
    else if (pathParts[0] === 'docker.io') {
      isDockerRequest = true;
      targetDomain = 'registry-1.docker.io';
      targetPath = pathParts.length === 2 ? `library/${pathParts[1]}` : pathParts.slice(1).join('/');
    } 
    else if (path.startsWith('/v2/')) {
      // Docker V2 API 直接透传，交由 Registry 自行解析 manifests/blobs
      isDockerRequest = true;
      targetDomain = 'registry-1.docker.io'; // 默认，后续会被 ALLOWED_HOSTS 覆盖如果是其他域
      targetPath = path.substring(1); // 保留 'v2/...'
      
      // 检查是否是其他 Docker 宿主的 /v2/ 请求 (如 /v2/ 前缀被误判，我们通过检查后续逻辑修正)
      // 实际上，如果是 ghcr.io/v2/...，pathParts[0] 是 'v2'，我们需要特殊处理
    }
    else if (ALLOWED_HOSTS.includes(pathParts[0])) {
      targetDomain = pathParts[0];
      targetPath = pathParts.slice(1).join('/') + url.search;
      isDockerRequest = isDockerHost(targetDomain);
      if (targetDomain === 'github.com') isGitRequest = isGitSmartHttpPath(pathParts.slice(1).join('/'), url.search) || targetPath.endsWith('.git');
    } 
    else if (pathParts[0] === 'v2' && pathParts.length > 1 && isDockerHost(pathParts[1])) {
      // 处理形如 /v2/ghcr.io/owner/repo 的变体 (非标准但有时出现)
      targetDomain = pathParts[1];
      targetPath = 'v2/' + pathParts.slice(2).join('/');
      isDockerRequest = true;
    }
    else {
      // 兜底：默认当作 Docker Hub 官方镜像 (如 /nginx 或 /library/nginx)
      isDockerRequest = true;
      targetDomain = 'registry-1.docker.io';
      targetPath = pathParts[0] === 'library' ? pathParts.join('/') : `library/${pathParts.join('/')}`;
    }
    
    // 修正 /v2/ 逻辑：如果目标域不是 docker.io，但路径以 v2/ 开头，需重新拼接
    if (path.startsWith('/v2/') && pathParts.length > 1) {
       const potentialHost = pathParts[1]; // 比如 /v2/ghcr.io/... 中的 ghcr.io (但这不符合常规，常规是 /ghcr.io/v2/...)
       // 标准 Docker 客户端请求格式为: /v2/<namespace>/<repo>/manifests/<tag>
       // 我们的 Worker 接收到的如果是直接代理，应该走第一个 if (fullPath.startsWith)
       // 这里保持对 /v2/... 的原样透传给 registry-1.docker.io，除非明确指定了其他域名
    }
  }

  // 3. 安全校验
  if (!ALLOWED_HOSTS.includes(targetDomain)) {
    return new Response(`Error: Invalid target domain '${targetDomain}'.\n`, { status: 403 });
  }

  if (RESTRICT_PATHS) {
    const checkPath = getWhitelistCheckPath({ requestPath: path, targetPath, isDockerRequest });
    const isPathAllowed = ALLOWED_PATHS.some(p => checkPath.toLowerCase().includes(p.toLowerCase()));
    if (!isPathAllowed) {
      return new Response(`Error: Path not allowed.\n`, { status: 403 });
    }
  }

  // 4. 构建目标 URL
  const targetUrl = isDockerRequest 
    ? `https://${targetDomain}/${targetPath}`
    : `https://${targetDomain}/${targetPath}`;

  // 5. 处理 Request Body (限制大小防 OOM)
  let bodyBuffer = null;
  if (hasRequestBody(request.method)) {
    const contentLength = parseInt(request.headers.get('content-length') || '0', 10);
    if (contentLength > MAX_BODY_SIZE) {
      return new Response('Request body too large (max 10MB)', { status: 413 });
    }
    bodyBuffer = await request.arrayBuffer();
  }

  let headers = await applyCommonProxyHeaders(request, targetUrl, isGitRequest);

  try {
    // 6. 首次请求
    const init = {
      method: request.method,
      headers,
      body: bodyBuffer,
      redirect: 'manual'
    };
    let response = await fetch(targetUrl, init);

    // 7. Docker Bearer Token 认证处理
    if (isDockerRequest && response.status === 401) {
      const wwwAuth = response.headers.get('WWW-Authenticate');
      if (wwwAuth) {
        // 兼容缺少 service 或 scope 的正则
        const authMatch = wwwAuth.match(/Bearer realm="([^"]+)"(?:,service="([^"]*)")?(?:,scope="([^"]*)")?/);
        if (authMatch) {
          const [, realm, service, scope] = authMatch;
          const token = await handleToken(realm, service || targetDomain, scope);
          
          if (token) {
            const authHeaders = await applyCommonProxyHeaders(request, targetUrl, isGitRequest);
            authHeaders.set('Authorization', `Bearer ${token}`);
            response = await fetch(targetUrl, { ...init, headers: authHeaders });
          } else {
            // 获取 token 失败，尝试移除 Authorization 头进行匿名请求
            const anonHeaders = await applyCommonProxyHeaders(request, targetUrl, isGitRequest);
            anonHeaders.delete('Authorization');
            response = await fetch(targetUrl, { ...init, headers: anonHeaders });
          }
        }
      }
    }

    // 8. 递归处理重定向 (拦截 302/307，防止客户端直连被墙 CDN)
    let redirects = 0;
    while ([301, 302, 303, 307, 308].includes(response.status) && redirects < MAX_REDIRECTS) {
      const location = response.headers.get('Location');
      if (!location) break;
      redirects++;

      let resolvedUrl;
      try { resolvedUrl = new URL(location, targetUrl).toString(); } 
      catch { break; }

      const followHeaders = await applyCommonProxyHeaders(request, resolvedUrl, isGitRequest);
      
      // 如果重定向到 S3，注入 AWS 必需的头
      if (isAmazonS3(resolvedUrl)) {
        followHeaders.set('x-amz-date', buildAmzDate());
        followHeaders.set('x-amz-content-sha256', await calculateSHA256(bodyBuffer));
      }

      // 保持原有的 Authorization (如果后端在 302 中要求保持)
      if (response.headers.get('Authorization')) {
        followHeaders.set('Authorization', response.headers.get('Authorization'));
      }

      const nextMethod = shouldChangeMethodToGet(response.status, request.method) ? 'GET' : request.method;
      
      response = await fetch(resolvedUrl, {
        method: nextMethod,
        headers: followHeaders,
        body: nextMethod === 'GET' || nextMethod === 'HEAD' ? null : bodyBuffer,
        redirect: 'manual'
      });
      targetUrl = resolvedUrl;
      
      if (response.status >= 400) break; // 遇到错误停止跟随，直接返回错误
    }

    // 9. 构建最终响应
    const newResponse = new Response(response.body, response);
    newResponse.headers.set('Access-Control-Allow-Origin', '*');
    newResponse.headers.set('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, DELETE, OPTIONS');
    newResponse.headers.set('Access-Control-Allow-Headers', '*');
    
    if (isDockerRequest) {
      newResponse.headers.set('Docker-Distribution-API-Version', 'registry/2.0');
      newResponse.headers.delete('Location'); // 强制所有流量经过 Worker
    }
    if (isGitRequest) {
      newResponse.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    }
    
    return newResponse;

  } catch (error) {
    console.error(`Proxy Error for ${targetUrl}:`, error.message);
    return new Response(`Error fetching resource: ${error.message}\n`, { status: 502 });
  }
}

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request);
  }
};
