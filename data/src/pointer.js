function scalePointerEvent(event, canvas) {
    const view = canvas.ownerDocument.defaultView;
    if (canvas.ownerDocument.pointerLockElement) return event;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return event;
    const dpr = view.devicePixelRatio || 1;
    const scaleX = canvas.width / rect.width / dpr;
    const scaleY = canvas.height / rect.height / dpr;
    if (Math.abs(scaleX - 1) < 0.0001 && Math.abs(scaleY - 1) < 0.0001) return event;

    const point = source => new Proxy(source, {
        get(target, property) {
            if (property === "clientX" || property === "x") return rect.left + Math.round((target.clientX - rect.left) * scaleX);
            if (property === "clientY" || property === "y") return rect.top + Math.round((target.clientY - rect.top) * scaleY);
            if (property === "pageX") return rect.left + view.scrollX + Math.round((target.clientX - rect.left) * scaleX);
            if (property === "pageY") return rect.top + view.scrollY + Math.round((target.clientY - rect.top) * scaleY);
            if (["touches", "changedTouches", "targetTouches"].includes(property)) return Array.from(target[property], point);
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
        }
    });
    return point(event);
}

// The core multiplies CSS coordinates by DPR; its viewport uses canvas pixels.
export function withCorePointerEvents(canvas, startCore) {
    const add = canvas.addEventListener;
    const remove = canvas.removeEventListener;
    const callbacks = new WeakMap();
    const types = new Set(["mousemove", "mousedown", "mouseup", "touchstart", "touchmove", "touchend", "touchcancel"]);
    canvas.addEventListener = function(type, callback, options) {
        if (types.has(type) && typeof callback === "function") {
            let wrapped = callbacks.get(callback);
            if (!wrapped) {
                wrapped = event => callback.call(canvas, scalePointerEvent(event, canvas));
                callbacks.set(callback, wrapped);
            }
            add.call(canvas, type, wrapped, options);
        } else {
            add.call(canvas, type, callback, options);
        }
    };
    canvas.removeEventListener = function(type, callback, options) {
        remove.call(canvas, type, callbacks.get(callback) || callback, options);
    };
    // Keep the wrapper installed after startup: threaded cores register their
    // native listeners asynchronously on the browser thread.
    return startCore();
}
