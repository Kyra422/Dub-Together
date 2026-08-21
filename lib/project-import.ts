"use client";

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { DubPlacement, GameMode } from "./types";

const MAX_IMPORTED_WAV_BYTES = 1024 * 1024 * 1024;
const MAX_IMPORTED_JSON_BYTES = 2 * 1024 * 1024;

export type ImportedPackIdentity = {
  hash: string;
  title: string;
  placements: DubPlacement[];
};

export type ImportedDubProject = {
  format: "dub-together-web-v1";
  packHash: string;
  packTitle: string;
  mode: GameMode;
  exportedAt: string;
  recordedClipIds: string[];
  placements: DubPlacement[];
  packFingerprint?: string;
};

export type ImportedDub = {
  project: ImportedDubProject;
  wav: File;
  match: "exact" | "fingerprint";
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeText(value: string) {
  return value.normalize("NFC").trim();
}

function normalizedPlacement(value: unknown): DubPlacement | null {
  if (!isRecord(value)
    || typeof value.clipId !== "string"
    || !Number.isInteger(value.placementIndex)
    || typeof value.time !== "number"
    || !Number.isFinite(value.time)
    || typeof value.audio !== "string"
    || typeof value.caption !== "string"
    || !Array.isArray(value.characters)
    || !value.characters.every((character) => typeof character === "string")
    || typeof value.dubOnly !== "boolean") return null;
  return {
    clipId: value.clipId,
    placementIndex: value.placementIndex as number,
    time: value.time,
    audio: value.audio,
    caption: value.caption,
    characters: value.characters as string[],
    dubOnly: value.dubOnly,
  };
}

export function createPackFingerprint(pack: Pick<ImportedPackIdentity, "title" | "placements">) {
  const placements = pack.placements.map((placement) => ({
    clipId: normalizeText(placement.clipId),
    placementIndex: placement.placementIndex,
    time: placement.time,
    audio: normalizeText(placement.audio).replaceAll("\\", "/").toLowerCase(),
    caption: normalizeText(placement.caption),
    characters: placement.characters.map(normalizeText).sort(),
    dubOnly: placement.dubOnly,
  })).sort((a, b) => a.time - b.time
    || (a.clipId < b.clipId ? -1 : a.clipId > b.clipId ? 1 : 0)
    || a.placementIndex - b.placementIndex);
  const descriptor = JSON.stringify({ title: normalizeText(pack.title).toLowerCase(), placements });
  return bytesToHex(sha256(new TextEncoder().encode(descriptor)));
}

async function isWaveFile(file: File) {
  if (file.size < 44 || file.size > MAX_IMPORTED_WAV_BYTES) return false;
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (bytes.byteLength < 12) return false;
  const tag = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end));
  return tag(0, 4) === "RIFF" && tag(8, 12) === "WAVE";
}

export async function parseImportedDub(input: File[] | FileList, selectedPack: string | ImportedPackIdentity): Promise<ImportedDub> {
  const files = Array.from(input);
  const jsonFiles = files.filter((file) => file.name.toLowerCase().endsWith(".json") || file.type === "application/json");
  const wavFiles = files.filter((file) => file.name.toLowerCase().endsWith(".wav") || ["audio/wav", "audio/x-wav"].includes(file.type));
  if (jsonFiles.length !== 1 || wavFiles.length !== 1) throw new Error("project_pair_required");
  if (!jsonFiles[0].size || jsonFiles[0].size > MAX_IMPORTED_JSON_BYTES) throw new Error("project_json_invalid");

  let raw: unknown;
  try {
    raw = JSON.parse(await jsonFiles[0].text());
  } catch {
    throw new Error("project_json_invalid");
  }
  if (!isRecord(raw)
    || raw.format !== "dub-together-web-v1"
    || typeof raw.packHash !== "string"
    || !raw.packHash
    || typeof raw.packTitle !== "string"
    || !Array.isArray(raw.placements)) {
    throw new Error("project_json_invalid");
  }
  const placements = raw.placements.map(normalizedPlacement);
  if (placements.some((placement) => placement === null)) throw new Error("project_json_invalid");
  const validPlacements = placements as DubPlacement[];
  const calculatedFingerprint = createPackFingerprint({ title: raw.packTitle, placements: validPlacements });
  if (raw.packFingerprint !== undefined
    && (typeof raw.packFingerprint !== "string" || raw.packFingerprint !== calculatedFingerprint)) {
    throw new Error("project_json_invalid");
  }

  const selectedPackHash = typeof selectedPack === "string" ? selectedPack : selectedPack.hash;
  const exactMatch = raw.packHash === selectedPackHash;
  const fingerprintMatch = typeof selectedPack !== "string"
    && calculatedFingerprint === createPackFingerprint(selectedPack);
  if (!exactMatch && !fingerprintMatch) throw new Error("project_pack_mismatch");
  if (!await isWaveFile(wavFiles[0])) throw new Error("project_wav_invalid");

  const project: ImportedDubProject = {
    format: "dub-together-web-v1",
    packHash: raw.packHash,
    packTitle: raw.packTitle,
    mode: raw.mode === "freestyle" || raw.mode === "gameshow" ? raw.mode : "standard",
    exportedAt: typeof raw.exportedAt === "string" ? raw.exportedAt : "",
    recordedClipIds: Array.isArray(raw.recordedClipIds) ? raw.recordedClipIds.filter((value): value is string => typeof value === "string") : [],
    placements: validPlacements,
    packFingerprint: calculatedFingerprint,
  };
  return { project, wav: wavFiles[0], match: exactMatch ? "exact" : "fingerprint" };
}
