// Super TV-PC monochrome pages emitted by the core's serial printer adapter.
export function decodeTVPCPrint(data) {
    const header = /^P5\n384 ([0-9]+)\n255\n/.exec(new TextDecoder().decode(data.subarray(0, 64)));
    const height = header ? Number(header[1]) : 0;
    if (!height || height > 4096 || data.length !== header[0].length + 384 * height)
        throw new Error("Invalid Super TV-PC print page");
    return { width: 384, height, pixels: data.subarray(header[0].length) };
}

export class SuperTVPCPrinter {
    constructor(emulator) {
        this.emulator = emulator;
        this.frontend = emulator.frontend;
        this.fs = emulator.gameManager?.FS;
        this.busy = false;
        this.disposed = false;
        this.activeProgress = false;
        this.lastRows = 0;
        this.feedContainer = null;
        this.feedPaper = null;
        this.feedCanvas = null;
        this.timer = setInterval(() => this.poll(), 50);
        emulator.on("exit", () => this.dispose());
    }
    text(value) { return this.frontend.localization(value); }

    getProgress() {
        // Source 1: Direct Module exports if available
        const Module = this.emulator.gameManager?.Module;
        if (Module && typeof Module._stvpc_printer_rows === "function") {
            try {
                const height = Module._stvpc_printer_height();
                const rows = Module._stvpc_printer_rows();
                if (height > 0 && rows > 0) {
                    const ptr = Module._stvpc_printer_pixels();
                    if (ptr) {
                        const rowbytes = 48; // 384 / 8
                        const pixels = Module.HEAPU8.subarray(ptr, ptr + rows * rowbytes);
                        return { width: 384, height, rows, pixels };
                    }
                }
            } catch (e) {
                // fall back to virtual FS
            }
        }

        // Source 2: Progress file in virtual FS
        if (this.fs) {
            try {
                const entries = this.fs.readdir("/tmp");
                if (entries.includes("stvpc-print-progress.bin")) {
                    const bytes = this.fs.readFile("/tmp/stvpc-print-progress.bin");
                    if (bytes && bytes.byteLength >= 16) {
                        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
                        if (view.getUint32(0, true) === 0x52505453) {
                            const width = view.getUint32(4, true);
                            const height = view.getUint32(8, true);
                            const rows = view.getUint32(12, true);
                            const rowbytes = width / 8;
                            if (width === 384 && height > 0 && rows > 0 && bytes.byteLength >= 16 + rows * rowbytes) {
                                const pixels = bytes.subarray(16, 16 + rows * rowbytes);
                                return { width, height, rows, pixels };
                            }
                        }
                    }
                }
            } catch (e) {
                // mid-write or locked
            }
        }
        return null;
    }

    ensureFeedWidget() {
        if (this.feedContainer && this.feedContainer.parentElement) return;
        const canvasParent = this.frontend.elements.main || this.frontend.canvas?.parentElement;
        if (!canvasParent) return;

        const container = document.createElement("div");
        container.className = "ejs_printer_feed_container";
        container.setAttribute("role", "status");
        container.setAttribute("aria-label", "Printer paper");

        const paper = document.createElement("div");
        paper.className = "ejs_printer_paper";
        paper.style.height = "2px";

        const canvas = document.createElement("canvas");
        canvas.className = "ejs_printer_paper_canvas";
        canvas.width = 192;
        canvas.height = 144;
        canvas.style.width = "192px";
        canvas.style.height = "144px";

        const tear = document.createElement("div");
        tear.className = "ejs_printer_paper_tear";

        paper.appendChild(canvas);
        container.appendChild(paper);
        container.appendChild(tear);

        canvasParent.appendChild(container);

        this.feedContainer = container;
        this.feedPaper = paper;
        this.feedCanvas = canvas;
        this.offscreenCanvas = null;
        this.lastRows = 0;
    }

    renderProgress(progress) {
        this.ensureFeedWidget();
        if (!this.feedCanvas || !this.feedPaper) return;

        const { width, height, rows, pixels } = progress;

        // Display at exactly half its native resolution
        const displayWidth = Math.round(width / 2);
        const displayHeight = Math.round(height / 2);
        const displayRows = Math.max(1, Math.round(rows / 2));
        const visibleHeight = Math.max(2, displayRows);
        this.feedPaper.style.height = visibleHeight + "px";

        if (this.feedContainer) {
            if (rows >= height) {
                this.feedContainer.classList.add("ejs_printer_cut");
            } else {
                this.feedContainer.classList.remove("ejs_printer_cut");
            }
        }

        if (this.feedCanvas.style.width !== displayWidth + "px") {
            this.feedCanvas.style.width = displayWidth + "px";
        }
        if (this.feedCanvas.style.height !== displayHeight + "px") {
            this.feedCanvas.style.height = displayHeight + "px";
        }

        if (rows !== this.lastRows) {
            this.lastRows = rows;
            if (!this.offscreenCanvas) {
                this.offscreenCanvas = document.createElement("canvas");
            }
            if (this.offscreenCanvas.width !== width || this.offscreenCanvas.height !== height) {
                this.offscreenCanvas.width = width;
                this.offscreenCanvas.height = height;
            }
            if (this.feedCanvas.width !== displayWidth || this.feedCanvas.height !== displayHeight) {
                this.feedCanvas.width = displayWidth;
                this.feedCanvas.height = displayHeight;
            }

            const offCtx = this.offscreenCanvas.getContext("2d");
            const imgData = offCtx.createImageData(width, rows);
            const data = imgData.data;
            const rowbytes = width / 8;
            for (let r = 0; r < rows; r++) {
                const rowOffset = r * rowbytes;
                for (let b = 0; b < rowbytes; b++) {
                    const byteVal = pixels[rowOffset + b];
                    const baseX = b * 8;
                    for (let bit = 0; bit < 8; bit++) {
                        const isBlack = (byteVal & (1 << bit)) !== 0;
                        const val = isBlack ? 0 : 255;
                        const idx = (r * width + baseX + bit) * 4;
                        data[idx] = val;
                        data[idx + 1] = val;
                        data[idx + 2] = val;
                        data[idx + 3] = 255;
                    }
                }
            }
            offCtx.putImageData(imgData, 0, 0);

            const ctx = this.feedCanvas.getContext("2d");
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = "high";
            ctx.clearRect(0, 0, displayWidth, displayHeight);
            ctx.drawImage(this.offscreenCanvas, 0, 0, width, rows, 0, 0, displayWidth, displayRows);
        }
    }

    removeFeedWidget() {
        if (this.feedContainer) {
            const container = this.feedContainer;
            if (this.feedPaper && this.feedCanvas) {
                this.feedPaper.style.height = this.feedCanvas.style.height;
            }
            container.classList.add("ejs_printer_cut");
            container.classList.add("ejs_printer_done");
            setTimeout(() => {
                if (container.parentElement) container.remove();
            }, 600);
            this.feedContainer = null;
            this.feedPaper = null;
            this.feedCanvas = null;
            this.offscreenCanvas = null;
            this.lastRows = 0;
        }
    }

    async poll() {
        if (this.disposed || this.busy) return;
        if (!this.fs) this.fs = this.emulator.gameManager?.FS;

        // Check if there is active printing progress
        const progress = this.getProgress();
        if (progress) {
            this.activeProgress = true;
            this.renderProgress(progress);
        } else if (this.activeProgress && !this.fs?.readdir("/tmp").some(name => /^stvpc-print-[0-9]+\.pgm$/.test(name))) {
            // Printing aborted or reset without completing
            this.activeProgress = false;
            this.removeFeedWidget();
        }

        // Check for completed print page
        if (this.frontend.isPopupOpen()) return;
        const file = this.fs?.readdir("/tmp").filter(name => /^stvpc-print-[0-9]+\.pgm$/.test(name)).sort()[0];
        if (!file) return;

        this.busy = true;
        this.activeProgress = false;
        try {
            const bytes = this.fs.readFile("/tmp/" + file);
            this.fs.unlink("/tmp/" + file);
            const page = decodeTVPCPrint(bytes);
            const canvas = document.createElement("canvas");
            canvas.width = page.width; canvas.height = page.height;
            const context = canvas.getContext("2d"), image = context.createImageData(page.width, page.height);
            for (let i = 0; i < page.pixels.length; i++) {
                image.data[i * 4] = image.data[i * 4 + 1] = image.data[i * 4 + 2] = page.pixels[i];
                image.data[i * 4 + 3] = 255;
            }
            context.putImageData(image, 0, 0);
            const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
            if (this.disposed) return;
            if (!blob) throw new Error("Could not encode Super TV-PC print page");

            // Dismiss the live feed widget smoothly: detach from edge and fade away
            this.removeFeedWidget();
            await new Promise(resolve => setTimeout(resolve, 550));
            if (this.disposed) return;

            this.show(blob, file.replace("stvpc-print-", "super-tv-pc-print-").replace(/\.pgm$/, ".png"));
        } catch (error) {
            console.error("Could not display Super TV-PC print", error);
            this.removeFeedWidget();
            this.busy = false;
        }
    }
    show(blob, filename) {
        this.resumeAfterPrint = !this.emulator.paused;
        this.emulator.pause(true);
        this.url = URL.createObjectURL(blob);
        const body = this.frontend.createPopup("Print", {});
        this.popup = body.parentElement;
        this.popup.classList.add("ejs_print_preview");
        this.popup.setAttribute("role", "dialog");
        this.popup.setAttribute("aria-modal", "true");
        this.popup.setAttribute("aria-label", this.text("Print"));
        const image = document.createElement("img");
        image.className = "ejs_print_image";
        image.alt = this.text("Printed image");
        image.src = this.url;
        image.draggable = false;
        body.appendChild(image);
        const actions = document.createElement("div");
        actions.className = "ejs_print_actions";
        const button = (label, action) => {
            const element = document.createElement("button");
            element.type = "button";
            element.className = "ejs_button_button ejs_popup_submit";
            element.textContent = this.text(label);
            element.addEventListener("click", action);
            actions.appendChild(element);
            return element;
        };
        const save = button("Save PNG", () => {
            const link = document.createElement("a");
            link.href = this.url;
            link.download = filename;
            link.click();
            this.close();
        });
        button("Cancel", () => this.close());
        body.appendChild(actions);
        this.popup.addEventListener("keydown", event => {
            event.stopPropagation();
            if (event.key === "Escape") { event.preventDefault(); this.close(); }
            if (event.key === "Tab") {
                event.preventDefault();
                const buttons = [...actions.querySelectorAll("button")];
                buttons[(buttons.indexOf(document.activeElement) + 1) % buttons.length].focus();
            }
        });
        this.popup.addEventListener("keyup", event => event.stopPropagation());
        save.focus({ preventScroll: true });
    }
    close(resume = true) {
        this.removeFeedWidget();
        if (!this.popup) return;
        if (this.frontend.currentPopup === this.popup) this.frontend.closePopup();
        else this.popup.remove();
        this.popup = null;
        const url = this.url;
        this.url = null;
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        this.busy = false;
        if (resume && this.resumeAfterPrint) this.emulator.play(true);
        this.frontend.elements.parent.focus({ preventScroll: true });
    }
    dispose() {
        this.disposed = true;
        clearInterval(this.timer);
        this.close(false);
    }
}
