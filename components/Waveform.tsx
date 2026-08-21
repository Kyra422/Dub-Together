"use client";

import { useEffect, useMemo, useState } from "react";

type Props = {
  blob: Blob | null;
  label: string;
  accent?: "blue" | "coral" | "mint";
  samples?: number[];
  currentTime?: number;
  duration?: number;
  timelineDuration?: number;
  onSeek?: (fraction: number) => void;
};

const BAR_COUNT = 96;

function fitPeaksToBars(source: number[]) {
  if (source.length === BAR_COUNT) return source;
  if (!source.length) return Array(BAR_COUNT).fill(0);
  return Array.from({ length: BAR_COUNT }, (_, bar) => {
    const start = Math.floor((bar / BAR_COUNT) * source.length);
    const end = Math.max(start + 1, Math.ceil(((bar + 1) / BAR_COUNT) * source.length));
    return Math.max(0, ...source.slice(start, end));
  });
}

export function Waveform({
  blob,
  label,
  accent = "blue",
  samples,
  currentTime = 0,
  duration = 0,
  timelineDuration = 0,
  onSeek,
}: Props) {
  const [decoded, setDecoded] = useState<{ blob: Blob | null; timelineDuration: number; peaks: number[] }>({
    blob: null,
    timelineDuration: 0,
    peaks: [],
  });
  const progress = duration > 0 ? Math.max(0, Math.min(1, currentTime / duration)) : 0;

  useEffect(() => {
    let active = true;
    if (!blob) return () => { active = false; };
    void (async () => {
      const context = new AudioContext();
      try {
        const buffer = await context.decodeAudioData(await blob.arrayBuffer());
        const data = buffer.getChannelData(0);
        const timelineFrames = timelineDuration > 0
          ? Math.max(1, Math.round(timelineDuration * buffer.sampleRate))
          : data.length;
        const result: number[] = [];
        for (let bar = 0; bar < BAR_COUNT; bar += 1) {
          let peak = 0;
          const start = Math.floor((bar / BAR_COUNT) * timelineFrames);
          const end = Math.min(data.length, Math.ceil(((bar + 1) / BAR_COUNT) * timelineFrames));
          const step = Math.max(1, Math.floor(Math.max(1, end - start) / 90));
          for (let index = start; index < end; index += step) {
            peak = Math.max(peak, Math.abs(data[index]));
          }
          result.push(peak);
        }
        const maximum = Math.max(0.04, ...result);
        if (active) setDecoded({ blob, timelineDuration, peaks: result.map((peak) => Math.min(1, peak / maximum)) });
      } catch {
        if (active) setDecoded({ blob, timelineDuration, peaks: [] });
      } finally {
        await context.close();
      }
    })();
    return () => { active = false; };
  }, [blob, timelineDuration]);

  const liveBars = useMemo(() => fitPeaksToBars(samples ?? []), [samples]);
  const empty = useMemo(() => Array(BAR_COUNT).fill(0), []);
  const peaks = decoded.blob === blob && decoded.timelineDuration === timelineDuration ? decoded.peaks : empty;
  const bars = samples ? liveBars : blob && peaks.length ? peaks : empty;

  return (
    <button
      type="button"
      className={`waveform waveform-${accent}`}
      onClick={(event) => {
        if (!onSeek) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        onSeek((event.clientX - bounds.left) / bounds.width);
      }}
      aria-label={`${label} waveform`}
    >
      <span className="waveform-label">{label}</span>
      <span className="waveform-bars" aria-hidden="true">
        {bars.map((peak, index) => (
          <i
            key={index}
            className={index / bars.length <= progress ? "played" : ""}
            style={{ height: `${Math.max(8, Math.min(100, peak * 100))}%` }}
          />
        ))}
        <b className="waveform-playhead" style={{ left: `${progress * 100}%` }} />
      </span>
    </button>
  );
}
