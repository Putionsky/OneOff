// Web MIDI output: send the generated performance to an external instrument or
// DAW. Notes are scheduled with precise timestamps so the humanized micro-timing
// survives the trip out of the browser.

export class MidiOutput {
  constructor({ onPorts } = {}) {
    this.onPorts = onPorts || (() => {});
    this.access = null;
    this.port = null;
    this.channel = 0;
  }

  get supported() {
    return typeof navigator !== 'undefined' && !!navigator.requestMIDIAccess;
  }

  async connect() {
    if (!this.supported) {
      this.onPorts([]);
      return false;
    }
    this.access = await navigator.requestMIDIAccess({ sysex: false });
    this.access.onstatechange = () => this.refreshPorts();
    this.refreshPorts();
    return true;
  }

  refreshPorts() {
    const ports = [];
    if (this.access) {
      for (const out of this.access.outputs.values()) {
        ports.push({ id: out.id, name: out.name });
      }
    }
    this.onPorts(ports);
  }

  selectPort(id) {
    this.port = null;
    if (this.access && id) {
      for (const out of this.access.outputs.values()) {
        if (out.id === id) this.port = out;
      }
    }
  }

  setChannel(ch) {
    this.channel = Math.max(0, Math.min(15, ch | 0));
  }

  // Send All-Notes-Off / All-Sound-Off on the active channel (panic).
  allNotesOff() {
    if (!this.port) return;
    this.port.send([0xb0 | this.channel, 0x7b, 0]); // all notes off
    this.port.send([0xb0 | this.channel, 0x78, 0]); // all sound off
  }

  // Schedule a note. `when` and `duration` are in seconds on the same clock as
  // performance.now()/1000; Web MIDI timestamps are in ms via performance.now.
  play(midi, velocity, whenSeconds, durationSeconds) {
    if (!this.port) return;
    const onTime = whenSeconds * 1000;
    const offTime = (whenSeconds + Math.max(0.05, durationSeconds)) * 1000;
    this.port.send([0x90 | this.channel, midi & 0x7f, velocity & 0x7f], onTime);
    this.port.send([0x80 | this.channel, midi & 0x7f, 0], offTime);
  }
}
