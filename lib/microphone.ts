"use client";

export type MicStatus = "idle" | "ready" | "recording" | "error";

export type MicSnapshot = {
  status: MicStatus;
  deviceId: string;
  deviceLabel: string;
  level: number;
  waveform: number[];
  error: string;
};

const WAVEFORM_BARS = 96;

const workletCode = `
class DubPcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.active = false;
    this.framesLeft = 0;
    this.port.onmessage = (event) => {
      if (event.data && event.data.command === 'start') {
        this.active = true;
        this.framesLeft = Math.max(0, Math.trunc(event.data.maxFrames || 0));
      }
      if (event.data && event.data.command === 'stop') {
        this.active = false;
        this.port.postMessage({ type: 'stopped' });
      }
    };
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (this.active && channel && channel.length) {
      const frameCount = this.framesLeft > 0 ? Math.min(channel.length, this.framesLeft) : channel.length;
      const copy = channel.slice(0, frameCount);
      this.port.postMessage(copy.buffer, [copy.buffer]);
      if (this.framesLeft > 0) {
        this.framesLeft -= frameCount;
        if (this.framesLeft <= 0) {
          this.active = false;
          this.port.postMessage({ type: 'auto-stopped' });
        }
      }
    }
    return true;
  }
}
registerProcessor('dub-pcm-processor', DubPcmProcessor);
`;

export function encodePcmWav(chunks: Float32Array[], sampleRate: number) {
  const frameCount = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const buffer = new ArrayBuffer(44 + frameCount * 2);
  const view = new DataView(buffer);
  const write = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + frameCount * 2, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, frameCount * 2, true);
  let offset = 44;
  for (const chunk of chunks) {
    for (const sample of chunk) {
      const normalized = Math.max(-1, Math.min(1, sample));
      view.setInt16(offset, normalized < 0 ? normalized * 0x8000 : normalized * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([buffer], { type: "audio/wav" });
}

export function limitPcmFrames(chunks: Float32Array[], maxFrames: number) {
  if (!Number.isFinite(maxFrames) || maxFrames <= 0) return chunks.map((chunk) => chunk.slice());
  const limited: Float32Array[] = [];
  let framesLeft = Math.trunc(maxFrames);
  for (const chunk of chunks) {
    if (framesLeft <= 0) break;
    const frameCount = Math.min(chunk.length, framesLeft);
    limited.push(chunk.slice(0, frameCount));
    framesLeft -= frameCount;
  }
  return limited;
}

export function normalizePcmChunks(
  chunks: Float32Array[],
  { targetRms = 0.14, peakLimit = 0.92, maxGain = 6, noiseFloor = 0.001 } = {},
) {
  let peak = 0;
  let squareSum = 0;
  let sampleCount = 0;
  for (const chunk of chunks) {
    for (const sample of chunk) {
      const absolute = Math.abs(sample);
      peak = Math.max(peak, absolute);
      squareSum += sample * sample;
      sampleCount += 1;
    }
  }
  if (!sampleCount) return [];
  const rms = Math.sqrt(squareSum / sampleCount);
  if (rms < noiseFloor || peak === 0) return chunks.map((chunk) => chunk.slice());
  const gain = Math.max(1, Math.min(maxGain, targetRms / rms, peakLimit / peak));
  return chunks.map((chunk) => {
    const normalized = new Float32Array(chunk.length);
    for (let index = 0; index < chunk.length; index += 1) {
      normalized[index] = Math.max(-peakLimit, Math.min(peakLimit, chunk[index] * gain));
    }
    return normalized;
  });
}

export class MicrophoneEngine {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private worklet: AudioWorkletNode | null = null;
  private silent: GainNode | null = null;
  private chunks: Float32Array[] = [];
  private targetFrames = 0;
  private recordedFrames = 0;
  private waveformBins = new Float32Array(WAVEFORM_BARS);
  private rollingPeaks: number[] = [];
  private onAutoStop: (() => void) | null = null;
  private startResolver: (() => void) | null = null;
  private stopResolver: (() => void) | null = null;
  private subscribers = new Set<(snapshot: MicSnapshot) => void>();
  private frame = 0;
  private lastMeterEmit = 0;
  private generation = 0;
  private snapshot: MicSnapshot = { status: "idle", deviceId: "", deviceLabel: "", level: 0, waveform: [], error: "" };

  subscribe(listener: (snapshot: MicSnapshot) => void) {
    this.subscribers.add(listener);
    listener(this.snapshot);
    return () => this.subscribers.delete(listener);
  }

  private emit(next: Partial<MicSnapshot>) {
    this.snapshot = { ...this.snapshot, ...next };
    for (const subscriber of this.subscribers) subscriber(this.snapshot);
  }

  async devices() {
    return (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === "audioinput");
  }

  async setup(deviceId = "") {
    await this.closeStream();
    const generation = ++this.generation;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          channelCount: 1,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      const track = stream.getAudioTracks()[0];
      if (!track) throw new Error("Geen audiotrack ontvangen van deze microfoon.");
      track.addEventListener("ended", () => {
        if (this.generation === generation) this.emit({ status: "error", error: "De microfoonverbinding is gestopt." });
      });
      track.addEventListener("mute", () => {
        if (this.generation === generation) this.emit({ error: "De microfoon geeft tijdelijk geen geluid door." });
      });
      track.addEventListener("unmute", () => {
        if (this.generation === generation) this.emit({ error: "" });
      });
      const context = new AudioContext({ latencyHint: "interactive" });
      await context.resume();
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      const moduleUrl = URL.createObjectURL(new Blob([workletCode], { type: "text/javascript" }));
      await context.audioWorklet.addModule(moduleUrl);
      URL.revokeObjectURL(moduleUrl);
      const worklet = new AudioWorkletNode(context, "dub-pcm-processor", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      const silent = context.createGain();
      silent.gain.value = 0;
      source.connect(worklet).connect(silent).connect(context.destination);
      worklet.port.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          const chunk = new Float32Array(event.data);
          this.chunks.push(chunk);
          this.addWaveformChunk(chunk);
          this.startResolver?.();
          this.startResolver = null;
        }
        else if (event.data?.type === "auto-stopped") {
          const callback = this.onAutoStop;
          this.onAutoStop = null;
          callback?.();
        }
        else if (event.data?.type === "stopped") {
          this.stopResolver?.();
          this.stopResolver = null;
        }
      };
      this.context = context;
      this.stream = stream;
      this.source = source;
      this.analyser = analyser;
      this.worklet = worklet;
      this.silent = silent;
      this.emit({
        status: "ready",
        deviceId: track.getSettings().deviceId ?? deviceId,
        deviceLabel: track.label || "Microfoon",
        waveform: [],
        error: "",
      });
      this.monitorLevel();
    } catch (error) {
      const message = error instanceof DOMException && error.name === "NotAllowedError"
        ? "Microfoontoegang is geweigerd. Sta toegang toe in je browser."
        : error instanceof Error ? error.message : "Microfoon kon niet worden geopend.";
      this.emit({ status: "error", error: message, level: 0, waveform: [] });
      throw error;
    }
  }

  async start(maxDurationSeconds = 0, onAutoStop?: () => void) {
    if (this.snapshot.status === "recording") throw new Error("microphone_already_recording");
    if (!this.context || !this.worklet || this.snapshot.status !== "ready") throw new Error("microphone_not_ready");
    const track = this.stream?.getAudioTracks()[0];
    if (!track || track.readyState !== "live" || !track.enabled) {
      this.emit({ status: "error", error: "De gekozen microfoon is niet meer actief. Open hem opnieuw." });
      throw new Error("microphone_track_inactive");
    }
    if (this.context.state !== "running") await this.context.resume();
    if (this.context.state !== "running") {
      this.emit({ status: "error", error: "De browser heeft audio gepauzeerd. Klik opnieuw op Microfoon inschakelen." });
      throw new Error("microphone_context_suspended");
    }
    this.chunks = [];
    this.recordedFrames = 0;
    this.targetFrames = maxDurationSeconds > 0
      ? Math.max(1, Math.round(maxDurationSeconds * this.context.sampleRate))
      : 0;
    this.waveformBins = new Float32Array(WAVEFORM_BARS);
    this.rollingPeaks = [];
    this.onAutoStop = onAutoStop ?? null;
    const firstFrame = new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.startResolver = null;
        reject(new Error("microphone_no_audio_frames"));
      }, 3_000);
      this.startResolver = () => {
        window.clearTimeout(timeout);
        resolve();
      };
    });
    this.emit({ status: "recording", waveform: Array(WAVEFORM_BARS).fill(0), error: "" });
    this.worklet.port.postMessage({ command: "start", maxFrames: this.targetFrames });
    try {
      await firstFrame;
    } catch (error) {
      this.worklet.port.postMessage({ command: "stop" });
      this.chunks = [];
      this.onAutoStop = null;
      this.emit({ status: "ready", error: "Er kwamen geen audioframes binnen. Reset de microfoon en probeer opnieuw." });
      throw error;
    }
  }

  async stop() {
    if (!this.context || !this.worklet || this.snapshot.status !== "recording") throw new Error("microphone_not_recording");
    this.onAutoStop = null;
    await new Promise<void>((resolve) => {
      const fallback = window.setTimeout(() => {
        this.stopResolver = null;
        resolve();
      }, 250);
      this.stopResolver = () => { window.clearTimeout(fallback); resolve(); };
      this.worklet!.port.postMessage({ command: "stop" });
    });
    if (!this.chunks.length) {
      this.emit({ status: "ready", error: "De opname bevatte geen audioframes. Reset de microfoon en probeer opnieuw." });
      throw new Error("microphone_no_audio_frames");
    }
    const limited = limitPcmFrames(this.chunks, this.targetFrames);
    const normalized = normalizePcmChunks(limited);
    const blob = encodePcmWav(normalized, this.context.sampleRate);
    this.chunks = [];
    this.emit({ status: "ready", waveform: this.displayWaveform() });
    return blob;
  }

  async closeStream() {
    this.generation += 1;
    cancelAnimationFrame(this.frame);
    this.startResolver = null;
    this.onAutoStop = null;
    this.stopResolver?.();
    this.stopResolver = null;
    this.worklet?.disconnect();
    this.source?.disconnect();
    this.analyser?.disconnect();
    this.silent?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    await this.context?.close().catch(() => undefined);
    this.context = null;
    this.stream = null;
    this.worklet = null;
    this.source = null;
    this.analyser = null;
    this.targetFrames = 0;
    this.recordedFrames = 0;
    this.waveformBins = new Float32Array(WAVEFORM_BARS);
    this.rollingPeaks = [];
    this.emit({ status: "idle", level: 0, waveform: [] });
  }

  private addWaveformChunk(chunk: Float32Array) {
    if (this.targetFrames > 0) {
      for (let index = 0; index < chunk.length; index += 1) {
        const bin = Math.min(
          WAVEFORM_BARS - 1,
          Math.floor(((this.recordedFrames + index) / this.targetFrames) * WAVEFORM_BARS),
        );
        this.waveformBins[bin] = Math.max(this.waveformBins[bin], Math.abs(chunk[index]));
      }
    } else {
      let peak = 0;
      for (const sample of chunk) peak = Math.max(peak, Math.abs(sample));
      this.rollingPeaks.push(peak);
      if (this.rollingPeaks.length > WAVEFORM_BARS) this.rollingPeaks.shift();
    }
    this.recordedFrames += chunk.length;
  }

  private displayWaveform() {
    const source = this.targetFrames > 0 ? [...this.waveformBins] : this.rollingPeaks;
    const padded = this.targetFrames > 0
      ? source
      : [...Array(Math.max(0, WAVEFORM_BARS - source.length)).fill(0), ...source];
    const maximum = Math.max(0.04, ...padded);
    return padded.map((peak) => Math.min(1, peak / maximum));
  }

  private monitorLevel = () => {
    if (!this.analyser) return;
    const samples = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const sample of samples) sum += sample * sample;
    const rms = Math.sqrt(sum / samples.length);
    const now = performance.now();
    if (now - this.lastMeterEmit >= 50) {
      this.lastMeterEmit = now;
      this.emit({
        level: Math.min(1, rms * 8),
        ...(this.snapshot.status === "recording" ? { waveform: this.displayWaveform() } : {}),
      });
    }
    this.frame = requestAnimationFrame(this.monitorLevel);
  };
}
