import { build, type Plugin } from 'esbuild';
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { SECURITY_HEADERS } from '../src/server/app.ts';

rmSync('dist/public', { recursive: true, force: true });
mkdirSync('dist/public', { recursive: true });
await build({
  entryPoints: ['src/web/main.tsx'],
  outfile: 'dist/public/app.js',
  bundle: true,
  minify: true,
  sourcemap: true,
  target: 'es2022',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'info',
});
copyFileSync('src/web/styles.css', 'dist/public/styles.css');
copyFileSync('src/web/index.html', 'dist/public/index.html');

/**
 * Saída no formato Build Output da Vercel. Roda na Vercel, que define VERCEL=1,
 * ou com BUILD_VERCEL=1 para conferir localmente.
 */
if (process.env.VERCEL || process.env.BUILD_VERCEL) {
  const output = '.vercel/output';
  const fn = `${output}/functions/server.func`;
  rmSync(output, { recursive: true, force: true });
  mkdirSync(fn, { recursive: true });
  cpSync('dist/public', `${output}/static`, { recursive: true });

  // Só para conferência local sem o pacote pg: em produção, a falta dele interrompe o build.
  const withoutPg: Plugin = {
    name: 'sem-pg',
    setup(b) {
      b.onResolve({ filter: /^pg$/ }, () => ({ path: 'pg', namespace: 'sem-pg' }));
      b.onLoad({ filter: /.*/, namespace: 'sem-pg' }, () => ({ contents: 'export default {};' }));
    },
  };
  if (!existsSync('node_modules/pg') && process.env.VERCEL) throw new Error('Pacote pg não instalado');

  await build({
    entryPoints: ['src/server/vercel.ts'],
    outfile: `${fn}/index.mjs`,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: ['pg-native'],
    banner: { js: `import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);` },
    plugins: existsSync('node_modules/pg') ? [] : [withoutPg],
    logLevel: 'info',
  });
  writeFileSync(`${fn}/.vc-config.json`, JSON.stringify({
    runtime: 'nodejs22.x',
    handler: 'index.mjs',
    launcherType: 'Nodejs',
    shouldAddHelpers: false,
    maxDuration: 60,
  }, null, 2));

  const headers = { ...SECURITY_HEADERS, 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' };
  writeFileSync(`${output}/config.json`, JSON.stringify({
    version: 3,
    routes: [
      { src: '^/(api|webhooks|internal)/.*$', dest: '/server' },
      { src: '^/healthz$', dest: '/server' },
      { src: '^/.*$', headers, continue: true },
      { handle: 'filesystem' },
      { src: '^/.*$', dest: '/index.html' },
    ],
    crons: [{ path: '/internal/jobs/run', schedule: '17 9 * * *' }],
  }, null, 2));
}
