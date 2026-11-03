// Keyboard sources share ownership and remain visible across native input polls.
export class KeyboardInput {
    constructor(emit, minimumHold = 100, frame = () => 0, minimumFrames = 0) {
        this.emit = emit;
        this.minimumHold = minimumHold;
        this.frame = frame;
        this.minimumFrames = minimumFrames;
        this.keys = new Map();
        this.sources = new Map();
    }
    set(code, down, source = `touch:${code}`) {
        const previous = this.sources.get(source);
        if (previous && (!down || previous !== code)) this.release(source);
        if (!down || previous === code) return;
        this.sources.set(source, code);
        let state = this.keys.get(code);
        if (!state) {
            state = { since: performance.now(), frame: this.frame(), owners: new Set(), timer: null };
            this.keys.set(code, state);
            this.emit(code, true);
        }
        clearTimeout(state.timer);
        state.owners.add(source);
    }
    release(source) {
        const code = this.sources.get(source);
        if (!code) return;
        this.sources.delete(source);
        const state = this.keys.get(code);
        state.owners.delete(source);
        if (state.owners.size) return;
        const finish = () => {
            const remaining = this.minimumHold - (performance.now() - state.since);
            if (remaining > 0 || this.frame() - state.frame < this.minimumFrames) {
                state.timer = setTimeout(finish, Math.max(16, remaining));
                return;
            }
            this.emit(code, false);
            this.keys.delete(code);
        };
        state.timer = setTimeout(finish, Math.max(0, this.minimumHold - (performance.now() - state.since)));
    }
    releaseGamepads() {
        for (const source of this.sources.keys()) {
            if (source.startsWith('gamepad:')) this.release(source);
        }
    }
    clear() {
        for (const [code, state] of this.keys) {
            clearTimeout(state.timer);
            this.emit(code, false);
        }
        this.keys.clear();
        this.sources.clear();
    }
}
