"use client";

import type { PackManifest, RuntimePack } from "./types";

type RepositoryPackEntry = {
  manifest: PackManifest;
  baseUrl: string;
};

type RepositoryPackCatalog = {
  version: 1;
  packs: RepositoryPackEntry[];
};

function joinAssetUrl(baseUrl: string, path: string) {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return `${baseUrl.replace(/\/$/, "")}/${encodedPath}`;
}

export function repositoryPackIconUrl(pack: RuntimePack) {
  if (!pack.remoteBaseUrl || !pack.icon) return "";
  return joinAssetUrl(pack.remoteBaseUrl, pack.icon);
}

export async function loadRepositoryPackCatalog(signal?: AbortSignal) {
  const response = await fetch("/pack-library.json", { cache: "no-store", signal });
  if (!response.ok) throw new Error(`pack_library_${response.status}`);
  const catalog = await response.json() as RepositoryPackCatalog;
  if (catalog.version !== 1 || !Array.isArray(catalog.packs)) throw new Error("pack_library_invalid");
  return catalog.packs.map(({ manifest, baseUrl }) => ({
    ...manifest.pack,
    files: new Map<string, File>(),
    remoteBaseUrl: baseUrl,
  } satisfies RuntimePack));
}

export async function hydrateRepositoryPack(
  pack: RuntimePack,
  onProgress?: (done: number, total: number, path: string) => void,
  signal?: AbortSignal,
) {
  if (!pack.remoteBaseUrl || pack.files.size >= pack.assets.length) return pack;

  const files = new Map<string, File>();
  let completed = 0;
  for (const asset of pack.assets) {
    const response = await fetch(joinAssetUrl(pack.remoteBaseUrl, asset.path), { signal });
    if (!response.ok) throw new Error(`pack_asset_${response.status}`);
    const blob = await response.blob();
    if (blob.size !== asset.size) throw new Error(`pack_asset_size_mismatch:${asset.path}`);
    const file = new File([blob], asset.path, { type: asset.type || blob.type, lastModified: 0 });
    files.set(asset.path, file);
    completed += file.size;
    onProgress?.(completed, pack.totalBytes, asset.path);
  }

  return { ...pack, files };
}
