/**
 * TAB_CAPTURE_SCRIPT — the in-page WebRTC peer (runs INSIDE the harness browser).
 *
 * Injected into every page via context addInitScript (manager.attachSignaling).
 * The ACTIVE tab captures ITSELF via getDisplayMedia and runs an
 * RTCPeerConnection in its own JS context; Node never touches media bytes —
 * it only relays SDP/ICE between this page and the panel over the panel WS
 * (webrtc.ts). GPU hardware encode happens inside Chromium itself.
 *
 * Signaling OUT (page → Node): window.__morikoRtcSignal(msg) — a Playwright
 *   exposeFunction binding installed by manager.attachSignaling.
 * Signaling IN (Node → page): page.evaluate('window.__morikoRtc.<fn>(...)')
 *   driven by webrtc.ts.
 *
 * API on window.__morikoRtc:
 *   start()          — acquire capture, build peer, emit {type:'offer', sdp}
 *   accept(sdp)      — apply the panel's answer
 *   addIce(candidate)— apply a remote ICE candidate
 *   stop()           — tear down peer + tracks (tab switch / last panel left)
 *   setStreamId(id)  — future extension hook (chromeMediaSourceId capture)
 *
 * Acquisition order (first success wins):
 *   1. streamId set via setStreamId (extension-provided source)
 *   2. getDisplayMedia preferCurrentTab (Chromium ≥ 107)
 *   3. getDisplayMedia plain
 *
 * NO CDP screencast exists in this transport — by design there is NO fallback.
 */
export const TAB_CAPTURE_SCRIPT = String.raw`
(() => {
  if (window !== window.top) return;
  if (window.__morikoRtc) return;
  const signal = (msg) => {
    try {
      if (typeof window.__morikoRtcSignal === 'function') window.__morikoRtcSignal(msg);
    } catch {}
  };
  const log = (text) => signal({ type: 'log', text: String(text) });
  let pc = null;
  let stream = null;
  let iceQueue = [];
  let statsTimer = null;
  let lastBytes = 0;

  async function acquire() {
    const tries = [];
    if (window.__morikoRtcStreamId) {
      tries.push(() => navigator.mediaDevices.getUserMedia({
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: window.__morikoRtcStreamId,
            maxFrameRate: 30,
          },
        },
        audio: false,
      }));
    }
    tries.push(() => navigator.mediaDevices.getDisplayMedia({
      // Capture follows the tab's native render resolution (no fixed downscale).
      video: { frameRate: 30 },
      preferCurrentTab: true,
      selfBrowserSurface: 'include',
      audio: false,
    }));
    tries.push(() => navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30 },
      audio: false,
    }));
    // Each attempt is hard-capped: getDisplayMedia can hang forever on a
    // picker dialog nobody can answer — that must surface as an error.
    const cap = (promise, ms) => Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('acquisition timeout (' + ms + 'ms)')), ms)),
    ]);
    let lastError = null;
    for (let i = 0; i < tries.length; i++) {
      log('acquire attempt ' + (i + 1) + '/' + tries.length);
      const p = tries[i]();
      try {
        const s = await cap(p, 6000);
        const track = s.getVideoTracks()[0];
        const settings = track ? track.getSettings() : {};
        const surface = settings.displaySurface || 'unknown';
        log('acquired: ' + (settings.width || '?') + 'x' + (settings.height || '?') + ' surface=' + surface);
        // PRIVACY GUARD — never stream the user's physical desktop. Only a
        // tab ('browser') or our own window is acceptable.
        if (surface === 'monitor') {
          for (const t of s.getTracks()) { try { t.stop(); } catch {} }
          lastError = new Error('surface=monitor rejected by privacy guard');
          log('REJECTED surface=monitor — privacy guard (physical desktop capture)');
          continue;
        }
        log('acquire OK surface=' + surface);
        return s;
      } catch (error) {
        lastError = error;
        p.then(st => { for (const t of st.getTracks()) { try { t.stop(); } catch {} } }).catch(() => {});
        log('acquire attempt ' + (i + 1) + ' FAILED: ' + ((error && error.name) || 'Error') + ': ' + ((error && error.message) || error));
        signal({ type: 'acquire-attempt-failed', error: String(error && error.message || error) });
      }
    }
    throw lastError || new Error('getDisplayMedia failed — no acceptable surface');
  }

  async function start() {
    log('start() requested');
    await stop();
    signal({ type: 'acquiring' });
    const s = await acquire();
    stream = s;
    for (const track of stream.getVideoTracks()) {
      track.contentHint = 'detail';
      track.addEventListener('ended', () => signal({ type: 'rtc-ended' }));
    }
    pc = new RTCPeerConnection({ iceServers: [] });
    pc.onicecandidate = (event) => {
      if (event.candidate) signal({ type: 'ice', candidate: event.candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => {
      signal({ type: 'state', state: pc ? pc.connectionState : 'closed' });
    };
    for (const track of stream.getTracks()) pc.addTrack(track, stream);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    log('offer created (' + pc.localDescription.sdp.length + ' bytes sdp) — sending to panel');
    signal({ type: 'offer', sdp: pc.localDescription.sdp });
    if (statsTimer) clearInterval(statsTimer);
    statsTimer = setInterval(async () => {
      if (!pc || pc.connectionState !== 'connected') return;
      try {
        const stats = await pc.getStats();
        let fps = null, kbps = null, width = null, height = null;
        for (const entry of stats.values()) {
          if (entry.type === 'outbound-rtp' && entry.kind === 'video') {
            fps = typeof entry.framesPerSecond === 'number' ? Math.round(entry.framesPerSecond) : fps;
            if (typeof entry.bytesSent === 'number') {
              kbps = Math.round((entry.bytesSent - lastBytes) * 8 / 5000);
              lastBytes = entry.bytesSent;
            }
          }
          if (entry.type === 'track' && entry.frameWidth) {
            width = entry.frameWidth; height = entry.frameHeight;
          }
        }
        signal({ type: 'stats', fps, kbps, width, height });
      } catch {}
    }, 5000);
  }

  async function accept(sdp) {
    if (!pc) return;
    await pc.setRemoteDescription({ type: 'answer', sdp });
    for (const candidate of iceQueue.splice(0)) {
      try { await pc.addIceCandidate(candidate); } catch {}
    }
  }

  async function addIce(candidate) {
    if (!pc) return;
    if (!pc.remoteDescription) { iceQueue.push(candidate); return; }
    try { await pc.addIceCandidate(candidate); } catch {}
  }

  async function stop() {
    if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
    if (pc) { try { pc.close(); } catch {} pc = null; }
    if (stream) {
      for (const track of stream.getTracks()) { try { track.stop(); } catch {} }
      stream = null;
    }
    iceQueue = [];
  }

  window.__morikoRtc = { start, accept, addIce, stop, setStreamId: (id) => { window.__morikoRtcStreamId = id; } };
})();
`;