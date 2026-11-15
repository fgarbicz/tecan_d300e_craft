// Assemble the desktop app's front end: app/ (interface) + src/ (engine modules) -> web-dist/.
// Run from the repo root (tauri.conf.json does this before dev/build).
import { cpSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const root = process.cwd(), out = join(root, 'web-dist');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(root, 'app'), join(out, 'app'), { recursive: true });
cpSync(join(root, 'src'), join(out, 'src'), { recursive: true });
console.log('web-dist ready');
