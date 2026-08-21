"use client";

import type { DubPack } from "./types";

export const BACKING_GAIN = 0.55;
export const DIALOGUE_GAIN = 1.08;

function encodeStereoWav(left: Float32Array, right: Float32Array, sampleRate: number) {
  const frames = Math.min(left.length, right.length);
  const buffer = new ArrayBuffer(44 + frames * 4);
  const view = new DataView(buffer);
  const write = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + frames * 4, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, frames * 4, true);
  let offset = 44;
  for (let index = 0; index < frames; index += 1) {
    for (const sample of [left[index], right[index]]) {
      const normalized = Math.max(-1, Math.min(1, sample));
      view.setInt16(offset, normalized < 0 ? normalized * 0x8000 : normalized * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([buffer], { type: "audio/wav" });
}

async function decode(context: BaseAudioContext, blob: Blob) {
  return context.decodeAudioData(await blob.arrayBuffer());
}

export async function mixDubToWav(
  pack: DubPack,
  files: Map<string, File>,
  takes: Map<string, Blob | Blob[]>,
  onProgress?: (label: string) => void,
) {
  const decoder = new AudioContext();
  try {
    const takeBuffers = new Map<string, AudioBuffer[]>();
    for (const [clipId, value] of takes) {
      const clipTakes = Array.isArray(value) ? value : [value];
      const decoded: AudioBuffer[] = [];
      for (const take of clipTakes) {
        onProgress?.(`Take verwerken: ${clipId}`);
        decoded.push(await decode(decoder, take));
      }
      takeBuffers.set(clipId, decoded);
    }
    let backing: AudioBuffer | null = null;
    if (pack.backingTrack && files.has(pack.backingTrack)) {
      onProgress?.("Backing track verwerken");
      backing = await decode(decoder, files.get(pack.backingTrack)!);
    }
    let duration = backing?.duration ?? 0;
    for (const placement of pack.placements) {
      const longest = Math.max(0, ...(takeBuffers.get(placement.clipId) ?? []).map((take) => take.duration));
      duration = Math.max(duration, placement.time + longest);
    }
    duration = Math.max(duration, 1);
    const sampleRate = 48_000;
    const offline = new OfflineAudioContext(2, Math.ceil(duration * sampleRate), sampleRate);
    const master = offline.createDynamicsCompressor();
    master.threshold.value = -8;
    master.knee.value = 8;
    master.ratio.value = 5;
    master.attack.value = 0.003;
    master.release.value = 0.18;
    master.connect(offline.destination);
    if (backing) {
      const source = offline.createBufferSource();
      const gain = offline.createGain();
      gain.gain.value = BACKING_GAIN;
      source.buffer = backing;
      source.connect(gain).connect(master);
      source.start(0);
    }
    for (const placement of pack.placements) {
      const clipTakes = takeBuffers.get(placement.clipId) ?? [];
      for (const take of clipTakes) {
        const source = offline.createBufferSource();
        const gain = offline.createGain();
        gain.gain.value = DIALOGUE_GAIN / Math.sqrt(Math.max(1, clipTakes.length));
        source.buffer = take;
        source.connect(gain).connect(master);
        source.start(placement.time);
      }
    }
    onProgress?.("Mix renderen");
    const rendered = await offline.startRendering();
    return encodeStereoWav(rendered.getChannelData(0), rendered.getChannelData(1), rendered.sampleRate);
  } finally {
    await decoder.close();
  }
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename.replace(/[<>:"/\\|?*]/g, "_");
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
