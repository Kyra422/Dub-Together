const MEDIA_PREFIX = "/__dub_media__/";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

async function fileFromPath(packHash, filePath) {
  const storageRoot = await navigator.storage.getDirectory();
  let directory = await storageRoot.getDirectoryHandle("dub-together");
  directory = await directory.getDirectoryHandle(packHash.replace(/[^a-f0-9]/gi, "_"));
  const parts = filePath.split("/").filter(Boolean);
  for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part);
  return (await directory.getFileHandle(parts.at(-1))).getFile();
}

function mime(path) {
  const extension = path.split(".").pop().toLowerCase();
  return ({ ogv: "video/ogg", ogg: "audio/ogg", mp3: "audio/mpeg", wav: "audio/wav", mp4: "video/mp4" })[extension] || "application/octet-stream";
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (!url.pathname.startsWith(MEDIA_PREFIX)) return;
  event.respondWith((async () => {
    try {
      const encoded = url.pathname.slice(MEDIA_PREFIX.length).split("/");
      if (encoded.length !== 2) return new Response("Invalid media path", { status: 400 });
      const packHash = decodeURIComponent(encoded[0]);
      const filePath = decodeURIComponent(encoded[1]);
      if (!packHash || !filePath || filePath.split("/").some((part) => !part || part === "..")) return new Response("Invalid media path", { status: 400 });
      const file = await fileFromPath(packHash, filePath);
      const range = event.request.headers.get("range");
      const headers = new Headers({ "accept-ranges": "bytes", "content-type": file.type || mime(filePath), "cache-control": "private, max-age=3600" });
      if (!range) {
        headers.set("content-length", String(file.size));
        return new Response(event.request.method === "HEAD" ? null : file, { status: 200, headers });
      }
      const match = range.match(/^bytes=(\d*)-(\d*)$/);
      if (!match) return new Response("Invalid range", { status: 416, headers: { "content-range": `bytes */${file.size}` } });
      let start = match[1] ? Number(match[1]) : 0;
      let end = match[2] ? Number(match[2]) : file.size - 1;
      if (!match[1] && match[2]) start = Math.max(0, file.size - Number(match[2]));
      end = Math.min(file.size - 1, end);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= file.size) {
        return new Response("Range not satisfiable", { status: 416, headers: { "content-range": `bytes */${file.size}` } });
      }
      const slice = file.slice(start, end + 1, file.type || mime(filePath));
      headers.set("content-length", String(slice.size));
      headers.set("content-range", `bytes ${start}-${end}/${file.size}`);
      return new Response(event.request.method === "HEAD" ? null : slice, { status: 206, headers });
    } catch {
      return new Response("Media not cached", { status: 404 });
    }
  })());
});
