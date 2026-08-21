# Dub packs

Drop each Choicer Voicer dub pack in its own folder here, then commit and push it.

Example:

```text
packs/
  My Cool Pack/
    _pack_info.ini
    dub_video.ogv
    001.ini
    001.ogg
    001.txt
    icon.png
```

During the build, `tools/build-pack-library.ts` automatically scans this folder and generates the in-game catalog. The game shows the pack immediately after the new deployment and only downloads its heavy media when someone starts or shares that pack.

The deployed app fetches pack assets from this public GitHub repository. GitHub does not accept normal Git files larger than 100 MiB, so very large individual video/audio files need another storage route (for example R2 or Git LFS).
