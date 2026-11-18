
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
  let desiredWidth = 0;
  let desiredHeight = 0;

  function setTargetSize(w, h) {
    if (typeof w === 'number' && Number.isFinite(w) && w > 0) {
      desiredWidth = Math.min(3840, Math.max(320, Math.round(w) & ~1));
    }
    if (typeof h === 'number' && Number.isFinite(h) && h > 0) {
      desiredHeight = Math.min(2160, Math.max(240, Math.round(h) & ~1));
    }
  }

  function currentTargetSize() {
    const targetW = desiredWidth > 0 ? desiredWidth : Math.max(320, (window.innerWidth || 1280) & ~1);
    const targetH = desiredHeight > 0 ? desiredHeight : Math.max(240, (window.innerHeight || 720) & ~1);
    return { targetW, targetH };
  }

  async function applyTrackConstraints(track) {
    if (!track || track.readyState !== 'live') return null;
    track.contentHint = 'detail';
    const { targetW, targetH } = currentTargetSize();
    try {
      await track.applyConstraints({
        width: { ideal: targetW },
        height: { ideal: targetH },
        frameRate: { ideal: 30, max: 30 },
      });
    } catch {}
    try {
      return typeof track.getSettings === 'function' ? track.getSettings() : null;
    } catch {
      return null;
    }
  }

  function getSettings() {
    const track = stream && stream.getVideoTracks ? stream.getVideoTracks()[0] : null;
    if (!track || track.readyState !== 'live' || typeof track.getSettings !== 'function') {
      return { active: false, width: 0, height: 0 };
    }
    try {
      const s = track.getSettings();
      return { active: true, width: Number(s.width) || 0, height: Number(s.height) || 0 };
    } catch {
      return { active: false, width: 0, height: 0 };
    }
  }

  async function acquire() {
    if (!navigator.mediaDevices) {
      throw new Error('navigator.mediaDevices is unavailable in this page context.');
    }
    const { targetW, targetH } = currentTargetSize();
    const tries = [];
    if (window.__morikoRtcStreamId) {
      tries.push(() => navigator.mediaDevices.getUserMedia({
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: window.__morikoRtcStreamId,
            maxWidth: targetW,
            maxHeight: targetH,
            maxFrameRate: 30,
          },
        },
        audio: false,
      }));
    }
    tries.push(() => navigator.mediaDevices.getDisplayMedia({
      // Capture follows the tab's active viewport dimensions at 30fps.
      video: { width: { ideal: targetW }, height: { ideal: targetH }, frameRate: { ideal: 30, max: 30 } },
      preferCurrentTab: true,
      selfBrowserSurface: 'include',
      audio: false,
    }));
    tries.push(() => navigator.mediaDevices.getDisplayMedia({
      video: { width: { ideal: targetW }, height: { ideal: targetH }, frameRate: { ideal: 30, max: 30 } },
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
        const s = await cap(p, 1800);
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

  async function start(w, h) {
    setTargetSize(w, h);
    log('start() requested');
    await stop();
    signal({ type: 'acquiring' });
    const s = await acquire();
    stream = s;
    for (const track of stream.getVideoTracks()) {
      await applyTrackConstraints(track);
      track.addEventListener('ended', () => signal({ type: 'rtc-ended' }));
    }
    pc = new RTCPeerConnection({ iceServers: [] });
    pc.onicecandidate = (event) => {
      if (event.candidate) signal({ type: 'ice', candidate: event.candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => {
      signal({ type: 'state', state: pc ? pc.connectionState : 'closed' });
    };
    for (const track of stream.getTracks()) {
      const sender = pc.addTrack(track, stream);
      try {
        if (sender && typeof sender.getParameters === 'function' && typeof sender.setParameters === 'function') {
          const params = sender.getParameters();
          params.degradationPreference = 'maintain-resolution';
          void sender.setParameters(params).catch(() => {});
        }
      } catch {}
    }
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    log('offer created (' + pc.localDescription.sdp.length + ' bytes sdp) — sending to panel');
    signal({ type: 'offer', sdp: pc.localDescription.sdp });
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
    if (pc) {
      pc.onicecandidate = null;
      pc.onconnectionstatechange = null;
      try { pc.close(); } catch {}
      pc = null;
    }
    if (stream) {
      for (const track of stream.getTracks()) { try { track.stop(); } catch {} }
      stream = null;
    }
    iceQueue = [];
  }

  async function resize(w, h) {
    setTargetSize(w, h);
    if (!stream) return { active: false, width: 0, height: 0 };
    let lastSettings = null;
    for (const track of stream.getVideoTracks()) {
      const s = await applyTrackConstraints(track);
      if (s) lastSettings = s;
    }
    const settings = lastSettings || getSettings();
    const width = Number(settings && settings.width) || 0;
    const height = Number(settings && settings.height) || 0;
    log('resize applied: requested=' + desiredWidth + 'x' + desiredHeight + ' track=' + width + 'x' + height);
    return { active: Boolean(stream), width, height };
  }

  window.__morikoRtc = { start, accept, addIce, stop, resize, getSettings, setStreamId: (id) => { window.__morikoRtcStreamId = id; } };
})();
`;
