# Netflix Watch Party

Real-time synced Netflix playback + persisted chat between two devices — a Mac
(any browser) and an Android phone/tablet (Firefox for Android).

## How it works

- `userscript/netflix-watch-party.user.js` runs on `netflix.com/watch/*` pages.
  It finds Netflix's `<video>` element, listens for play/pause/seek, and
  broadcasts those over WebSocket. It also shows a small draggable chat panel.
- `server/` is a small Node/Express/Socket.IO relay. It forwards playback
  events between the two people in a room, relays chat, and saves chat
  history to a JSON file per room so it survives reconnects.
- Both devices run the **same script**, connected to the **same deployed
  server**, using the **same room code**.

Netflix's DRM protects the decoded video picture, not the `<video>` element's
JS control surface — `currentTime`, `.play()`, `.pause()`, and its events are
all readable/controllable via script even though the actual frames can't be
captured. That's the mechanism this (and tools like Teleparty) rely on. It
only works while Netflix is open in a real browser tab — it cannot control
the native Netflix Android app.

## 1. Deploy the server

This is a standard Node app — deploy it anywhere that runs Node 18+
(Render, Railway, Fly.io, a VPS, etc.). Render instructions below, since
that's what you used for Cipherline:

1. Push this repo to GitHub.
2. On [render.com](https://render.com), **New > Web Service**, connect the repo.
3. Render should pick up `server/render.yaml` automatically. If asked manually:
   - Root directory: `server`
   - Build command: `npm install`
   - Start command: `npm start`
4. Deploy. Render gives you a URL like `https://your-app.onrender.com`.
5. Visit `https://your-app.onrender.com/` — you should see
   `Netflix Watch Party server is running.`

**Important — chat persistence on Render's free tier:** the free plan has no
persistent disk, so the `server/data/*.json` chat files are wiped on every
redeploy or when the free instance spins down from inactivity (they survive
normal reconnects/restarts within a running deploy, just not a fresh
deploy). If you want chat history to survive redeploys, add a small Render
Disk mounted at `server/data` (Render dashboard → your service → Disks),
or point `rooms.js` at any database later — the storage logic is isolated
in that one file.

## 2. Install the userscript

You don't need to edit anything — fetch it straight from your deployed
server and it self-configures with the right URL:

```
https://your-app.onrender.com/netflix-watch-party.user.js
```

**On Mac:**
1. Install [Tampermonkey](https://www.tampermonkey.net/) for your browser (Chrome, Firefox, Safari, Edge all work).
2. Open the URL above in that browser — Tampermonkey will prompt to install it. Confirm.

**On Android (phone or tablet):**
1. Install **Firefox for Android** from the Play Store. (Chrome for Android doesn't support extensions at all — Firefox is currently the only mainstream option that does.)
2. In Firefox, install **Violentmonkey** from the Firefox Add-ons page.
3. Open the same URL above in Firefox — Violentmonkey will prompt to install it. Confirm.
4. Watch Netflix through Firefox (netflix.com), not the native Netflix app — the native app can't be scripted at all.

Both devices are now running the same script, pointed at the same server.

## 3. Use it

1. Open the same Netflix title on both devices, in the browsers set up above.
2. A small "Watch Party" panel appears near the top-right of the page (drag it
   by the header if it's in the way; tap `–` to minimize).
3. On both devices: enter a name, enter the **same room code** (anything you
   both agree on — treat it like a shared password), tap **Connect**.
4. Play, pause, or seek on either side — the other follows automatically.
   A background heartbeat every few seconds corrects any drift over ~1.5s
   (e.g. from buffering differences).
5. Chat in the panel — messages are saved server-side and reload automatically
   if either of you reconnects or refreshes.

## Notes / limitations

- No login system beyond the room code — anyone who knows your server URL
  and room code can join. Fine for a private two-person tool; pick a
  non-obvious room code.
- The Android side must use Firefox (for extension support) and the Netflix
  website (not the app) — this is a platform limitation, not something this
  project can work around.
- Netflix periodically tweaks its page structure; the script looks for the
  page's `<video>` element directly rather than relying on CSS classes, which
  is the more stable approach, but occasional breakage after a Netflix
  redesign is possible.
