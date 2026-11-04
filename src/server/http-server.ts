import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { isApiPath, withSecurityHeaders } from './app.ts';
import type { Deps } from './deps.ts';
import { serveApi } from './node-adapter.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.map': 'application/json',
};

export function startHttpServer(deps: Deps, port: number, publicDir = resolve(process.env.PUBLIC_DIR ?? 'dist/public')) {
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://x').pathname;
    if (!isApiPath(pathname)) {
      const candidate = normalize(join(publicDir, pathname));
      const file =
        candidate.startsWith(publicDir) && existsSync(candidate) && statSync(candidate).isFile()
          ? candidate
          : join(publicDir, 'index.html');
      const probe = withSecurityHeaders(new Response(null), deps.config.production);
      probe.headers.forEach((value, key) => res.setHeader(key, value));
      res.setHeader('Content-Type', MIME[extname(file)] ?? 'application/octet-stream');
      createReadStream(file).pipe(res);
      return;
    }
    await serveApi(req, res, deps);
  });
  server.listen(port);
  return server;
}
