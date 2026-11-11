import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const srcDir = path.join(rootDir, 'src');
const distDir = path.join(rootDir, 'dist');

// 1. Prefer local TypeScript compiler (tsc) when available in node_modules
const localTsc = path.join(rootDir, 'node_modules', '.bin', 'tsc');
if (fs.existsSync(localTsc)) {
  const res = spawnSync(localTsc, [], { cwd: rootDir, stdio: 'inherit' });
  process.exit(res.status ?? 0);
}

// 2. Fallback to Babel TypeScript compiler when building in offline environments without node_modules
const require = createRequire(import.meta.url);
let babel;
let tsPreset;
try {
  babel = require('@babel/core');
  tsPreset = require('@babel/preset-typescript');
} catch {
  babel = require('/usr/share/nodejs/@babel/core');
  tsPreset = require('/usr/share/nodejs/@babel/preset-typescript');
}

if (fs.existsSync(distDir)) {
  fs.rmSync(distDir, { recursive: true, force: true });
}

function compileDirectory(currentSrc, currentOut) {
  fs.mkdirSync(currentOut, { recursive: true });
  for (const entry of fs.readdirSync(currentSrc, { withFileTypes: true })) {
    const srcPath = path.join(currentSrc, entry.name);
    if (entry.isDirectory()) {
      compileDirectory(srcPath, path.join(currentOut, entry.name));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      const code = fs.readFileSync(srcPath, 'utf8');
      const transformed = babel.transformSync(code, {
        filename: srcPath,
        presets: [[tsPreset, { allowDeclareFields: true }]],
        retainLines: true,
      });
      const jsOutPath = path.join(currentOut, entry.name.replace(/\.ts$/, '.js'));
      fs.writeFileSync(jsOutPath, transformed.code, 'utf8');

      // Also copy .d.ts stub for non-test source files so package types exist
      if (!currentSrc.includes('__tests__')) {
        const dtsOutPath = path.join(currentOut, entry.name.replace(/\.ts$/, '.d.ts'));
        fs.writeFileSync(dtsOutPath, code, 'utf8');
      }
    }
  }
}

compileDirectory(srcDir, distDir);
