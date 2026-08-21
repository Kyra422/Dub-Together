import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { prepareManifest, scanChoicerEntries } from "../lib/choicer-packs.ts";

const root = path.resolve("packs");
const output = path.resolve("public/pack-library.json");
const rawBase = (process.env.DUB_PACK_RAW_BASE_URL || "https://raw.githubusercontent.com/Kyra422/Dub-Together/main/packs").replace(/\/$/, "");

function mimeFor(filename: string) {
  const ext = path.extname(filename).slice(1).toLowerCase();
  return ({
    ogg: "audio/ogg", mp3: "audio/mpeg", wav: "audio/wav", ogv: "video/ogg", mp4: "video/mp4",
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", txt: "text/plain",
    ini: "text/plain", cfg: "text/plain",
  } as Record<string, string>)[ext] ?? "application/octet-stream";
}

async function exists(directory: string) {
  try {
    return (await stat(directory)).isDirectory();
  } catch {
    return false;
  }
}

async function walk(directory: string, relative = ""): Promise<{ absolute: string; relative: string }[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const result: { absolute: string; relative: string }[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const nextRelative = relative ? `${relative}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await walk(absolute, nextRelative));
    else if (entry.isFile()) result.push({ absolute, relative: nextRelative.replaceAll("\\", "/") });
  }
  return result;
}

function encodeRemotePath(value: string) {
  return value.split("/").map(encodeURIComponent).join("/");
}

await mkdir(path.dirname(output), { recursive: true });

if (!await exists(root)) {
  await writeFile(output, JSON.stringify({ version: 1, packs: [] }, null, 2));
  console.log("No packs/ directory found; generated an empty pack catalog.");
  process.exit(0);
}

const diskFiles = await walk(root);
const entries = await Promise.all(diskFiles.map(async ({ absolute, relative }) => {
  const data = await readFile(absolute);
  const fileStats = await stat(absolute);
  return {
    path: relative,
    file: new File([data], path.basename(relative), { type: mimeFor(relative), lastModified: Math.floor(fileStats.mtimeMs) }),
  };
}));

const packs = await scanChoicerEntries(entries);
const catalog = {
  version: 1 as const,
  packs: [] as { manifest: Awaited<ReturnType<typeof prepareManifest>>; baseUrl: string }[],
};

for (const pack of packs) {
  const manifest = await prepareManifest(pack);
  catalog.packs.push({
    manifest,
    baseUrl: `${rawBase}/${encodeRemotePath(pack.basePath)}`,
  });
  console.log(`Indexed ${pack.title} (${pack.assets.length} assets)`);
}

await writeFile(output, JSON.stringify(catalog, null, 2));
console.log(`Generated ${path.relative(process.cwd(), output)} with ${catalog.packs.length} pack(s).`);
