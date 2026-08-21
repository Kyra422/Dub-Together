export type Language = "nl" | "en";
export type GameMode = "standard" | "freestyle" | "gameshow";

export type PackAsset = {
  id: string;
  path: string;
  size: number;
  type: string;
  sha256: string;
};

export type DubClip = {
  id: string;
  stem: string;
  caption: string;
  image: string;
  audio: string;
  timestamps: number[];
  time: number;
  characters: string[];
  tags: string[];
  dubOnly: boolean;
  metadata: string;
};

export type DubPlacement = {
  clipId: string;
  placementIndex: number;
  time: number;
  audio: string;
  caption: string;
  characters: string[];
  dubOnly: boolean;
};

export type DubPack = {
  id: string;
  hash: string;
  basePath: string;
  title: string;
  subtitle: string;
  authors: string[];
  readme: string;
  icon: string;
  video: string;
  backingTrack: string;
  clips: DubClip[];
  placements: DubPlacement[];
  characters: string[];
  assets: PackAsset[];
  totalBytes: number;
};

export type RuntimePack = DubPack & {
  files: Map<string, File>;
  remoteBaseUrl?: string;
};

export type Player = {
  id: string;
  name: string;
  ready: boolean;
  spectator: boolean;
  isHost: boolean;
  lastSeen: number;
};

export type TakeSubmission = {
  status: "waiting" | "recording" | "uploaded" | "failed";
  storageKey?: string;
  byteSize?: number;
  mime?: string;
};

export type ActiveTake = {
  id: string;
  clipId: string;
  startsAt: number;
  endsAt: number;
  participants: string[];
  submissions: Record<string, TakeSubmission>;
};

export type RoomPack = {
  hash: string;
  title: string;
  totalBytes: number;
  assetCount: number;
  status: "uploading" | "ready";
};

export type ChatMessage = {
  id: string;
  playerId: string;
  playerName: string;
  text: string;
  at: number;
};

export type RoomState = {
  mode: GameMode;
  phase: "lobby" | "studio" | "countdown" | "recording" | "review" | "watch";
  language: Language;
  clipIndex: number;
  roleAssignments: Record<string, string>;
  pack: RoomPack | null;
  activeTake: ActiveTake | null;
  takeHistory: Record<string, ActiveTake>;
  playback: null | { kind: "reference" | "dub"; startsAt: number; from: number };
  messages: ChatMessage[];
};

export type RoomSnapshot = {
  code: string;
  revision: number;
  serverTime: number;
  state: RoomState;
  players: Player[];
  localPlayerId: string;
  isHost: boolean;
};

export type SessionCredentials = {
  roomCode: string;
  playerId: string;
  token: string;
};

export type PackManifest = {
  version: 1;
  pack: Omit<DubPack, "assets"> & { assets: PackAsset[] };
};
