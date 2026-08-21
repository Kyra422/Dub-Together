import { env } from "cloudflare:workers";
import type { ActiveTake, RoomState } from "../types";

type Bindings = {
  DB: D1Database;
  PACKS: R2Bucket;
};

export const bindings = env as unknown as Bindings;
export const MAX_PACK_BYTES = 1024 * 1024 * 1024;
export const MAX_PART_BYTES = 8 * 1024 * 1024;
export const MAX_TAKE_BYTES = 64 * 1024 * 1024;

let schemaPromise: Promise<void> | null = null;

export function ensureSchema() {
  schemaPromise ??= bindings.DB.batch([
    bindings.DB.prepare(`CREATE TABLE IF NOT EXISTS rooms (
      code TEXT PRIMARY KEY,
      host_player_id TEXT NOT NULL,
      pin_hash TEXT NOT NULL DEFAULT '',
      state_json TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`),
    bindings.DB.prepare(`CREATE TABLE IF NOT EXISTS players (
      room_code TEXT NOT NULL,
      id TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      ready INTEGER NOT NULL DEFAULT 0,
      spectator INTEGER NOT NULL DEFAULT 0,
      last_seen INTEGER NOT NULL,
      PRIMARY KEY (room_code, id)
    )`),
    bindings.DB.prepare(`CREATE TABLE IF NOT EXISTS assets (
      room_code TEXT NOT NULL,
      pack_hash TEXT NOT NULL,
      asset_id TEXT NOT NULL,
      path TEXT NOT NULL,
      object_key TEXT NOT NULL,
      size INTEGER NOT NULL,
      mime TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      upload_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      PRIMARY KEY (room_code, asset_id)
    )`),
    bindings.DB.prepare(`CREATE TABLE IF NOT EXISTS media_tickets (
      ticket_hash TEXT PRIMARY KEY,
      room_code TEXT NOT NULL,
      asset_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    )`),
    bindings.DB.prepare("CREATE INDEX IF NOT EXISTS media_tickets_expiry ON media_tickets (expires_at)"),
  ]).then(() => undefined).catch((error: unknown) => {
    schemaPromise = null;
    throw error;
  });
  return schemaPromise;
}

export function json(data: unknown, status = 200, headers?: HeadersInit) {
  return Response.json(data, {
    status,
    headers: { "cache-control": "no-store", ...headers },
  });
}

export function cleanCode(value: unknown) {
  return String(value ?? "").toUpperCase().replace(/[^A-Z2-9]/g, "").slice(0, 6);
}

export function cleanName(value: unknown) {
  return String(value ?? "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 28);
}

export function randomToken(bytes = 24) {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(data, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function randomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const values = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(values, (value) => alphabet[value % alphabet.length]).join("");
}

export async function hashSecret(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function makePinHash(pin: string) {
  if (!pin) return "";
  const salt = randomToken(12);
  return `${salt}:${await hashSecret(`${salt}:${pin}`)}`;
}

export async function verifyPin(pin: string, stored: string) {
  if (!stored) return true;
  const [salt, expected] = stored.split(":", 2);
  if (!salt || !expected) return false;
  return await hashSecret(`${salt}:${pin}`) === expected;
}

export function initialState(language: "nl" | "en"): RoomState {
  return {
    mode: "standard",
    phase: "lobby",
    language,
    clipIndex: 0,
    roleAssignments: {},
    pack: null,
    activeTake: null,
    takeHistory: {},
    playback: null,
    messages: [],
  };
}

export async function authenticate(request: Request, roomCode: string, playerId: string) {
  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!token || !roomCode || !playerId) return null;
  const row = await bindings.DB.prepare(
    `SELECT p.id, p.name, p.ready, p.spectator, p.last_seen, r.host_player_id
     FROM players p JOIN rooms r ON r.code = p.room_code
     WHERE p.room_code = ? AND p.id = ? AND p.token_hash = ?`,
  ).bind(roomCode, playerId, await hashSecret(token)).first<{
    id: string;
    name: string;
    ready: number;
    spectator: number;
    last_seen: number;
    host_player_id: string;
  }>();
  return row ? { ...row, isHost: row.host_player_id === row.id } : null;
}

export async function getRoom(code: string) {
  const row = await bindings.DB.prepare(
    "SELECT code, host_player_id, pin_hash, state_json, revision, created_at, updated_at FROM rooms WHERE code = ?",
  ).bind(code).first<{
    code: string;
    host_player_id: string;
    pin_hash: string;
    state_json: string;
    revision: number;
    created_at: number;
    updated_at: number;
  }>();
  if (!row) return null;
  return { ...row, state: JSON.parse(row.state_json) as RoomState };
}

export async function saveState(code: string, revision: number, state: RoomState) {
  const result = await bindings.DB.prepare(
    "UPDATE rooms SET state_json = ?, revision = revision + 1, updated_at = ? WHERE code = ? AND revision = ?",
  ).bind(JSON.stringify(state), Date.now(), code, revision).run();
  return result.meta.changes === 1;
}

export async function mutateState(
  code: string,
  mutate: (state: RoomState) => void | Promise<void>,
) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const room = await getRoom(code);
    if (!room) return null;
    const state = structuredClone(room.state);
    await mutate(state);
    if (await saveState(code, room.revision, state)) {
      return { state, revision: room.revision + 1 };
    }
  }
  throw new Error("room_update_conflict");
}

export function activeTakeIsParticipant(activeTake: ActiveTake | null, playerId: string) {
  return Boolean(activeTake?.participants.includes(playerId));
}

export function safeObjectSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 160);
}
