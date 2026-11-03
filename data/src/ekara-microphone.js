// Browser microphone PCM for the e-kara firmware's analog input.
export class EkaraMicrophone {
    constructor(emulator) {
        this.emulator = emulator;
        this.module = emulator.Module;
        this.frontend = emulator.frontend;
        this.address = this.module._ekara_microphone_buffer();
        this.generation = 0;
        this.disposed = false;
        this.manuallyDisabled = false;
        this.controller = new AbortController();
        this.button = document.createElement("button");
        this.button.type = "button";
        this.button.className = "ejs_menu_button";
        this.button.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/><rect class="ejs_mic_level" x="10" y="13" width="4" height="0" fill="currentColor" stroke="none"/><path class="ejs_mic_off" d="M3 3l18 18"/></svg><span class="ejs_menu_text ejs_menu_text_right"></span>';
        this.label = this.button.querySelector("span");
        this.update(false);
        this.button.addEventListener("click", () => {
            if (this.stream) {
                this.manuallyDisabled = true;
                this.stop();
            } else {
                this.manuallyDisabled = false;
                this.start(true);
            }
        }, { signal: this.controller.signal });
        this.frontend.elements.menu.appendChild(this.button);

        const onEmulatorClick = (event) => {
            if (this.button.contains(event.target)) return;
            if (this.frontend.elements.menu?.contains(event.target)) return;
            if (this.frontend.elements.contextmenu?.contains(event.target)) return;
            if (event.target.closest?.('.ejs_popup_container')) return;
            if (this.stream || this.pending || this.disposed || this.manuallyDisabled) return;
            this.start(false, true);
        };
        this.frontend.elements.parent.addEventListener("pointerdown", onEmulatorClick, { signal: this.controller.signal, capture: true });
        this.frontend.elements.parent.addEventListener("click", onEmulatorClick, { signal: this.controller.signal, capture: true });

        window.addEventListener("pagehide", () => this.dispose(), { signal: this.controller.signal });
        document.addEventListener("visibilitychange", () => { if (document.hidden) this.stop(); }, { signal: this.controller.signal });
        emulator.on("exit", () => this.dispose());
        this.start();
    }
    text(value) { return this.frontend.localization(value, false); }
    update(active) {
        const label = this.text(active ? "Disable microphone" : "Enable microphone");
        this.label.textContent = label;
        this.button.querySelector(".ejs_mic_off").style.display = active ? "none" : "";
        this.button.setAttribute("aria-label", label);
        this.button.setAttribute("aria-pressed", String(active));
    }
    heap() { return new Int32Array(this.module.HEAPU8.buffer, this.address, 8195); }
    load(heap, index) { return typeof SharedArrayBuffer !== "undefined" && heap.buffer instanceof SharedArrayBuffer ? Atomics.load(heap, index) : heap[index]; }
    store(heap, index, value) {
        if (typeof SharedArrayBuffer !== "undefined" && heap.buffer instanceof SharedArrayBuffer) Atomics.store(heap, index, value);
        else heap[index] = value;
    }
    showLevel(level = 0) {
        const value = Math.max(0, Math.min(1, level / 0.25));
        const fill = this.button.querySelector(".ejs_mic_level");
        fill.setAttribute("y", String(13 - value * 10));
        fill.setAttribute("height", String(value * 10));
        this.level = value;
        if (this.stream) this.label.textContent = this.text("Disable microphone") + " · " + this.text("Input level") + ": " + Math.round(value * 100) + "%";
    }
    push(samples) {
        const heap = this.heap();
        const running = !this.emulator.paused && !document.hidden;
        this.store(heap, 2, running ? 1 : 0);
        if (!running) return;
        let write = this.load(heap, 0) >>> 0;
        const read = this.load(heap, 1) >>> 0;
        const free = 8192 - ((write - read) >>> 0);
        for (let i = 0; i < Math.min(samples.length, free); i++) heap[3 + ((write + i) % 8192)] = samples[i];
        this.store(heap, 0, (write + Math.min(samples.length, free)) | 0);
    }
    async start(userInitiated = false, fromEmulatorClick = false) {
        if (this.pending || this.disposed) return;
        if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) {
            if (userInitiated) {
                this.error("Microphone input requires a secure connection and a browser with audio capture support.");
            }
            return;
        }
        this.pending = true;
        const generation = ++this.generation;
        let stream = null, context = null, url = null;
        try {
            if (window.__ekaraInitialStream && window.__ekaraInitialStream.active) {
                stream = window.__ekaraInitialStream;
                window.__ekaraInitialStream = null;
            } else if (window.__ekaraInitialStreamPromise) {
                try {
                    stream = await window.__ekaraInitialStreamPromise;
                } catch (e) {
                    stream = null;
                }
                window.__ekaraInitialStreamPromise = null;
            }

            if (!stream || !stream.active) {
                stream = await navigator.mediaDevices.getUserMedia({
                    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: false, autoGainControl: false },
                    video: false
                });
            }

            if (this.disposed || generation !== this.generation) {
                stream?.getTracks().forEach(track => track.stop());
                return;
            }
            this.stream = stream;

            context = new AudioContext();
            this.context = context;
            await context.resume();
            if (this.disposed || generation !== this.generation) return;

            url = URL.createObjectURL(new Blob([workletSource], { type: "text/javascript" }));
            await context.audioWorklet.addModule(url);
            if (this.disposed || generation !== this.generation) return;
            this.source = context.createMediaStreamSource(stream);
            this.processor = new AudioWorkletNode(context, "ekara-microphone", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
            this.processor.port.onmessage = event => {
                if (generation !== this.generation) return;
                this.showLevel(event.data.level);
                this.push(event.data.pcm);
            };
            this.source.connect(this.processor);
            // The worklet outputs silence; captured audio only goes to the core.
            this.processor.connect(context.destination);
            for (const track of stream.getAudioTracks()) track.addEventListener("ended", () => this.stop(), { signal: this.controller.signal });
            this.update(true);
            this.frontend.elements.parent.focus({ preventScroll: true });
        } catch (error) {
            if (generation === this.generation && !this.disposed) {
                this.stop();
                if (userInitiated) {
                    this.error(error.name === "NotAllowedError" ? "Microphone access was denied. Allow it in your browser and try again." : "Could not start the microphone. Check that an input device is available and try again.");
                }
            }
        } finally {
            if (url) URL.revokeObjectURL(url);
            if (generation !== this.generation && context && context.state !== "closed") context.close().catch(() => {});
            if (generation === this.generation) this.pending = false;
        }
    }
    error(message) {
        const body = this.frontend.createPopup(this.text("Microphone"), {});
        const paragraph = document.createElement("p");
        paragraph.textContent = this.text(message);
        body.appendChild(paragraph);
        const close = document.createElement("button");
        close.type = "button";
        close.className = "ejs_button_button";
        close.textContent = this.text("Close");
        const dismiss = () => {
            this.frontend.closePopup();
            this.frontend.elements.parent.focus({ preventScroll: true });
        };
        close.addEventListener("click", dismiss, { signal: this.controller.signal });
        body.appendChild(close);
        const popup = body.parentElement;
        popup.setAttribute("role", "dialog");
        popup.setAttribute("aria-modal", "true");
        popup.setAttribute("aria-label", this.text("Microphone"));
        popup.addEventListener("keydown", event => {
            event.stopPropagation();
            if (event.key === "Escape") { event.preventDefault(); dismiss(); }
            if (event.key === "Tab") { event.preventDefault(); close.focus(); }
        }, { signal: this.controller.signal });
        popup.addEventListener("keyup", event => event.stopPropagation(), { signal: this.controller.signal });
        close.focus({ preventScroll: true });
    }
    stop() {
        ++this.generation;
        this.pending = false;
        this.store(this.heap(), 2, 0);
        if (this.processor) { this.processor.port.onmessage = null; this.processor.disconnect(); this.processor.port.close(); }
        this.source?.disconnect();
        this.stream?.getTracks().forEach(track => track.stop());
        this.context?.close().catch(() => {});
        this.processor = this.source = this.stream = this.context = null;
        this.update(false);
        this.showLevel();
    }
    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this.stop();
        this.controller.abort();
        this.button.remove();
    }
}

const workletSource = `
class EkaraMicrophoneProcessor extends AudioWorkletProcessor {
    constructor() {
        super(); this.phase = 0; this.sum = 0; this.count = 0; this.block = [];
        this.previous = 0; this.highpass = 0; this.gain = 1;
    }
    publish() {
        let energy = 0, peak = 0;
        for (let i = 0; i < this.block.length; i++) {
            const input = this.block[i];
            this.highpass = input - this.previous + 0.995 * this.highpass;
            this.previous = input;
            this.block[i] = this.highpass;
            energy += this.highpass * this.highpass;
            peak = Math.max(peak, Math.abs(this.highpass));
        }
        const rms = Math.sqrt(energy / this.block.length);
        const target = Math.max(0.25, Math.min(32, 0.16 / Math.max(rms, 0.0005)));
        this.gain += (target - this.gain) * (target < this.gain ? 0.8 : 0.15);
        const gain = Math.min(this.gain, 0.95 / Math.max(peak, 0.00001));
        const pcm = Int16Array.from(this.block, value => Math.round(Math.max(-1, Math.min(1, value * gain)) * 32767));
        this.port.postMessage({ pcm, level: rms * gain }, [pcm.buffer]);
        this.block = [];
    }
    process(inputs) {
        const input = inputs[0]?.[0];
        if (input) for (const value of input) {
            this.sum += value; this.count++; this.phase += 16000;
            if (this.phase >= sampleRate) {
                this.phase -= sampleRate;
                this.block.push(this.sum / this.count);
                this.sum = 0; this.count = 0;
                if (this.block.length === 256) this.publish();
            }
        }
        return true;
    }
}
registerProcessor("ekara-microphone", EkaraMicrophoneProcessor);
`;
