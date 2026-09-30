import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
};

let server;
let firefoxProc;

function startServer(port = 8181) {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/report') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          handleReport(JSON.parse(body));
        });
        return;
      }

      const parsedUrl = new URL(req.url, `http://localhost:${port}`);
      let filePath = path.join(ROOT, parsedUrl.pathname);
      if (filePath.endsWith(path.sep)) filePath = path.join(filePath, 'index.html');

      fs.stat(filePath, (err, stats) => {
        if (err || !stats.isFile()) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        const ext = path.extname(filePath);
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
        fs.createReadStream(filePath).pipe(res);
      });
    });

    server.listen(port, () => resolve(port));
  });
}

function handleReport(report) {
  const { tests, errors } = report;
  console.log('\n--- Headless Browser Verification Results ---');
  let allPass = true;
  for (const t of tests) {
    if (t.pass) {
      console.log(`  ✓ ${t.name}`);
    } else {
      console.error(`  ✗ ${t.name}: ${t.detail || 'failed'}`);
      allPass = false;
    }
  }

  if (errors && errors.length > 0) {
    console.error('\nConsole errors detected:');
    for (const e of errors) console.error(`  ${e}`);
    allPass = false;
  }

  console.log(`\nSummary: ${tests.filter((t) => t.pass).length}/${tests.length} tests passed.`);
  cleanup(allPass ? 0 : 1);
}

function cleanup(exitCode = 0) {
  if (firefoxProc) {
    try { firefoxProc.kill(); } catch { /* ignore */ }
  }
  if (server) {
    server.close(() => process.exit(exitCode));
  } else {
    process.exit(exitCode);
  }
}

async function main() {
  const port = await startServer(8181);
  console.log(`Test server running at http://localhost:${port}`);

  const testUrl = `http://localhost:${port}/tests/browser-test.html`;
  const firefoxPath = 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';

  console.log(`Launching Firefox headless: ${firefoxPath}`);
  firefoxProc = spawn(firefoxPath, ['--headless', testUrl], {
    stdio: 'ignore',
  });

  // Timeout safety
  setTimeout(() => {
    console.error('Timed out waiting for headless test report (20 s)');
    cleanup(1);
  }, 20000);
}

main().catch((err) => {
  console.error(err);
  cleanup(1);
});
