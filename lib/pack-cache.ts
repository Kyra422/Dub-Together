"use client";

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { hashFile } from "./choicer-packs";
import { mapConcurrent } from "./concurrency.ts";
import type { PackManifest } from "./types";

type StorageManagerWithDirectory = StorageManager & {
  getDirectory?: () => Promise<FileSystemDirectoryHandle>;
};

const DOWNLOAD_CONCURRENCY = 3;
const CACHE_VERSION = 2;

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason ?? new DOMException("download_aborted", "AbortError");
}

async function withPackLock<T>(packHash: string, signal: AbortSignal | undefined, work: () => Promise<T>) {
  const locks = navigator.locks;
  if (!locks) return work();
  return locks.request(`dub-together-pack-${packHash.replace(/[^a-f0-9]/gi, "_")}`, { mode: "exclusive", signal }, work);
}

async function cacheRoot() {
  const manager = navigator.storage as StorageManagerWithDirectory;
  if (!manager.getDirectory) throw new Error("persistent_storage_unsupported");
  const originRoot = await manager.getDirectory();
  return originRoot.getDirectoryHandle("dub-together", { create: true });
}

async function packDirectory(packHash: string, create = true) {
  return (await cacheRoot()).getDirectoryHandle(packHash.replace(/[^a-f0-9]/gi, "_"), { create });
}

async function fileHandleFor(root: FileSystemDirectoryHandle, path: string, create: boolean) {
  const parts = path.replaceAll("\\", "/").split("/").filter(Boolean);
  if (!parts.length || parts.some((part) => part === "..")) throw new Error("invalid_cache_path");
  let directory = root;
  for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part, { create });
  return directory.getFileHandle(parts.at(-1)!, { create });
}

export async function cacheManifest(manifest: PackManifest) {
  const root = await packDirectory(manifest.pack.hash);
  const handle = await root.getFileHandle("manifest.json", { create: true });
  const writable = await handle.createWritable();
  await writable.write(JSON.stringify({ cacheVersion: CACHE_VERSION, manifest }));
  await writable.close();
}

export async function cacheFile(packHash: string, path: string, source: File) {
  const root = await packDirectory(packHash);
  const handle = await fileHandleFor(root, path, true);
  try {
    const existing = await handle.getFile();
    if (existing.size === source.size && existing.lastModified === source.lastModified) return;
  } catch {
    // The file will be written below.
  }
  const writable = await handle.createWritable();
  await writable.write(source);
  await writable.close();
}

export function cachedMediaUrl(packHash: string, path: string) {
  return `/__dub_media__/${encodeURIComponent(packHash)}/${encodeURIComponent(path)}`;
}

export async function readCachedManifest(packHash: string) {
  try {
    const root = await packDirectory(packHash, false);
    const file = await (await root.getFileHandle("manifest.json")).getFile();
    const cached = JSON.parse(await file.text()) as { cacheVersion?: number; manifest?: PackManifest };
    if (cached.cacheVersion !== CACHE_VERSION || cached.manifest?.version !== 1 || cached.manifest.pack.hash !== packHash) return null;
    return cached.manifest;
  } catch {
    return null;
  }
}

export async function cacheLocalPack(manifest: PackManifest, sourceFiles: Map<string, File>, onProgress?: (done: number, total: number, path: string) => void) {
  const root = await packDirectory(manifest.pack.hash);
  let done = 0;
  for (const asset of manifest.pack.assets) {
    const source = sourceFiles.get(asset.path);
    if (!source) throw new Error(`Bestand ontbreekt: ${asset.path}`);
    const handle = await fileHandleFor(root, asset.path, true);
    const writable = await handle.createWritable();
    await writable.write(source);
    await writable.close();
    done += asset.size;
    onProgress?.(done, manifest.pack.totalBytes, asset.path);
  }
  await cacheManifest(manifest);
}

export async function downloadPack(
  manifest: PackManifest,
  getAsset: (assetId: string, signal: AbortSignal) => Promise<Response>,
  onProgress?: (done: number, total: number, path: string) => void,
  signal?: AbortSignal,
) {
  return withPackLock(manifest.pack.hash, signal, async () => {
    const failureController = new AbortController();
    const downloadSignal = signal ? AbortSignal.any([signal, failureController.signal]) : failureController.signal;
    throwIfAborted(downloadSignal);
    const root = await packDirectory(manifest.pack.hash);
    let completed = 0;
    const report = (bytes: number, path: string) => {
      completed += bytes;
      onProgress?.(Math.min(completed, manifest.pack.totalBytes), manifest.pack.totalBytes, path);
    };

    await mapConcurrent(manifest.pack.assets, DOWNLOAD_CONCURRENCY, async (asset) => {
      throwIfAborted(downloadSignal);
      const handle = await fileHandleFor(root, asset.path, true);
      let valid = false;
      try {
        const cached = await handle.getFile();
        if (cached.size === asset.size) valid = (await hashFile(cached)) === asset.sha256;
      } catch {
        valid = false;
      }
      throwIfAborted(downloadSignal);
      if (valid) {
        report(asset.size, asset.path);
        return;
      }

      const response = await getAsset(asset.id, downloadSignal);
      if (!response.ok || !response.body) throw new Error(`Download mislukt: ${asset.path}`);
      const writable = await handle.createWritable();
      const reader = response.body.getReader();
      const hasher = sha256.create();
      let fileDone = 0;
      try {
        while (true) {
          throwIfAborted(downloadSignal);
          const { value, done } = await reader.read();
          if (done) break;
          hasher.update(value);
          await writable.write(value);
          fileDone += value.byteLength;
          report(value.byteLength, asset.path);
        }
        throwIfAborted(downloadSignal);
        await writable.close();
      } catch (error) {
        await reader.cancel().catch(() => undefined);
        await writable.abort().catch(() => undefined);
        throw error;
      } finally {
        reader.releaseLock();
      }
      const digest = bytesToHex(hasher.digest());
      if (fileDone !== asset.size || digest !== asset.sha256) throw new Error(`Checksum klopt niet: ${asset.path}`);
    }, (error) => failureController.abort(error));

    throwIfAborted(downloadSignal);
    await cacheManifest(manifest);
    return loadCachedFilesUnlocked(manifest);
  });
}

async function loadCachedFilesUnlocked(manifest: PackManifest) {
  const root = await packDirectory(manifest.pack.hash, false);
  const files = new Map<string, File>();
  for (const asset of manifest.pack.assets) {
    const file = await (await fileHandleFor(root, asset.path, false)).getFile();
    if (file.size !== asset.size) throw new Error(`Cache is onvolledig: ${asset.path}`);
    files.set(asset.path, new File([file], asset.path, { type: asset.type, lastModified: file.lastModified }));
  }
  return files;
}

export async function loadCachedFiles(manifest: PackManifest, signal?: AbortSignal) {
  return withPackLock(manifest.pack.hash, signal, () => loadCachedFilesUnlocked(manifest));
}
