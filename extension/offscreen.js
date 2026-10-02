// Generated tones, so no audio files ship with the extension.
function play(urgent) {
  const ctx = new AudioContext();
  const notes = urgent ? [880, 660, 880, 660, 880, 660, 880, 660] : [660, 880];
  const step = urgent ? 0.22 : 0.28;
  notes.forEach((freq, i) => {
    const t0 = ctx.currentTime + i * step;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.35, t0 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + step - 0.03);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + step);
  });
  setTimeout(() => ctx.close(), notes.length * step * 1000 + 500);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target === 'offscreen' && msg.type === 'beep') play(Boolean(msg.urgent));
});

play(new URLSearchParams(location.search).get('urgent') === '1');
