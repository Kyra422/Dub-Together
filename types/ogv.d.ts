declare module "ogv" {
  export const OGVLoader: { base: string };
  export class OGVPlayer extends HTMLElement {
    constructor(options?: Record<string, unknown>);
    src: string;
    currentTime: number;
    duration: number;
    paused: boolean;
    muted: boolean;
    preload: string;
    play(): Promise<void> | void;
    pause(): void;
  }
}
