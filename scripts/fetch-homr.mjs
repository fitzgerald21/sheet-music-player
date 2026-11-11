// Downloads what "Scan on this device" needs into public/homr/ (not committed, ~160 MB):
//   - homr's three ONNX models, from the homr project's GitHub release
//   - the homr Python package (a wheel, run in the browser by Pyodide)
//   - onnxruntime-web's WebAssembly runtime, copied from node_modules
// homr is © Christian Liebhardt and contributors, AGPL-3.0: https://github.com/liebharc/homr
// Run with: npm run fetch-homr   (the Pages workflow runs it before building)
import { mkdir, writeFile, copyFile, stat, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'public', 'homr');

export const HOMR_VERSION = '0.7.1';
const WHEEL = `homr-${HOMR_VERSION}-py3-none-any.whl`;
const WHEEL_URL = `https://files.pythonhosted.org/packages/66/43/bf958d1b16971cc7b67574cf797b3d2290712d873d632a78c7d6ae46e49a/${WHEEL}`;
const RELEASE = 'https://github.com/liebharc/homr/releases/download/onnx_checkpoints/';
const MODELS = {
  segnet: 'segnet_308-3296ccd40960f90ca6ab9c035cca945675d30a0f',
  encoder: 'encoder_pytorch_model_509-2293bba14bfea47d9d28411339362af15fce4c31',
  decoder: 'decoder_pytorch_model_509-2293bba14bfea47d9d28411339362af15fce4c31',
};

async function download(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      if (attempt >= 4) throw new Error(`Could not download ${url}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

const size = async (p) => (existsSync(p) ? (await stat(p)).size : 0);

await mkdir(join(out, 'ort'), { recursive: true });
const manifest = { homr: HOMR_VERSION, wheel: WHEEL, models: {} };

for (const [key, name] of Object.entries(MODELS)) {
  const file = `${name}.onnx`;
  const target = join(out, file);
  if (!(await size(target))) {
    process.stdout.write(`Downloading ${key} model… `);
    const zip = unzipSync(await download(`${RELEASE}${name}.zip`));
    const entry = Object.keys(zip).find((n) => n.endsWith('.onnx'));
    if (!entry) throw new Error(`No .onnx file inside ${name}.zip`);
    await writeFile(target, zip[entry]);
    console.log(`${(zip[entry].length / 1e6).toFixed(0)} MB`);
  }
  manifest.models[key] = { file, bytes: await size(target) };
}

if (!(await size(join(out, WHEEL)))) {
  process.stdout.write('Downloading the homr package… ');
  await writeFile(join(out, WHEEL), await download(WHEEL_URL));
  console.log('done');
}

const ortDist = join(root, 'node_modules', 'onnxruntime-web', 'dist');
for (const f of await readdir(ortDist)) {
  if (/^ort-wasm-simd-threaded\.(mjs|wasm)$/.test(f)) await copyFile(join(ortDist, f), join(out, 'ort', f));
}

await writeFile(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`homr ${HOMR_VERSION} is ready in public/homr`);
