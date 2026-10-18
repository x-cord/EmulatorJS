// Storyware geometry and scan pairing follow MAME's CC0 beena.lay layout.
export class BeenaBook {
    constructor(emulator) {
        this.emulator = emulator;
        this.manager = emulator.gameManager;
        this.parent = emulator.frontend.elements.parent;
        this.controller = new AbortController();
        this.urls = new Map();
        this.pointer = null;
        this.releaseFrame = null;
        this.disposed = false;
        this.ready = false;
        this.lastPage = -1;
        this.createView();
        this.bindInput();
        this.resize = new ResizeObserver(() => {
            const fixed = 64 + this.controls.offsetHeight + this.status.offsetHeight;
            const width = 4 * (1 + this.artwork.outerPadding);
            const screenHeight = width * 3 / 4;
            const bookHeight = 2.8 * (1 + this.artwork.bottomPadding);
            const unit = Math.max(0, Math.min(this.parent.clientWidth / width,
                (this.parent.clientHeight - fixed) / (screenHeight + bookHeight + .1)));
            this.parent.style.setProperty("--ejs-beena-width", unit * width + "px");
            this.parent.style.setProperty("--ejs-beena-tv-height", unit * screenHeight + "px");
            this.root.style.paddingTop = unit * .1 + "px";
            this.stage.style.height = unit * bookHeight + "px";
            this.spread.style.width = unit * 4 + "px";
            this.spread.style.height = unit * 2.8 + "px";
        });
        for (const element of [this.parent, this.controls, this.status]) this.resize.observe(element);
        this.tick = () => {
            if (this.disposed) return;
            if (this.releaseFrame !== null && (this.manager.getFrameNum() > this.releaseFrame || !this.canInteract()))
                this.release(false, true);
            this.render();
            this.animation = requestAnimationFrame(this.tick);
        };
        this.tick();
        emulator.on("exit", () => this.dispose());
        this.loadScans().catch(error => {
            if (this.disposed) return;
            this.status.textContent = this.text("Book scans could not be loaded");
            console.warn("Could not load Beena storyware", error);
        });
    }
    text(value) {
        return this.emulator.frontend.localization(value, false);
    }
    listen(element, type, callback, options = {}) {
        element.addEventListener(type, callback, { ...options, signal: this.controller.signal });
    }
    createView() {
        this.parent.classList.add("ejs_beena");
        this.root = document.createElement("section");
        this.root.className = "ejs_beena_book";
        this.root.setAttribute("aria-label", this.text("Storybook"));
        this.root.innerHTML = `<div class="ejs_beena_stage"><div class="ejs_beena_spread">
            <div class="ejs_beena_page ejs_beena_left"><img draggable="false"></div>
            <div class="ejs_beena_page ejs_beena_right"><img draggable="false"></div>
            <svg class="ejs_beena_pen" viewBox="0 0 1 1" aria-hidden="true">
                <g fill="none" stroke="#2222cc" stroke-width="0.06">
                    <circle cx="0.5" cy="0.5" r="0.1"/><circle cx="0.5" cy="0.5" r="0.47"/>
                    <path d="M.03 .5H.4M.6 .5H.97M.5 .03V.4M.5 .6V.97"/>
                </g>
            </svg>
        </div></div><div class="ejs_beena_controls"></div><p class="ejs_beena_status" role="status"></p>`;
        this.stage = this.root.querySelector(".ejs_beena_stage");
        this.spread = this.root.querySelector(".ejs_beena_spread");
        this.images = [...this.root.querySelectorAll("img")];
        this.cursor = this.root.querySelector("svg");
        this.status = this.root.querySelector(".ejs_beena_status");
        this.status.textContent = this.text("Loading book scans…");
        const controls = this.controls = this.root.querySelector(".ejs_beena_controls");
        const button = (label, action) => {
            const element = document.createElement("button");
            element.type = "button";
            element.textContent = this.text(label);
            this.listen(element, "click", () => {
                if (!this.canInteract()) return;
                this.release(false, true);
                action();
                this.parent.focus({ preventScroll: true });
                this.render();
            });
            controls.appendChild(element);
            return element;
        };
        button("Previous spread", () => this.turn(-1));
        this.selection = document.createElement("select");
        this.selection.setAttribute("aria-label", this.text("Book position"));
        for (let page = 0; page < 7; page++) {
            const option = document.createElement("option");
            option.value = page;
            option.textContent = `${this.text("Book position")} ${page + 1} / 7`;
            this.selection.appendChild(option);
        }
        this.listen(this.selection, "change", () => {
            this.release(false, true);
            this.manager.setBeenaBookPage(Number(this.selection.value));
            this.parent.focus({ preventScroll: true });
            this.render();
        });
        controls.appendChild(this.selection);
        button("Next spread", () => this.turn(1));
        this.target = button("Switch pen target", () => {
            const state = this.manager.getBeenaBookState();
            this.manager.setBeenaBookPen(-1, -1, false, 1 - state.target);
        });
        this.target.setAttribute("aria-pressed", "false");
        this.parent.appendChild(this.root);
    }
    canInteract() {
        return !this.emulator.paused && !this.emulator.frontend.isSettingsMenuOpen() && !this.emulator.frontend.isPopupOpen();
    }
    turn(delta) {
        const state = this.manager.getBeenaBookState();
        if (state) this.manager.setBeenaBookPage((state.page + delta + 7) % 7);
    }
    bindInput() {
        for (const type of ["mousedown", "touchstart", "click"])
            this.listen(this.root, type, event => event.stopPropagation());
        const point = event => {
            const rect = this.spread.getBoundingClientRect();
            return [
                Math.max(0, Math.min(255, (event.clientX - rect.left) / rect.width * 255)),
                Math.max(0, Math.min(255, (event.clientY - rect.top) / rect.height * 255))
            ];
        };
        this.listen(this.spread, "pointerdown", event => {
            if (!this.canInteract() || this.pointer !== null || event.button !== 0) return;
            event.preventDefault();
            event.stopPropagation();
            this.pointer = event.pointerId;
            this.pressFrame = this.manager.getFrameNum();
            this.releaseFrame = null;
            this.spread.setPointerCapture(event.pointerId);
            this.parent.focus({ preventScroll: true });
            this.manager.setBeenaBookPen(...point(event), true, 1);
        });
        this.listen(this.spread, "pointermove", event => {
            if (!this.canInteract() || (this.pointer !== null && this.pointer !== event.pointerId)) return;
            this.manager.setBeenaBookPen(...point(event), this.pointer !== null || this.releaseFrame !== null, 1);
        });
        for (const type of ["pointerup", "pointercancel", "lostpointercapture"])
            this.listen(this.spread, type, event => {
                if (event.pointerId === this.pointer) this.release(false, type !== "pointerup");
            });
        this.listen(window, "blur", () => this.release(false, true));
        this.listen(document, "visibilitychange", () => { if (document.hidden) this.release(false, true); });
        const canvas = this.emulator.frontend.canvas;
        for (const type of ["mousemove", "touchstart", "touchmove"])
            this.listen(canvas, type, () => {
                if (this.pointer === null && this.canInteract()) {
                    this.releaseFrame = null;
                    this.manager.setBeenaBookPen(-1, -1, false, 0);
                }
            });
        this.listen(this.parent, "keydown", event => {
            if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.code)) this.release(true);
        }, { capture: true });
    }
    release(clearPosition = false, immediate = false) {
        const pointer = this.pointer;
        this.pointer = null;
        const state = this.manager.getBeenaBookState();
        const keepPosition = !clearPosition && state?.target === 1;
        // Keep quick taps active until the core has run an input frame.
        const wait = pointer !== null && !clearPosition && !immediate && this.canInteract() && this.manager.getFrameNum() <= this.pressFrame;
        this.releaseFrame = wait ? this.pressFrame : null;
        if (!wait) this.manager.setBeenaBookPen(keepPosition ? state.x : -1, keepPosition ? state.y : -1, false);
        if (pointer !== null && this.spread.hasPointerCapture(pointer)) this.spread.releasePointerCapture(pointer);
    }
    async loadScans() {
        const path = "/" + this.emulator.fileName.replace(/^\/+/, "");
        const archive = this.manager.FS.readFile(path);
        await this.emulator.compression.decompress(archive, () => {}, (name, bytes) => {
            const match = /(?:^|\/)page0*(\d+)\.(jpe?g|png|bmp)$/i.exec(name);
            if (!match || this.disposed) return;
            const index = Number(match[1]);
            if (index < 1 || index > 12) return;
            const type = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", bmp: "image/bmp" }[match[2].toLowerCase()];
            if (this.urls.has(index)) URL.revokeObjectURL(this.urls.get(index));
            const data = bytes instanceof Uint8Array || bytes instanceof ArrayBuffer ? bytes : new Uint8Array(Object.values(bytes));
            this.urls.set(index, URL.createObjectURL(new Blob([data], { type })));
        });
        if (this.disposed) return;
        if (!this.urls.size) throw new Error("The cartridge archive contains no page scans");
        this.ready = true;
        this.lastPage = -1;
        this.render();
    }
    render() {
        const state = this.manager.getBeenaBookState();
        if (!state) return;
        if (this.pointer !== null && !this.canInteract()) this.release();
        if (state.page !== this.lastPage) {
            this.lastPage = state.page;
            this.root.dataset.page = state.page;
            this.selection.value = state.page;
            const pages = [state.page * 2, state.page * 2 + 1];
            this.images.forEach((image, side) => {
                const url = this.urls.get(pages[side]);
                image.hidden = !url;
                if (url) image.src = url;
                else image.removeAttribute("src");
                image.alt = url ? `${this.text("Page")} ${pages[side]}` : "";
                image.parentElement.dataset.scan = url ? pages[side] : "";
            });
            if (this.ready) {
                const visible = pages.filter(page => this.urls.has(page));
                this.status.textContent = visible.length
                    ? `${this.text("Pages")}: ${visible.join(" – ")}`
                    : this.text("Book closed");
            }
        }
        this.cursor.hidden = state.target !== 1;
        this.cursor.style.left = state.x / 255 * 100 + "%";
        this.cursor.style.top = state.y / 255 * 100 + "%";
        this.target.setAttribute("aria-pressed", String(state.target === 1));
        this.root.dataset.penTarget = state.target ? "book" : "tablet";
    }
    dispose() {
        this.disposed = true;
        this.release(true);
        this.controller.abort();
        this.resize.disconnect();
        cancelAnimationFrame(this.animation);
        for (const url of this.urls.values()) URL.revokeObjectURL(url);
        this.urls.clear();
        this.root.remove();
        this.parent.classList.remove("ejs_beena");
        this.parent.style.removeProperty("--ejs-beena-width");
        this.parent.style.removeProperty("--ejs-beena-tv-height");
    }
}
