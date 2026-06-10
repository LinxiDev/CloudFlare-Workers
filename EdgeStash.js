/**
 * EdgeStash - Cloudflare-based Cloud Drive
 * 更新日期: 2026-06-06
 * 更新内容:
 * 1. 前端页面基于 Vue3、Element Plus、Tailwind CSS 和 HTML 统一美化，接入 Iconify 图标库。
 * 2. 使用用户 Logo 转换后的 PNG 作为 favicon、登录页、后台和云盘页面品牌标识。
 * 3. 后台统计新增当前 R2 存储用量、10GB 免费容量、剩余容量和文件数量展示。
 * 4. 文件列表新增文件夹大小与文件数量计算，并在文件夹卡片下方展示。
 * 5. 上传前后校验 R2 10GB 免费额度，避免继续写入导致超用。
 * 6. 修复根目录空文件夹展示、特殊字符路径、重命名覆盖、HTML 预览净化和分片取消清理。
 * 7. 收紧云盘文件区、工具栏和卡片间距，让页面更紧凑。
 * 8. 将前端静态资源从 jsDelivr 切换到 BootCDN 和 npmmirror。
 */

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

const R2_FREE_QUOTA_BYTES = 10 * 1024 * 1024 * 1024;

function generateId(length = 16) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  const randomValues = new Uint8Array(length);
  crypto.getRandomValues(randomValues);
  for (let i = 0; i < length; i++) result += chars[randomValues[i] % chars.length];
  return result;
}

async function hashPassword(password) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function createJWT(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = btoa(JSON.stringify(header)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const encodedPayload = btoa(JSON.stringify(payload)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(`${encodedHeader}.${encodedPayload}`));
  const encodedSignature = btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${encodedHeader}.${encodedPayload}.${encodedSignature}`;
}

async function verifyJWT(token, env) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    const encoder = new TextEncoder();
    const jwtKey = env.JWT_SECRET || env.ADMIN_PASSWORD;
    const key = await crypto.subtle.importKey('raw', encoder.encode(jwtKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const signatureData = Uint8Array.from(atob(encodedSignature.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    const valid = await crypto.subtle.verify('HMAC', key, signatureData, encoder.encode(`${encodedHeader}.${encodedPayload}`));
    if (!valid) return null;
    const payload = JSON.parse(atob(encodedPayload.replace(/-/g, '+').replace(/_/g, '/')));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch (e) { return null; }
}

function safeDecodePath(path) {
  try { return decodeURIComponent(path); } catch { return path; }
}

function encodePathSegments(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

async function resolveActualKey(r2, key) {
  if (!key) return key;
  const head1 = await r2.head(key);
  if (head1) return key;
  const encoded = encodePathSegments(key);
  if (encoded !== key) {
    const head2 = await r2.head(encoded);
    if (head2) return encoded;
  }
  return key;
}

// ============ 新增：文件夹元数据管理（KV） ============

// 在 KV 中注册一个文件夹
async function registerFolder(kv, folderPath) {
  // folderPath 格式: /path/to/folder (不带末尾斜杠)
  if (!folderPath) return;
  const key = 'folder:' + folderPath;
  await kv.put(key, JSON.stringify({ createdAt: Date.now() }));
}

// 取消注册一个文件夹
async function unregisterFolder(kv, folderPath) {
  if (!folderPath) return;
  const key = 'folder:' + folderPath;
  await kv.delete(key);
  // 同时取消所有子文件夹的注册
  let cursor;
  const prefix = key + '/';
  do {
    const listed = await kv.list({ prefix, cursor, limit: 100 });
    for (const k of listed.keys) {
      await kv.delete(k.name);
    }
    cursor = listed.list_complete ? null : listed.cursor;
  } while (cursor);
}

// 列出某个父目录下的所有子文件夹（从 KV 中）
async function listRegisteredFolders(kv, parentPath) {
  // parentPath: /path/to/parent (不带末尾斜杠，根目录为空字符串)
  const prefix = parentPath ? 'folder:' + parentPath + '/' : 'folder:/';
  const result = [];
  let cursor;
  do {
    const listed = await kv.list({ prefix, cursor, limit: 1000 });
    for (const key of listed.keys) {
      // key.name 格式: folder:/path/to/parent/childName
      const fullPath = key.name.slice('folder:'.length);
      const childName = fullPath.slice(parentPath.length + 1);
      // 只取直接子文件夹（不含斜杠）
      if (childName && !childName.includes('/')) {
        result.push({ name: childName, path: fullPath });
      }
    }
    cursor = listed.list_complete ? null : listed.cursor;
  } while (cursor);
  return result;
}

// 检查文件夹是否在 KV 中注册
async function isFolderRegistered(kv, folderPath) {
  const data = await kv.get('folder:' + folderPath);
  return !!data;
}

async function migrateToDecoded(r2, decodedPrefix, encodedPrefix) {
  try {
    if (!encodedPrefix || decodedPrefix === encodedPrefix) return;
    let cursor;
    do {
      const batch = await r2.list({ prefix: encodedPrefix, cursor, limit: 100 });
      for (const obj of (batch.objects || [])) {
        const relativePath = obj.key.slice(encodedPrefix.length);
        const decodedRelative = safeDecodePath(relativePath);
        const newKey = decodedPrefix + decodedRelative;
        const existing = await r2.head(newKey);
        if (!existing) {
          const original = await r2.get(obj.key);
          if (original) await r2.put(newKey, original.body, { httpMetadata: original.httpMetadata, customMetadata: original.customMetadata });
        }
        await r2.delete(obj.key);
      }
      cursor = batch.truncated ? batch.cursor : null;
    } while (cursor);
  } catch (e) { console.error('Migration error:', e); }
}

function getExpirationTime(expiresIn) {
  const now = Date.now();
  switch (expiresIn) {
    case '1h': return now + 60 * 60 * 1000;
    case '1d': return now + 24 * 60 * 60 * 1000;
    case '1m': return now + 30 * 24 * 60 * 60 * 1000;
    case 'permanent': return null;
    default: return now + 24 * 60 * 60 * 1000;
  }
}

function formatFileSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function getMimeType(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  const mimeTypes = {
    'html': 'text/html', 'css': 'text/css', 'js': 'application/javascript', 'json': 'application/json',
    'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'gif': 'image/gif', 'svg': 'image/svg+xml', 'webp': 'image/webp', 'ico': 'image/x-icon',
    'pdf': 'application/pdf', 'zip': 'application/zip', 'txt': 'text/plain', 'md': 'text/markdown',
    'mp3': 'audio/mpeg', 'mp4': 'video/mp4', 'webm': 'video/webm',
    'doc': 'application/msword', 'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'xls': 'application/vnd.ms-excel', 'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'ppt': 'application/vnd.ms-powerpoint', 'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  };
  return mimeTypes[ext] || 'application/octet-stream';
}

function getPreviewType(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'ico', 'bmp'].includes(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (['txt', 'md', 'json', 'js', 'ts', 'css', 'html', 'xml', 'yaml', 'yml', 'ini', 'conf', 'sh', 'bash', 'py', 'java', 'c', 'cpp', 'h', 'hpp', 'go', 'rs', 'sql', 'log'].includes(ext)) return 'text';
  if (ext === 'docx') return 'word';
  if (['mp4', 'webm', 'ogg'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'ogg', 'flac', 'm4a'].includes(ext)) return 'audio';
  return null;
}

function parseCookies(request) {
  const cookieHeader = request.headers.get('Cookie') || '';
  const cookies = {};
  cookieHeader.split(';').forEach(cookie => {
    const [name, value] = cookie.trim().split('=');
    if (name && value) cookies[name] = decodeURIComponent(value);
  });
  return cookies;
}

function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function htmlResponse(html, status = 200, headers = {}) {
  return new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', ...headers } });
}

// ============================================================================
// HANDLERS
// ============================================================================

async function handleLogin(request, env) {
  try {
    const body = await request.json();
    const { email, password, isAdmin } = body;
    const jwtSecret = env.JWT_SECRET || env.ADMIN_PASSWORD;
    if (isAdmin) {
      if (password === env.ADMIN_PASSWORD) {
        const token = await createJWT({ role: 'admin', exp: Date.now() + 24 * 60 * 60 * 1000 }, jwtSecret);
        return jsonResponse({ success: true, role: 'admin' }, 200, { 'Set-Cookie': `token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400` });
      }
      return jsonResponse({ success: false, message: '管理员密码错误' }, 401);
    } else {
      if (!email || !password) return jsonResponse({ success: false, message: '请输入邮箱和密码' }, 400);
      const userData = await env.KV_STORE.get(`user:${email}`);
      if (!userData) return jsonResponse({ success: false, message: '用户不存在' }, 401);
      const user = JSON.parse(userData);
      const passwordHash = await hashPassword(password);
      if (user.passwordHash !== passwordHash) return jsonResponse({ success: false, message: '密码错误' }, 401);
      const token = await createJWT({ email: user.email, role: 'user', exp: Date.now() + 24 * 60 * 60 * 1000 }, jwtSecret);
      return jsonResponse({ success: true, role: 'user', email: user.email }, 200, { 'Set-Cookie': `token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400` });
    }
  } catch (e) { return jsonResponse({ success: false, message: '登录失败: ' + e.message }, 500); }
}

async function handleLogout() {
  return jsonResponse({ success: true }, 200, { 'Set-Cookie': 'token=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' });
}

async function verifyAuth(request, env) {
  const cookies = parseCookies(request);
  const token = cookies.token;
  if (!token) return null;
  return await verifyJWT(token, env);
}

async function requireAuth(request, env) {
  const auth = await verifyAuth(request, env);
  if (!auth) return jsonResponse({ success: false, message: '未授权' }, 401);
  return auth;
}

async function requireAdmin(request, env) {
  const auth = await verifyAuth(request, env);
  if (!auth || auth.role !== 'admin') return jsonResponse({ success: false, message: '需要管理员权限' }, 403);
  return auth;
}

async function getR2PrefixStats(r2, prefix) {
  let normalized = prefix || '';
  if (normalized.startsWith('/')) normalized = normalized.slice(1);
  if (normalized && !normalized.endsWith('/')) normalized += '/';

  const prefixes = [normalized];
  const encoded = encodePathSegments(normalized.replace(/\/$/, '')) + (normalized ? '/' : '');
  if (encoded && encoded !== normalized) prefixes.push(encoded);

  const seen = new Set();
  let size = 0;
  let fileCount = 0;
  for (const scanPrefix of prefixes) {
    let cursor;
    do {
      const listed = await r2.list({ prefix: scanPrefix, cursor, limit: 1000 });
      for (const obj of (listed.objects || [])) {
        if (obj.key.endsWith('/.folder') || seen.has(obj.key)) continue;
        seen.add(obj.key);
        size += obj.size || 0;
        fileCount++;
      }
      cursor = listed.truncated ? listed.cursor : null;
    } while (cursor);
  }
  return { size, sizeFormatted: formatFileSize(size), fileCount };
}

async function getR2BucketStats(r2) {
  let cursor;
  let size = 0;
  let fileCount = 0;
  do {
    const listed = await r2.list({ cursor, limit: 1000 });
    for (const obj of (listed.objects || [])) {
      if (obj.key.endsWith('/.folder')) continue;
      size += obj.size || 0;
      fileCount++;
    }
    cursor = listed.truncated ? listed.cursor : null;
  } while (cursor);
  return { size, sizeFormatted: formatFileSize(size), fileCount };
}

function buildR2QuotaStatus(storageStats, incomingBytes = 0) {
  const used = storageStats.size || 0;
  const quota = R2_FREE_QUOTA_BYTES;
  const remaining = Math.max(quota - used, 0);
  const incoming = Math.max(Number(incomingBytes) || 0, 0);
  const usagePercent = quota > 0 ? Math.min(100, Math.round((used / quota) * 1000) / 10) : 0;
  return {
    used,
    usedFormatted: formatFileSize(used),
    quota,
    quotaFormatted: formatFileSize(quota),
    remaining,
    remainingFormatted: formatFileSize(remaining),
    incoming,
    incomingFormatted: formatFileSize(incoming),
    usagePercent,
    allowed: incoming <= remaining
  };
}

async function getR2QuotaStatus(r2, incomingBytes = 0) {
  return buildR2QuotaStatus(await getR2BucketStats(r2), incomingBytes);
}

function quotaExceededResponse(status, message) {
  return jsonResponse({
    success: false,
    message: message || `R2 免费容量剩余 ${status.remainingFormatted}，当前文件 ${status.incomingFormatted}，上传后会超过 ${status.quotaFormatted} 免费额度`,
    remainingStorageSize: status.remaining,
    remainingStorageSizeFormatted: status.remainingFormatted,
    r2FreeQuotaSize: status.quota,
    r2FreeQuotaSizeFormatted: status.quotaFormatted
  }, 413);
}

async function deleteUploadedObjectIfQuotaExceeded(r2, key, incomingBytes) {
  const afterUploadStats = await getR2BucketStats(r2);
  if ((afterUploadStats.size || 0) <= R2_FREE_QUOTA_BYTES) return null;
  await r2.delete(key);
  const status = await getR2QuotaStatus(r2, incomingBytes);
  return quotaExceededResponse(status, `上传后会超过 R2 ${status.quotaFormatted} 免费额度，文件已自动删除。当前剩余 ${status.remainingFormatted}，该文件大小 ${status.incomingFormatted}`);
}

// ============ 核心修改：handleListFiles（合并 KV 中的文件夹注册）============
async function handleListFiles(request, env, path, ctx) {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;
  try {
    let prefix = path || '';
    if (prefix.startsWith('/')) prefix = prefix.slice(1);
    if (prefix && !prefix.endsWith('/')) prefix += '/';
    const decodedPrefix = prefix;
    const encodedPrefix = encodePathSegments(prefix.replace(/\/$/, '')) + (prefix ? '/' : '');
    const shouldCheckEncoded = encodedPrefix && encodedPrefix !== decodedPrefix;
    const [decodedList, encodedList] = await Promise.all([
      env.R2_BUCKET.list({ prefix: decodedPrefix, delimiter: '/', limit: 1000 }),
      shouldCheckEncoded ? env.R2_BUCKET.list({ prefix: encodedPrefix, delimiter: '/', limit: 1000 }) : null
    ]);
    
    const foldersMap = new Map();
    const filesMap = new Map();
    
    function processList(listed) {
      if (!listed) return;
      for (const folderPath of (listed.delimitedPrefixes || [])) {
        const decoded = safeDecodePath(folderPath);
        const name = decoded.slice(decodedPrefix.length).replace(/\/$/, '');
        // 跳过 .folder 占位文件目录
        if (name && !foldersMap.has(name)) {
          foldersMap.set(name, { name, path: '/' + decoded.replace(/\/$/, '') });
        }
      }
      for (const obj of (listed.objects || [])) {
        const decodedKey = safeDecodePath(obj.key);
        const name = decodedKey.slice(decodedPrefix.length);
        // 跳过 .folder 占位文件（兼容未迁移的数据）
        if (name === '.folder') continue;
        if (name && !name.includes('/') && !filesMap.has(name)) {
          filesMap.set(name, { name, path: '/' + decodedKey, size: obj.size, sizeFormatted: formatFileSize(obj.size), lastModified: obj.uploaded.toISOString(), previewType: getPreviewType(name) });
        }
      }
    }
    
    processList(decodedList);
    processList(encodedList);
    
    // 合并 KV 中注册的文件夹（包括空的文件夹）
    const parentPath = decodedPrefix ? '/' + decodedPrefix.replace(/\/$/, '') : '';
    const kvFolders = await listRegisteredFolders(env.KV_STORE, parentPath);
    for (const f of kvFolders) {
      if (!foldersMap.has(f.name)) {
        foldersMap.set(f.name, f);
      }
    }

    const folders = Array.from(foldersMap.values());
    await Promise.all(folders.map(async (folder) => {
      const stats = await getR2PrefixStats(env.R2_BUCKET, folder.path);
      folder.size = stats.size;
      folder.sizeFormatted = stats.sizeFormatted;
      folder.fileCount = stats.fileCount;
    }));
    
    if (shouldCheckEncoded && ctx && encodedList && ((encodedList.objects && encodedList.objects.length > 0) || (encodedList.delimitedPrefixes && encodedList.delimitedPrefixes.length > 0))) {
      ctx.waitUntil(migrateToDecoded(env.R2_BUCKET, decodedPrefix, encodedPrefix));
    }
    
    return jsonResponse({ success: true, folders, files: Array.from(filesMap.values()), currentPath: '/' + decodedPrefix.replace(/\/$/, '') || '/' });
  } catch (e) { return jsonResponse({ success: false, message: '获取文件列表失败: ' + e.message }, 500); }
}

async function handleUploadFile(request, env, path) {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;
  try {
    const formData = await request.formData();
    const file = formData.get('file');
    if (!file) return jsonResponse({ success: false, message: '没有上传文件' }, 400);
    let filePath = path || '';
    if (filePath.startsWith('/')) filePath = filePath.slice(1);
    if (filePath && !filePath.endsWith('/')) filePath += '/';
    let fileName = file.name;
    let key = filePath + fileName;
    let counter = 1;
    while (await env.R2_BUCKET.head(key)) {
      const dot = fileName.lastIndexOf('.');
      if (dot > 0) fileName = fileName.substring(0, dot) + ` (${counter})` + fileName.substring(dot);
      else fileName = file.name + ` (${counter})`;
      key = filePath + fileName;
      counter++;
    }
    const quotaStatus = await getR2QuotaStatus(env.R2_BUCKET, file.size || 0);
    if (!quotaStatus.allowed) return quotaExceededResponse(quotaStatus);
    await env.R2_BUCKET.put(key, file.stream(), { httpMetadata: { contentType: file.type || getMimeType(file.name) } });
    const quotaExceeded = await deleteUploadedObjectIfQuotaExceeded(env.R2_BUCKET, key, file.size || 0);
    if (quotaExceeded) return quotaExceeded;
    return jsonResponse({ success: true, message: '文件上传成功', path: '/' + key, renamed: fileName !== file.name });
  } catch (e) { return jsonResponse({ success: false, message: '文件上传失败: ' + e.message }, 500); }
}

async function handleInitMultipart(request, env, path) {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;
  try {
    let { filename, size } = await request.json();
    if (!filename) return jsonResponse({ success: false, message: '请提供文件名' }, 400);
    const fileSize = Number(size);
    if (!Number.isFinite(fileSize) || fileSize < 0) return jsonResponse({ success: false, message: '请提供有效的文件大小' }, 400);
    let filePath = path || '';
    if (filePath.startsWith('/')) filePath = filePath.slice(1);
    if (filePath && !filePath.endsWith('/')) filePath += '/';
    let key = filePath + filename;
    let counter = 1;
    const originalFilename = filename;
    while (await env.R2_BUCKET.head(key)) {
      const dot = originalFilename.lastIndexOf('.');
      if (dot > 0) filename = originalFilename.substring(0, dot) + ` (${counter})` + originalFilename.substring(dot);
      else filename = originalFilename + ` (${counter})`;
      key = filePath + filename;
      counter++;
    }
    const quotaStatus = await getR2QuotaStatus(env.R2_BUCKET, fileSize);
    if (!quotaStatus.allowed) return quotaExceededResponse(quotaStatus);
    const multipartUpload = await env.R2_BUCKET.createMultipartUpload(key, { httpMetadata: { contentType: getMimeType(filename) } });
    return jsonResponse({ success: true, uploadId: multipartUpload.uploadId, finalFilename: filename, renamed: filename !== originalFilename });
  } catch (e) { return jsonResponse({ success: false, message: '初始化上传失败: ' + e.message }, 500); }
}

async function handleUploadPart(request, env, path) {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;
  try {
    const formData = await request.formData();
    const chunk = formData.get('file');
    const partNumber = parseInt(formData.get('partNumber'));
    const uploadId = formData.get('uploadId');
    const filename = formData.get('filename');
    let filePath = path || '';
    if (filePath.startsWith('/')) filePath = filePath.slice(1);
    if (filePath && !filePath.endsWith('/')) filePath += '/';
    const key = filePath + filename;
    const multipartUpload = env.R2_BUCKET.resumeMultipartUpload(key, uploadId);
    const part = await multipartUpload.uploadPart(partNumber, chunk);
    return jsonResponse({ success: true, partNumber: part.partNumber, etag: part.etag });
  } catch (e) { return jsonResponse({ success: false, message: '分片上传失败: ' + e.message }, 500); }
}

async function handleCompleteMultipart(request, env, path) {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;
  try {
    const { filename, uploadId, parts } = await request.json();
    let filePath = path || '';
    if (filePath.startsWith('/')) filePath = filePath.slice(1);
    if (filePath && !filePath.endsWith('/')) filePath += '/';
    const key = filePath + filename;
    const multipartUpload = env.R2_BUCKET.resumeMultipartUpload(key, uploadId);
    const completedObject = await multipartUpload.complete(parts);
    const uploadedSize = completedObject?.size || (await env.R2_BUCKET.head(key))?.size || 0;
    const quotaExceeded = await deleteUploadedObjectIfQuotaExceeded(env.R2_BUCKET, key, uploadedSize);
    if (quotaExceeded) return quotaExceeded;
    return jsonResponse({ success: true, message: '文件合并成功', path: '/' + key });
  } catch (e) { return jsonResponse({ success: false, message: '合并文件失败: ' + e.message }, 500); }
}

async function handleAbortMultipart(request, env, path) {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;
  try {
    const { filename, uploadId } = await request.json();
    if (!filename || !uploadId) return jsonResponse({ success: false, message: '请提供上传信息' }, 400);
    let filePath = path || '';
    if (filePath.startsWith('/')) filePath = filePath.slice(1);
    if (filePath && !filePath.endsWith('/')) filePath += '/';
    const key = filePath + filename;
    const multipartUpload = env.R2_BUCKET.resumeMultipartUpload(key, uploadId);
    await multipartUpload.abort();
    return jsonResponse({ success: true, message: '分片上传已取消' });
  } catch (e) { return jsonResponse({ success: false, message: '取消上传失败: ' + e.message }, 500); }
}

// ============ 核心修改：handleDeleteFile（同时清理 KV 中的文件夹注册）============
async function handleDeleteFile(request, env, path) {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;
  try {
    let key = path || '';
    if (key.startsWith('/')) key = key.slice(1);
    
    const decodedKey = key;
    const encodedKey = encodePathSegments(key);
    const decodedPrefix = decodedKey + (decodedKey && !decodedKey.endsWith('/') ? '/' : '');
    const encodedPrefix = encodedKey + (encodedKey && !encodedKey.endsWith('/') ? '/' : '');
    
    // 检查是否是文件夹（R2 中有内容，或 KV 中有注册）
    const [decList, encList, kvRegistered] = await Promise.all([
      decodedPrefix ? env.R2_BUCKET.list({ prefix: decodedPrefix, limit: 1 }) : Promise.resolve({ objects: [] }),
      encodedPrefix !== decodedPrefix && encodedPrefix ? env.R2_BUCKET.list({ prefix: encodedPrefix, limit: 1 }) : Promise.resolve({ objects: [] }),
      isFolderRegistered(env.KV_STORE, '/' + decodedKey)
    ]);
    
    const hasFolderContent = 
      (decList.objects && decList.objects.length > 0) || 
      (encList.objects && encList.objects.length > 0) ||
      kvRegistered;
    
    // 删除 R2 中的文件/文件夹内容
    const prefixesToDelete = [];
    if (decList.objects && decList.objects.length > 0) prefixesToDelete.push(decodedPrefix);
    if (encList.objects && encList.objects.length > 0) prefixesToDelete.push(encodedPrefix);
    
    for (const pfx of prefixesToDelete) {
      let cursor;
      do {
        const batch = await env.R2_BUCKET.list({ prefix: pfx, cursor });
        if (batch.objects && batch.objects.length > 0) await env.R2_BUCKET.delete(batch.objects.map(obj => obj.key));
        cursor = batch.truncated ? batch.cursor : null;
      } while (cursor);
    }
    
    // 如果是单个文件（不是文件夹）
    if (!hasFolderContent || prefixesToDelete.length === 0) {
      const actualKey = await resolveActualKey(env.R2_BUCKET, decodedKey);
      try { await env.R2_BUCKET.delete(actualKey); } catch {}
    }
    
    // 清理 KV 中的文件夹注册（包括子文件夹）
    await unregisterFolder(env.KV_STORE, '/' + decodedKey);
    
    return jsonResponse({ success: true, message: '删除成功' });
  } catch (e) { return jsonResponse({ success: false, message: '删除失败: ' + e.message }, 500); }
}

async function handleRenameFile(request, env, path) {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;
  try {
    const body = await request.json();
    const { newName } = body;
    if (!newName) return jsonResponse({ success: false, message: '请提供新名称' }, 400);
    let oldKey = path || '';
    if (oldKey.startsWith('/')) oldKey = oldKey.slice(1);
    const actualOldKey = await resolveActualKey(env.R2_BUCKET, oldKey);
    const oldObject = await env.R2_BUCKET.get(actualOldKey);
    if (!oldObject) return jsonResponse({ success: false, message: '文件不存在' }, 404);
    const parentPath = oldKey.includes('/') ? oldKey.substring(0, oldKey.lastIndexOf('/') + 1) : '';
    const newKey = parentPath + newName;
    const actualNewKey = await resolveActualKey(env.R2_BUCKET, newKey);
    if (actualNewKey !== actualOldKey && await env.R2_BUCKET.head(actualNewKey)) return jsonResponse({ success: false, message: '目标名称已存在' }, 409);
    await env.R2_BUCKET.put(newKey, oldObject.body, { httpMetadata: oldObject.httpMetadata, customMetadata: oldObject.customMetadata });
    await env.R2_BUCKET.delete(actualOldKey);
    return jsonResponse({ success: true, message: '重命名成功', newPath: '/' + newKey });
  } catch (e) { return jsonResponse({ success: false, message: '重命名失败: ' + e.message }, 500); }
}

// ============ 核心修改：handleCreateFolder（改用 KV 注册）============
async function handleCreateFolder(request, env) {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;
  try {
    const body = await request.json();
    let { path: folderPath } = body;
    if (!folderPath) return jsonResponse({ success: false, message: '请提供文件夹路径' }, 400);
    folderPath = safeDecodePath(folderPath);
    if (folderPath.startsWith('/')) folderPath = folderPath.slice(1);
    if (!folderPath.endsWith('/')) folderPath += '/';
    
    // 不再创建 R2 占位文件，改为在 KV 中注册
    const fullPath = '/' + folderPath.slice(0, -1);
    await registerFolder(env.KV_STORE, fullPath);
    
    // 同时确保父文件夹链也被注册
    const parts = fullPath.split('/').filter(Boolean);
    let current = '';
    for (const part of parts.slice(0, -1)) { // 排除文件夹自身（它已注册）
      current += '/' + part;
      await registerFolder(env.KV_STORE, current);
    }
    
    return jsonResponse({ success: true, message: '文件夹创建成功', path: fullPath });
  } catch (e) { return jsonResponse({ success: false, message: '创建文件夹失败: ' + e.message }, 500); }
}

async function handleDownloadFile(request, env, path) {
  const auth = await verifyAuth(request, env);
  if (!auth) return jsonResponse({ success: false, message: '未授权' }, 401);
  try {
    let key = path || '';
    if (key.startsWith('/')) key = key.slice(1);
    const actualKey = await resolveActualKey(env.R2_BUCKET, key);
    const object = await env.R2_BUCKET.get(actualKey);
    if (!object) return jsonResponse({ success: false, message: '文件不存在' }, 404);
    const filename = safeDecodePath(actualKey).split('/').pop();
    return new Response(object.body, { headers: { 'Content-Type': object.httpMetadata?.contentType || getMimeType(filename), 'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`, 'Content-Length': object.size, 'Cache-Control': 'private, no-store' } });
  } catch (e) { return jsonResponse({ success: false, message: '下载失败: ' + e.message }, 500); }
}

async function handlePreviewFile(request, env, path) {
  const auth = await verifyAuth(request, env);
  if (!auth) return jsonResponse({ success: false, message: '未授权' }, 401);
  try {
    let key = path || '';
    if (key.startsWith('/')) key = key.slice(1);
    const actualKey = await resolveActualKey(env.R2_BUCKET, key);
    const object = await env.R2_BUCKET.get(actualKey);
    if (!object) return jsonResponse({ success: false, message: '文件不存在' }, 404);
    const filename = safeDecodePath(actualKey).split('/').pop();
    return new Response(object.body, { headers: { 'Content-Type': object.httpMetadata?.contentType || getMimeType(filename), 'Content-Length': object.size, 'Cache-Control': 'private, max-age=3600' } });
  } catch (e) { return jsonResponse({ success: false, message: '预览失败: ' + e.message }, 500); }
}

async function handleCreateShare(request, env) {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;
  try {
    const body = await request.json();
    let { filePath, password, expiresIn } = body;
    if (!filePath) return jsonResponse({ success: false, message: '请提供文件路径' }, 400);
    let key = filePath;
    if (key.startsWith('/')) key = key.slice(1);
    const actualKey = await resolveActualKey(env.R2_BUCKET, key);
    const object = await env.R2_BUCKET.head(actualKey);
    if (!object) return jsonResponse({ success: false, message: '文件不存在' }, 404);
    const shareId = generateId(12);
    const shareData = { shareId, filePath: key, fileName: safeDecodePath(actualKey).split('/').pop(), fileSize: object.size, passwordHash: password ? await hashPassword(password) : null, expiresAt: getExpirationTime(expiresIn || '1d'), viewCount: 0, downloadCount: 0, createdAt: Date.now() };
    await env.KV_STORE.put(`share:${shareId}`, JSON.stringify(shareData));
    const totalShares = parseInt(await env.KV_STORE.get('stats:totalShares') || '0');
    await env.KV_STORE.put('stats:totalShares', String(totalShares + 1));
    return jsonResponse({ success: true, shareId, shareUrl: `/s/${shareId}` });
  } catch (e) { return jsonResponse({ success: false, message: '创建分享链接失败: ' + e.message }, 500); }
}

async function handleGetShareInfo(request, env, shareId) {
  try {
    const shareData = await env.KV_STORE.get(`share:${shareId}`);
    if (!shareData) return jsonResponse({ success: false, message: '分享链接不存在' }, 404);
    const share = JSON.parse(shareData);
    if (share.expiresAt && Date.now() > share.expiresAt) return jsonResponse({ success: false, message: '分享链接已过期' }, 410);
    share.viewCount++;
    await env.KV_STORE.put(`share:${shareId}`, JSON.stringify(share));
    const totalViews = parseInt(await env.KV_STORE.get('stats:totalViews') || '0');
    await env.KV_STORE.put('stats:totalViews', String(totalViews + 1));
    return jsonResponse({ success: true, fileName: share.fileName, fileSize: share.fileSize, fileSizeFormatted: formatFileSize(share.fileSize), requiresPassword: !!share.passwordHash, expiresAt: share.expiresAt });
  } catch (e) { return jsonResponse({ success: false, message: '获取分享信息失败: ' + e.message }, 500); }
}

async function handleShareDownload(request, env, shareId) {
  try {
    const shareData = await env.KV_STORE.get(`share:${shareId}`);
    if (!shareData) return jsonResponse({ success: false, message: '分享链接不存在' }, 404);
    const share = JSON.parse(shareData);
    if (share.expiresAt && Date.now() > share.expiresAt) return jsonResponse({ success: false, message: '分享链接已过期' }, 410);
    if (share.passwordHash) {
      const body = await request.json();
      const { password } = body;
      if (!password) return jsonResponse({ success: false, message: '请输入密码' }, 401);
      const passwordHash = await hashPassword(password);
      if (passwordHash !== share.passwordHash) return jsonResponse({ success: false, message: '密码错误' }, 401);
    }
    const actualKey = await resolveActualKey(env.R2_BUCKET, share.filePath);
    const object = await env.R2_BUCKET.get(actualKey);
    if (!object) return jsonResponse({ success: false, message: '文件不存在' }, 404);
    share.downloadCount++;
    await env.KV_STORE.put(`share:${shareId}`, JSON.stringify(share));
    const totalDownloads = parseInt(await env.KV_STORE.get('stats:totalDownloads') || '0');
    await env.KV_STORE.put('stats:totalDownloads', String(totalDownloads + 1));
    return new Response(object.body, { headers: { 'Content-Type': object.httpMetadata?.contentType || getMimeType(share.fileName), 'Content-Disposition': `attachment; filename="${encodeURIComponent(share.fileName)}"`, 'Content-Length': object.size, 'Cache-Control': 'public, max-age=31536000, immutable' } });
  } catch (e) { return jsonResponse({ success: false, message: '下载失败: ' + e.message }, 500); }
}

async function handleGetStats(request, env) {
  const auth = await requireAdmin(request, env);
  if (auth instanceof Response) return auth;
  try {
    const totalShares = parseInt(await env.KV_STORE.get('stats:totalShares') || '0');
    const totalViews = parseInt(await env.KV_STORE.get('stats:totalViews') || '0');
    const totalDownloads = parseInt(await env.KV_STORE.get('stats:totalDownloads') || '0');
    const storageStats = await getR2BucketStats(env.R2_BUCKET);
    const quotaStatus = buildR2QuotaStatus(storageStats);
    return jsonResponse({
      success: true,
      totalShares,
      totalViews,
      totalDownloads,
      totalStorageSize: storageStats.size,
      totalStorageSizeFormatted: storageStats.sizeFormatted,
      totalFiles: storageStats.fileCount,
      r2FreeQuotaSize: quotaStatus.quota,
      r2FreeQuotaSizeFormatted: quotaStatus.quotaFormatted,
      remainingStorageSize: quotaStatus.remaining,
      remainingStorageSizeFormatted: quotaStatus.remainingFormatted,
      storageUsagePercent: quotaStatus.usagePercent
    });
  } catch (e) { return jsonResponse({ success: false, message: '获取统计数据失败: ' + e.message }, 500); }
}

async function handleListShares(request, env) {
  const auth = await requireAdmin(request, env);
  if (auth instanceof Response) return auth;
  try {
    const shares = [];
    let cursor;
    do {
      const listed = await env.KV_STORE.list({ prefix: 'share:', cursor, limit: 100 });
      for (const key of listed.keys) {
        const data = await env.KV_STORE.get(key.name);
        if (data) {
          const share = JSON.parse(data);
          shares.push({ ...share, fileSizeFormatted: formatFileSize(share.fileSize), isExpired: share.expiresAt && Date.now() > share.expiresAt });
        }
      }
      cursor = listed.list_complete ? null : listed.cursor;
    } while (cursor);
    shares.sort((a, b) => b.createdAt - a.createdAt);
    return jsonResponse({ success: true, shares });
  } catch (e) { return jsonResponse({ success: false, message: '获取分享列表失败: ' + e.message }, 500); }
}

async function handleDeleteShare(request, env, shareId) {
  const auth = await requireAdmin(request, env);
  if (auth instanceof Response) return auth;
  try {
    await env.KV_STORE.delete(`share:${shareId}`);
    const totalShares = parseInt(await env.KV_STORE.get('stats:totalShares') || '0');
    if (totalShares > 0) await env.KV_STORE.put('stats:totalShares', String(totalShares - 1));
    return jsonResponse({ success: true, message: '分享链接已删除' });
  } catch (e) { return jsonResponse({ success: false, message: '删除分享链接失败: ' + e.message }, 500); }
}

async function handleListUsers(request, env) {
  const auth = await requireAdmin(request, env);
  if (auth instanceof Response) return auth;
  try {
    const users = [];
    let cursor;
    do {
      const listed = await env.KV_STORE.list({ prefix: 'user:', cursor, limit: 100 });
      for (const key of listed.keys) {
        const data = await env.KV_STORE.get(key.name);
        if (data) {
          const user = JSON.parse(data);
          users.push({ email: user.email, role: user.role, createdAt: user.createdAt });
        }
      }
      cursor = listed.list_complete ? null : listed.cursor;
    } while (cursor);
    return jsonResponse({ success: true, users });
  } catch (e) { return jsonResponse({ success: false, message: '获取用户列表失败: ' + e.message }, 500); }
}

async function handleCreateUser(request, env) {
  const auth = await requireAdmin(request, env);
  if (auth instanceof Response) return auth;
  try {
    const body = await request.json();
    const { email, password } = body;
    if (!email || !password) return jsonResponse({ success: false, message: '请提供邮箱和密码' }, 400);
    const existing = await env.KV_STORE.get(`user:${email}`);
    if (existing) return jsonResponse({ success: false, message: '用户已存在' }, 409);
    const userData = { email, passwordHash: await hashPassword(password), role: 'user', createdAt: Date.now() };
    await env.KV_STORE.put(`user:${email}`, JSON.stringify(userData));
    return jsonResponse({ success: true, message: '用户创建成功', email });
  } catch (e) { return jsonResponse({ success: false, message: '创建用户失败: ' + e.message }, 500); }
}

async function handleDeleteUser(request, env, email) {
  const auth = await requireAdmin(request, env);
  if (auth instanceof Response) return auth;
  try {
    const decodedEmail = decodeURIComponent(email);
    await env.KV_STORE.delete(`user:${decodedEmail}`);
    return jsonResponse({ success: true, message: '用户已删除' });
  } catch (e) { return jsonResponse({ success: false, message: '删除用户失败: ' + e.message }, 500); }
}

async function handleCheckAuth(request, env) {
  const auth = await verifyAuth(request, env);
  if (!auth) return jsonResponse({ authenticated: false });
  return jsonResponse({ authenticated: true, role: auth.role, email: auth.email });
}

const APP_LOGO_DATA_URL = 'data:image/png;base64,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';

const APP_LOGO_SRC = '/logo.png';
const BOOTCDN_BASE_URL = 'https://cdn.bootcdn.net/ajax/libs';
const NPMMIRROR_BASE_URL = 'https://registry.npmmirror.com';
const MATERIAL_ICON_BASE_URL = 'https://npm.onmicrosoft.cn/material-icon-theme@5.35.0/icons/';

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

const APP_ASSETS = `
<link rel="icon" type="image/png" href="${APP_LOGO_SRC}">
<link rel="preconnect" href="https://cdn.bootcdn.net">
<link rel="preconnect" href="https://registry.npmmirror.com">
<link rel="preconnect" href="https://npm.onmicrosoft.cn">
<link rel="stylesheet" href="${BOOTCDN_BASE_URL}/element-plus/2.11.4/index.min.css">
<link rel="stylesheet" href="${BOOTCDN_BASE_URL}/element-plus/2.11.4/theme-chalk/dark/css-vars.min.css">
<script>(function(){var t=localStorage.getItem('edgestash-theme');var d=t?t==='dark':window.matchMedia('(prefers-color-scheme: dark)').matches;document.documentElement.classList.toggle('dark',d);})();</script>
<script src="${BOOTCDN_BASE_URL}/tailwindcss-browser/4.1.13/index.global.min.js"></script>
<script>
  window.tailwind = window.tailwind || {};
  tailwind.config = { darkMode: 'class', corePlugins: { preflight: false }, theme: { extend: { colors: { brand: { 500: '#0ea5e9', 600: '#2563eb' } }, boxShadow: { panel: '0 20px 60px rgba(21,40,70,.12)' } } } };
</script>
<script src="${BOOTCDN_BASE_URL}/vue/3.5.22/vue.global.prod.min.js"></script>
<script src="${BOOTCDN_BASE_URL}/element-plus/2.11.4/index.full.min.js"></script>
<script src="${NPMMIRROR_BASE_URL}/iconify-icon/3.0.1/files/dist/iconify-icon.min.js"></script>
<style>
  :root { color-scheme: light; --app-bg:#f5f7fb; --app-surface:#fff; --app-muted:#667085; --app-border:#dce5ef; --app-text:#142033; --app-soft:#eef6ff; --app-shadow:0 20px 60px rgba(21,40,70,.12); --el-border-radius-base:8px; --el-color-primary:#2563eb; }
  html.dark { color-scheme: dark; --app-bg:#0f141c; --app-surface:#171f2b; --app-muted:#9aa8ba; --app-border:rgba(148,163,184,.2); --app-text:#edf4ff; --app-soft:rgba(37,99,235,.12); --app-shadow:0 20px 60px rgba(0,0,0,.36); }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; background:linear-gradient(180deg,#f8fafc 0%,#eef6f8 100%); color:var(--app-text); font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
  html.dark body { background:linear-gradient(180deg,#0f141c 0%,#111827 100%); }
  [v-cloak] { display:none; }
  .app-page { min-height:100vh; }
  .topbar { position:sticky; top:0; z-index:20; height:62px; display:flex; align-items:center; justify-content:space-between; gap:12px; padding:0 24px; border-bottom:1px solid var(--app-border); background:color-mix(in srgb,var(--app-surface) 88%,transparent); backdrop-filter:blur(16px); }
  .brand { display:flex; align-items:center; gap:12px; min-width:0; }
  .brand-logo { width:42px; height:42px; border-radius:8px; object-fit:cover; box-shadow:0 10px 28px rgba(37,99,235,.24); border:1px solid color-mix(in srgb,var(--app-border) 70%,transparent); background:#fff; flex:none; }
  .brand-title { font-weight:800; font-size:17px; letter-spacing:0; white-space:nowrap; }
  .brand-subtitle { color:var(--app-muted); font-size:12px; margin-top:2px; white-space:nowrap; }
  .top-actions { display:flex; align-items:center; gap:8px; flex-wrap:wrap; justify-content:flex-end; }
  .container { width:min(1440px,100%); margin:0 auto; padding:22px; }
  .surface { background:var(--app-surface); border:1px solid var(--app-border); border-radius:8px; box-shadow:var(--app-shadow); }
  .auth-wrap { min-height:100vh; display:grid; place-items:center; padding:20px; background:radial-gradient(circle at 20% 15%,rgba(37,99,235,.16),transparent 30%),radial-gradient(circle at 84% 18%,rgba(20,184,166,.14),transparent 30%),var(--app-bg); }
  .auth-card { width:min(420px,100%); padding:24px; }
  .auth-head { text-align:center; margin-bottom:18px; }
  .auth-logo { width:68px; height:68px; border-radius:8px; object-fit:cover; margin-bottom:12px; box-shadow:0 16px 36px rgba(37,99,235,.26); border:1px solid color-mix(in srgb,var(--app-border) 70%,transparent); background:#fff; }
  .auth-title { font-size:24px; font-weight:850; }
  .muted { color:var(--app-muted); }
  .toolbar { display:flex; align-items:center; gap:8px; margin:14px 0; flex-wrap:wrap; }
  .toolbar-spacer { flex:1; min-width:16px; }
  .breadcrumb-row { display:flex; align-items:center; gap:6px; color:var(--app-muted); font-size:13px; flex-wrap:wrap; }
  .file-zone { min-height:calc(100vh - 168px); padding:18px; transition:border-color .2s,background .2s; }
  .file-zone.drag-over { border-color:var(--el-color-primary); background:var(--app-soft); }
  .file-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(220px,1fr)); gap:14px; }
  .file-card { position:relative; min-height:168px; padding:14px; display:flex; flex-direction:column; border:1px solid var(--app-border); border-radius:8px; background:var(--app-surface); transition:transform .18s,border-color .18s,box-shadow .18s; cursor:pointer; overflow:hidden; }
  .file-card::before { content:""; position:absolute; inset:0 0 auto; height:3px; background:linear-gradient(90deg,var(--el-color-primary),#14b8a6); opacity:0; transition:opacity .18s; }
  .file-card:hover { transform:translateY(-2px); border-color:color-mix(in srgb,var(--el-color-primary) 55%,var(--app-border)); box-shadow:0 12px 30px rgba(21,40,70,.12); }
  .file-card:hover::before,.file-card:focus-visible::before { opacity:1; }
  .file-card:focus-visible { outline:2px solid color-mix(in srgb,var(--el-color-primary) 70%,transparent); outline-offset:2px; }
  .folder-card { min-height:136px; }
  .folder-card .file-meta { margin-top:auto; }
  .file-icon { width:52px; height:52px; display:grid; place-items:center; border-radius:8px; background:var(--app-soft); margin-bottom:10px; }
  .file-card .file-icon { margin-left:auto; margin-right:auto; }
  .material-file-icon { width:46px; height:46px; object-fit:contain; display:block; filter:drop-shadow(0 8px 16px rgba(21,40,70,.12)); }
  html.dark .material-file-icon { filter:drop-shadow(0 8px 18px rgba(0,0,0,.32)); }
  .share-file-icon { flex:none; margin-bottom:0; }
  .share-file-icon .material-file-icon { width:44px; height:44px; }
  .file-type-folder,.file-type-archive { background:#fff7ed; }
  .file-type-executable { background:#f5f3ff; }
  .file-type-document { background:#eff6ff; }
  .file-type-sheet { background:#ecfdf5; }
  .file-type-media { background:#fdf2f8; }
  .file-type-code { background:#ecfeff; }
  .file-type-text { background:#f8fafc; }
  html.dark .file-type-folder,html.dark .file-type-archive { background:rgba(245,158,11,.14); }
  html.dark .file-type-executable { background:rgba(124,58,237,.16); }
  html.dark .file-type-document { background:rgba(37,99,235,.16); }
  html.dark .file-type-sheet { background:rgba(5,150,105,.16); }
  html.dark .file-type-media { background:rgba(219,39,119,.16); }
  html.dark .file-type-code { background:rgba(8,145,178,.16); }
  html.dark .file-type-text { background:rgba(100,116,139,.18); }
  .file-name { font-weight:700; font-size:14px; line-height:1.35; word-break:break-all; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; min-height:40px; }
  .file-card .file-name,.file-card .file-meta { width:100%; text-align:center; }
  .file-meta { color:var(--app-muted); font-size:12px; margin-top:5px; min-height:18px; }
  .file-actions { margin-top:auto; display:grid; grid-template-columns:repeat(auto-fit,minmax(32px,1fr)); gap:5px; align-items:center; justify-items:center; }
  .file-actions .el-button { margin-left:0; }
  .empty-state { min-height:280px; display:grid; place-items:center; text-align:center; color:var(--app-muted); }
  .empty-state iconify-icon { font-size:54px; color:var(--el-color-primary); opacity:.75; }
  .stats-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:12px; margin-bottom:16px; }
  .stat-card { padding:16px; }
  .stat-icon { width:36px; height:36px; border-radius:8px; display:grid; place-items:center; background:var(--app-soft); color:var(--el-color-primary); font-size:22px; margin-bottom:12px; }
  .stat-value { font-size:26px; font-weight:850; line-height:1.1; overflow-wrap:anywhere; }
  .stat-label { color:var(--app-muted); font-size:13px; margin-top:4px; }
  .stat-note { color:var(--app-muted); font-size:12px; margin-top:7px; }
  .quota-progress { margin-top:12px; }
  .preview-body { min-height:360px; max-height:70vh; overflow:auto; display:grid; place-items:center; }
  .preview-image { max-width:100%; max-height:68vh; border-radius:8px; }
  .preview-frame { width:100%; height:68vh; border:0; border-radius:8px; background:#fff; }
  .preview-text { width:100%; min-height:360px; margin:0; padding:18px; border-radius:8px; background:#111827; color:#e5e7eb; overflow:auto; white-space:pre-wrap; font-family:Consolas,"SFMono-Regular",monospace; font-size:13px; line-height:1.65; }
  .preview-markdown { width:min(860px,100%); padding:22px; border-radius:8px; background:var(--app-surface); color:var(--app-text); line-height:1.75; }
  .preview-media { max-width:100%; max-height:68vh; border-radius:8px; }
  .el-button iconify-icon { font-size:17px; }
  @media (max-width:720px) { .topbar{height:auto;align-items:flex-start;padding:12px 16px}.container{padding:14px}.brand-subtitle{display:none}.toolbar-spacer{display:none}.file-zone{padding:12px}.file-grid{grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px}.file-card{min-height:152px;padding:12px} }
</style>`;

const APP_HELPERS = `
function installCommonApp(app) {
  app.config.compilerOptions.isCustomElement = function(tag) { return tag === 'iconify-icon'; };
  app.use(ElementPlus);
  app.mount('#app');
}
function commonState() {
  return { logo: '${APP_LOGO_SRC}', isDark: document.documentElement.classList.contains('dark') };
}
function commonMethods() {
  return {
    toggleTheme() { this.isDark = !this.isDark; document.documentElement.classList.toggle('dark', this.isDark); localStorage.setItem('edgestash-theme', this.isDark ? 'dark' : 'light'); },
    async logout() { await fetch('/api/logout', { method: 'POST' }); window.location.href = '/login.html'; },
    async copyText(text, message) {
      try {
        if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
        else { var input = document.createElement('textarea'); input.value = text; input.style.position = 'fixed'; input.style.opacity = '0'; document.body.appendChild(input); input.select(); document.execCommand('copy'); document.body.removeChild(input); }
        ElementPlus.ElMessage.success(message || '已复制');
      } catch (error) { ElementPlus.ElMessage.error('复制失败: ' + error.message); }
    },
    materialIcon(iconName) { return '${MATERIAL_ICON_BASE_URL}' + (iconName || 'file') + '.svg'; },
    materialFileIcon(name) {
      var lowerName = String(name || '').toLowerCase();
      var ext = lowerName.includes('.') ? lowerName.split('.').pop() : lowerName;
      var names = { dockerfile:'docker', makefile:'makefile', license:'license', 'readme.md':'readme', '.gitignore':'git', '.env':'tune', 'package.json':'nodejs', 'package-lock.json':'npm', 'yarn.lock':'yarn', 'pnpm-lock.yaml':'pnpm' };
      var map = { pdf:'pdf', doc:'word', docx:'word', xls:'table', xlsx:'table', csv:'table', ppt:'powerpoint', pptx:'powerpoint', jpg:'image', jpeg:'image', png:'image', gif:'image', svg:'svg', webp:'image', bmp:'image', ico:'favicon', mp3:'audio', wav:'audio', flac:'audio', m4a:'audio', ogg:'audio', mp4:'video', webm:'video', mov:'video', mkv:'video', avi:'video', zip:'zip', rar:'zip', '7z':'zip', tar:'zip', gz:'zip', exe:'exe', msi:'exe', apk:'android', deb:'installation', rpm:'installation', dmg:'installation', js:'javascript', mjs:'javascript', cjs:'javascript', ts:'typescript', jsx:'react', tsx:'react_ts', vue:'vue', html:'html', htm:'html', css:'css', scss:'sass', sass:'sass', less:'less', json:'json', xml:'xml', yaml:'yaml', yml:'yaml', toml:'config', ini:'config', conf:'config', env:'tune', md:'markdown', markdown:'markdown', txt:'document', log:'log', sh:'console', bash:'console', zsh:'console', ps1:'powershell', py:'python', java:'java', go:'go', rs:'rust', php:'php', rb:'ruby', c:'c', h:'h', cpp:'cpp', hpp:'hpp', cs:'csharp', sql:'database', sqlite:'database', db:'database' };
      return this.materialIcon(names[lowerName] || map[ext] || 'file');
    },
    fileIcon(name) { return this.materialFileIcon(name); },
    handleMaterialIconError(event) { var img = event && event.target; if (!img || img.dataset.fallback === '1') return; img.dataset.fallback = '1'; img.src = this.materialIcon('file'); },
    encodePath(path) { var normalized = String(path || '/'); if (!normalized.startsWith('/')) normalized = '/' + normalized; return normalized.split('/').map(function(part) { return encodeURIComponent(part); }).join('/'); },
    apiUrl(base, path) { return base + this.encodePath(path); },
    escapeHtml(text) { var div = document.createElement('div'); div.textContent = text == null ? '' : String(text); return div.innerHTML; }
  };
}`;

const LOGIN_PAGE = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>登录 - EdgeStash</title>${APP_ASSETS}</head><body>
<div id="app" class="auth-wrap min-h-screen bg-slate-50 px-6 py-6 dark:bg-slate-950" v-cloak>
  <el-button class="theme-float" circle style="position:fixed;right:18px;top:18px;" @click="toggleTheme"><iconify-icon :icon="isDark ? 'solar:sun-2-bold-duotone' : 'solar:moon-bold-duotone'"></iconify-icon></el-button>
  <div class="surface auth-card shadow-xl transition-colors duration-300">
    <div class="auth-head flex flex-col items-center text-center"><img class="auth-logo" src="${APP_LOGO_SRC}" alt="EdgeStash Logo"><div class="auth-title">EdgeStash</div><div class="muted" style="margin-top:6px;">私有边缘存储</div></div>
    <el-tabs v-model="mode" stretch><el-tab-pane label="管理员" name="admin"></el-tab-pane><el-tab-pane label="授权用户" name="user"></el-tab-pane></el-tabs>
    <el-form @submit.prevent="handleLogin" label-position="top">
      <el-form-item v-if="mode === 'user'" label="邮箱"><el-input v-model="form.email" size="large" autocomplete="username" placeholder="name@example.com"></el-input></el-form-item>
      <el-form-item label="密码"><el-input v-model="form.password" size="large" type="password" show-password autocomplete="current-password" placeholder="请输入密码" @keyup.enter="handleLogin"></el-input></el-form-item>
      <el-button type="primary" size="large" style="width:100%;" :loading="loading" @click="handleLogin"><iconify-icon icon="solar:login-3-bold-duotone"></iconify-icon>登录</el-button>
    </el-form>
  </div>
</div>
<script>${APP_HELPERS}
const app = Vue.createApp({ data() { return Object.assign(commonState(), { mode:'admin', loading:false, form:{ email:'', password:'' } }); }, methods: Object.assign(commonMethods(), { async handleLogin() { if (!this.form.password || (this.mode === 'user' && !this.form.email)) return ElementPlus.ElMessage.error('请填写登录信息'); this.loading = true; try { var response = await fetch('/api/login', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ isAdmin:this.mode === 'admin', email:this.mode === 'admin' ? undefined : this.form.email, password:this.form.password }) }); var data = await response.json(); if (!data.success) throw new Error(data.message || '登录失败'); window.location.href = '/'; } catch (error) { ElementPlus.ElMessage.error(error.message); } finally { this.loading = false; } } }) });
installCommonApp(app);</script></body></html>`;

const ADMIN_PAGE = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>管理后台 - EdgeStash</title>${APP_ASSETS}</head><body>
<div id="app" class="app-page" v-cloak>
  <header class="topbar flex items-center justify-between gap-3 border-b border-slate-200/80 bg-white/85 dark:border-slate-700/60 dark:bg-slate-900/80">
    <div class="brand"><img class="brand-logo" src="${APP_LOGO_SRC}" alt="EdgeStash Logo"><div><div class="brand-title">EdgeStash 管理后台</div><div class="brand-subtitle">存储、分享与授权</div></div></div>
    <div class="top-actions"><el-button circle @click="toggleTheme"><iconify-icon :icon="isDark ? 'solar:sun-2-bold-duotone' : 'solar:moon-bold-duotone'"></iconify-icon></el-button><el-button @click="goHome"><iconify-icon icon="solar:folder-with-files-bold-duotone"></iconify-icon>云盘</el-button><el-button text @click="logout">退出</el-button></div>
  </header>
  <main class="container mx-auto">
    <el-tabs v-model="activeTab" @tab-change="handleTabChange"><el-tab-pane name="stats"><template #label><iconify-icon icon="solar:chart-2-bold-duotone"></iconify-icon> 统计</template></el-tab-pane><el-tab-pane name="shares"><template #label><iconify-icon icon="solar:link-bold-duotone"></iconify-icon> 分享</template></el-tab-pane><el-tab-pane name="users"><template #label><iconify-icon icon="solar:users-group-rounded-bold-duotone"></iconify-icon> 用户</template></el-tab-pane></el-tabs>
    <section v-show="activeTab === 'stats'" v-loading="loading.stats"><div class="stats-grid"><div class="surface stat-card transition duration-200 hover:-translate-y-0.5 hover:border-sky-300 dark:hover:border-sky-500" v-for="item in statCards" :key="item.label"><div class="stat-icon"><iconify-icon :icon="item.icon"></iconify-icon></div><div class="stat-value">{{ item.value }}</div><div class="stat-label">{{ item.label }}</div><div v-if="item.note" class="stat-note">{{ item.note }}</div><el-progress v-if="item.percent !== undefined" class="quota-progress" :percentage="item.percent" :status="item.status"></el-progress></div></div></section>
    <section v-show="activeTab === 'shares'" class="surface" style="padding:16px;" v-loading="loading.shares"><el-table :data="shares" style="width:100%;"><el-table-column prop="fileName" label="文件" min-width="220"></el-table-column><el-table-column prop="fileSizeFormatted" label="大小" width="110"></el-table-column><el-table-column prop="shareId" label="分享 ID" min-width="150"></el-table-column><el-table-column label="访问" width="120"><template #default="{ row }">{{ row.viewCount || 0 }} / {{ row.downloadCount || 0 }}</template></el-table-column><el-table-column label="状态" width="110"><template #default="{ row }"><el-tag :type="row.isExpired ? 'danger' : 'success'">{{ row.isExpired ? '已过期' : '有效' }}</el-tag></template></el-table-column><el-table-column label="操作" width="160" fixed="right"><template #default="{ row }"><el-button size="small" @click="copyShare(row.shareId)"><iconify-icon icon="solar:copy-bold-duotone"></iconify-icon></el-button><el-button size="small" type="danger" @click="deleteShare(row.shareId)"><iconify-icon icon="solar:trash-bin-trash-bold-duotone"></iconify-icon></el-button></template></el-table-column></el-table></section>
    <section v-show="activeTab === 'users'" class="surface" style="padding:16px;" v-loading="loading.users"><div class="toolbar" style="margin-top:0;"><div class="toolbar-spacer"></div><el-button type="primary" @click="userDialog = true"><iconify-icon icon="solar:user-plus-bold-duotone"></iconify-icon>添加用户</el-button></div><el-table :data="users" style="width:100%;"><el-table-column prop="email" label="邮箱" min-width="240"></el-table-column><el-table-column label="角色" width="120"><template #default="{ row }"><el-tag :type="row.role === 'admin' ? 'danger' : 'info'">{{ row.role === 'admin' ? '管理员' : '普通用户' }}</el-tag></template></el-table-column><el-table-column label="创建时间" min-width="180"><template #default="{ row }">{{ formatTime(row.createdAt) }}</template></el-table-column><el-table-column label="操作" width="120" fixed="right"><template #default="{ row }"><el-button size="small" type="danger" @click="deleteUser(row.email)"><iconify-icon icon="solar:user-block-bold-duotone"></iconify-icon></el-button></template></el-table-column></el-table></section>
  </main>
  <el-dialog v-model="userDialog" title="添加授权用户" width="420px"><el-form label-position="top"><el-form-item label="邮箱"><el-input v-model="newUser.email" placeholder="name@example.com"></el-input></el-form-item><el-form-item label="初始密码"><el-input v-model="newUser.password" show-password placeholder="请输入密码"></el-input></el-form-item></el-form><template #footer><el-button @click="userDialog=false">取消</el-button><el-button type="primary" :loading="loading.addUser" @click="addUser">添加</el-button></template></el-dialog>
</div>
<script>${APP_HELPERS}
const app = Vue.createApp({ data() { return Object.assign(commonState(), { activeTab:'stats', stats:{ totalShares:0,totalViews:0,totalDownloads:0,totalStorageSizeFormatted:'0 B',r2FreeQuotaSizeFormatted:'10 GB',remainingStorageSizeFormatted:'10 GB',storageUsagePercent:0,totalFiles:0 }, shares:[], users:[], loading:{ stats:false,shares:false,users:false,addUser:false }, userDialog:false, newUser:{ email:'',password:'' } }); }, computed:{ statCards(){ var percent=Number(this.stats.storageUsagePercent || 0); return [{ label:'R2 免费容量', value:(this.stats.totalStorageSizeFormatted || '0 B') + ' / ' + (this.stats.r2FreeQuotaSizeFormatted || '10 GB'), note:'剩余 ' + (this.stats.remainingStorageSizeFormatted || '10 GB'), percent:percent, status:percent >= 90 ? 'exception' : undefined, icon:'solar:database-bold-duotone' },{ label:'存储文件数', value:this.stats.totalFiles || 0, icon:'solar:documents-bold-duotone' },{ label:'分享链接数', value:this.stats.totalShares || 0, icon:'solar:link-bold-duotone' },{ label:'浏览次数', value:this.stats.totalViews || 0, icon:'solar:eye-bold-duotone' },{ label:'下载次数', value:this.stats.totalDownloads || 0, icon:'solar:download-bold-duotone' }]; } }, mounted(){ this.checkAdminAuth(); this.loadStats(); }, methods:Object.assign(commonMethods(), { goHome(){ window.location.href='/'; }, async checkAdminAuth(){ try { var data = await (await fetch('/api/auth/check')).json(); if (!data.authenticated || data.role !== 'admin') window.location.href='/login.html'; } catch (error) { window.location.href='/login.html'; } }, handleTabChange(name){ if (name === 'stats') this.loadStats(); if (name === 'shares') this.loadShares(); if (name === 'users') this.loadUsers(); }, async loadStats(){ this.loading.stats=true; try { var data = await (await fetch('/api/admin/stats')).json(); if (!data.success) throw new Error(data.message || '加载失败'); this.stats=data; } catch(error){ ElementPlus.ElMessage.error(error.message); } finally { this.loading.stats=false; } }, async loadShares(){ this.loading.shares=true; try { var data = await (await fetch('/api/admin/shares')).json(); if (!data.success) throw new Error(data.message || '加载失败'); this.shares=data.shares || []; } catch(error){ ElementPlus.ElMessage.error(error.message); } finally { this.loading.shares=false; } }, async loadUsers(){ this.loading.users=true; try { var data = await (await fetch('/api/admin/users')).json(); if (!data.success) throw new Error(data.message || '加载失败'); this.users=data.users || []; } catch(error){ ElementPlus.ElMessage.error(error.message); } finally { this.loading.users=false; } }, async addUser(){ if (!this.newUser.email || !this.newUser.password) return ElementPlus.ElMessage.error('请填写邮箱和密码'); this.loading.addUser=true; try { var data = await (await fetch('/api/admin/users',{ method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify(this.newUser) })).json(); if (!data.success) throw new Error(data.message || '添加失败'); this.userDialog=false; this.newUser={ email:'',password:'' }; this.loadUsers(); ElementPlus.ElMessage.success('已添加'); } catch(error){ ElementPlus.ElMessage.error(error.message); } finally { this.loading.addUser=false; } }, async deleteUser(email){ try { await ElementPlus.ElMessageBox.confirm('确定撤销 ' + email + ' 的授权吗？','撤销授权',{ type:'warning' }); var data = await (await fetch('/api/admin/users/' + encodeURIComponent(email),{ method:'DELETE' })).json(); if (!data.success) throw new Error(data.message || '删除失败'); this.loadUsers(); } catch(error){ if (error !== 'cancel') ElementPlus.ElMessage.error(error.message || error); } }, async deleteShare(id){ try { await ElementPlus.ElMessageBox.confirm('确定删除该分享链接吗？','删除分享',{ type:'warning' }); var data = await (await fetch('/api/admin/shares/' + id,{ method:'DELETE' })).json(); if (!data.success) throw new Error(data.message || '删除失败'); this.loadShares(); this.loadStats(); } catch(error){ if (error !== 'cancel') ElementPlus.ElMessage.error(error.message || error); } }, copyShare(id){ this.copyText(window.location.origin + '/s/' + id, '分享链接已复制'); }, formatTime(value){ return value ? new Date(value).toLocaleString('zh-CN') : '-'; } }) });
installCommonApp(app);</script></body></html>`;

const SHARE_PAGE = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>文件分享 - EdgeStash</title>${APP_ASSETS}</head><body>
<div id="app" class="auth-wrap min-h-screen bg-slate-50 px-6 py-6 dark:bg-slate-950" v-cloak>
  <div class="surface auth-card shadow-xl transition-colors duration-300" style="max-width:520px;"><div class="auth-head flex flex-col items-center text-center"><img class="auth-logo" src="${APP_LOGO_SRC}" alt="EdgeStash Logo"><div class="auth-title">EdgeStash 分享</div></div><div v-if="loading" style="text-align:center;padding:22px;"><el-icon class="is-loading"><iconify-icon icon="solar:refresh-bold-duotone"></iconify-icon></el-icon></div><el-result v-else-if="expired" icon="warning" title="链接不可用" sub-title="分享链接已过期或不存在"></el-result><div v-else><div style="display:flex;gap:12px;align-items:center;margin-bottom:18px;"><div class="file-icon file-type-document share-file-icon"><img class="material-file-icon" :src="fileIcon(info.fileName)" alt="" @error="handleMaterialIconError"></div><div style="min-width:0;"><div class="file-name" style="-webkit-line-clamp:3;">{{ info.fileName }}</div><div class="file-meta">{{ info.fileSizeFormatted }}</div></div></div><el-input v-if="info.requiresPassword" v-model="password" type="password" show-password placeholder="请输入分享密码" style="margin-bottom:12px;"></el-input><el-button type="primary" size="large" style="width:100%;" :loading="downloading" @click="downloadFile"><iconify-icon icon="solar:download-bold-duotone"></iconify-icon>下载文件</el-button></div></div>
</div>
<script>${APP_HELPERS}
const app = Vue.createApp({ data(){ return Object.assign(commonState(), { loading:true, expired:false, info:{}, password:'', downloading:false, shareId:'' }); }, mounted(){ this.loadShareInfo(); }, methods:Object.assign(commonMethods(), { async loadShareInfo(){ this.shareId = window.location.pathname.split('/').filter(Boolean).pop(); if (!this.shareId) { this.expired=true; this.loading=false; return; } try { var data = await (await fetch('/api/share/' + this.shareId)).json(); if (!data.success) throw new Error(data.message || '链接不可用'); this.info=data; } catch(error){ this.expired=true; } finally { this.loading=false; } }, async downloadFile(){ if (this.info.requiresPassword && !this.password) return ElementPlus.ElMessage.error('请输入分享密码'); this.downloading=true; try { var response = await fetch('/api/share/' + this.shareId + '/download',{ method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ password:this.password }) }); if (!response.ok) { var err = await response.json(); throw new Error(err.message || '下载失败'); } var filename=this.info.fileName || 'download'; var blob=await response.blob(); var url=URL.createObjectURL(blob); var a=document.createElement('a'); a.href=url; a.download=filename; document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url); } catch(error){ ElementPlus.ElMessage.error(error.message); } finally { this.downloading=false; } } }) });
installCommonApp(app);</script></body></html>`;

const INDEX_PAGE = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>EdgeStash 云盘</title>${APP_ASSETS}<script src="${BOOTCDN_BASE_URL}/marked/16.3.0/lib/marked.umd.min.js"></script><script src="${BOOTCDN_BASE_URL}/mammoth/1.11.0/mammoth.browser.min.js"></script><script src="${BOOTCDN_BASE_URL}/dompurify/3.2.7/purify.min.js"></script></head><body>
<div id="app" class="app-page" v-cloak>
  <header class="topbar flex items-center justify-between gap-3 border-b border-slate-200/80 bg-white/85 dark:border-slate-700/60 dark:bg-slate-900/80"><div class="brand"><img class="brand-logo" src="${APP_LOGO_SRC}" alt="EdgeStash Logo"><div><div class="brand-title">EdgeStash</div><div class="brand-subtitle">Cloudflare R2 私有云盘</div></div></div><div class="top-actions"><el-button circle @click="toggleTheme"><iconify-icon :icon="isDark ? 'solar:sun-2-bold-duotone' : 'solar:moon-bold-duotone'"></iconify-icon></el-button><el-button v-if="auth.role === 'admin'" @click="goAdmin"><iconify-icon icon="solar:settings-bold-duotone"></iconify-icon>管理</el-button><el-button text @click="logout">退出</el-button></div></header>
  <main class="container mx-auto">
    <div class="breadcrumb-row"><el-button link @click="navigateTo('/')"><iconify-icon icon="solar:home-2-bold-duotone"></iconify-icon>根目录</el-button><template v-for="crumb in breadcrumbs" :key="crumb.path"><span>/</span><el-button link @click="navigateTo(crumb.path)">{{ crumb.name }}</el-button></template></div>
    <div class="toolbar"><el-button type="primary" @click="folderDialog = true"><iconify-icon icon="solar:folder-add-bold-duotone"></iconify-icon>新建文件夹</el-button><el-button @click="selectFiles"><iconify-icon icon="solar:upload-bold-duotone"></iconify-icon>上传</el-button><input ref="fileInput" type="file" multiple style="display:none;" @change="handleFileInput"><el-button @click="loadFiles"><iconify-icon icon="solar:refresh-bold-duotone"></iconify-icon>刷新</el-button><div class="toolbar-spacer"></div><el-select v-model="sort" style="width:160px;"><el-option label="名称 A-Z" value="name-asc"></el-option><el-option label="名称 Z-A" value="name-desc"></el-option><el-option label="大小降序" value="size-desc"></el-option><el-option label="大小升序" value="size-asc"></el-option><el-option label="最新上传" value="time-desc"></el-option><el-option label="最早上传" value="time-asc"></el-option></el-select></div>
    <section class="surface file-zone transition-colors duration-200" :class="{ 'drag-over': dragOver }" v-loading="loading" @dragenter.prevent="dragOver=true" @dragover.prevent="dragOver=true" @dragleave.prevent="dragOver=false" @drop.prevent="handleDrop"><div v-if="sortedFolders.length || sortedFiles.length" class="file-grid"><article v-for="folder in sortedFolders" :key="'folder:' + folder.path" class="file-card folder-card group transition duration-200 hover:-translate-y-0.5 hover:border-sky-300 dark:hover:border-sky-500" tabindex="0" @dblclick="navigateTo(folder.path)" @keydown.enter="navigateTo(folder.path)"><div class="file-icon file-type-folder transition-transform duration-200 group-hover:scale-105"><img class="material-file-icon" :src="materialIcon('folder')" alt="" @error="handleMaterialIconError"></div><div class="file-name" :title="folder.name">{{ folder.name }}</div><div class="file-meta">{{ folder.sizeFormatted || '0 B' }} · {{ folder.fileCount || 0 }} 个文件</div></article><article v-for="file in sortedFiles" :key="'file:' + file.path" class="file-card group transition duration-200 hover:-translate-y-0.5 hover:border-sky-300 dark:hover:border-sky-500" tabindex="0" @dblclick="openFile(file)" @keydown.enter="openFile(file)"><div class="file-icon transition-transform duration-200 group-hover:scale-105" :class="fileIconClass(file.name)"><img class="material-file-icon" :src="fileIcon(file.name)" alt="" @error="handleMaterialIconError"></div><div class="file-name" :title="file.name">{{ file.name }}</div><div class="file-meta">{{ file.sizeFormatted }} · {{ formatDate(file.lastModified) }}</div><div class="file-actions"><el-button v-if="file.previewType" size="small" @click="previewFile(file)"><iconify-icon icon="solar:eye-bold-duotone"></iconify-icon></el-button><el-button size="small" @click="downloadFile(file.path)"><iconify-icon icon="solar:download-bold-duotone"></iconify-icon></el-button><el-button size="small" @click="showShare(file)"><iconify-icon icon="solar:link-bold-duotone"></iconify-icon></el-button><el-button size="small" @click="showRename(file)"><iconify-icon icon="solar:pen-bold-duotone"></iconify-icon></el-button><el-button size="small" type="danger" @click="deleteItem(file)"><iconify-icon icon="solar:trash-bin-trash-bold-duotone"></iconify-icon></el-button></div></article></div><div v-else class="empty-state"><div><iconify-icon icon="solar:folder-open-bold-duotone"></iconify-icon><div style="font-weight:650;margin-top:8px;">当前文件夹为空</div></div></div></section>
  </main>
  <el-dialog v-model="folderDialog" title="新建文件夹" width="420px"><el-input v-model="folderName" placeholder="文件夹名称"></el-input><template #footer><el-button @click="folderDialog=false">取消</el-button><el-button type="primary" @click="createFolder">创建</el-button></template></el-dialog>
  <el-dialog v-model="renameDialog" title="重命名" width="420px"><el-input v-model="newName" placeholder="新名称"></el-input><template #footer><el-button @click="renameDialog=false">取消</el-button><el-button type="primary" @click="renameFile">保存</el-button></template></el-dialog>
  <el-dialog v-model="shareDialog" title="创建分享链接" width="460px"><el-form label-position="top"><el-form-item label="分享密码"><el-input v-model="share.password" placeholder="留空则公开"></el-input></el-form-item><el-form-item label="有效期"><el-select v-model="share.expiresIn" style="width:100%;"><el-option label="1 小时" value="1h"></el-option><el-option label="1 天" value="1d"></el-option><el-option label="1 个月" value="1m"></el-option><el-option label="永久" value="permanent"></el-option></el-select></el-form-item></el-form><template #footer><el-button @click="shareDialog=false">取消</el-button><el-button type="primary" @click="createShare">生成</el-button></template></el-dialog>
  <el-dialog v-model="shareResultDialog" title="分享链接" width="520px"><el-input v-model="shareResultUrl" readonly></el-input><template #footer><el-button type="primary" @click="copyText(shareResultUrl, '分享链接已复制')"><iconify-icon icon="solar:copy-bold-duotone"></iconify-icon>复制</el-button></template></el-dialog>
  <el-dialog v-model="uploadDialog" title="上传进度" width="460px" :close-on-click-modal="false"><div class="file-name" style="margin-bottom:10px;">{{ upload.name }}</div><el-progress :percentage="upload.percent"></el-progress><div class="file-meta" style="margin-top:8px;">{{ upload.status }}</div><template #footer><el-button v-if="upload.abortable" type="danger" @click="cancelUpload">取消</el-button></template></el-dialog>
  <el-dialog v-model="previewDialog" :title="preview.name" width="86vw" top="5vh"><div class="preview-body" v-loading="preview.loading"><img v-if="preview.mode==='image'" class="preview-image" :src="preview.url" :alt="preview.name"><iframe v-else-if="preview.mode==='pdf'" class="preview-frame" :src="preview.url"></iframe><pre v-else-if="preview.mode==='text'" class="preview-text">{{ preview.text }}</pre><div v-else-if="preview.mode==='html'" class="preview-markdown" v-html="preview.html"></div><video v-else-if="preview.mode==='video'" class="preview-media" controls autoplay :src="preview.url"></video><audio v-else-if="preview.mode==='audio'" class="preview-media" controls autoplay :src="preview.url"></audio><el-empty v-else description="无法预览"></el-empty></div><template #footer><el-button @click="downloadFile(preview.path)"><iconify-icon icon="solar:download-bold-duotone"></iconify-icon>下载</el-button></template></el-dialog>
</div>
<script>${APP_HELPERS}
const app = Vue.createApp({ data(){ return Object.assign(commonState(), { auth:{}, currentPath:'/', folders:[], files:[], sort:localStorage.getItem('edgestash-sort') || 'name-asc', loading:false, dragOver:false, folderDialog:false, folderName:'', renameDialog:false, renameTarget:null, newName:'', shareDialog:false, shareTarget:null, share:{ password:'', expiresIn:'1d' }, shareResultDialog:false, shareResultUrl:'', uploadDialog:false, upload:{ name:'', percent:0, status:'', abortable:false }, currentAbort:null, currentMultipart:null, previewDialog:false, preview:{ name:'', path:'', url:'', mode:'', text:'', html:'', loading:false } }); }, computed:{ breadcrumbs(){ var parts=this.currentPath.split('/').filter(Boolean); var out=[], path=''; parts.forEach(function(part){ path += '/' + part; out.push({ name:part, path:path }); }); return out; }, sortedFolders(){ var arr=this.folders.slice(); var parts=this.sort.split('-'); var field=parts[0]; var mul=parts[1] === 'asc' ? 1 : -1; arr.sort(function(a,b){ if (field === 'size') return ((a.size || 0) - (b.size || 0)) * mul; return a.name.localeCompare(b.name, 'zh-CN') * mul; }); return arr; }, sortedFiles(){ var arr=this.files.slice(); var parts=this.sort.split('-'); var field=parts[0]; var mul=parts[1] === 'asc' ? 1 : -1; arr.sort(function(a,b){ if (field === 'size') return ((a.size || 0) - (b.size || 0)) * mul; if (field === 'time') return (new Date(a.lastModified || 0) - new Date(b.lastModified || 0)) * mul; return a.name.localeCompare(b.name, 'zh-CN') * mul; }); return arr; } }, watch:{ sort(value){ localStorage.setItem('edgestash-sort', value); } }, mounted(){ this.checkAuth(); this.loadFiles(); }, methods:Object.assign(commonMethods(), { async checkAuth(){ try { var data = await (await fetch('/api/auth/check')).json(); if (!data.authenticated) window.location.href='/login.html'; this.auth=data; } catch(error){ window.location.href='/login.html'; } }, goAdmin(){ window.location.href='/admin.html'; }, async loadFiles(){ this.loading=true; try { var response=await fetch(this.apiUrl('/api/files', this.currentPath)); var data=await response.json(); if (!data.success) { if (response.status === 401) { window.location.href='/login.html'; return; } throw new Error(data.message || '加载失败'); } this.folders=data.folders || []; this.files=data.files || []; this.currentPath=data.currentPath || this.currentPath; } catch(error){ ElementPlus.ElMessage.error(error.message); } finally { this.loading=false; } }, navigateTo(path){ this.currentPath=path || '/'; this.loadFiles(); }, selectFiles(){ this.$refs.fileInput.click(); }, handleFileInput(e){ this.handleFiles(e.target.files); e.target.value=''; }, handleDrop(e){ this.dragOver=false; this.handleFiles(e.dataTransfer.files); }, async handleFiles(fileList){ var files=Array.from(fileList || []); if (!files.length) return; this.uploadDialog=true; this.upload.abortable=true; var ok=0; for (var i=0;i<files.length;i++){ var file=files[i]; this.upload.name=file.name; this.upload.percent=0; this.upload.status='上传中'; this.currentAbort=new AbortController(); try { if (file.size > 5 * 1024 * 1024) await this.uploadFileChunked(file, this.currentAbort.signal); else await this.uploadFileRegular(file, this.currentAbort.signal); ok++; } catch(error){ if (error.name !== 'AbortError') ElementPlus.ElMessage.error(file.name + ': ' + error.message); } finally { this.currentAbort=null; if (this.currentMultipart) { var pending=this.currentMultipart; this.currentMultipart=null; try { await fetch(this.apiUrl('/api/files/abort', pending.path),{ method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ filename:pending.filename, uploadId:pending.uploadId }) }); } catch(e){} } } } this.upload.abortable=false; this.upload.percent=100; this.upload.status='完成'; if (ok) { ElementPlus.ElMessage.success('上传完成'); this.loadFiles(); setTimeout(() => { this.uploadDialog=false; }, 700); } }, uploadFileRegular(file, signal){ return new Promise((resolve,reject) => { var formData=new FormData(); formData.append('file', file); var xhr=new XMLHttpRequest(); xhr.open('POST',this.apiUrl('/api/files', this.currentPath),true); xhr.upload.onprogress=(event)=>{ if (event.lengthComputable) this.upload.percent=Math.round((event.loaded/event.total)*100); }; xhr.onload=()=>{ try { var data=JSON.parse(xhr.responseText); if (xhr.status >= 200 && xhr.status < 300 && data.success) resolve(data); else reject(new Error(data.message || '上传失败')); } catch(e){ reject(new Error('响应解析失败')); } }; xhr.onerror=()=>reject(new Error('网络连接失败')); xhr.onabort=()=>reject(new DOMException('Upload aborted','AbortError')); signal.addEventListener('abort',()=>xhr.abort()); xhr.send(formData); }); }, async uploadFileChunked(file, signal){ var chunkSize=5*1024*1024; var total=Math.ceil(file.size/chunkSize); var init=await (await fetch(this.apiUrl('/api/files/init', this.currentPath),{ method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ filename:file.name, size:file.size }), signal:signal })).json(); if (!init.success) throw new Error(init.message || '初始化失败'); var filename=init.finalFilename || file.name; this.currentMultipart={ filename:filename, uploadId:init.uploadId, path:this.currentPath }; var parts=[]; var uploaded=0; for (var i=0;i<total;i++){ var start=i*chunkSize; var end=Math.min(start+chunkSize,file.size); var chunk=file.slice(start,end); this.upload.status='分片 ' + (i + 1) + ' / ' + total; var form=new FormData(); form.append('file',chunk); form.append('partNumber',i+1); form.append('uploadId',init.uploadId); form.append('filename',filename); var part=await (await fetch(this.apiUrl('/api/files/part', this.currentPath),{ method:'POST', body:form, signal:signal })).json(); if (!part.success) throw new Error(part.message || '分片上传失败'); parts.push({ partNumber:part.partNumber, etag:part.etag }); uploaded += chunk.size; this.upload.percent=Math.round((uploaded/file.size)*98); } this.upload.status='合并文件'; var done=await (await fetch(this.apiUrl('/api/files/complete', this.currentPath),{ method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ filename:filename, uploadId:init.uploadId, parts:parts }), signal:signal })).json(); if (!done.success) throw new Error(done.message || '合并失败'); this.currentMultipart=null; }, async cancelUpload(){ if (this.currentAbort) this.currentAbort.abort(); if (this.currentMultipart) { var pending=this.currentMultipart; this.currentMultipart=null; try { await fetch(this.apiUrl('/api/files/abort', pending.path),{ method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ filename:pending.filename, uploadId:pending.uploadId }) }); } catch(e){} } }, async createFolder(){ var name=this.folderName.trim(); if (!name) return ElementPlus.ElMessage.error('请输入名称'); var path=this.currentPath.endsWith('/') ? this.currentPath + name : this.currentPath + '/' + name; try { var data=await (await fetch('/api/folders',{ method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ path:path }) })).json(); if (!data.success) throw new Error(data.message || '创建失败'); this.folderDialog=false; this.folderName=''; this.loadFiles(); } catch(error){ ElementPlus.ElMessage.error(error.message); } }, showRename(file){ this.renameTarget=file; this.newName=file.name; this.renameDialog=true; }, async renameFile(){ if (!this.renameTarget || !this.newName.trim()) return; try { var data=await (await fetch(this.apiUrl('/api/files', this.renameTarget.path),{ method:'PUT', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ newName:this.newName.trim() }) })).json(); if (!data.success) throw new Error(data.message || '重命名失败'); this.renameDialog=false; this.loadFiles(); } catch(error){ ElementPlus.ElMessage.error(error.message); } }, async deleteItem(item){ try { await ElementPlus.ElMessageBox.confirm('确定删除“' + item.name + '”吗？','删除确认',{ type:'warning' }); var data=await (await fetch(this.apiUrl('/api/files', item.path),{ method:'DELETE' })).json(); if (!data.success) throw new Error(data.message || '删除失败'); this.loadFiles(); } catch(error){ if (error !== 'cancel') ElementPlus.ElMessage.error(error.message || error); } }, showShare(file){ this.shareTarget=file; this.share={ password:'', expiresIn:'1d' }; this.shareDialog=true; }, async createShare(){ try { var body={ filePath:this.shareTarget.path, password:this.share.password, expiresIn:this.share.expiresIn }; var data=await (await fetch('/api/share',{ method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify(body) })).json(); if (!data.success) throw new Error(data.message || '创建失败'); this.shareDialog=false; this.shareResultUrl=window.location.origin + data.shareUrl; this.shareResultDialog=true; } catch(error){ ElementPlus.ElMessage.error(error.message); } }, openFile(file){ if (file.previewType) this.previewFile(file); else this.downloadFile(file.path); }, downloadFile(path){ window.open(this.apiUrl('/api/download', path), '_blank', 'noopener,noreferrer'); }, async previewFile(file){ this.preview={ name:file.name, path:file.path, url:this.apiUrl('/api/preview', file.path), mode:file.previewType, text:'', html:'', loading:true }; this.previewDialog=true; try { if (file.previewType === 'text') { var text=await (await fetch(this.preview.url)).text(); var ext=file.name.split('.').pop().toLowerCase(); if (ext === 'md') { this.preview.mode='html'; this.preview.html=DOMPurify.sanitize(marked.parse(text)); } else { if (ext === 'json') { try { text=JSON.stringify(JSON.parse(text), null, 2); } catch(e) {} } this.preview.text=text; } } else if (file.previewType === 'word') { var buf=await (await fetch(this.preview.url)).arrayBuffer(); var res=await mammoth.convertToHtml({ arrayBuffer:buf }); this.preview.mode='html'; this.preview.html=DOMPurify.sanitize(res.value); } } catch(error){ ElementPlus.ElMessage.error('预览失败: ' + error.message); } finally { this.preview.loading=false; } }, fileIconClass(name){ var lowerName=String(name || '').toLowerCase(); var ext=lowerName.includes('.') ? lowerName.split('.').pop() : lowerName; if (['zip','rar','7z','tar','gz'].includes(ext)) return 'file-type-archive'; if (['exe','msi','apk','deb','rpm','dmg'].includes(ext)) return 'file-type-executable'; if (['doc','docx','pdf','ppt','pptx'].includes(ext)) return 'file-type-document'; if (['xls','xlsx','csv'].includes(ext)) return 'file-type-sheet'; if (['jpg','jpeg','png','gif','svg','webp','bmp','ico','mp3','wav','flac','m4a','mp4','webm','mov','mkv','avi'].includes(ext)) return 'file-type-media'; if (['js','mjs','cjs','ts','jsx','tsx','vue','html','htm','css','scss','sass','less','json','xml','yaml','yml','sh','bash','zsh','ps1','py','java','go','rs','php','rb','c','h','cpp','hpp','cs','sql'].includes(ext) || lowerName === 'dockerfile') return 'file-type-code'; return 'file-type-text'; }, formatDate(value){ return value ? new Date(value).toLocaleDateString('zh-CN') : '-'; } }) });
installCommonApp(app);</script></body></html>`;


// ============================================================================
// MAIN REQUEST HANDLER
// ============================================================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
    if (method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
    
    try {
      if (path === '/logo.png' || path === '/favicon.png' || path === '/favicon.ico') return imageDataUrlResponse(APP_LOGO_DATA_URL);

      if (path.startsWith('/api/')) {
        if (path === '/api/login' && method === 'POST') return await handleLogin(request, env);
        if (path === '/api/logout' && method === 'POST') return await handleLogout();
        if (path === '/api/auth/check') return await handleCheckAuth(request, env);
        
        if (path.startsWith('/api/files/abort')) {
          const filePath = decodeURIComponent(path.slice('/api/files/abort'.length)) || '/';
          if (method === 'POST') return await handleAbortMultipart(request, env, filePath);
        }
        else if (path.startsWith('/api/files/init')) {
          const filePath = decodeURIComponent(path.slice('/api/files/init'.length)) || '/';
          if (method === 'POST') return await handleInitMultipart(request, env, filePath);
        }
        else if (path.startsWith('/api/files/part')) {
          const filePath = decodeURIComponent(path.slice('/api/files/part'.length)) || '/';
          if (method === 'POST') return await handleUploadPart(request, env, filePath);
        }
        else if (path.startsWith('/api/files/complete')) {
          const filePath = decodeURIComponent(path.slice('/api/files/complete'.length)) || '/';
          if (method === 'POST') return await handleCompleteMultipart(request, env, filePath);
        }
        else if (path.startsWith('/api/files')) {
          const filePath = decodeURIComponent(path.slice('/api/files'.length)) || '/';
          if (method === 'GET') return await handleListFiles(request, env, filePath, ctx);
          if (method === 'POST') return await handleUploadFile(request, env, filePath);
          if (method === 'PUT') return await handleRenameFile(request, env, filePath);
          if (method === 'DELETE') return await handleDeleteFile(request, env, filePath);
        }
        
        if (path === '/api/folders' && method === 'POST') return await handleCreateFolder(request, env);
        if (path.startsWith('/api/download')) return await handleDownloadFile(request, env, decodeURIComponent(path.slice('/api/download'.length)));
        if (path.startsWith('/api/preview')) return await handlePreviewFile(request, env, decodeURIComponent(path.slice('/api/preview'.length)));
        if (path === '/api/share' && method === 'POST') return await handleCreateShare(request, env);
        if (path.match(/^\/api\/share\/[^/]+$/) && method === 'GET') return await handleGetShareInfo(request, env, path.split('/').pop());
        if (path.match(/^\/api\/share\/[^/]+\/download$/) && method === 'POST') return await handleShareDownload(request, env, path.split('/')[3]);
        if (path === '/api/admin/stats' && method === 'GET') return await handleGetStats(request, env);
        if (path === '/api/admin/shares' && method === 'GET') return await handleListShares(request, env);
        if (path.match(/^\/api\/admin\/shares\/[^/]+$/) && method === 'DELETE') return await handleDeleteShare(request, env, path.split('/').pop());
        if (path === '/api/admin/users' && method === 'GET') return await handleListUsers(request, env);
        if (path === '/api/admin/users' && method === 'POST') return await handleCreateUser(request, env);
        if (path.match(/^\/api\/admin\/users\/[^/]+$/) && method === 'DELETE') return await handleDeleteUser(request, env, path.split('/').pop());
        
        return jsonResponse({ success: false, message: 'API 路径不存在' }, 404);
      }
      
      if (path.startsWith('/s/')) return htmlResponse(SHARE_PAGE);
      if (path === '/login.html' || path === '/login') return htmlResponse(LOGIN_PAGE);
      if (path === '/admin.html' || path === '/admin') {
        const auth = await verifyAuth(request, env);
        if (!auth || auth.role !== 'admin') return Response.redirect(url.origin + '/login.html', 302);
        return htmlResponse(ADMIN_PAGE);
      }
      if (path === '/' || path === '/index.html') {
        const auth = await verifyAuth(request, env);
        if (!auth) return Response.redirect(url.origin + '/login.html', 302);
        return htmlResponse(INDEX_PAGE);
      }
      return Response.redirect(url.origin + '/', 302);
    } catch (error) {
      console.error('Error:', error);
      return jsonResponse({ success: false, message: '服务器错误: ' + error.message }, 500);
    }
  }
};
