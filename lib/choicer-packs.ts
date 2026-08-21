"use client";

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { DubClip, DubPlacement, PackAsset, PackManifest, RuntimePack } from "./types";

const AUDIO = new Set(["ogg", "mp3", "wav"]);
const IMAGES = new Set(["png", "jpg", "jpeg", "webp"]);
const METADATA = new Set(["ini", "cfg", "txt"]);
const VIDEOS = new Set(["dub_video.ogv", "dub_video.mp4"]);
const MAX_PACK_BYTES = 1024 * 1024 * 1024;
const fileHashCache = new WeakMap<File, Promise<string>>();

function normalizePath(path: string) {
  return path.replaceAll("\\", "/").replace(/^\/+/, "").split("/").filter((part) => part && part !== ".").join("/");
}

function dirname(path: string) {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

function basename(path: string) {
  return path.slice(path.lastIndexOf("/") + 1);
}

function extension(path: string) {
  const name = basename(path);
  const index = name.lastIndexOf(".");
  return index < 0 ? "" : name.slice(index + 1).toLowerCase();
}

function stem(path: string) {
  const name = basename(path);
  const index = name.lastIndexOf(".");
  return index < 0 ? name : name.slice(0, index);
}

function stripQuotes(value: string) {
  const clean = value.trim();
  if (clean.length >= 2 && ((clean.startsWith('"') && clean.endsWith('"')) || (clean.startsWith("'") && clean.endsWith("'")))) {
    try {
      return JSON.parse(clean.startsWith('"') ? clean : `"${clean.slice(1, -1).replaceAll('"', '\\"')}"`);
    } catch {
      return clean.slice(1, -1);
    }
  }
  return clean;
}

function parseValue(raw: string): unknown {
  const value = raw.trim();
  if (value.startsWith("[") && value.endsWith("]")) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1).split(",").map(stripQuotes).filter(Boolean);
    }
  }
  if (/^(true|false)$/i.test(value)) return value.toLowerCase() === "true";
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return stripQuotes(value);
}

function parseConfig(text: string) {
  const result: Record<string, Record<string, unknown>> = {};
  let section = "";
  for (const rawLine of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    const sectionMatch = line.match(/^\[([^\]]+)]$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim().toLowerCase();
      result[section] ??= {};
      continue;
    }
    const equals = line.indexOf("=");
    if (equals < 1 || !section) continue;
    const key = line.slice(0, equals).trim();
    result[section][key] = parseValue(line.slice(equals + 1));
  }
  return result;
}

function stringList(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))];
}

export function repairText(value: string) {
  return value
    .replaceAll("Ã¢â‚¬Å“", "“")
    .replaceAll("Ã¢â‚¬Â", "”")
    .replaceAll("Ã¢â‚¬â„¢", "’")
    .replaceAll("Ã¢â‚¬â€œ", "–")
    .replaceAll("â€œ", "“")
    .replaceAll("â€", "”")
    .replaceAll("â€™", "’")
    .replaceAll("â€“", "–");
}

async function smallText(file: File) {
  if (file.size > 2 * 1024 * 1024) return "";
  return repairText(await file.text());
}

function shaString(value: string) {
  return bytesToHex(sha256(new TextEncoder().encode(value)));
}

function mimeFor(file: File) {
  if (file.type) return file.type;
  const ext = extension(file.name);
  return ({
    ogg: "audio/ogg", mp3: "audio/mpeg", wav: "audio/wav", ogv: "video/ogg", mp4: "video/mp4",
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", txt: "text/plain",
    ini: "text/plain", cfg: "text/plain",
  } as Record<string, string>)[ext] ?? "application/octet-stream";
}

function caseFind(files: Map<string, File>, wanted: string) {
  const lower = wanted.toLowerCase();
  return [...files.keys()].find((name) => name.toLowerCase() === lower) ?? "";
}

function sibling(files: Map<string, File>, wantedStem: string, extensions: Set<string>) {
  for (const name of files.keys()) {
    if (stem(name).toLowerCase() === wantedStem.toLowerCase() && extensions.has(extension(name))) return name;
  }
  return "";
}

async function buildPack(basePath: string, directFiles: File[], paths: Map<File, string>): Promise<RuntimePack | null> {
  const files = new Map<string, File>();
  for (const file of directFiles) files.set(basename(paths.get(file) ?? file.name), file);
  const lowerNames = [...files.keys()].map((name) => name.toLowerCase());
  const metadataTexts = new Map<string, string>();
  for (const [name, file] of files) {
    if (METADATA.has(extension(name))) metadataTexts.set(name, await smallText(file));
  }
  const modernMetadata = [...metadataTexts.entries()].filter(([name, text]) => {
    const lower = name.toLowerCase();
    return !["_pack_info.ini", "_pack_info.cfg"].includes(lower)
      && text.toLowerCase().includes("[data]")
      && (/dub_timestamps\s*=/.test(text) || /dub_characters\s*=/.test(text));
  });
  const playable = lowerNames.some((name) => VIDEOS.has(name)) || modernMetadata.length > 0
    || [...files.keys()].some((name) => AUDIO.has(extension(name)) && Boolean(caseFind(files, `${stem(name)}.txt`)));
  if (!playable) return null;

  let info: Record<string, unknown> = {};
  for (const name of ["_pack_info.ini", "_pack_info.cfg"]) {
    const found = caseFind(files, name);
    if (found) {
      info = parseConfig(metadataTexts.get(found) ?? "").data ?? {};
      break;
    }
  }
  const folderName = basename(basePath) || "Dub pack";
  const title = String(info.title ?? folderName).trim() || folderName;
  let subtitle = String(info.subtitle ?? "").trim();
  let authors = stringList(info.authors);
  if (!subtitle) {
    const name = caseFind(files, "_subtitle.txt");
    if (name) subtitle = (metadataTexts.get(name) ?? "").trim();
  }
  if (!authors.length) {
    const name = caseFind(files, "_author.txt");
    if (name) authors = [(metadataTexts.get(name) ?? "").trim()].filter(Boolean);
  }
  const configuredIcon = typeof info.icon === "string" ? caseFind(files, info.icon) : "";
  let icon = configuredIcon;
  if (!icon) {
    for (const preferred of ["icon.png", "icon.jpg", "_icon.png", "_icon.jpg", "_pack_filler_image.png", "_pack_filler_image.jpg"]) {
      icon = caseFind(files, preferred);
      if (icon) break;
    }
  }
  if (!icon) icon = [...files.keys()].find((name) => IMAGES.has(extension(name))) ?? "";
  const video = [...files.keys()].find((name) => name.toLowerCase() === "dub_video.ogv")
    ?? [...files.keys()].find((name) => name.toLowerCase() === "dub_video.mp4") ?? "";
  const backingTrack = [...files.keys()].find((name) => stem(name).toLowerCase() === "_backing_track" && AUDIO.has(extension(name))) ?? "";

  const clips: DubClip[] = [];
  const claimed = new Set<string>();
  for (const [metadataName, text] of modernMetadata) {
    const data = parseConfig(text).data ?? {};
    const clipStem = stem(metadataName);
    let caption = String(data.caption ?? clipStem).trim();
    const captionName = caseFind(files, `${clipStem}.txt`);
    if (captionName && captionName.toLowerCase() !== metadataName.toLowerCase()) {
      const override = (metadataTexts.get(captionName) ?? "").trim().replace(/^"|"$/g, "");
      if (override && !override.toLowerCase().includes("[data]")) caption = override;
    }
    const configuredImage = typeof data.image === "string" ? caseFind(files, data.image) : "";
    const image = configuredImage || sibling(files, clipStem, IMAGES) || icon;
    const audio = sibling(files, clipStem, AUDIO);
    const timestamps = Array.isArray(data.dub_timestamps)
      ? data.dub_timestamps.map(Number).filter(Number.isFinite).map((value) => Math.max(0, value))
      : [];
    clips.push({
      id: clipStem,
      stem: clipStem,
      caption: repairText(caption),
      image,
      audio,
      timestamps,
      time: timestamps[0] ?? -1,
      characters: stringList(data.dub_characters),
      tags: stringList(data.tags),
      dubOnly: Boolean(data.dub_only),
      metadata: metadataName,
    });
    claimed.add(clipStem.toLowerCase());
  }
  for (const [name] of files) {
    if (name.startsWith("_") || !AUDIO.has(extension(name)) || claimed.has(stem(name).toLowerCase())) continue;
    const clipStem = stem(name);
    const textName = caseFind(files, `${clipStem}.txt`);
    let caption = clipStem.replaceAll("_", " ");
    if (textName) caption = (metadataTexts.get(textName) ?? caption).trim().replace(/^"|"$/g, "");
    clips.push({
      id: clipStem,
      stem: clipStem,
      caption: repairText(caption),
      image: sibling(files, clipStem, IMAGES) || icon,
      audio: name,
      timestamps: [],
      time: -1,
      characters: [],
      tags: [],
      dubOnly: false,
      metadata: "",
    });
  }
  clips.sort((a, b) => a.time >= 0 && b.time >= 0 && a.time !== b.time ? a.time - b.time : a.stem.localeCompare(b.stem, undefined, { numeric: true }));
  if (!clips.length) return null;

  const placements: DubPlacement[] = clips.flatMap((clip) => clip.timestamps.map((time, placementIndex) => ({
    clipId: clip.id,
    placementIndex,
    time,
    audio: clip.audio,
    caption: clip.caption,
    characters: clip.characters,
    dubOnly: clip.dubOnly,
  }))).sort((a, b) => a.time - b.time || a.clipId.localeCompare(b.clipId, undefined, { numeric: true }));
  const characters = [...new Set(clips.flatMap((clip) => clip.characters))].sort((a, b) => a.localeCompare(b));
  const assets: PackAsset[] = [...files].map(([path, file]) => ({
    id: shaString(`${path.toLowerCase()}:${file.size}:${file.lastModified}`).slice(0, 32),
    path,
    size: file.size,
    type: mimeFor(file),
    sha256: "",
  }));
  const totalBytes = assets.reduce((sum, asset) => sum + asset.size, 0);
  if (totalBytes > MAX_PACK_BYTES) return null;
  const descriptor = JSON.stringify(assets.map(({ path, size }) => [path.toLowerCase(), size]).sort());
  return {
    id: basePath,
    hash: shaString(`${title}\n${descriptor}`).slice(0, 40),
    basePath,
    title: repairText(title),
    subtitle: repairText(subtitle),
    authors,
    readme: String(info.readme ?? "").trim(),
    icon,
    video,
    backingTrack,
    clips,
    placements,
    characters,
    assets,
    totalBytes,
    files,
  };
}

export type ChoicerFileEntry = {
  file: File;
  path: string;
};

export async function scanChoicerEntries(input: ChoicerFileEntry[]) {
  const paths = new Map<File, string>();
  const byDirectory = new Map<string, File[]>();
  for (const entry of input) {
    const path = normalizePath(entry.path);
    if (!path || path.split("/").some((part) => part === ".." || part.startsWith("."))) continue;
    paths.set(entry.file, path);
    const directory = dirname(path);
    const list = byDirectory.get(directory) ?? [];
    list.push(entry.file);
    byDirectory.set(directory, list);
  }
  const packs: RuntimePack[] = [];
  for (const [directory, files] of byDirectory) {
    if (directory.split("/").length > 8) continue;
    const pack = await buildPack(directory, files, paths);
    if (pack) packs.push(pack);
  }
  return packs.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
}

export async function scanChoicerFiles(input: File[] | FileList) {
  return scanChoicerEntries(Array.from(input).map((file) => ({
    file,
    path: file.webkitRelativePath || file.name,
  })));
}

async function calculateFileHash(file: File, onProgress?: (processed: number) => void) {
  const hasher = sha256.create();
  const chunkSize = 4 * 1024 * 1024;
  const yieldEvery = 32 * 1024 * 1024;
  let nextYield = yieldEvery;
  let processed = 0;
  for (let offset = 0; offset < file.size; offset += chunkSize) {
    const bytes = new Uint8Array(await file.slice(offset, Math.min(file.size, offset + chunkSize)).arrayBuffer());
    hasher.update(bytes);
    processed += bytes.byteLength;
    onProgress?.(processed);
    if (processed >= nextYield && processed < file.size) {
      nextYield += yieldEvery;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
  return bytesToHex(hasher.digest());
}

export async function hashFile(file: File, onProgress?: (processed: number) => void) {
  const cached = fileHashCache.get(file);
  if (cached) {
    const digest = await cached;
    onProgress?.(file.size);
    return digest;
  }
  const pending = calculateFileHash(file, onProgress);
  fileHashCache.set(file, pending);
  try {
    return await pending;
  } catch (error) {
    fileHashCache.delete(file);
    throw error;
  }
}

export async function prepareManifest(pack: RuntimePack, onProgress?: (done: number, total: number, path: string) => void): Promise<PackManifest> {
  let completedBytes = 0;
  const assets: PackAsset[] = [];
  for (const asset of pack.assets) {
    const file = pack.files.get(asset.path);
    if (!file) throw new Error(`Bestand ontbreekt: ${asset.path}`);
    const before = completedBytes;
    const digest = await hashFile(file, (processed) => onProgress?.(before + processed, pack.totalBytes, asset.path));
    completedBytes += file.size;
    assets.push({ ...asset, sha256: digest });
  }
  const hash = shaString(JSON.stringify(assets.map((asset) => [asset.path, asset.size, asset.sha256])));
  const { files: _files, remoteBaseUrl: _remoteBaseUrl, ...serializablePack } = pack;
  return {
    version: 1,
    pack: { ...serializablePack, hash, assets },
  };
}

export function runtimeFromManifest(manifest: PackManifest, files: Map<string, File>): RuntimePack {
  return { ...manifest.pack, files };
}

export function formatBytes(bytes: number) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KiB`;
  return `${bytes} B`;
}
