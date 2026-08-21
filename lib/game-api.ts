"use client";

import type { PackManifest, RoomSnapshot, SessionCredentials } from "./types";
import { mapConcurrent } from "./concurrency.ts";

const ENDPOINT = "/api/game";
const UPLOAD_PART_CONCURRENCY = 3;
const UPLOAD_PART_ATTEMPTS = 4;

type UploadedPart = { partNumber: number; etag: string };

class NonRetryableUploadError extends Error {}

function waitBeforeRetry(attempt: number, signal: AbortSignal) {
  const delay = 200 * (2 ** attempt) + Math.floor(Math.random() * 100);
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("upload_aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delay);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function parseResponse(response: Response) {
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(String(body.error ?? `HTTP ${response.status}`));
  return body;
}

function authHeaders(credentials: SessionCredentials) {
  return { authorization: `Bearer ${credentials.token}` };
}

export async function createRoom(name: string, pin: string, language: "nl" | "en") {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "create_room", name, pin, language }),
  });
  return await parseResponse(response) as unknown as SessionCredentials;
}

export async function joinRoom(roomCode: string, name: string, pin: string) {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "join_room", roomCode, name, pin }),
  });
  return await parseResponse(response) as unknown as SessionCredentials;
}

export async function getSnapshot(credentials: SessionCredentials) {
  const query = new URLSearchParams({ action: "state", room: credentials.roomCode, player: credentials.playerId });
  const response = await fetch(`${ENDPOINT}?${query}`, { headers: authHeaders(credentials), cache: "no-store" });
  const body = await parseResponse(response) as { snapshot: RoomSnapshot };
  return body.snapshot;
}

export async function sendCommand(credentials: SessionCredentials, command: string, data: Record<string, unknown> = {}) {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(credentials) },
    body: JSON.stringify({ action: "command", roomCode: credentials.roomCode, playerId: credentials.playerId, command, ...data }),
  });
  const body = await parseResponse(response) as { snapshot?: RoomSnapshot };
  return body.snapshot;
}

async function postAuthed(credentials: SessionCredentials, body: Record<string, unknown>) {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(credentials) },
    body: JSON.stringify({ ...body, roomCode: credentials.roomCode, playerId: credentials.playerId }),
  });
  return parseResponse(response);
}

async function uploadPartWithRetry(
  credentials: SessionCredentials,
  assetId: string,
  uploadId: string,
  partNumber: number,
  chunk: Blob,
  signal: AbortSignal,
) {
  let lastError: unknown = new Error("upload_failed");
  for (let attempt = 0; attempt < UPLOAD_PART_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(`${ENDPOINT}?action=upload_part`, {
        method: "PUT",
        headers: {
          ...authHeaders(credentials),
          "x-room-code": credentials.roomCode,
          "x-player-id": credentials.playerId,
          "x-asset-id": assetId,
          "x-upload-id": uploadId,
          "x-part-number": String(partNumber),
          "x-part-size": String(chunk.size),
        },
        body: chunk,
        signal,
      });
      if (response.ok) return await parseResponse(response) as unknown as UploadedPart;
      const retryable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
      const body = await response.json().catch(() => ({})) as Record<string, unknown>;
      const responseError = new Error(String(body.error ?? `HTTP ${response.status}`));
      if (!retryable) throw new NonRetryableUploadError(responseError.message);
      lastError = responseError;
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      if (error instanceof NonRetryableUploadError) throw error;
      lastError = error;
    }
    if (attempt + 1 < UPLOAD_PART_ATTEMPTS) await waitBeforeRetry(attempt, signal);
  }
  throw lastError;
}

export async function uploadPack(
  credentials: SessionCredentials,
  manifest: PackManifest,
  files: Map<string, File>,
  onProgress?: (done: number, total: number, path: string) => void,
) {
  await postAuthed(credentials, { action: "pack_begin", manifest });
  let completed = 0;
  for (const asset of manifest.pack.assets) {
    const file = files.get(asset.path);
    if (!file) throw new Error(`Bestand ontbreekt: ${asset.path}`);
    const begin = await postAuthed(credentials, { action: "upload_begin", assetId: asset.id }) as { ready?: boolean; uploadId?: string; partSize?: number };
    if (!begin.ready) {
      const uploadId = begin.uploadId!;
      const partSize = begin.partSize ?? 8 * 1024 * 1024;
      const pendingParts: { partNumber: number; chunk: Blob }[] = [];
      for (let offset = 0; offset < file.size; offset += partSize) {
        const chunk = file.slice(offset, Math.min(file.size, offset + partSize));
        pendingParts.push({ partNumber: pendingParts.length + 1, chunk });
      }
      const controller = new AbortController();
      let uploadedForAsset = 0;
      const parts = await mapConcurrent(pendingParts, UPLOAD_PART_CONCURRENCY, async ({ partNumber, chunk }) => {
        const part = await uploadPartWithRetry(credentials, asset.id, uploadId, partNumber, chunk, controller.signal);
        uploadedForAsset += chunk.size;
        onProgress?.(completed + uploadedForAsset, manifest.pack.totalBytes, asset.path);
        return part;
      }, (error) => controller.abort(error));
      parts.sort((left, right) => left.partNumber - right.partNumber);
      await postAuthed(credentials, { action: "upload_complete", assetId: asset.id, parts });
    }
    completed += file.size;
    onProgress?.(completed, manifest.pack.totalBytes, asset.path);
  }
  await postAuthed(credentials, { action: "pack_ready" });
}

export async function fetchManifest(credentials: SessionCredentials, signal?: AbortSignal) {
  const query = new URLSearchParams({ action: "manifest", room: credentials.roomCode, player: credentials.playerId });
  const response = await fetch(`${ENDPOINT}?${query}`, { headers: authHeaders(credentials), signal });
  if (!response.ok) await parseResponse(response);
  return await response.json() as PackManifest;
}

export function fetchPackAsset(credentials: SessionCredentials, assetId: string, signal?: AbortSignal) {
  const query = new URLSearchParams({ action: "asset", room: credentials.roomCode, player: credentials.playerId, asset: assetId });
  return fetch(`${ENDPOINT}?${query}`, { headers: authHeaders(credentials), signal });
}

export async function createMediaUrl(credentials: SessionCredentials, assetId: string) {
  const body = await postAuthed(credentials, { action: "media_ticket", assetId }) as { url: string };
  return body.url;
}

export async function uploadTake(credentials: SessionCredentials, takeId: string, blob: Blob) {
  const response = await fetch(`${ENDPOINT}?action=take`, {
    method: "PUT",
    headers: {
      ...authHeaders(credentials),
      "content-type": "audio/wav",
      "x-room-code": credentials.roomCode,
      "x-player-id": credentials.playerId,
      "x-take-id": takeId,
      "x-byte-size": String(blob.size),
    },
    body: blob,
  });
  return parseResponse(response);
}

export function takeUrl(credentials: SessionCredentials, takeId: string, ownerId: string) {
  const query = new URLSearchParams({ action: "take", room: credentials.roomCode, player: credentials.playerId, take: takeId, owner: ownerId });
  return `${ENDPOINT}?${query}`;
}

export async function fetchTake(credentials: SessionCredentials, takeId: string, ownerId: string) {
  const response = await fetch(takeUrl(credentials, takeId, ownerId), { headers: authHeaders(credentials) });
  if (!response.ok) await parseResponse(response);
  return response.blob();
}
