// Opening a window where it was last left. A place saved on another screen layout (a monitor
// unplugged, a laptop undocked) is refused by Chrome: "Bounds must be at least 50% within
// visible screen space". Then the window opens at Chrome's own spot, at its usual size, and
// onStale runs first so the old place is forgotten before the page looks for it.

/** create: chrome.windows.create; opts: the window without a place; saved: { left, top, width, height } or nothing. */
export async function createWindowAt(create, opts, saved, onStale = async () => {}) {
  if (saved) {
    try {
      return await create({ ...opts, width: saved.width || opts.width, height: saved.height || opts.height, left: saved.left, top: saved.top });
    } catch {
      await onStale();
    }
  }
  return create(opts);
}
