const TOUCH_PEN_SETTLE_FRAMES = 6;

// Storyware geometry and scan pairing follow MAME's CC0 beena.lay layout.
export class BeenaBook {
    constructor(emulator) {
        this.emulator = emulator;
        this.manager = emulator.gameManager;
        this.parent = emulator.frontend.elements.parent;
        emulator.frontend.dockMenu();
        this.controller = new AbortController();
        this.urls = new Map();
        this.artwork = { outerPadding: 0, bottomPadding: 0 };
        this.pointer = null;
        this.bookPointerPosition = null;
        this.pendingPress = null;
        this.penQueue = [];
        this.activePenStroke = null;
        this.pointerStroke = null;
        this.penReleaseFrame = -1;
        this.pressFrame = null;
        this.releaseFrame = null;
        this.disposed = false;
        this.ready = false;
        this.lastPage = -1;
        this.createView();
        if (/(?:^|\/)beena_conan\.zip$/i.test(emulator.fileName))
            this.setArtworkDimensions({ pageWidth: 1200, inputHeight: 1680, outerPadding: 48, bottomPadding: 80 });
        this.bindInput();
        this.resizeView = () => {
            const toolbarHeight = parseFloat(getComputedStyle(this.parent).getPropertyValue("--ejs-toolbar-height"));
            const style = getComputedStyle(this.root);
            const rowGap = parseFloat(style.rowGap) || 6;
            const fixed = toolbarHeight + 3 * rowGap + parseFloat(style.borderTopWidth)
                + this.controls.getBoundingClientRect().height + this.status.getBoundingClientRect().height;
            const width = 4 * (1 + this.artwork.outerPadding);
            const screenHeight = width * 3 / 4;
            const bookHeight = 2.8 * (1 + this.artwork.bottomPadding);
            const unit = Math.max(0, Math.min(this.parent.clientWidth / width,
                (this.parent.clientHeight - fixed) / (screenHeight + bookHeight)));
            this.parent.style.setProperty("--ejs-beena-width", unit * width + "px");
            this.parent.style.setProperty("--ejs-beena-tv-height", unit * screenHeight + "px");
            this.root.style.paddingTop = rowGap + "px";
            this.stage.style.height = unit * bookHeight + "px";
            this.spread.style.width = unit * 4 + "px";
            this.spread.style.height = unit * 2.8 + "px";
            if (!this.positionsMenu.hidden) this.positionMenu();
        };
        this.resizeView();
        this.resize = new ResizeObserver(this.resizeView);
        for (const element of [this.parent, this.controls, this.status]) this.resize.observe(element);
        this.tick = () => {
            if (this.disposed) return;
            const frame = this.manager.getFrameNum();
            if ((this.activePenStroke || this.penQueue.length) && !this.canInteract()) this.release(false, true);
            this.startPenStroke(frame);
            if (this.pendingPress && frame >= this.pendingPress.frame + this.pendingPress.settleFrames) {
                const { x, y, target } = this.pendingPress;
                this.pendingPress = null;
                this.pressFrame = frame;
                this.manager.setBeenaBookPen(x, y, true, target);
            }
            if (this.activePenStroke?.ended && this.pressFrame !== null) {
                this.releaseFrame = this.pressFrame;
                if (frame > this.pressFrame) {
                    const { x, y, target } = this.activePenStroke;
                    this.manager.setBeenaBookPen(x, y, false, target);
                    this.activePenStroke = null;
                    this.pressFrame = this.releaseFrame = null;
                    this.penReleaseFrame = frame;
                }
            }
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
    setArtworkDimensions({ pageWidth, inputHeight, outerPadding, bottomPadding }) {
        this.artwork = { outerPadding: outerPadding / pageWidth, bottomPadding: bottomPadding / inputHeight };
        this.root.style.setProperty("--ejs-beena-outer-padding", this.artwork.outerPadding * 100 + "%");
        this.root.style.setProperty("--ejs-beena-bottom-padding", this.artwork.bottomPadding * 100 + "%");
    }
    createView() {
        this.parent.classList.add("ejs_beena");
        this.root = document.createElement("section");
        this.root.className = "ejs_beena_book";
        this.root.setAttribute("aria-label", this.text("Storybook"));
        this.root.innerHTML = `<div class="ejs_beena_controls"></div><div class="ejs_beena_stage"><div class="ejs_beena_spread">
            <div class="ejs_beena_page ejs_beena_left"><img draggable="false"></div>
            <div class="ejs_beena_page ejs_beena_right"><img draggable="false"></div>
            <svg class="ejs_beena_pen" viewBox="0 0 1 1" aria-hidden="true">
                <g fill="none" stroke="#2222cc" stroke-width="0.06">
                    <circle cx="0.5" cy="0.5" r="0.1"/><circle cx="0.5" cy="0.5" r="0.47"/>
                    <path d="M.03 .5H.4M.6 .5H.97M.5 .03V.4M.5 .6V.97"/>
                </g>
            </svg>
        </div></div><p class="ejs_beena_status" role="status"></p>`;
        this.stage = this.root.querySelector(".ejs_beena_stage");
        this.spread = this.root.querySelector(".ejs_beena_spread");
        this.images = [...this.root.querySelectorAll("img")];
        this.cursor = this.root.querySelector("svg");
        this.screenCursor = this.cursor.cloneNode(true);
        this.screenCursor.classList.add("ejs_beena_screen_pen");
        this.emulator.frontend.game.appendChild(this.screenCursor);
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
        this.positionControl = document.createElement("div");
        this.positionControl.className = "ejs_beena_position";
        this.selection = document.createElement("button");
        this.selection.type = "button";
        this.selection.id = "ejs-beena-position";
        this.selection.setAttribute("aria-label", this.text("Book position"));
        this.selection.setAttribute("aria-haspopup", "listbox");
        this.selection.setAttribute("aria-expanded", "false");
        this.selection.setAttribute("aria-controls", "ejs-beena-positions");
        this.positionsMenu = document.createElement("div");
        this.positionsMenu.id = "ejs-beena-positions";
        this.positionsMenu.className = "ejs_beena_positions";
        this.positionsMenu.setAttribute("role", "listbox");
        this.positionsMenu.setAttribute("aria-labelledby", this.selection.id);
        this.positionsMenu.hidden = true;
        this.positionOptions = [];
        this.positions = this.manager.getBeenaBookState().positions;
        for (let page = 0; page < this.positions; page++) {
            const option = document.createElement("button");
            option.type = "button";
            option.value = page;
            option.setAttribute("role", "option");
            option.tabIndex = -1;
            option.textContent = `${this.text("Book position")} ${page + 1} / ${this.positions}`;
            this.listen(option, "click", () => {
                if (!this.canInteract()) return;
                this.release(false, true);
                this.manager.setBeenaBookPage(page);
                this.closePositionMenu(true);
                this.render();
            });
            this.positionOptions.push(option);
            this.positionsMenu.appendChild(option);
        }
        this.listen(this.selection, "click", () => {
            if (this.positionsMenu.hidden) this.openPositionMenu();
            else this.closePositionMenu(true);
        });
        this.positionControl.append(this.selection, this.positionsMenu);
        controls.appendChild(this.positionControl);
        button("Next spread", () => this.turn(1));
        this.parent.appendChild(this.root);
    }
    positionMenu() {
        const bounds = this.parent.getBoundingClientRect();
        const anchor = this.selection.getBoundingClientRect();
        const container = this.positionControl.getBoundingClientRect();
        const menu = this.positionsMenu;
        const width = Math.min(anchor.width, bounds.width - 16);
        const below = bounds.bottom - anchor.bottom - 8;
        const above = anchor.top - bounds.top - 8;
        const upward = below < Math.min(220, this.positions * 32 + 2) && above > below;
        menu.style.width = width + "px";
        menu.style.maxHeight = Math.max(0, Math.min(220, upward ? above : below)) + "px";
        menu.style.left = Math.max(bounds.left + 8, Math.min(anchor.left, bounds.right - width - 8)) - container.left + "px";
        menu.style.top = (upward ? anchor.top - menu.offsetHeight - 4 : anchor.bottom + 4) - container.top + "px";
    }
    openPositionMenu() {
        if (!this.canInteract()) return;
        this.positionsMenu.hidden = false;
        this.selection.setAttribute("aria-expanded", "true");
        this.positionMenu();
        const page = this.manager.getBeenaBookState().page;
        this.positionOptions[page].focus({ preventScroll: true });
        this.positionsMenu.scrollTop = this.positionOptions[page].offsetTop - this.positionsMenu.clientHeight / 2;
    }
    closePositionMenu(focus = false) {
        this.positionsMenu.hidden = true;
        this.selection.setAttribute("aria-expanded", "false");
        if (focus) this.selection.focus({ preventScroll: true });
    }
    canInteract() {
        return !this.emulator.paused && !this.emulator.frontend.isSettingsMenuOpen() && !this.emulator.frontend.isPopupOpen();
    }
    turn(delta) {
        const state = this.manager.getBeenaBookState();
        if (state) this.manager.setBeenaBookPage((state.page + delta + state.positions) % state.positions);
    }
    bindInput() {
        for (const type of ["pointerdown", "mousedown", "touchstart", "click"])
            this.listen(this.root, type, event => event.stopPropagation());
        this.listen(this.positionControl, "keydown", event => {
            event.stopPropagation();
            if (event.key === "Escape") {
                event.preventDefault();
                this.closePositionMenu(true);
            } else if (event.key === "Tab") {
                this.closePositionMenu();
            } else if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                if (event.target === this.selection) {
                    if (this.positionsMenu.hidden) this.openPositionMenu();
                    else this.closePositionMenu(true);
                } else if (this.positionOptions.includes(event.target)) {
                    event.target.click();
                }
            } else if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
                event.preventDefault();
                if (this.positionsMenu.hidden) {
                    this.openPositionMenu();
                    return;
                }
                const current = this.positionOptions.indexOf(document.activeElement);
                const next = event.key === "Home" ? 0 : event.key === "End" ? this.positions - 1
                    : (current + (event.key === "ArrowUp" ? -1 : 1) + this.positions) % this.positions;
                this.positionOptions[next].focus({ preventScroll: true });
                this.positionsMenu.scrollTop = this.positionOptions[next].offsetTop - this.positionsMenu.clientHeight / 2;
            }
        });
        this.listen(this.positionControl, "keyup", event => event.stopPropagation());
        this.listen(this.positionControl, "focusout", event => {
            if (!this.positionControl.contains(event.relatedTarget)) this.closePositionMenu();
        });
        this.listen(this.parent, "pointerdown", event => {
            if (!this.positionControl.contains(event.target)) this.closePositionMenu();
        }, { capture: true });
        this.listen(this.parent, "keydown", event => {
            if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.code))
                this.bookPointerPosition = null;
        }, { capture: true });
        const bindSurface = (surface, target) => {
            const point = event => {
                const rect = surface.getBoundingClientRect();
                const outer = target === 1 ? this.artwork.outerPadding / 2 : 0;
                const bottom = target === 1 ? this.artwork.bottomPadding : 0;
                const x = Math.max(-outer, Math.min(1 + outer, (event.clientX - rect.left) / rect.width)) * 255;
                const y = Math.max(0, Math.min(1 + bottom, (event.clientY - rect.top) / rect.height)) * 255;
                const coreX = Math.max(0, Math.min(255, x));
                const coreY = Math.max(0, Math.min(255, y));
                this.bookPointerPosition = target === 1
                    ? { x, y, coreX: Math.round(coreX), coreY: Math.round(coreY) } : null;
                return [coreX, coreY];
            };
            this.listen(surface, "pointerdown", event => {
                if (!this.canInteract() || this.pointer !== null || event.button !== 0) return;
                event.preventDefault();
                event.stopImmediatePropagation();
                this.pointer = event.pointerId;
                this.captureSurface = surface;
                const [x, y] = point(event);
                this.pointerStroke = { x, y, target, ended: false,
                    settleFrames: event.pointerType === "touch" ? TOUCH_PEN_SETTLE_FRAMES : 1 };
                this.penQueue.push(this.pointerStroke);
                this.startPenStroke(this.manager.getFrameNum());
                surface.setPointerCapture(event.pointerId);
                this.parent.focus({ preventScroll: true });
            }, { capture: true });
            this.listen(surface, "pointermove", event => {
                if (!this.canInteract() || (this.pointer !== null && (this.pointer !== event.pointerId || this.captureSurface !== surface))) return;
                if (this.pointer === null && (this.activePenStroke || this.penQueue.length)) return;
                const [x, y] = point(event);
                if (this.pointerStroke) {
                    Object.assign(this.pointerStroke, { x, y });
                    if (this.pointerStroke !== this.activePenStroke) return;
                }
                this.manager.setBeenaBookPen(x, y, !!this.activePenStroke && !this.pendingPress, target);
            });
            for (const type of ["pointerup", "pointercancel", "lostpointercapture"])
                this.listen(surface, type, event => {
                    if (event.pointerId === this.pointer) this.release(false, type !== "pointerup");
                });
            for (const type of ["mousemove", "mousedown", "mouseup", "touchstart", "touchmove", "touchend", "touchcancel"])
                this.listen(surface, type, event => {
                    event.stopImmediatePropagation();
                    if (event.cancelable && type.startsWith("touch")) event.preventDefault();
                }, { capture: true, passive: false });
        };
        bindSurface(this.spread, 1);
        bindSurface(this.emulator.frontend.game, 0);
        this.listen(window, "blur", () => this.release(false, true));
        this.listen(document, "visibilitychange", () => { if (document.hidden) this.release(false, true); });
    }
    startPenStroke(frame) {
        if (this.activePenStroke || !this.penQueue.length || frame <= this.penReleaseFrame) return;
        this.activePenStroke = this.pendingPress = this.penQueue.shift();
        this.pendingPress.frame = frame;
        this.pressFrame = this.releaseFrame = null;
        const { x, y, target } = this.pendingPress;
        this.manager.setBeenaBookPen(x, y, false, target);
    }
    release(clearPosition = false, immediate = false) {
        const pointer = this.pointer;
        this.pointer = null;
        const state = this.manager.getBeenaBookState();
        const keepPosition = !clearPosition && state;
        const defer = !clearPosition && !immediate && this.canInteract();
        if (defer && this.pointerStroke) {
            this.pointerStroke.ended = true;
            if (this.pointerStroke === this.activePenStroke && this.pressFrame !== null)
                this.releaseFrame = this.pressFrame;
        } else {
            this.penQueue.length = 0;
            this.activePenStroke = this.pendingPress = null;
            this.pressFrame = this.releaseFrame = null;
            this.manager.setBeenaBookPen(keepPosition ? state.x : -1, keepPosition ? state.y : -1, false);
            this.penReleaseFrame = this.manager.getFrameNum();
        }
        this.pointerStroke = null;
        if (pointer !== null && this.captureSurface?.hasPointerCapture(pointer)) this.captureSurface.releasePointerCapture(pointer);
        this.captureSurface = null;
    }
    async loadScans() {
        const path = "/" + this.emulator.fileName.replace(/^\/+/, "");
        const archive = this.manager.FS.readFile(path);
        await this.emulator.compression.decompress(archive, () => {}, (name, bytes) => {
            if (this.disposed) return;
            const data = bytes instanceof Uint8Array || bytes instanceof ArrayBuffer ? bytes : new Uint8Array(Object.values(bytes));
            if (/(?:^|\/)beena-book\.json$/i.test(name)) {
                const metadata = JSON.parse(new TextDecoder().decode(data));
                const { pageWidth, inputHeight, outerPadding, bottomPadding } = metadata;
                if (metadata.version !== 1 || ![pageWidth, inputHeight, outerPadding, bottomPadding].every(Number.isFinite) ||
                    pageWidth <= 0 || inputHeight <= 0 || Math.abs(inputHeight / pageWidth - 1.4) > .001 ||
                    outerPadding < 0 || outerPadding > pageWidth * .1 || bottomPadding < 0 || bottomPadding > inputHeight * .1)
                    throw new Error("Invalid Beena book dimensions");
                this.setArtworkDimensions(metadata);
                return;
            }
            const match = /(?:^|\/)page0*(\d+)\.(jpe?g|png|bmp)$/i.exec(name);
            if (!match) return;
            const index = Number(match[1]);
            if (index < 1 || index > 12) return;
            const type = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", bmp: "image/bmp" }[match[2].toLowerCase()];
            if (this.urls.has(index)) URL.revokeObjectURL(this.urls.get(index));
            this.urls.set(index, URL.createObjectURL(new Blob([data], { type })));
        });
        if (this.disposed) return;
        if (!this.urls.size) throw new Error("The cartridge archive contains no page scans");
        this.ready = true;
        this.resizeView();
        this.lastPage = -1;
        this.render();
    }
    render() {
        const state = this.manager.getBeenaBookState();
        if (!state) return;
        if (this.pointer !== null && !this.canInteract()) this.release();
        if (!this.positionsMenu.hidden && !this.canInteract()) this.closePositionMenu();
        if (state.page !== this.lastPage) {
            this.lastPage = state.page;
            this.root.dataset.page = state.page;
            this.selection.textContent = `${this.text("Book position")} ${state.page + 1} / ${this.positions} ▾`;
            this.positionOptions.forEach((option, page) => option.setAttribute("aria-selected", String(page === state.page)));
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
        if (this.bookPointerPosition && (state.target !== 1 ||
            state.x !== this.bookPointerPosition.coreX || state.y !== this.bookPointerPosition.coreY))
            this.bookPointerPosition = null;
        const bookPosition = this.bookPointerPosition || state;
        this.cursor.toggleAttribute("hidden", state.target !== 1);
        this.cursor.style.left = bookPosition.x / 255 * 100 + "%";
        this.cursor.style.top = bookPosition.y / 255 * 100 + "%";
        this.screenCursor.toggleAttribute("hidden", state.target !== 0);
        this.screenCursor.style.left = state.x / 255 * 100 + "%";
        this.screenCursor.style.top = state.y / 255 * 100 + "%";
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
        this.screenCursor.remove();
        this.parent.classList.remove("ejs_beena");
        this.parent.style.removeProperty("--ejs-beena-width");
        this.parent.style.removeProperty("--ejs-beena-tv-height");
    }
}
