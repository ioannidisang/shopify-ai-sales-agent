// Local browser fixture only: real synthetic MediaStreamTracks, never getUserMedia,
// a Tavus/Daily connection, a camera, or a physical microphone.
export default {
  createCallObject(options) {
    const listeners = new Map();
    let destroyed = false, frame = 0, microphoneRequested = false, toneEnabled = false;
    const audioContext = new AudioContext();
    const oscillator = audioContext.createOscillator(); oscillator.frequency.value = 440;
    const localGain = audioContext.createGain(); localGain.gain.value = 0;
    const remoteGain = audioContext.createGain(); remoteGain.gain.value = 0;
    const localDestination = audioContext.createMediaStreamDestination();
    const remoteDestination = audioContext.createMediaStreamDestination();
    oscillator.connect(localGain).connect(localDestination);
    oscillator.connect(remoteGain).connect(remoteDestination);
    oscillator.start();
    const localTrack = localDestination.stream.getAudioTracks()[0]; localTrack.enabled = false;
    const localAudio = { state: 'off', persistentTrack: localTrack };
    const canvas = document.createElement('canvas'); canvas.width = 480; canvas.height = 270;
    const context = canvas.getContext('2d');
    const draw = () => {
      frame++;
      context.fillStyle = '#213e2d'; context.fillRect(0, 0, 480, 270);
      context.fillStyle = 'white'; context.font = 'bold 24px system-ui'; context.textAlign = 'center';
      context.fillText('SYNTHETIC AVATAR FIXTURE', 240, 105);
      context.font = '16px system-ui'; context.fillText('No camera / microphone / Tavus connection', 240, 145);
      context.fillText(`Moving frame ${frame}`, 240, 185);
    };
    draw();
    const stream = canvas.captureStream(5);
    let remoteVideoTrack = stream.getVideoTracks()[0];
    let remoteAudioTrack = remoteDestination.stream.getAudioTracks()[0];
    const allocatedTracks = [localTrack, remoteVideoTrack, remoteAudioTrack];
    const state = window.__avatarFixture = {
      created: true, cameraDisabled: options.videoSource === false,
      microphoneInitiallyOff: options.startAudioOff === true, microphoneEnabled: false,
      microphonePromptSuppressed: options.dailyConfig?.alwaysIncludeMicInPermissionPrompt === false,
      responds: 0, interrupts: 0, remoteReplacements: 0, injectedAutoplayBlocks: 0, destroyed: false,
    };
    const dialog = document.querySelector('[data-sales-agent]')?.shadowRoot?.querySelector('dialog');
    const video = dialog?.querySelector('video');
    const controls = document.createElement('details'); controls.className = 'synthetic-avatar-controls';
    controls.style.cssText = 'margin:12px 0;padding:12px;border:2px dashed #ab641b;background:#fff8ef;color:#182b20';
    const summary = document.createElement('summary'); summary.textContent = 'Synthetic media controls · no device capture'; controls.append(summary);
    const note = document.createElement('p');
    note.textContent = 'Test-only controls. Enable the widget microphone first, then confirm or reject synthetic permission here. Cancellation uses the widget button. These controls never ask for device access.';
    controls.append(note);
    const evidence = document.createElement('pre'); evidence.className = 'synthetic-avatar-evidence';
    evidence.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px';
    const controlButtons = [];
    const report = () => {
      const media = video?.srcObject instanceof MediaStream ? video.srcObject.getTracks() : [];
      evidence.textContent = JSON.stringify({ ...state, microphoneRequested, microphoneState: localAudio.state,
        localTrack: { kind: localTrack.kind, readyState: localTrack.readyState, enabled: localTrack.enabled, muted: localTrack.muted },
        remoteTracks: media.map(track => ({ kind: track.kind, readyState: track.readyState })),
        video: video ? { paused: video.paused, readyState: video.readyState, time: Math.round(video.currentTime * 10) / 10, width: video.videoWidth, height: video.videoHeight } : null,
        syntheticFrames: frame, syntheticAudioContext: audioContext.state, syntheticToneEnabled: toneEnabled,
      }, null, 2);
    };
    const emit = (event, payload) => { listeners.get(event)?.(payload); report(); };
    const addControl = (label, action) => {
      const control = document.createElement('button'); control.type = 'button'; control.textContent = label;
      control.style.cssText = 'margin:4px;padding:8px;font:inherit';
      control.addEventListener('click', () => { if (!destroyed) action(); report(); });
      controlButtons.push(control); controls.append(control); return control;
    };
    const makePlayable = async () => {
      await audioContext.resume();
      if (destroyed) return;
      // Deliberately also works after cancellation, so the actual transport must
      // mute this late track rather than claiming that permission is still wanted.
      localTrack.enabled = true; localAudio.state = 'playable'; state.microphoneEnabled = true;
      emit('track-started'); emit('participant-updated');
    };
    addControl('Confirm synthetic microphone permission', makePlayable);
    addControl('Deliver late permission after cancellation', makePlayable);
    addControl('Simulate microphone device error', () => {
      localAudio.state = 'blocked'; localTrack.enabled = false;
      emit('camera-error', { error: { type: 'permissions' } });
    });
    addControl('Replace remote audio and video tracks', () => {
      const oldVideo = remoteVideoTrack, oldAudio = remoteAudioTrack;
      remoteVideoTrack = oldVideo.clone(); remoteAudioTrack = oldAudio.clone();
      allocatedTracks.push(remoteVideoTrack, remoteAudioTrack);
      oldVideo.stop(); oldAudio.stop(); state.remoteReplacements++;
      emit('participant-updated');
    });
    addControl('Start silent synthetic audio clock', () => {
      void audioContext.resume().then(report);
    });
    addControl('Enable synthetic audio tone', () => {
      toneEnabled = true;
      void audioContext.resume().then(() => { remoteGain.gain.setValueAtTime(0.015, audioContext.currentTime); report(); });
    });
    addControl('Simulate fatal connection error', () => {
      emit('error', { error: { type: 'connection-error', details: { on: 'rtc-connection' } } });
      emit('left-meeting');
    });
    addControl('Simulate provider ejection', () => {
      emit('error', { error: { type: 'ejected' } }); emit('left-meeting');
    });
    // Inject one local play() rejection only when explicitly requested by the
    // fixture URL. The production fallback button must recover with native play.
    const originalPlay = video?.play;
    let blockNextPlay = new URL(location.href).searchParams.get('playback') === 'block-once';
    if (video && blockNextPlay) video.play = function () {
      if (blockNextPlay) {
        blockNextPlay = false; state.injectedAutoplayBlocks++; report();
        return Promise.reject(new DOMException('Synthetic autoplay rejection', 'NotAllowedError'));
      }
      return originalPlay.call(this);
    };
    controls.append(evidence);
    dialog?.querySelector('.synthetic-avatar-controls')?.remove();
    dialog?.append(controls);
    report();
    const frameTimer = setInterval(() => { draw(); report(); }, 200);
    return {
      on(event, handler) { listeners.set(event, handler); return this; },
      participants() { return {
        local: { local: true, tracks: { audio: localAudio } },
        replica: { local: false, tracks: { video: { state: 'playable', persistentTrack: remoteVideoTrack }, audio: { state: 'playable', persistentTrack: remoteAudioTrack } } },
      }; },
      async join() { if (destroyed) throw new Error('Stopped fixture'); },
      setLocalAudio(enabled) {
        microphoneRequested = enabled; state.microphoneEnabled = false;
        localTrack.enabled = false; localAudio.state = enabled ? 'loading' : 'off';
        emit('participant-updated');
      },
      setLocalVideo(enabled) { if (enabled) throw new Error('Fixture camera must stay off'); },
      sendAppMessage(message) {
        if (message.event_type === 'conversation.respond') {
          state.responds++;
          if (toneEnabled) remoteGain.gain.setValueAtTime(0.015, audioContext.currentTime);
          void fetch('/__fixture/avatar/respond', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: message.properties.text }) });
        }
        if (message.event_type === 'conversation.interrupt') {
          state.interrupts++; remoteGain.gain.setValueAtTime(0, audioContext.currentTime);
        }
        report();
      },
      async leave() { emit('left-meeting'); },
      async destroy() {
        destroyed = true; clearInterval(frameTimer);
        for (const track of allocatedTracks) track.stop();
        oscillator.stop(); await audioContext.close();
        state.destroyed = true; state.microphoneEnabled = false;
        for (const control of controlButtons) control.disabled = true;
        if (video && originalPlay) video.play = originalPlay;
        report();
      },
    };
  },
};
