// Command-line transcription: npm run transcribe -- page1.jpg [page2.jpg ...] [--out file.smp.json] [--effort high]
// Needs ANTHROPIC_API_KEY. Import the resulting .smp.json in the app (Library → Import).
import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { transcribePages, Effort, PageImage } from '../src/omr/transcribe';
import { convertPages } from '../src/omr/convert';

const args = process.argv.slice(2);
const files: string[] = [];
let out = '';
let effort: Effort = 'high';
let model: string | undefined;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out') out = args[++i];
  else if (args[i] === '--effort') effort = args[++i] as Effort;
  else if (args[i] === '--model') model = args[++i];
  else files.push(args[i]);
}
if (!files.length) {
  console.error('Usage: npm run transcribe -- page1.jpg [page2.jpg ...] [--out score.smp.json] [--effort medium|high|xhigh] [--model id]');
  process.exit(1);
}
const MIME: Record<string, PageImage['mediaType']> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const images: PageImage[] = files.map((f) => {
  const mediaType = MIME[path.extname(f).toLowerCase()];
  if (!mediaType) throw new Error(`Unsupported image type: ${f} (use JPEG, PNG or WebP)`);
  const buf = fs.readFileSync(f);
  if (buf.length > 5 * 1024 * 1024) console.warn(`Warning: ${f} is over 5 MB – the API may reject it; resize it first.`);
  return { data: buf.toString('base64'), mediaType };
});

const t0 = Date.now();
const pages = await transcribePages(new Anthropic(), images, {
  effort,
  model,
  onProgress: ({ page, progress }) => {
    if (progress.phase !== 'writing' || progress.measures % 4 === 0)
      process.stderr.write(`\rpage ${page + 1}: ${progress.phase} ${progress.measures ? `${progress.measures} measures` : ''}      `);
  },
});
const { score, warnings, repaired } = convertPages(pages);
const file = out || `${(score.title || 'score').replace(/[^\w-]+/g, '-')}.smp.json`;
fs.writeFileSync(file, JSON.stringify(score, null, 1));
console.error(`\nDone in ${Math.round((Date.now() - t0) / 1000)}s: "${score.title}", ${score.measures.length} measures → ${file}`);
if (repaired.length) console.error(`Rhythm auto-fixed in measures: ${repaired.map((i) => i + 1).join(', ')}`);
for (const w of [...warnings, ...(score.notes ?? [])]) console.error(`  • ${w}`);
