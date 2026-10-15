// Local test fixture only. No Tavus/Daily service, camera, microphone or real media capture.
export default {
  createCallObject(options) {
    const listeners = new Map();
    let destroyed = false;
    const canvas = document.createElement('canvas'); canvas.width = 480; canvas.height = 270;
    const context = canvas.getContext('2d');
    context.fillStyle = '#213e2d'; context.fillRect(0, 0, 480, 270);
    context.fillStyle = 'white'; context.font = 'bold 24px system-ui'; context.textAlign = 'center';
    context.fillText('SYNTHETIC AVATAR FIXTURE', 240, 120); context.font = '16px system-ui'; context.fillText('No camera / microphone / Tavus connection', 240, 160);
    const stream = canvas.captureStream(1);
    const track = stream.getVideoTracks()[0];
    window.__avatarFixture = { created: true, cameraDisabled: options.videoSource === false, microphoneInitiallyOff: options.startAudioOff === true, microphoneEnabled: false, responds: 0, interrupts: 0, destroyed: false };
    return {
      on(event, handler) { listeners.set(event, handler); return this; },
      participants() { return { replica: { local: false, tracks: { video: { persistentTrack: track } } } }; },
      async join() { if (destroyed) throw new Error('Stopped fixture'); },
      setLocalAudio(enabled) { window.__avatarFixture.microphoneEnabled = enabled; },
      setLocalVideo(enabled) { if (enabled) throw new Error('Fixture camera must stay off'); },
      sendAppMessage(message) {
        if (message.event_type === 'conversation.respond') {
          window.__avatarFixture.responds++;
          void fetch('/__fixture/avatar/respond', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: message.properties.text }) });
        }
        if (message.event_type === 'conversation.interrupt') window.__avatarFixture.interrupts++;
      },
      async leave() { listeners.get('left-meeting')?.(); },
      async destroy() { destroyed = true; track.stop(); window.__avatarFixture.destroyed = true; },
    };
  },
};
