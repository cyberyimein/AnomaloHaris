// Export only the demo source. Never copy repository history, environment files,
// backend code, private data or local fonts to the hosted source repository.
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const destination = resolve('sites/anomaloharis-demo');
const manifestPath = resolve(destination, '.openai/hosting.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (!manifest.project_id) throw new Error('Register the Site before preparing source.');
manifest.static = { directory: 'dist' };
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

for (const directory of ['src/demo', 'src/assets']) {
  await mkdir(resolve(destination, directory), { recursive: true });
}
for (const file of ['demo/DemoApp.vue', 'demo/demo.css', 'style.css', 'assets/anomaloharis-shrimp.png']) {
  await copyFile(resolve('frontend/src', file), resolve(destination, 'src', file));
}
await copyFile(resolve('frontend/index.html'), resolve(destination, 'index.html'));
await writeFile(resolve(destination, 'src/main.js'), `import { createApp } from 'vue';
import './style.css';
import DemoApp from './demo/DemoApp.vue';
document.title = 'AnomaloHaris · Interactive Demo';
createApp(DemoApp).mount('#app');
`);
await writeFile(resolve(destination, 'vite.config.js'), `import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
export default defineConfig({ plugins: [vue()], build: { outDir: 'dist', sourcemap: false } });
`);
await writeFile(resolve(destination, 'package.json'), `${JSON.stringify({
  name: 'anomaloharis-demo',
  version: '0.1.0',
  private: true,
  type: 'module',
  scripts: { dev: 'vite --host 127.0.0.1', build: 'vite build' },
  dependencies: { vue: '3.5.13', '@lucide/vue': '1.21.0' },
  devDependencies: { vite: '6.4.3', '@vitejs/plugin-vue': '5.2.1' },
}, null, 2)}\n`);
await writeFile(resolve(destination, '.gitignore'), 'node_modules/\n.env\n.env.*\n*.log\n');
await writeFile(resolve(destination, 'README.md'), `# AnomaloHaris demo\n\nStatic, browser-only project showcase. All conversations, workflows and device states are simulated. No model calls, backend, hardware connections, credentials or persistent user storage.\n\nSource is exported from the AnomaloHaris demo branch with scripts/prepare-demo-site.mjs. Build with npm install and npm run build.\n`);
console.log(`Demo source prepared at ${destination}`);
