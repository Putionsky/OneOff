// Web MIDI input: connect to hardware/virtual MIDI ports and surface note-on /
// note-off as simple callbacks. Gracefully degrades when Web MIDI is missing
// (e.g. Safari, or insecure origin) so the on-screen keyboard still works.

export class MidiInput {
  constructor({ onNoteOn, onNoteOff, onPorts } = {}) {
    this.onNoteOn = onNoteOn || (() => {});
    this.onNoteOff = onNoteOff || (() => {});
    this.onPorts = onPorts || (() => {});
    this.access = null;
    this.activePort = null; // null = listen to all inputs
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
    this.bindAll();
    return true;
  }

  refreshPorts() {
    const ports = [];
    if (this.access) {
      for (const input of this.access.inputs.values()) {
        ports.push({ id: input.id, name: input.name });
      }
    }
    this.onPorts(ports);
  }

  selectPort(id) {
    this.activePort = id || null;
    this.bindAll();
  }

  bindAll() {
    if (!this.access) return;
    for (const input of this.access.inputs.values()) {
      input.onmidimessage =
        !this.activePort || input.id === this.activePort
          ? (e) => this.handle(e)
          : null;
    }
  }

  handle(e) {
    const [status, data1, data2] = e.data;
    const cmd = status & 0xf0;
    if (cmd === 0x90 && data2 > 0) {
      this.onNoteOn(data1, data2);
    } else if (cmd === 0x80 || (cmd === 0x90 && data2 === 0)) {
      this.onNoteOff(data1);
    }
  }
}
