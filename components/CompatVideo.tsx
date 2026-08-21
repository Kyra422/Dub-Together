"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

export type VideoHandle = {
  play: () => Promise<void>;
  pause: () => void;
  currentTime: number;
  duration: number;
};

type MediaLike = HTMLElement & {
  play: () => Promise<void> | void;
  pause: () => void;
  currentTime: number;
  duration: number;
  muted: boolean;
};

type Props = {
  src: string;
  isOgv: boolean;
  muted?: boolean;
  onTimeUpdate?: (time: number) => void;
  onLoadedMetadata?: (duration: number) => void;
  onError?: (message: string) => void;
};

export const CompatVideo = forwardRef<VideoHandle, Props>(function CompatVideo(
  { src, isOgv, muted = true, onTimeUpdate, onLoadedMetadata, onError },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const nativeRef = useRef<HTMLVideoElement>(null);
  const mediaRef = useRef<MediaLike | null>(null);
  const callbacksRef = useRef({ onTimeUpdate, onLoadedMetadata, onError });
  callbacksRef.current = { onTimeUpdate, onLoadedMetadata, onError };

  useImperativeHandle(ref, () => ({
    async play() {
      const result = mediaRef.current?.play();
      if (result instanceof Promise) await result;
    },
    pause() { mediaRef.current?.pause(); },
    get currentTime() { return mediaRef.current?.currentTime ?? 0; },
    set currentTime(value: number) { if (mediaRef.current) mediaRef.current.currentTime = value; },
    get duration() { return mediaRef.current?.duration ?? 0; },
  }), []);

  useEffect(() => {
    if (isOgv || !nativeRef.current) return;
    const native = nativeRef.current;
    mediaRef.current = native;
    return () => { if (mediaRef.current === native) mediaRef.current = null; };
  }, [isOgv, src]);

  useEffect(() => {
    if (!isOgv || !src || !containerRef.current) return;
    let disposed = false;
    let player: MediaLike | null = null;
    void import("ogv").then((module) => {
      if (disposed || !containerRef.current) return;
      module.OGVLoader.base = "/ogv";
      const instance = new module.OGVPlayer({ worker: true }) as unknown as MediaLike & { src: string; preload: string };
      player = instance;
      mediaRef.current = instance;
      instance.className = "compat-video-player";
      instance.preload = "auto";
      instance.muted = muted;
      instance.addEventListener("timeupdate", () => callbacksRef.current.onTimeUpdate?.(instance.currentTime));
      instance.addEventListener("loadedmetadata", () => callbacksRef.current.onLoadedMetadata?.(instance.duration));
      instance.addEventListener("error", () => callbacksRef.current.onError?.("OGV-video kon niet worden gedecodeerd."));
      containerRef.current.appendChild(instance);
      instance.src = src;
    }).catch((error: unknown) => callbacksRef.current.onError?.(error instanceof Error ? error.message : "OGV-decoder kon niet laden."));
    return () => {
      disposed = true;
      player?.pause();
      player?.remove();
      if (mediaRef.current === player) mediaRef.current = null;
    };
  }, [isOgv, muted, src]);

  useEffect(() => {
    if (mediaRef.current) mediaRef.current.muted = muted;
  }, [muted]);

  if (isOgv) return <div ref={containerRef} className="compat-video" aria-label="Ogg Theora video" />;
  return <video
    ref={nativeRef}
    src={src}
    muted={muted}
    playsInline
    preload="metadata"
    onTimeUpdate={(event) => onTimeUpdate?.(event.currentTarget.currentTime)}
    onLoadedMetadata={(event) => onLoadedMetadata?.(event.currentTarget.duration)}
    onError={() => onError?.("Video kan niet worden afgespeeld in deze browser.")}
  />;
});
