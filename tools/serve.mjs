/* =============================================================
 * serve.mjs — 零依赖本地静态服务器
 * -------------------------------------------------------------
 * 只用 Node 内置模块，不需要 npm install。
 *
 *   node tools/serve.mjs            # 默认端口 8899，自动打开浏览器
 *   node tools/serve.mjs 9000       # 指定端口
 *   node tools/serve.mjs 9000 --no-open
 *
 * 为什么需要它：
 *   直接双击 index.html 走的是 file:// 协议，浏览器会把来源判定为
 *   "null"，大部分公开音源的 CORS 响应头不认这个来源，搜索会大面积
 *   失败。用 http://127.0.0.1 打开就没有这个问题。
 * ============================================================= */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', 'app');

const args = process.argv.slice(2);
const wantPort = Number(args.find((a) => /^\d+$/.test(a))) || 8899;
const noOpen = args.includes('--no-open');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};

function send(res, code, body, headers = {}) {
  res.writeHead(code, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    return send(res, 400, 'Bad Request');
  }
  if (urlPath === '/') urlPath = '/index.html';

  // 防目录穿越：解析后必须仍在 ROOT 内
  const filePath = path.join(ROOT, urlPath);
  if (!filePath.startsWith(ROOT)) return send(res, 403, 'Forbidden');

  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not Found');
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': st.size,
      'Cache-Control': 'no-store'
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

// 端口被占就顺延，最多试 20 个
function listen(port, tries = 0) {
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && tries < 20) return listen(port + 1, tries + 1);
    console.error('[Music Hub] 启动失败：', e.message);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}/index.html`;
    console.log('');
    console.log('  Music Hub 已启动');
    console.log('  ' + url);
    console.log('');
    console.log('  按 Ctrl+C 停止服务');
    console.log('');
    if (!noOpen) open(url);
  });
}

function open(url) {
  const p = process.platform;
  try {
    if (p === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    else if (p === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    /* 打不开就算了，用户手动复制地址 */
  }
}

if (!fs.existsSync(path.join(ROOT, 'index.html'))) {
  console.error('[Music Hub] 找不到 app/index.html，请确认目录结构完整。');
  process.exit(1);
}

listen(wantPort);
