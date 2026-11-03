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
        this.fs = emulator.gameManager.FS;
        this.busy = false;
        this.disposed = false;
        this.timer = setInterval(() => this.poll(), 200);
        emulator.on("exit", () => this.dispose());
    }
    text(value) { return this.frontend.localization(value); }
    async poll() {
        if (this.disposed || this.busy || this.frontend.isPopupOpen()) return;
        const file = this.fs.readdir("/tmp").filter(name => /^stvpc-print-[0-9]+\.pgm$/.test(name)).sort()[0];
        if (!file) return;
        this.busy = true;
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
            this.show(blob, file.replace("stvpc-print-", "super-tv-pc-print-").replace(/\.pgm$/, ".png"));
        } catch (error) {
            console.error("Could not display Super TV-PC print", error);
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
