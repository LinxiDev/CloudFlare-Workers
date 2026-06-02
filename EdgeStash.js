/**
 * EdgeStash - Cloudflare-based Cloud Drive
 * Final: 移除 .folder 污染，改用 KV 存储文件夹元数据
 */

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

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

// 迁移旧的 .folder 文件到 KV
async function migrateLegacyFolderFiles(r2, kv) {
  try {
    let cursor;
    const toDelete = [];
    do {
      const listed = await r2.list({ cursor, limit: 100 });
      for (const obj of (listed.objects || [])) {
        if (obj.key.endsWith('/.folder')) {
          // 这是一个旧的 .folder 占位文件
          const folderPath = '/' + obj.key.slice(0, -'/.folder'.length);
          const decoded = safeDecodePath(folderPath);
          await registerFolder(kv, decoded);
          toDelete.push(obj.key);
        }
      }
      cursor = listed.truncated ? listed.cursor : null;
    } while (cursor);
    
    // 批量删除旧的 .folder 文件
    if (toDelete.length > 0) {
      // R2 批量删除每次最多 1000 个
      for (let i = 0; i < toDelete.length; i += 1000) {
        await r2.delete(toDelete.slice(i, i + 1000));
      }
    }
  } catch (e) {
    console.error('Migration error:', e);
  }
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

// ============ 核心修改：handleListFiles（合并 KV 中的文件夹注册）============
async function handleListFiles(request, env, path, ctx) {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;
  try {
    // 首次访问时后台迁移旧的 .folder 文件
    const migrated = await env.KV_STORE.get('system:folderMigrated');
    if (!migrated && ctx) {
      ctx.waitUntil((async () => {
        await migrateLegacyFolderFiles(env.R2_BUCKET, env.KV_STORE);
        await env.KV_STORE.put('system:folderMigrated', '1');
      })());
    }
    
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
    const parentPath = '/' + decodedPrefix.replace(/\/$/, '');
    const kvFolders = await listRegisteredFolders(env.KV_STORE, parentPath);
    for (const f of kvFolders) {
      if (!foldersMap.has(f.name)) {
        foldersMap.set(f.name, f);
      }
    }
    
    if (shouldCheckEncoded && ctx && encodedList && ((encodedList.objects && encodedList.objects.length > 0) || (encodedList.delimitedPrefixes && encodedList.delimitedPrefixes.length > 0))) {
      ctx.waitUntil(migrateToDecoded(env.R2_BUCKET, decodedPrefix, encodedPrefix));
    }
    
    return jsonResponse({ success: true, folders: Array.from(foldersMap.values()), files: Array.from(filesMap.values()), currentPath: '/' + decodedPrefix.replace(/\/$/, '') || '/' });
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
    await env.R2_BUCKET.put(key, file.stream(), { httpMetadata: { contentType: file.type || getMimeType(file.name) } });
    return jsonResponse({ success: true, message: '文件上传成功', path: '/' + key, renamed: fileName !== file.name });
  } catch (e) { return jsonResponse({ success: false, message: '文件上传失败: ' + e.message }, 500); }
}

async function handleInitMultipart(request, env, path) {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;
  try {
    let { filename } = await request.json();
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
    await multipartUpload.complete(parts);
    return jsonResponse({ success: true, message: '文件合并成功', path: '/' + key });
  } catch (e) { return jsonResponse({ success: false, message: '合并文件失败: ' + e.message }, 500); }
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
    await env.R2_BUCKET.put(newKey, oldObject.body, { httpMetadata: oldObject.httpMetadata });
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
    return jsonResponse({ success: true, totalShares, totalViews, totalDownloads });
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

// ============================================================================
// CSS & HTML PAGES (与上一版相同，此处省略)
// ============================================================================

const CSS_STYLES = `
<style>
  :root {
    --bg-primary: #ffffff; --bg-secondary: #f9fafb; --bg-tertiary: #f3f4f6;
    --text-primary: #111827; --text-secondary: #6b7280; --text-tertiary: #9ca3af;
    --accent: #2563eb; --accent-hover: #1d4ed8; --accent-light: rgba(37, 99, 235, 0.1);
    --danger: #ef4444; --danger-hover: #dc2626; --success: #10b981; --warning: #f59e0b;
    --border: #e5e7eb;
    --shadow-sm: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
    --shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
    --shadow-lg: 0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05);
    --radius: 8px; --radius-lg: 12px;
    --transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
    --login-bg: linear-gradient(135deg, #f0f4ff 0%, #faf5ff 100%);
    --header-bg: rgba(255, 255, 255, 0.8);
  }
  [data-theme="dark"] {
    --bg-primary: #1a1f2e; --bg-secondary: #0f1419; --bg-tertiary: #252b3b;
    --text-primary: #f1f5f9; --text-secondary: #94a3b8; --text-tertiary: #64748b;
    --accent: #3b82f6; --accent-hover: #2563eb; --accent-light: rgba(59, 130, 246, 0.15);
    --danger: #ef4444; --danger-hover: #dc2626;
    --border: #2d3548;
    --shadow-sm: 0 1px 2px 0 rgba(0, 0, 0, 0.3);
    --shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.4), 0 2px 4px -1px rgba(0, 0, 0, 0.3);
    --shadow-lg: 0 10px 15px -3px rgba(0, 0, 0, 0.5), 0 4px 6px -2px rgba(0, 0, 0, 0.4);
    --login-bg: linear-gradient(135deg, #0f1419 0%, #1a1f2e 100%);
    --header-bg: rgba(26, 31, 46, 0.85);
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: var(--bg-secondary); color: var(--text-primary); min-height: 100vh; line-height: 1.5; -webkit-font-smoothing: antialiased; transition: background 0.3s, color 0.3s; }
  ::-webkit-scrollbar { width: 8px; height: 8px; } ::-webkit-scrollbar-track { background: transparent; } ::-webkit-scrollbar-thumb { background: var(--text-tertiary); border-radius: 4px; } ::-webkit-scrollbar-thumb:hover { background: var(--text-secondary); }
  .container { max-width: 1280px; margin: 0 auto; padding: 24px; }
  .header { position: sticky; top: 0; z-index: 50; background: var(--header-bg); backdrop-filter: blur(12px); border-bottom: 1px solid var(--border); padding: 0 24px; height: 64px; display: flex; align-items: center; justify-content: space-between; transition: background 0.3s; }
  .logo { font-size: 20px; font-weight: 700; color: var(--text-primary); display: flex; align-items: center; gap: 8px; }
  .logo span { background: linear-gradient(135deg, #2563eb, #7c3aed); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
  .btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 8px 16px; border: 1px solid transparent; border-radius: var(--radius); font-size: 14px; font-weight: 500; cursor: pointer; transition: var(--transition); text-decoration: none; user-select: none; }
  .btn-primary { background: var(--accent); color: white; }
  .btn-primary:hover { background: var(--accent-hover); transform: translateY(-1px); box-shadow: var(--shadow); }
  .btn-secondary { background: var(--bg-primary); color: var(--text-primary); border-color: var(--border); }
  .btn-secondary:hover { background: var(--bg-tertiary); border-color: var(--text-tertiary); }
  .btn-danger { background: var(--danger); color: white; }
  .btn-danger:hover { background: var(--danger-hover); }
  .btn-sm { padding: 6px 10px; font-size: 13px; }
  .btn-ghost { background: transparent; color: var(--text-secondary); padding: 6px 10px; }
  .btn-ghost:hover { background: var(--bg-tertiary); color: var(--text-primary); }
  .btn-icon { width: 36px; height: 36px; padding: 0; border-radius: 50%; font-size: 16px; }
  .form-group { margin-bottom: 16px; }
  .form-label { display: block; margin-bottom: 6px; font-size: 13px; font-weight: 500; color: var(--text-secondary); }
  .form-input, .form-select { width: 100%; padding: 9px 12px; background: var(--bg-primary); border: 1px solid var(--border); border-radius: var(--radius); color: var(--text-primary); font-size: 14px; transition: var(--transition); }
  .form-input:focus, .form-select:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-light); }
  .card { background: var(--bg-primary); border-radius: var(--radius-lg); border: 1px solid var(--border); box-shadow: var(--shadow-sm); overflow: hidden; transition: background 0.3s, border-color 0.3s; }
  .toolbar { display: flex; gap: 12px; margin-bottom: 20px; flex-wrap: wrap; align-items: center; }
  .toolbar-spacer { flex: 1; }
  .sort-select { padding: 7px 12px; background: var(--bg-primary); border: 1px solid var(--border); border-radius: var(--radius); color: var(--text-primary); font-size: 13px; cursor: pointer; transition: var(--transition); }
  .sort-select:hover { border-color: var(--text-tertiary); }
  .breadcrumb { display: flex; align-items: center; gap: 4px; padding: 8px 0; font-size: 14px; color: var(--text-secondary); flex-wrap: wrap; }
  .breadcrumb-item { color: var(--text-secondary); text-decoration: none; padding: 4px 8px; border-radius: 4px; transition: var(--transition); cursor: pointer; }
  .breadcrumb-item:hover { color: var(--accent); background: var(--accent-light); }
  .breadcrumb-item.active { color: var(--text-primary); font-weight: 600; cursor: default; }
  .breadcrumb-item.active:hover { background: transparent; }
  .file-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 16px; padding: 20px; }
  .file-item { background: var(--bg-primary); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 16px; cursor: pointer; transition: var(--transition); position: relative; display: flex; flex-direction: column; align-items: center; text-align: center; user-select: none; }
  .file-item:hover { border-color: var(--accent); box-shadow: var(--shadow); transform: translateY(-2px); }
  .file-item.drag-over { border-color: var(--accent); background: var(--accent-light); transform: scale(1.02); }
  .file-icon-wrapper { width: 48px; height: 48px; display: flex; align-items: center; justify-content: center; margin-bottom: 12px; background: var(--bg-secondary); border-radius: var(--radius); font-size: 24px; }
  .file-name { font-size: 13px; font-weight: 500; color: var(--text-primary); word-break: break-all; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; margin-bottom: 4px; width: 100%; }
  .file-meta { font-size: 11px; color: var(--text-tertiary); }
  .file-actions { position: absolute; top: 8px; right: 8px; display: flex; gap: 4px; opacity: 0; transform: translateY(-4px); transition: var(--transition); background: var(--bg-primary); backdrop-filter: blur(4px); padding: 4px; border-radius: 6px; box-shadow: var(--shadow); border: 1px solid var(--border); }
  .file-item:hover .file-actions { opacity: 1; transform: translateY(0); }
  .action-btn { width: 28px; height: 28px; display: flex; align-items: center; justify-content: center; border: none; background: transparent; border-radius: 4px; cursor: pointer; font-size: 14px; transition: var(--transition); color: var(--text-secondary); }
  .action-btn:hover { background: var(--bg-tertiary); color: var(--text-primary); }
  .action-btn.danger:hover { background: rgba(239, 68, 68, 0.15); color: var(--danger); }
  .table-container { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th { text-align: left; padding: 12px 20px; font-weight: 600; color: var(--text-secondary); font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; background: var(--bg-secondary); border-bottom: 1px solid var(--border); }
  td { padding: 14px 20px; border-bottom: 1px solid var(--border); color: var(--text-primary); }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: var(--bg-secondary); }
  .badge { display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 99px; font-size: 12px; font-weight: 500; }
  .badge-success { background: rgba(16, 185, 129, 0.15); color: var(--success); }
  .badge-warning { background: rgba(245, 158, 11, 0.15); color: var(--warning); }
  .badge-error { background: rgba(239, 68, 68, 0.15); color: var(--danger); }
  .badge-info { background: var(--accent-light); color: var(--accent); }
  .modal-overlay { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.4); backdrop-filter: blur(4px); display: flex; align-items: center; justify-content: center; z-index: 1000; opacity: 0; visibility: hidden; transition: var(--transition); }
  .modal-overlay.active { opacity: 1; visibility: visible; }
  .modal { background: var(--bg-primary); border-radius: var(--radius-lg); padding: 24px; width: 90%; max-width: 440px; box-shadow: var(--shadow-lg); transform: scale(0.95) translateY(10px); transition: var(--transition); border: 1px solid var(--border); }
  .modal-overlay.active .modal { transform: scale(1) translateY(0); }
  .modal-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; }
  .modal-title { font-size: 18px; font-weight: 600; }
  .modal-close { background: none; border: none; font-size: 20px; color: var(--text-tertiary); cursor: pointer; padding: 4px; border-radius: 4px; transition: var(--transition); }
  .modal-close:hover { background: var(--bg-tertiary); color: var(--text-primary); }
  .preview-overlay { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.92); backdrop-filter: blur(8px); display: flex; flex-direction: column; z-index: 2000; opacity: 0; visibility: hidden; transition: var(--transition); }
  .preview-overlay.active { opacity: 1; visibility: visible; }
  .preview-header { display: flex; align-items: center; justify-content: space-between; padding: 16px 24px; border-bottom: 1px solid rgba(255,255,255,0.1); }
  .preview-filename { color: white; font-weight: 500; font-size: 15px; }
  .preview-content { flex: 1; overflow: auto; display: flex; align-items: center; justify-content: center; padding: 24px; }
  .preview-image { max-width: 90%; max-height: 90vh; object-fit: contain; border-radius: 4px; box-shadow: var(--shadow-lg); }
  .preview-text { width: 100%; max-width: 900px; height: 80vh; background: #1e1e1e; color: #d4d4d4; border-radius: var(--radius); padding: 24px; overflow: auto; font-family: 'Menlo', 'Monaco', 'Courier New', monospace; font-size: 13px; line-height: 1.6; white-space: pre-wrap; }
  .preview-pdf, .preview-office { width: 100%; height: 90vh; border: none; border-radius: var(--radius); background: white; }
  .preview-video, .preview-audio { max-width: 100%; max-height: 80vh; border-radius: var(--radius); }
  .preview-markdown { width: 100%; max-width: 800px; background: var(--bg-primary); color: var(--text-primary); border-radius: var(--radius); padding: 40px; overflow: auto; line-height: 1.8; }
  .preview-markdown h1, .preview-markdown h2, .preview-markdown h3 { margin-top: 24px; margin-bottom: 16px; font-weight: 600; }
  .preview-markdown p { margin-bottom: 16px; }
  .preview-markdown code { background: var(--bg-tertiary); padding: 2px 6px; border-radius: 4px; font-family: monospace; font-size: 0.9em; }
  .preview-markdown pre { background: #1e1e1e; color: #d4d4d4; padding: 16px; border-radius: var(--radius); overflow-x: auto; margin-bottom: 16px; }
  .preview-markdown pre code { background: none; padding: 0; color: inherit; }
  .toast-container { position: fixed; top: 24px; right: 24px; z-index: 3000; display: flex; flex-direction: column; gap: 12px; }
  .toast { padding: 12px 16px; border-radius: var(--radius); color: white; font-size: 14px; font-weight: 500; box-shadow: var(--shadow-lg); animation: slideIn 0.3s ease; display: flex; align-items: center; gap: 10px; min-width: 280px; transition: opacity 0.3s; }
  .toast-success { background: var(--success); }
  .toast-error { background: var(--danger); }
  .toast-info { background: var(--accent); }
  @keyframes slideIn { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
  .loading-overlay { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.4); backdrop-filter: blur(2px); display: flex; align-items: center; justify-content: center; z-index: 3000; }
  [data-theme="light"] .loading-overlay { background: rgba(255, 255, 255, 0.7); }
  .spinner { width: 32px; height: 32px; border: 3px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .empty-state { text-align: center; padding: 80px 20px; color: var(--text-tertiary); }
  .empty-icon { font-size: 48px; margin-bottom: 16px; opacity: 0.5; }
  .center-container { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; background: var(--login-bg); transition: background 0.3s; }
  .center-card { background: var(--bg-primary); border-radius: var(--radius-lg); padding: 32px; width: 100%; max-width: 400px; box-shadow: var(--shadow-lg); border: 1px solid var(--border); transition: background 0.3s, border-color 0.3s; }
  .center-header { text-align: center; margin-bottom: 24px; }
  .center-title { font-size: 24px; font-weight: 700; margin-bottom: 8px; }
  .center-subtitle { color: var(--text-secondary); font-size: 14px; }
  .tabs { display: flex; gap: 4px; background: var(--bg-tertiary); padding: 4px; border-radius: var(--radius); margin-bottom: 24px; }
  .tab { flex: 1; padding: 8px; border: none; background: transparent; color: var(--text-secondary); font-size: 14px; font-weight: 500; cursor: pointer; border-radius: 6px; transition: var(--transition); }
  .tab.active { background: var(--bg-primary); color: var(--text-primary); box-shadow: var(--shadow-sm); }
  .tab:hover:not(.active) { color: var(--text-primary); }
  .tab-content { display: none; }
  .tab-content.active { display: block; }
  .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .stat-card { background: var(--bg-primary); border-radius: var(--radius-lg); padding: 20px; border: 1px solid var(--border); text-align: center; transition: background 0.3s, border-color 0.3s; }
  .stat-value { font-size: 32px; font-weight: 700; background: linear-gradient(135deg, #2563eb, #7c3aed); -webkit-background-clip: text; -webkit-text-fill-color: transparent; margin-bottom: 4px; }
  .stat-label { font-size: 13px; color: var(--text-secondary); font-weight: 500; }
  .progress-bar-container { background: var(--bg-tertiary); border-radius: 99px; height: 8px; overflow: hidden; margin-bottom: 12px; }
  .progress-bar { background: linear-gradient(90deg, var(--accent), #7c3aed); height: 100%; width: 0%; transition: width 0.2s ease-out; border-radius: 99px; }
  .context-menu { position: fixed; background: var(--bg-primary); border: 1px solid var(--border); border-radius: var(--radius); padding: 6px; min-width: 180px; box-shadow: var(--shadow-lg); z-index: 1500; display: none; transition: opacity 0.15s; }
  .context-menu.active { display: block; animation: ctxFadeIn 0.15s ease; }
  @keyframes ctxFadeIn { from { opacity: 0; transform: scale(0.95); } to { opacity: 1; transform: scale(1); } }
  .context-menu-item { padding: 8px 12px; cursor: pointer; display: flex; align-items: center; gap: 10px; border-radius: 6px; font-size: 13px; color: var(--text-primary); transition: background 0.15s; }
  .context-menu-item:hover { background: var(--bg-tertiary); }
  .context-menu-item.danger { color: var(--danger); }
  .context-menu-item.danger:hover { background: rgba(239, 68, 68, 0.1); }
  .context-menu-divider { height: 1px; background: var(--border); margin: 4px 0; }
  .context-menu-item .ctx-icon { width: 18px; text-align: center; font-size: 14px; }
  .context-menu-item .ctx-label { flex: 1; }
  .theme-toggle { cursor: pointer; transition: var(--transition); font-size: 18px; }
  .theme-toggle:hover { transform: rotate(15deg); }
  @media (max-width: 640px) {
    .file-grid { grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 12px; padding: 12px; }
    .header { padding: 0 16px; }
    .container { padding: 16px; }
    .file-actions { opacity: 1; transform: translateY(0); }
    .toolbar { gap: 8px; }
    .toolbar-spacer { display: none; }
  }
</style>
`;

const LOGIN_PAGE = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>登录 - EdgeStash</title>${CSS_STYLES}
<script>(function(){const t=localStorage.getItem('edgestash-theme');if(t)document.documentElement.setAttribute('data-theme',t);else if(window.matchMedia('(prefers-color-scheme: dark)').matches)document.documentElement.setAttribute('data-theme','dark');})();</script>
</head><body>
  <div style="position:absolute;top:16px;right:16px;"><button class="btn btn-icon btn-ghost theme-toggle" onclick="toggleTheme()" id="themeToggle" title="切换主题">🌓</button></div>
  <div class="center-container"><div class="center-card"><div class="center-header"><div class="center-title">EdgeStash</div><div class="center-subtitle">安全、高效的云端存储服务</div></div>
    <div class="tabs"><button class="tab active" onclick="switchLoginTab('admin')">管理员</button><button class="tab" onclick="switchLoginTab('user')">授权用户</button></div>
    <form id="loginForm" onsubmit="handleLogin(event)"><div id="emailField" class="form-group" style="display: none;"><label class="form-label">邮箱地址</label><input type="email" id="email" class="form-input" placeholder="name@example.com"></div>
      <div class="form-group"><label class="form-label">密码</label><input type="password" id="password" class="form-input" placeholder="请输入密码" required></div>
      <button type="submit" class="btn btn-primary" style="width: 100%; margin-top: 8px;">安全登录</button></form></div></div>
  <div class="toast-container" id="toastContainer"></div>
  <script>
    updateThemeIcon();
    function toggleTheme(){const cur=document.documentElement.getAttribute('data-theme')||'light';const next=cur==='dark'?'light':'dark';document.documentElement.setAttribute('data-theme',next);localStorage.setItem('edgestash-theme',next);updateThemeIcon();}
    function updateThemeIcon(){const t=document.documentElement.getAttribute('data-theme')||'light';const btn=document.getElementById('themeToggle');if(btn)btn.textContent=t==='dark'?'☀️':'🌙';}
    let isAdminLogin = true;
    function switchLoginTab(type) { isAdminLogin = type === 'admin'; document.querySelectorAll('.tab').forEach((tab, index) => { tab.classList.toggle('active', (index === 0 && isAdminLogin) || (index === 1 && !isAdminLogin)); }); document.getElementById('emailField').style.display = isAdminLogin ? 'none' : 'block'; }
    async function handleLogin(e) { e.preventDefault(); const password = document.getElementById('password').value; const email = document.getElementById('email').value; try { const response = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ isAdmin: isAdminLogin, email: isAdminLogin ? undefined : email, password }) }); const data = await response.json(); if (data.success) { showToast('登录成功，正在跳转...', 'success'); setTimeout(() => { window.location.href = '/'; }, 600); } else { showToast(data.message || '登录失败', 'error'); } } catch (error) { showToast('网络错误: ' + error.message, 'error'); } }
    function showToast(message, type = 'info') { const container = document.getElementById('toastContainer'); const toast = document.createElement('div'); const icon = type === 'success' ? '✅' : type === 'error' ? '❌' : 'ℹ️'; toast.className = 'toast toast-' + type; toast.innerHTML = '<span>' + icon + '</span><span>' + message + '</span>'; container.appendChild(toast); setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, 3000); }
  </script></body></html>`;

const ADMIN_PAGE = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>管理后台 - EdgeStash</title>${CSS_STYLES}
<script>(function(){const t=localStorage.getItem('edgestash-theme');if(t)document.documentElement.setAttribute('data-theme',t);else if(window.matchMedia('(prefers-color-scheme: dark)').matches)document.documentElement.setAttribute('data-theme','dark');})();</script>
</head><body>
  <div class="header"><div class="logo">⚙️ <span>EdgeStash 管理后台</span></div><div style="display: flex; gap: 8px; align-items:center;"><button class="btn btn-icon btn-ghost theme-toggle" onclick="toggleTheme()" id="themeToggle" title="切换主题">🌓</button><button class="btn btn-secondary btn-sm" onclick="window.location.href='/'">📁 返回云盘</button><button class="btn btn-ghost btn-sm" onclick="logout()">退出</button></div></div>
  <div class="container"><div class="tabs"><button class="tab active" onclick="switchTab('stats',this)">📊 统计数据</button><button class="tab" onclick="switchTab('shares',this)">🔗 分享链接</button><button class="tab" onclick="switchTab('users',this)">👥 授权用户</button></div>
    <div id="statsTab" class="tab-content active"><div class="stats-grid"><div class="stat-card"><div class="stat-value" id="totalShares">0</div><div class="stat-label">总分享链接数</div></div><div class="stat-card"><div class="stat-value" id="totalViews">0</div><div class="stat-label">总浏览次数</div></div><div class="stat-card"><div class="stat-value" id="totalDownloads">0</div><div class="stat-label">总下载次数</div></div></div></div>
    <div id="sharesTab" class="tab-content"><div class="card" style="padding:0;"><div style="padding: 16px 20px; border-bottom: 1px solid var(--border); font-size: 15px; font-weight: 600;">分享链接管理</div><div class="table-container"><table><thead><tr><th>文件名</th><th>分享 ID</th><th>密码</th><th>浏览/下载</th><th>状态</th><th>操作</th></tr></thead><tbody id="sharesTable"></tbody></table></div></div></div>
    <div id="usersTab" class="tab-content"><div class="card" style="padding:0;"><div style="padding: 16px 20px; border-bottom: 1px solid var(--border); font-size: 15px; font-weight: 600; display:flex; justify-content:space-between; align-items:center;">授权用户管理<button class="btn btn-primary btn-sm" onclick="showAddUserModal()">+ 添加用户</button></div><div class="table-container"><table><thead><tr><th>邮箱</th><th>角色</th><th>创建时间</th><th>操作</th></tr></thead><tbody id="usersTable"></tbody></table></div></div></div>
  </div>
  <div class="modal-overlay" id="addUserModal"><div class="modal"><div class="modal-header"><div class="modal-title">添加授权用户</div><button class="modal-close" onclick="closeModal('addUserModal')">&times;</button></div><form onsubmit="addUser(event)"><div class="form-group"><label class="form-label">邮箱地址</label><input type="email" id="newUserEmail" class="form-input" placeholder="name@example.com" required></div><div class="form-group"><label class="form-label">初始密码</label><input type="text" id="newUserPassword" class="form-input" placeholder="请输入密码" required></div><button type="submit" class="btn btn-primary" style="width: 100%;">确认添加</button></form></div></div>
  <div class="toast-container" id="toastContainer"></div><div class="loading-overlay" id="loadingOverlay" style="display: none;"><div class="spinner"></div></div>
  <script>
    updateThemeIcon();
    function toggleTheme(){const cur=document.documentElement.getAttribute('data-theme')||'light';const next=cur==='dark'?'light':'dark';document.documentElement.setAttribute('data-theme',next);localStorage.setItem('edgestash-theme',next);updateThemeIcon();}
    function updateThemeIcon(){const t=document.documentElement.getAttribute('data-theme')||'light';const btn=document.getElementById('themeToggle');if(btn)btn.textContent=t==='dark'?'☀️':'🌙';}
    async function checkAdminAuth() { try { const response = await fetch('/api/auth/check'); const data = await response.json(); if (!data.authenticated || data.role !== 'admin') window.location.href = '/login.html'; } catch (error) { window.location.href = '/login.html'; } }
    function switchTab(tab,el) { document.querySelectorAll('.tab').forEach(t => t.classList.remove('active')); document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active')); el.classList.add('active'); document.getElementById(tab + 'Tab').classList.add('active'); if (tab === 'stats') loadStats(); else if (tab === 'shares') loadShares(); else if (tab === 'users') loadUsers(); }
    async function loadStats() { try { const response = await fetch('/api/admin/stats'); const data = await response.json(); if (data.success) { document.getElementById('totalShares').textContent = data.totalShares; document.getElementById('totalViews').textContent = data.totalViews; document.getElementById('totalDownloads').textContent = data.totalDownloads; } } catch (error) { showToast('加载失败', 'error'); } }
    async function loadShares() { showLoading(true); try { const response = await fetch('/api/admin/shares'); const data = await response.json(); if (data.success) { const tbody = document.getElementById('sharesTable'); if (data.shares.length === 0) { tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-tertiary); padding: 40px;">暂无分享链接</td></tr>'; return; } tbody.innerHTML = data.shares.map(share => \`<tr><td style="font-weight: 500;">\${escapeHtml(share.fileName)}</td><td><code style="background: var(--bg-tertiary); padding: 2px 6px; border-radius: 4px; font-size: 12px;">\${share.shareId}</code></td><td>\${share.passwordHash ? '<span class="badge badge-warning">是</span>' : '<span class="badge badge-info">否</span>'}</td><td>\${share.viewCount} / \${share.downloadCount}</td><td>\${share.isExpired ? '<span class="badge badge-error">已过期</span>' : '<span class="badge badge-success">有效</span>'}</td><td><button class="btn btn-secondary btn-sm" onclick="copyShareLink('\${share.shareId}')">复制</button> <button class="btn btn-danger btn-sm" onclick="deleteShare('\${share.shareId}')">删除</button></td></tr>\`).join(''); } } catch (error) { showToast('加载失败', 'error'); } finally { showLoading(false); } }
    async function loadUsers() { showLoading(true); try { const response = await fetch('/api/admin/users'); const data = await response.json(); if (data.success) { const tbody = document.getElementById('usersTable'); if (data.users.length === 0) { tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-tertiary); padding: 40px;">暂无授权用户</td></tr>'; return; } tbody.innerHTML = data.users.map(user => \`<tr><td style="font-weight: 500;">\${escapeHtml(user.email)}</td><td>\${user.role === 'admin' ? '<span class="badge badge-error">管理员</span>' : '<span class="badge badge-info">普通用户</span>'}</td><td style="color: var(--text-secondary); font-size: 13px;">\${user.createdAt ? new Date(user.createdAt).toLocaleString() : '-'}</td><td><button class="btn btn-danger btn-sm" onclick="deleteUser('\${encodeURIComponent(user.email)}')">撤销授权</button></td></tr>\`).join(''); } } catch (error) { showToast('加载失败', 'error'); } finally { showLoading(false); } }
    function showAddUserModal() { document.getElementById('newUserEmail').value = ''; document.getElementById('newUserPassword').value = ''; document.getElementById('addUserModal').classList.add('active'); }
    async function addUser(event) { event.preventDefault(); const email = document.getElementById('newUserEmail').value; const password = document.getElementById('newUserPassword').value; closeModal('addUserModal'); showLoading(true); try { const response = await fetch('/api/admin/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) }); const data = await response.json(); showToast(data.success ? '添加成功' : '失败: ' + data.message, data.success ? 'success' : 'error'); if (data.success) loadUsers(); } catch (error) { showToast('失败: ' + error.message, 'error'); } finally { showLoading(false); } }
    async function deleteUser(email) { if (!confirm('确定要撤销该用户的授权吗？')) return; showLoading(true); try { const response = await fetch('/api/admin/users/' + email, { method: 'DELETE' }); const data = await response.json(); showToast(data.success ? '已删除' : '失败: ' + data.message, data.success ? 'success' : 'error'); if (data.success) loadUsers(); } catch (error) { showToast('失败: ' + error.message, 'error'); } finally { showLoading(false); } }
    async function deleteShare(shareId) { if (!confirm('确定要删除该分享链接吗？')) return; showLoading(true); try { const response = await fetch('/api/admin/shares/' + shareId, { method: 'DELETE' }); const data = await response.json(); showToast(data.success ? '已删除' : '失败: ' + data.message, data.success ? 'success' : 'error'); if (data.success) loadShares(); } catch (error) { showToast('失败: ' + error.message, 'error'); } finally { showLoading(false); } }
    function copyShareLink(shareId) { navigator.clipboard.writeText(window.location.origin + '/s/' + shareId).then(() => showToast('链接已复制', 'success')).catch(() => showToast('复制失败', 'error')); }
    async function logout() { await fetch('/api/logout', { method: 'POST' }); window.location.href = '/login.html'; }
    function closeModal(id) { document.getElementById(id).classList.remove('active'); }
    function showLoading(show) { document.getElementById('loadingOverlay').style.display = show ? 'flex' : 'none'; }
    function showToast(message, type = 'info') { const container = document.getElementById('toastContainer'); const toast = document.createElement('div'); const icon = type === 'success' ? '✅' : type === 'error' ? '❌' : 'ℹ️'; toast.className = 'toast toast-' + type; toast.innerHTML = '<span>' + icon + '</span><span>' + message + '</span>'; container.appendChild(toast); setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, 3000); }
    function escapeHtml(text) { const div = document.createElement('div'); div.textContent = text; return div.innerHTML; }
    checkAdminAuth(); loadStats();
  </script></body></html>`;

const SHARE_PAGE = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>文件分享 - EdgeStash</title>${CSS_STYLES}
<script>(function(){const t=localStorage.getItem('edgestash-theme');if(t)document.documentElement.setAttribute('data-theme',t);else if(window.matchMedia('(prefers-color-scheme: dark)').matches)document.documentElement.setAttribute('data-theme','dark');})();</script>
</head><body>
  <div class="center-container"><div class="center-card" id="shareCard" style="text-align: center;">
    <div id="loadingState"><div class="spinner" style="margin: 0 auto 16px;"></div><div style="color: var(--text-secondary);">验证分享链接中...</div></div>
    <div id="expiredState" style="display: none;"><div style="font-size: 48px; margin-bottom: 16px;">⚠️</div><div style="font-size: 18px; font-weight: 600; color: var(--danger); margin-bottom: 8px;">链接已过期或不存在</div><p style="color: var(--text-secondary); font-size: 14px;">请联系分享者获取新的有效链接</p></div>
    <div id="shareContent" style="display: none;"><div style="font-size: 48px; margin-bottom: 16px;">📄</div><div style="font-size: 18px; font-weight: 600; margin-bottom: 8px; word-break: break-all;" id="fileName"></div><div style="color: var(--text-secondary); font-size: 14px; margin-bottom: 24px;" id="fileSize"></div>
      <div id="passwordForm" style="display: none; text-align: left; margin-bottom: 20px;"><label class="form-label">此分享受密码保护</label><input type="password" id="sharePassword" class="form-input" placeholder="请输入分享密码"></div>
      <button class="btn btn-primary" style="width: 100%;" onclick="downloadFile()">⬇️ 立即下载</button></div>
  </div></div>
  <div class="toast-container" id="toastContainer"></div>
  <script>
    let shareId = ''; let requiresPassword = false;
    async function loadShareInfo() { const pathParts = window.location.pathname.split('/'); shareId = pathParts[pathParts.length - 1]; if (!shareId) { showExpired(); return; } try { const response = await fetch('/api/share/' + shareId); const data = await response.json(); if (!data.success) { showExpired(); return; } document.getElementById('loadingState').style.display = 'none'; document.getElementById('shareContent').style.display = 'block'; document.getElementById('fileName').textContent = data.fileName; document.getElementById('fileSize').textContent = data.fileSizeFormatted; requiresPassword = data.requiresPassword; if (requiresPassword) document.getElementById('passwordForm').style.display = 'block'; } catch (error) { showExpired(); } }
    function showExpired() { document.getElementById('loadingState').style.display = 'none'; document.getElementById('expiredState').style.display = 'block'; }
    async function downloadFile() { const password = document.getElementById('sharePassword')?.value || ''; if (requiresPassword && !password) { showToast('请输入分享密码', 'error'); return; } try { const response = await fetch('/api/share/' + shareId + '/download', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) }); if (response.ok) { const contentDisposition = response.headers.get('Content-Disposition'); let filename = 'download'; if (contentDisposition) { const match = contentDisposition.match(/filename\\*?=(?:UTF-8'')?["']?([^"';\\n]+)/i); if (match) filename = decodeURIComponent(match[1]); } const blob = await response.blob(); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url); showToast('下载已开始', 'success'); } else { const data = await response.json(); showToast(data.message || '下载失败', 'error'); } } catch (error) { showToast('下载失败: ' + error.message, 'error'); } }
    function showToast(message, type = 'info') { const container = document.getElementById('toastContainer'); const toast = document.createElement('div'); const icon = type === 'success' ? '✅' : type === 'error' ? '❌' : 'ℹ️'; toast.className = 'toast toast-' + type; toast.innerHTML = '<span>' + icon + '</span><span>' + message + '</span>'; container.appendChild(toast); setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, 3000); }
    loadShareInfo();
  </script></body></html>`;

const INDEX_PAGE = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>EdgeStash 云盘</title>${CSS_STYLES}
<script>(function(){const t=localStorage.getItem('edgestash-theme');if(t)document.documentElement.setAttribute('data-theme',t);else if(window.matchMedia('(prefers-color-scheme: dark)').matches)document.documentElement.setAttribute('data-theme','dark');})();</script>
<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script><script src="https://cdn.jsdelivr.net/npm/mammoth@1.6.0/mammoth.browser.min.js"></script></head><body>
  <div class="header">
    <div class="logo">📦 <span>EdgeStash</span></div>
    <div style="display: flex; gap: 8px; align-items: center;">
      <button class="btn btn-icon btn-ghost theme-toggle" onclick="toggleTheme()" id="themeToggle" title="切换主题">🌓</button>
      <button class="btn btn-secondary btn-sm" onclick="window.location.href='/admin.html'">⚙️ 管理后台</button>
      <button class="btn btn-ghost btn-sm" onclick="logout()">退出</button>
    </div>
  </div>
  <div class="container">
    <div class="breadcrumb" id="breadcrumb"></div>
    <div class="toolbar">
      <button class="btn btn-primary" onclick="showNewFolderModal()">📁 新建文件夹</button>
      <button class="btn btn-secondary" onclick="document.getElementById('fileInput').click()">⬆️ 上传文件</button>
      <input type="file" id="fileInput" multiple style="display: none;" onchange="handleFileUpload(event)">
      <div class="toolbar-spacer"></div>
      <select id="sortSelect" class="sort-select" onchange="applySort()">
        <option value="name-asc">名称 A→Z</option>
        <option value="name-desc">名称 Z→A</option>
        <option value="size-desc">大小 ↓</option>
        <option value="size-asc">大小 ↑</option>
        <option value="time-desc">最新上传</option>
        <option value="time-asc">最旧上传</option>
      </select>
    </div>
    <div class="card" id="dropZone">
      <div id="fileList" class="file-grid"></div>
      <div id="emptyState" class="empty-state" style="display: none;">
        <div class="empty-icon">📂</div>
        <div style="font-size: 15px; font-weight: 500; margin-bottom: 4px;">此文件夹为空</div>
        <div style="font-size: 13px;">点击右上角上传、新建文件夹，或直接将文件拖拽到此处</div>
      </div>
    </div>
  </div>
  
  <div id="contextMenu" class="context-menu"></div>
  
  <div class="modal-overlay" id="uploadProgressModal"><div class="modal" style="max-width: 420px;"><div class="modal-header"><div class="modal-title">📤 正在上传</div><button class="modal-close" onclick="closeUploadModal()" id="closeUploadModalBtn" style="display:none;">&times;</button></div>
    <div style="margin-bottom: 8px; display: flex; justify-content: space-between; font-size: 14px; font-weight: 500; color: var(--text-primary);"><span id="uploadFileName" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 75%;" title=""></span><span id="uploadProgressText">0%</span></div>
    <div class="progress-bar-container"><div id="uploadProgressBar" class="progress-bar"></div></div>
    <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 8px;"><div style="font-size: 12px; color: var(--text-tertiary);" id="uploadStatusText">准备上传...</div><button id="cancelUploadBtn" class="btn btn-danger btn-sm" onclick="cancelUpload()" style="display: none;">取消</button></div>
  </div></div>

  <div class="modal-overlay" id="newFolderModal"><div class="modal"><div class="modal-header"><div class="modal-title">新建文件夹</div><button class="modal-close" onclick="closeModal('newFolderModal')">&times;</button></div><form onsubmit="createFolder(event)"><div class="form-group"><label class="form-label">文件夹名称</label><input type="text" id="folderName" class="form-input" placeholder="请输入名称" required></div><button type="submit" class="btn btn-primary" style="width: 100%;">创建</button></form></div></div>
  <div class="modal-overlay" id="renameModal"><div class="modal"><div class="modal-header"><div class="modal-title">重命名</div><button class="modal-close" onclick="closeModal('renameModal')">&times;</button></div><form onsubmit="renameFile(event)"><div class="form-group"><label class="form-label">新名称</label><input type="text" id="newFileName" class="form-input" required></div><input type="hidden" id="renameFilePath"><button type="submit" class="btn btn-primary" style="width: 100%;">确认修改</button></form></div></div>
  <div class="modal-overlay" id="shareModal"><div class="modal"><div class="modal-header"><div class="modal-title">创建分享链接</div><button class="modal-close" onclick="closeModal('shareModal')">&times;</button></div><form onsubmit="createShare(event)"><div class="form-group"><label class="form-label">分享密码 (留空则公开)</label><input type="text" id="sharePassword" class="form-input" placeholder="可选"></div><div class="form-group"><label class="form-label">有效期</label><select id="shareExpiry" class="form-select"><option value="1h">1 小时</option><option value="1d" selected>1 天</option><option value="1m">1 个月</option><option value="permanent">永久有效</option></select></div><input type="hidden" id="shareFilePath"><button type="submit" class="btn btn-primary" style="width: 100%;">生成链接</button></form></div></div>
  <div class="modal-overlay" id="shareResultModal"><div class="modal"><div class="modal-header"><div class="modal-title">分享已创建</div><button class="modal-close" onclick="closeModal('shareResultModal')">&times;</button></div><div class="form-group"><label class="form-label">分享链接</label><input type="text" id="shareResultUrl" class="form-input" readonly style="font-family: monospace; font-size: 13px;"></div><button class="btn btn-primary" style="width: 100%;" onclick="copyShareLink()">📋 复制链接</button></div></div>
  <div class="preview-overlay" id="previewOverlay"><div class="preview-header"><div class="preview-filename" id="previewFilename"></div><div style="display: flex; gap: 8px;"><button class="btn btn-secondary btn-sm" id="previewDownloadBtn">⬇️ 下载</button><button class="btn btn-ghost btn-sm" style="color: white;" onclick="closePreview()">✕ 关闭</button></div></div><div class="preview-content" id="previewContent"><div class="spinner"></div></div></div>
  <div class="toast-container" id="toastContainer"></div><div class="loading-overlay" id="loadingOverlay" style="display: none;"><div class="spinner"></div></div>
  
  <script>
    let currentPath = '/';
    const CHUNK_SIZE = 5 * 1024 * 1024;
    let currentUploadAbortController = null;
    let currentFilesData = { folders: [], files: [] };
    let currentSort = localStorage.getItem('edgestash-sort') || 'name-asc';
    
    function toggleTheme(){const cur=document.documentElement.getAttribute('data-theme')||'light';const next=cur==='dark'?'light':'dark';document.documentElement.setAttribute('data-theme',next);localStorage.setItem('edgestash-theme',next);updateThemeIcon();}
    function updateThemeIcon(){const t=document.documentElement.getAttribute('data-theme')||'light';const btn=document.getElementById('themeToggle');if(btn)btn.textContent=t==='dark'?'☀️':'🌙';}
    updateThemeIcon();
    
    function escapeJs(str) { if (typeof str !== 'string') return ''; return str.replace(/\\\\/g, '\\\\\\\\').replace(/'/g, "\\\\'").replace(/"/g, '\\\\"').replace(/\\n/g, '\\\\n').replace(/\\r/g, '\\\\r'); }
    function escapeHtml(text) { const div = document.createElement('div'); div.textContent = text; return div.innerHTML; }
    
    async function checkAuth() { try { const response = await fetch('/api/auth/check'); const data = await response.json(); if (!data.authenticated) window.location.href = '/login.html'; } catch (error) { window.location.href = '/login.html'; } }
    
    async function loadFiles() {
      showLoading(true);
      try {
        const response = await fetch('/api/files' + currentPath);
        const data = await response.json();
        if (!data.success) { if (response.status === 401) { window.location.href = '/login.html'; return; } throw new Error(data.message); }
        currentFilesData = { folders: data.folders || [], files: data.files || [] };
        renderBreadcrumb();
        applySort();
      } catch (error) { showToast('加载失败: ' + error.message, 'error'); }
      finally { showLoading(false); }
    }
    
    function applySort() {
      const sortValue = document.getElementById('sortSelect').value;
      currentSort = sortValue;
      localStorage.setItem('edgestash-sort', sortValue);
      const [field, dir] = sortValue.split('-');
      const mul = dir === 'asc' ? 1 : -1;
      const sortedFolders = [...currentFilesData.folders].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN') * mul);
      const sortedFiles = [...currentFilesData.files].sort((a, b) => {
        if (field === 'name') return a.name.localeCompare(b.name, 'zh-CN') * mul;
        if (field === 'size') return (a.size - b.size) * mul;
        if (field === 'time') return (new Date(a.lastModified) - new Date(b.lastModified)) * mul;
        return 0;
      });
      renderFiles(sortedFolders, sortedFiles);
    }
    
    document.addEventListener('DOMContentLoaded', () => {
      const sel = document.getElementById('sortSelect');
      if (sel) sel.value = currentSort;
    });
    
    function renderBreadcrumb() {
      const breadcrumb = document.getElementById('breadcrumb');
      const parts = currentPath.split('/').filter(p => p);
      let html = '<a class="breadcrumb-item" onclick="navigateTo(\\'/\\')">🏠 首页</a>';
      let path = '';
      parts.forEach((part, index) => {
        path += '/' + part;
        const isLast = index === parts.length - 1;
        html += '<span style="color: var(--text-tertiary);">/</span>';
        if (isLast) html += '<span class="breadcrumb-item active">' + escapeHtml(part) + '</span>';
        else html += '<a class="breadcrumb-item" onclick="navigateTo(\\'' + escapeJs(path) + '\\')">' + escapeHtml(part) + '</a>';
      });
      breadcrumb.innerHTML = html;
    }
    
    function renderFiles(folders, files) {
      const fileList = document.getElementById('fileList');
      const emptyState = document.getElementById('emptyState');
      if (folders.length === 0 && files.length === 0) { fileList.innerHTML = ''; emptyState.style.display = 'block'; return; }
      emptyState.style.display = 'none';
      let html = '';
      folders.forEach(folder => {
        html += \`<div class="file-item" data-type="folder" data-path="\${escapeHtml(folder.path)}" data-name="\${escapeHtml(folder.name)}" ondblclick="navigateTo('\${escapeJs(folder.path)}')" oncontextmenu="showContextMenu(event, 'folder', '\${escapeJs(folder.path)}', '\${escapeJs(folder.name)}')"><div class="file-actions"><button class="action-btn" title="重命名" onclick="event.stopPropagation(); showRenameModal('\${escapeJs(folder.path)}', '\${escapeJs(folder.name)}')">✏️</button><button class="action-btn danger" title="删除" onclick="event.stopPropagation(); deleteFile('\${escapeJs(folder.path)}')">🗑️</button></div><div class="file-icon-wrapper">📁</div><div class="file-name" title="\${escapeHtml(folder.name)}">\${escapeHtml(folder.name)}</div><div class="file-meta">文件夹</div></div>\`;
      });
      files.forEach(file => {
        const icon = getFileIcon(file.name);
        const previewType = file.previewType || '';
        const timeDisplay = file.lastModified ? new Date(file.lastModified).toLocaleDateString('zh-CN') : '';
        html += \`<div class="file-item" data-type="file" data-path="\${escapeHtml(file.path)}" data-name="\${escapeHtml(file.name)}" data-previewable="\${previewType}" ondblclick="handleFileClick('\${escapeJs(file.path)}', '\${escapeJs(previewType)}', '\${escapeJs(file.name)}')" oncontextmenu="showContextMenu(event, 'file', '\${escapeJs(file.path)}', '\${escapeJs(file.name)}', '\${escapeJs(previewType)}')"><div class="file-actions">\${previewType ? '<button class="action-btn" title="预览" onclick="event.stopPropagation(); previewFile(\\'' + escapeJs(file.path) + '\\', \\'' + escapeJs(previewType) + '\\', \\'' + escapeJs(file.name) + '\\')">👁️</button>' : ''}<button class="action-btn" title="分享" onclick="event.stopPropagation(); showShareModal('\${escapeJs(file.path)}')">🔗</button><button class="action-btn" title="重命名" onclick="event.stopPropagation(); showRenameModal('\${escapeJs(file.path)}', '\${escapeJs(file.name)}')">✏️</button><button class="action-btn danger" title="删除" onclick="event.stopPropagation(); deleteFile('\${escapeJs(file.path)}')">🗑️</button></div><div class="file-icon-wrapper">\${icon}</div><div class="file-name" title="\${escapeHtml(file.name)}">\${escapeHtml(file.name)}</div><div class="file-meta">\${file.sizeFormatted} · \${timeDisplay}</div></div>\`;
      });
      fileList.innerHTML = html;
    }
    
    function handleFileClick(path, previewType, filename) {
      if (previewType) previewFile(path, previewType, filename);
      else downloadFile(path);
    }
    
    function getFileIcon(filename) {
      const ext = filename.split('.').pop().toLowerCase();
      const icons = { 'pdf': '📕', 'doc': '📘', 'docx': '📘', 'xls': '📗', 'xlsx': '📗', 'ppt': '📙', 'pptx': '📙', 'jpg': '🖼️', 'jpeg': '🖼️', 'png': '🖼️', 'gif': '🖼️', 'svg': '🖼️', 'webp': '🖼️', 'mp3': '🎵', 'wav': '🎵', 'flac': '🎵', 'mp4': '🎬', 'avi': '🎬', 'mkv': '🎬', 'zip': '📦', 'rar': '📦', '7z': '📦', 'tar': '📦', 'gz': '📦', 'js': '📜', 'ts': '📜', 'py': '📜', 'java': '📜', 'cpp': '📜', 'c': '📜', 'html': '🌐', 'css': '🎨', 'json': '📋', 'txt': '📄', 'md': '📝' };
      return icons[ext] || '📄';
    }
    
    function navigateTo(path) { currentPath = path; loadFiles(); }
    
    async function previewFile(path, previewType, filename) {
      const overlay = document.getElementById('previewOverlay');
      const content = document.getElementById('previewContent');
      document.getElementById('previewFilename').textContent = filename;
      document.getElementById('previewDownloadBtn').onclick = () => downloadFile(path);
      content.innerHTML = '<div class="spinner"></div>';
      overlay.classList.add('active');
      try {
        const previewUrl = '/api/preview' + path;
        switch (previewType) {
          case 'image': content.innerHTML = '<img class="preview-image" src="' + previewUrl + '" alt="' + escapeHtml(filename) + '">'; break;
          case 'pdf': content.innerHTML = '<iframe class="preview-pdf" src="' + previewUrl + '"></iframe>'; break;
          case 'text':
            const textResponse = await fetch(previewUrl);
            const text = await textResponse.text();
            const ext = filename.split('.').pop().toLowerCase();
            if (ext === 'md') content.innerHTML = '<div class="preview-markdown">' + marked.parse(text) + '</div>';
            else if (ext === 'json') { try { content.innerHTML = '<pre class="preview-text">' + escapeHtml(JSON.stringify(JSON.parse(text), null, 2)) + '</pre>'; } catch { content.innerHTML = '<pre class="preview-text">' + escapeHtml(text) + '</pre>'; } }
            else { content.innerHTML = '<pre class="preview-text">' + escapeHtml(text) + '</pre>'; }
            break;
          case 'video': content.innerHTML = '<video class="preview-video" controls autoplay><source src="' + previewUrl + '"></video>'; break;
          case 'audio': content.innerHTML = '<audio class="preview-audio" controls autoplay><source src="' + previewUrl + '"></audio>'; break;
          case 'word':
            const docxResponse = await fetch(previewUrl);
            const result = await mammoth.convertToHtml({ arrayBuffer: await docxResponse.arrayBuffer() });
            content.innerHTML = '<div class="preview-markdown">' + result.value + '</div>';
            break;
          default: content.innerHTML = '<div style="color: white;">不支持预览此文件类型</div>';
        }
      } catch (error) { content.innerHTML = '<div style="color: #ef4444;">预览加载失败: ' + escapeHtml(error.message) + '</div>'; }
    }
    
    function closePreview() { document.getElementById('previewOverlay').classList.remove('active'); setTimeout(() => { document.getElementById('previewContent').innerHTML = ''; }, 300); }
    
    const contextMenu = document.getElementById('contextMenu');
    let longPressTimer = null;
    
    function showContextMenu(e, type, path, name, previewType) {
      e.preventDefault();
      e.stopPropagation();
      hideContextMenu();
      let items = [];
      if (type === 'folder') {
        items = [
          { icon: '📂', label: '打开', action: () => navigateTo(path) },
          { icon: '✏️', label: '重命名', action: () => showRenameModal(path, name) },
          { divider: true },
          { icon: '🗑️', label: '删除', cls: 'danger', action: () => deleteFile(path) }
        ];
      } else {
        if (previewType) items.push({ icon: '👁️', label: '预览', action: () => previewFile(path, previewType, name) });
        items.push({ icon: '⬇️', label: '下载', action: () => downloadFile(path) });
        items.push({ icon: '🔗', label: '分享', action: () => showShareModal(path) });
        items.push({ icon: '📋', label: '复制链接', action: () => copyDownloadLink(path) });
        items.push({ divider: true });
        items.push({ icon: '✏️', label: '重命名', action: () => showRenameModal(path, name) });
        items.push({ icon: '🗑️', label: '删除', cls: 'danger', action: () => deleteFile(path) });
      }
      let html = '';
      items.forEach(item => {
        if (item.divider) { html += '<div class="context-menu-divider"></div>'; return; }
        html += \`<div class="context-menu-item \${item.cls||''}" data-idx="\${items.indexOf(item)}"><span class="ctx-icon">\${item.icon}</span><span class="ctx-label">\${item.label}</span></div>\`;
      });
      contextMenu.innerHTML = html;
      contextMenu.querySelectorAll('.context-menu-item').forEach(el => {
        el.onclick = () => {
          const idx = parseInt(el.dataset.idx);
          items[idx].action();
          hideContextMenu();
        };
      });
      const menuWidth = 180;
      const menuHeight = items.length * 36;
      let x = e.clientX || e.pageX;
      let y = e.clientY || e.pageY;
      if (x + menuWidth > window.innerWidth) x = window.innerWidth - menuWidth - 8;
      if (y + menuHeight > window.innerHeight) y = window.innerHeight - menuHeight - 8;
      contextMenu.style.left = x + 'px';
      contextMenu.style.top = y + 'px';
      contextMenu.classList.add('active');
    }
    
    function hideContextMenu() { contextMenu.classList.remove('active'); }
    
    document.addEventListener('click', (e) => {
      if (!contextMenu.contains(e.target)) hideContextMenu();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { hideContextMenu(); closePreview(); }
    });
    
    let touchStartX = 0, touchStartY = 0;
    document.addEventListener('touchstart', (e) => {
      const item = e.target.closest('.file-item');
      if (!item) return;
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
      longPressTimer = setTimeout(() => {
        const type = item.dataset.type;
        const path = item.dataset.path;
        const name = item.dataset.name;
        const previewType = item.dataset.previewable || '';
        const fakeEvent = { clientX: touchStartX, clientY: touchStartY, preventDefault: ()=>{}, stopPropagation: ()=>{} };
        showContextMenu(fakeEvent, type, path, name, previewType);
      }, 600);
    });
    document.addEventListener('touchmove', (e) => {
      if (longPressTimer) {
        const dx = Math.abs(e.touches[0].clientX - touchStartX);
        const dy = Math.abs(e.touches[0].clientY - touchStartY);
        if (dx > 10 || dy > 10) { clearTimeout(longPressTimer); longPressTimer = null; }
      }
    });
    document.addEventListener('touchend', () => { if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; } });
    document.addEventListener('touchcancel', () => { if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; } });
    
    function copyDownloadLink(path) {
      const fullUrl = window.location.origin + '/api/download' + path;
      navigator.clipboard.writeText(fullUrl).then(() => showToast('下载链接已复制', 'success')).catch(() => showToast('复制失败', 'error'));
    }
    
    const dropZone = document.getElementById('dropZone');
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => { dropZone.addEventListener(eventName, preventDefaults, false); });
    function preventDefaults(e) { e.preventDefault(); e.stopPropagation(); }
    ['dragenter', 'dragover'].forEach(eventName => { dropZone.addEventListener(eventName, () => dropZone.classList.add('drag-over'), false); });
    ['dragleave', 'drop'].forEach(eventName => { dropZone.addEventListener(eventName, () => dropZone.classList.remove('drag-over'), false); });
    dropZone.addEventListener('drop', (e) => { const dt = e.dataTransfer; const files = dt.files; if (files.length > 0) { const fakeEvent = { target: { files: files, value: '' } }; handleFileUpload(fakeEvent); } }, false);

    async function handleFileUpload(event) {
      const files = Array.from(event.target.files);
      if (!files.length) return;
      document.getElementById('uploadProgressModal').classList.add('active');
      document.getElementById('closeUploadModalBtn').style.display = 'none';
      document.getElementById('cancelUploadBtn').style.display = 'inline-flex';
      let successCount = 0;
      let errorCount = 0;
      let renamedCount = 0;
      
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        document.getElementById('uploadFileName').textContent = file.name;
        document.getElementById('uploadFileName').title = file.name;
        currentUploadAbortController = new AbortController();
        try {
          if (file.size > CHUNK_SIZE) {
            document.getElementById('uploadStatusText').textContent = '大文件，启动分片上传...';
            const result = await uploadFileChunked(file, (percent, status) => { updateUploadProgress(percent); if (status) document.getElementById('uploadStatusText').textContent = status; }, currentUploadAbortController.signal);
            if (result && result.renamed) renamedCount++;
          } else {
            document.getElementById('uploadStatusText').textContent = '正在上传...';
            const result = await uploadFileRegular(file, (percent) => { updateUploadProgress(percent); }, currentUploadAbortController.signal);
            if (result && result.renamed) renamedCount++;
          }
          successCount++;
        } catch (error) {
          if (error.name === 'AbortError') { showToast('已取消上传: ' + file.name, 'info'); }
          else { errorCount++; showToast('上传失败: ' + file.name + ' (' + error.message + ')', 'error'); }
        } finally { currentUploadAbortController = null; }
      }
      
      document.getElementById('uploadStatusText').textContent = '上传完成';
      updateUploadProgress(100);
      
      if (successCount > 0) {
        let msg = \`成功上传 \${successCount} 个文件\`;
        if (renamedCount > 0) msg += \` (其中 \${renamedCount} 个已自动重命名)\`;
        showToast(msg, 'success');
        loadFiles();
        if (errorCount === 0) {
          setTimeout(closeUploadModal, 1500);
        } else {
          document.getElementById('closeUploadModalBtn').style.display = 'block';
          document.getElementById('cancelUploadBtn').style.display = 'none';
        }
      } else {
        document.getElementById('closeUploadModalBtn').style.display = 'block';
        document.getElementById('cancelUploadBtn').style.display = 'none';
      }
      if (errorCount > 0 && successCount > 0) {
        showToast(\`\${errorCount} 个文件上传失败\`, 'error');
      }
      event.target.value = '';
    }
    
    function cancelUpload() { if (currentUploadAbortController) currentUploadAbortController.abort(); }
    
    function closeUploadModal() {
      document.getElementById('uploadProgressModal').classList.remove('active');
      document.getElementById('uploadProgressBar').style.width = '0%';
      document.getElementById('uploadProgressText').textContent = '0%';
      document.getElementById('uploadStatusText').textContent = '准备上传...';
      document.getElementById('closeUploadModalBtn').style.display = 'none';
      document.getElementById('cancelUploadBtn').style.display = 'none';
    }
    
    function updateUploadProgress(percent) { const rounded = Math.round(percent); document.getElementById('uploadProgressText').textContent = rounded + '%'; document.getElementById('uploadProgressBar').style.width = rounded + '%'; }
    
    function uploadFileRegular(file, onProgress, signal) {
      return new Promise((resolve, reject) => {
        const formData = new FormData();
        formData.append('file', file);
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/files' + currentPath, true);
        xhr.upload.onprogress = (event) => { if (event.lengthComputable) onProgress((event.loaded / event.total) * 100); };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try { const data = JSON.parse(xhr.responseText); if (data.success) resolve(data); else reject(new Error(data.message || '未知错误')); }
            catch (e) { reject(new Error('解析响应失败')); }
          } else { reject(new Error('HTTP 错误: ' + xhr.status)); }
        };
        xhr.onerror = () => reject(new Error('网络连接失败'));
        xhr.ontimeout = () => reject(new Error('请求超时'));
        xhr.timeout = 300000;
        xhr.onabort = () => reject(new DOMException('Upload aborted', 'AbortError'));
        signal.addEventListener('abort', () => { xhr.abort(); });
        xhr.send(formData);
      });
    }
    
    async function uploadFileChunked(file, onProgress, signal) {
      const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
      const initRes = await fetch('/api/files/init' + currentPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: file.name }), signal });
      const initData = await initRes.json();
      if (!initData.success) throw new Error(initData.message);
      const uploadId = initData.uploadId;
      const actualFilename = initData.finalFilename || file.name;
      const parts = [];
      let uploadedBytes = 0;
      for (let i = 0; i < totalChunks; i++) {
        if (signal.aborted) throw new DOMException('Upload aborted', 'AbortError');
        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, file.size);
        const chunk = file.slice(start, end);
        onProgress((uploadedBytes / file.size) * 100, \`正在上传分片 \${i + 1} / \${totalChunks}\`);
        const formData = new FormData();
        formData.append('file', chunk);
        formData.append('partNumber', i + 1);
        formData.append('uploadId', uploadId);
        formData.append('filename', actualFilename);
        const res = await fetch('/api/files/part' + currentPath, { method: 'POST', body: formData, signal });
        const partData = await res.json();
        if (!partData.success) throw new Error('分片 ' + (i + 1) + ' 上传失败: ' + partData.message);
        parts.push({ partNumber: partData.partNumber, etag: partData.etag });
        uploadedBytes += chunk.size;
      }
      onProgress(99, '正在合并文件...');
      const completeRes = await fetch('/api/files/complete' + currentPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: actualFilename, uploadId, parts }), signal });
      const completeData = await completeRes.json();
      if (!completeData.success) throw new Error('文件合并失败: ' + completeData.message);
      onProgress(100, '合并完成');
      return { renamed: initData.renamed };
    }
    
    function showNewFolderModal() { document.getElementById('folderName').value = ''; document.getElementById('newFolderModal').classList.add('active'); }
    async function createFolder(event) { event.preventDefault(); const name = document.getElementById('folderName').value.trim(); if (!name) return showToast('请输入名称', 'error'); closeModal('newFolderModal'); showLoading(true); try { let folderPath = currentPath.endsWith('/') ? currentPath + name : currentPath + '/' + name; const response = await fetch('/api/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: folderPath }) }); const data = await response.json(); showToast(data.success ? '创建成功' : '创建失败: ' + data.message, data.success ? 'success' : 'error'); if (data.success) loadFiles(); } catch (error) { showToast('创建失败: ' + error.message, 'error'); } finally { showLoading(false); } }
    function showRenameModal(path, currentName) { document.getElementById('renameFilePath').value = path; document.getElementById('newFileName').value = currentName; document.getElementById('renameModal').classList.add('active'); }
    async function renameFile(event) { event.preventDefault(); const path = document.getElementById('renameFilePath').value; const newName = document.getElementById('newFileName').value.trim(); if (!newName) return showToast('请输入新名称', 'error'); closeModal('renameModal'); showLoading(true); try { const response = await fetch('/api/files' + path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ newName }) }); const data = await response.json(); showToast(data.success ? '重命名成功' : '失败: ' + data.message, data.success ? 'success' : 'error'); if (data.success) loadFiles(); } catch (error) { showToast('失败: ' + error.message, 'error'); } finally { showLoading(false); } }
    async function deleteFile(path) { if (!confirm('确定要删除吗？此操作不可恢复。')) return; showLoading(true); try { const response = await fetch('/api/files' + path, { method: 'DELETE' }); const data = await response.json(); showToast(data.success ? '删除成功' : '失败: ' + data.message, data.success ? 'success' : 'error'); if (data.success) loadFiles(); } catch (error) { showToast('失败: ' + error.message, 'error'); } finally { showLoading(false); } }
    function downloadFile(path) { window.open('/api/download' + path, '_blank'); }
    function showShareModal(path) { document.getElementById('shareFilePath').value = path; document.getElementById('sharePassword').value = ''; document.getElementById('shareExpiry').value = '1d'; document.getElementById('shareModal').classList.add('active'); }
    async function createShare(event) { event.preventDefault(); const filePath = document.getElementById('shareFilePath').value; const password = document.getElementById('sharePassword').value; const expiresIn = document.getElementById('shareExpiry').value; closeModal('shareModal'); showLoading(true); try { const response = await fetch('/api/share', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filePath, password, expiresIn }) }); const data = await response.json(); if (data.success) { document.getElementById('shareResultUrl').value = window.location.origin + data.shareUrl; document.getElementById('shareResultModal').classList.add('active'); } else { showToast('创建失败: ' + data.message, 'error'); } } catch (error) { showToast('创建失败: ' + error.message, 'error'); } finally { showLoading(false); } }
    function copyShareLink() { const input = document.getElementById('shareResultUrl'); input.select(); document.execCommand('copy'); showToast('链接已复制', 'success'); }
    async function logout() { await fetch('/api/logout', { method: 'POST' }); window.location.href = '/login.html'; }
    function closeModal(id) { document.getElementById(id).classList.remove('active'); }
    function showLoading(show) { document.getElementById('loadingOverlay').style.display = show ? 'flex' : 'none'; }
    function showToast(message, type = 'info') { const container = document.getElementById('toastContainer'); const toast = document.createElement('div'); const icon = type === 'success' ? '✅' : type === 'error' ? '❌' : 'ℹ️'; toast.className = 'toast toast-' + type; toast.innerHTML = '<span>' + icon + '</span><span>' + message + '</span>'; container.appendChild(toast); setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, 3000); }
    checkAuth(); loadFiles();
  </script></body></html>`;

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
      if (path.startsWith('/api/')) {
        if (path === '/api/login' && method === 'POST') return await handleLogin(request, env);
        if (path === '/api/logout' && method === 'POST') return await handleLogout();
        if (path === '/api/auth/check') return await handleCheckAuth(request, env);
        
        if (path.startsWith('/api/files/init')) {
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
