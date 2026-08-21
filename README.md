# Dub Together

Online multiplayer dubbing studio for Choicer Voicer dub packs.

## Add a dub pack

Put each pack in its own folder under `packs/` and push it to `main`. The build automatically indexes the folder and makes the pack appear in the in-game library. Heavy media is lazy-loaded only when that pack is selected.

```text
packs/
  My Pack/
    _pack_info.ini
    dub_video.ogv
    001.ini
    001.ogg
    001.txt
```

The multiplayer backend uses Cloudflare D1 for room state and R2 for shared packs and recorded takes.
