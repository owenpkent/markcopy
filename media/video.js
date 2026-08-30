// src/webview/menu.ts
var HOVER_CLOSE_MS = 150;
var panelSeq = 0;
function createMenu(root) {
  const panels = [];
  const anchorOf = /* @__PURE__ */ new WeakMap();
  let pendingClose;
  let invoker;
  const closeListeners = /* @__PURE__ */ new Set();
  function owns(node) {
    return panels.some((panel) => panel === node || panel.contains(node));
  }
  function cancelPendingClose() {
    if (pendingClose !== void 0) {
      window.clearTimeout(pendingClose);
      pendingClose = void 0;
    }
  }
  function scheduleClose(depth) {
    cancelPendingClose();
    pendingClose = window.setTimeout(() => {
      pendingClose = void 0;
      closeFrom(depth);
    }, HOVER_CLOSE_MS);
  }
  function closeFrom(depth) {
    cancelPendingClose();
    const wasOpen = panels.length > 0;
    const heldFocus = owns(document.activeElement);
    while (panels.length > depth) {
      const panel = panels.pop();
      const anchor = anchorOf.get(panel);
      if (anchor) {
        anchor.setAttribute("aria-expanded", "false");
        anchor.removeAttribute("aria-controls");
      }
      if (panel === root) {
        root.hidden = true;
        root.innerHTML = "";
      } else {
        panel.remove();
      }
    }
    if (depth > 0 || !wasOpen) {
      return;
    }
    const returnTo = invoker;
    invoker = void 0;
    if (heldFocus && returnTo?.isConnected) {
      returnTo.focus();
    }
    for (const listener of [...closeListeners]) {
      listener();
    }
  }
  function rows(panel) {
    return panel ? Array.from(panel.querySelectorAll(".mc-menu-item")) : [];
  }
  function focusFirst(panel) {
    rows(panel)[0]?.focus();
  }
  function moveFocus(panel, current, delta) {
    const list = rows(panel);
    if (list.length === 0) return;
    const next = (list.indexOf(current) + delta + list.length) % list.length;
    list[next].focus();
  }
  function isOpenFor(anchor, depth) {
    const panel = panels[depth];
    return !!panel && anchorOf.get(panel) === anchor;
  }
  function wirePanel(panel) {
    panel.addEventListener("click", (ev) => ev.stopPropagation());
    panel.addEventListener("mouseenter", cancelPendingClose);
  }
  wirePanel(root);
  function openSubmenu(anchor, entries, depth) {
    const parent = panels[depth - 1];
    if (!parent) return;
    const panel = document.createElement("div");
    panel.className = "mc-menu mc-menu--sub";
    panel.setAttribute("role", "menu");
    panelSeq += 1;
    panel.id = `mc-submenu-${panelSeq}`;
    if (!anchor.id) anchor.id = `mc-submenu-anchor-${panelSeq}`;
    panel.setAttribute("aria-labelledby", anchor.id);
    anchor.setAttribute("aria-controls", panel.id);
    anchor.setAttribute("aria-expanded", "true");
    wirePanel(panel);
    document.body.appendChild(panel);
    panels.push(panel);
    anchorOf.set(panel, anchor);
    render(panel, entries, depth);
    const row = anchor.getBoundingClientRect();
    const box = parent.getBoundingClientRect();
    let left = box.right - 4;
    if (left + panel.offsetWidth > window.innerWidth) {
      left = Math.max(0, box.left - panel.offsetWidth + 4);
    }
    let top = row.top - 4;
    if (top + panel.offsetHeight > window.innerHeight) {
      top = Math.max(0, window.innerHeight - panel.offsetHeight);
    }
    panel.style.left = `${left + window.scrollX}px`;
    panel.style.top = `${top + window.scrollY}px`;
  }
  function rowFor(entry, depth) {
    if (entry.kind === "divider") {
      const el2 = document.createElement("div");
      el2.className = "mc-menu-divider";
      el2.setAttribute("role", "separator");
      return el2;
    }
    if (entry.kind === "label") {
      const el2 = document.createElement("div");
      el2.className = "mc-menu-group-label";
      el2.textContent = entry.label;
      return el2;
    }
    const el = document.createElement("div");
    el.tabIndex = 0;
    if (entry.kind === "radio" || entry.kind === "checkbox") {
      el.className = "mc-menu-item mc-menu-item--check";
      el.setAttribute("role", entry.kind === "radio" ? "menuitemradio" : "menuitemcheckbox");
      el.setAttribute("aria-checked", String(entry.checked));
      const check = document.createElement("span");
      check.className = "mc-menu-check";
      check.setAttribute("aria-hidden", "true");
      check.textContent = entry.checked ? "\u2713" : "";
      const text = document.createElement("span");
      text.textContent = entry.label;
      el.append(check, text);
    } else if (entry.kind === "submenu") {
      el.className = "mc-menu-item mc-menu-item--submenu";
      el.setAttribute("role", "menuitem");
      el.setAttribute("aria-haspopup", "true");
      el.setAttribute("aria-expanded", "false");
      const text = document.createElement("span");
      text.textContent = entry.label;
      const arrow = document.createElement("span");
      arrow.className = "mc-menu-arrow";
      arrow.setAttribute("aria-hidden", "true");
      arrow.textContent = "\u25B8";
      el.append(text, arrow);
    } else {
      el.className = "mc-menu-item";
      el.setAttribute("role", "menuitem");
      el.textContent = entry.label;
    }
    el.addEventListener("mouseenter", () => {
      cancelPendingClose();
      if (entry.kind !== "submenu") {
        scheduleClose(depth + 1);
        return;
      }
      if (isOpenFor(el, depth + 1)) return;
      closeFrom(depth + 1);
      openSubmenu(el, entry.entries, depth + 1);
    });
    el.addEventListener("focus", () => closeFrom(depth + 1));
    el.addEventListener("click", (ev) => {
      ev.stopPropagation();
      cancelPendingClose();
      if (entry.kind === "submenu") {
        if (!isOpenFor(el, depth + 1)) {
          closeFrom(depth + 1);
          openSubmenu(el, entry.entries, depth + 1);
        }
        focusFirst(panels[depth + 1]);
        return;
      }
      closeFrom(0);
      void entry.run();
    });
    el.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        el.click();
      } else if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
        ev.preventDefault();
        ev.stopPropagation();
        moveFocus(panels[depth], el, ev.key === "ArrowDown" ? 1 : -1);
      } else if (ev.key === "ArrowRight" && entry.kind === "submenu") {
        ev.preventDefault();
        ev.stopPropagation();
        el.click();
      } else if (ev.key === "ArrowLeft" || ev.key === "Escape") {
        if (depth === 0 && ev.key === "Escape") return;
        ev.preventDefault();
        ev.stopPropagation();
        if (depth === 0) return;
        const parentRow = anchorOf.get(panels[depth]);
        closeFrom(depth);
        parentRow?.focus();
      }
    });
    return el;
  }
  function render(panel, entries, depth) {
    panel.innerHTML = "";
    for (const entry of entries) {
      panel.appendChild(rowFor(entry, depth));
    }
  }
  return {
    show(pageX, pageY, entries) {
      const opener = document.activeElement;
      closeFrom(0);
      invoker = opener instanceof HTMLElement && opener !== document.body ? opener : void 0;
      panels.push(root);
      render(root, entries, 0);
      root.style.left = `${pageX}px`;
      root.style.top = `${pageY}px`;
      root.hidden = false;
      const rect = root.getBoundingClientRect();
      if (rect.right > window.innerWidth) {
        root.style.left = `${Math.max(0, pageX - rect.width)}px`;
      }
      if (rect.bottom > window.innerHeight) {
        root.style.top = `${Math.max(0, pageY - rect.height)}px`;
      }
      focusFirst(root);
    },
    hide() {
      closeFrom(0);
    },
    owns,
    isOpen() {
      return panels.length > 0;
    },
    onClose(listener) {
      closeListeners.add(listener);
      return () => {
        closeListeners.delete(listener);
      };
    }
  };
}

// src/webview/videoInfo.ts
function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "--:--";
  }
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor(total % 3600 / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "";
  }
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit >= 2 ? Math.round(value * 10) / 10 : Math.round(value);
  return `${rounded} ${units[unit]}`;
}
function timecodeSlug(seconds) {
  const total = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor(total % 3600 / 60);
  const s = (total % 60).toFixed(3).padStart(6, "0");
  if (h > 0) {
    return `${h}h${String(m).padStart(2, "0")}m${s}s`;
  }
  return m > 0 ? `${m}m${s}s` : `${s}s`;
}
function frameFileName(videoName, seconds) {
  const dot = videoName.lastIndexOf(".");
  const base = dot > 0 ? videoName.slice(0, dot) : videoName || "frame";
  return `${base}-${timecodeSlug(seconds)}.png`;
}
function describeMediaError(code, name) {
  switch (code) {
    case 1:
      return `Loading ${name} was cancelled.`;
    case 2:
      return `${name} could not be read from disk.`;
    case 3:
      return `${name} is damaged, or uses a codec VS Code cannot decode. Try opening it in your default player.`;
    default:
      return `VS Code cannot play ${name}. It supports H.264 (and AAC audio); ProRes, DNxHD, and most HEVC files need your default player.`;
  }
}

// src/webview/video.ts
var vscode = acquireVsCodeApi();
var video = document.getElementById("mc-video");
var stage = document.getElementById("mc-stage");
var statusEl = document.getElementById("mc-status");
var errorEl = document.getElementById("mc-error");
var menuEl = document.getElementById("mc-menu");
var toastEl = document.getElementById("mc-toast");
var contextMenu = createMenu(menuEl);
var fileName = "";
var filePath = "";
var fileBytes = 0;
var sourceUri = "";
var frameCopyBlocked = false;
var corsRetried = false;
var currentTheme = document.body.getAttribute("data-mc-theme") || "auto";
var toastTimer = 0;
function toast(text, ms = 1600) {
  toastEl.textContent = text;
  toastEl.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.hidden = true, ms);
}
function updateStatus() {
  const parts = [fileName];
  if (video.videoWidth > 0) {
    parts.push(`${video.videoWidth}x${video.videoHeight}`);
  }
  if (video.duration > 0) {
    parts.push(formatDuration(video.duration));
  }
  const size = formatBytes(fileBytes);
  if (size) {
    parts.push(size);
  }
  statusEl.textContent = parts.join("  \xB7  ");
}
function showError(message) {
  stage.hidden = true;
  errorEl.hidden = false;
  errorEl.textContent = "";
  const text = document.createElement("p");
  text.className = "mc-video-error-text";
  text.textContent = message;
  errorEl.appendChild(text);
  const open = document.createElement("button");
  open.type = "button";
  open.className = "mc-video-button";
  open.textContent = "Open in Default App";
  open.addEventListener("click", () => vscode.postMessage({ type: "openExternal" }));
  errorEl.appendChild(open);
}
function load(msg) {
  fileName = msg.name;
  filePath = msg.path;
  fileBytes = msg.size;
  sourceUri = msg.src;
  video.loop = msg.loop;
  video.autoplay = msg.autoplay;
  video.muted = msg.autoplay;
  video.crossOrigin = "anonymous";
  video.src = sourceUri;
  updateStatus();
}
video.addEventListener("loadedmetadata", () => {
  stage.hidden = false;
  errorEl.hidden = true;
  updateStatus();
});
video.addEventListener("error", () => {
  if (!corsRetried && sourceUri) {
    corsRetried = true;
    frameCopyBlocked = true;
    video.removeAttribute("crossorigin");
    video.src = sourceUri;
    video.load();
    return;
  }
  showError(describeMediaError(video.error?.code, fileName));
});
function frameCanvas() {
  if (!video.videoWidth || !video.videoHeight) {
    return null;
  }
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return null;
  }
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas;
}
function toBlob(canvas) {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}
function frameFailure() {
  return frameCopyBlocked ? "Frames cannot be copied from this file" : "Could not read the current frame";
}
async function copyFramePng() {
  const canvas = frameCanvas();
  if (!canvas) {
    toast("No frame to copy yet");
    return;
  }
  try {
    const blob = await toBlob(canvas);
    if (blob && navigator.clipboard && "write" in navigator.clipboard) {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      toast("Copied frame as PNG");
    } else {
      toast("PNG copy not supported here");
    }
  } catch {
    toast(frameFailure());
  }
}
async function saveFramePng() {
  const canvas = frameCanvas();
  if (!canvas) {
    toast("No frame to save yet");
    return;
  }
  try {
    const data = canvas.toDataURL("image/png");
    vscode.postMessage({
      type: "saveFrame",
      data: data.slice(data.indexOf(",") + 1),
      name: frameFileName(fileName, video.currentTime)
    });
  } catch {
    toast(frameFailure());
  }
}
function copyText(text, label) {
  if (!text) {
    toast("Nothing to copy");
    return;
  }
  const onCopy = (e) => {
    e.clipboardData?.setData("text/plain", text);
    e.preventDefault();
  };
  document.addEventListener("copy", onCopy);
  const ok = document.execCommand("copy");
  document.removeEventListener("copy", onCopy);
  if (!ok) {
    void navigator.clipboard?.writeText(text);
  }
  toast(label);
}
var SPEEDS = [0.25, 0.5, 1, 1.5, 2];
function setSpeed(rate) {
  video.playbackRate = rate;
  toast(rate === 1 ? "Normal speed" : `${rate}x speed`);
}
function toggleLoop() {
  video.loop = !video.loop;
  vscode.postMessage({ type: "updateSetting", key: "video.loop", value: video.loop });
  toast(video.loop ? "Looping" : "Looping off");
}
function togglePlay() {
  if (video.paused) {
    void video.play().catch(() => void 0);
  } else {
    video.pause();
  }
}
function nudge(seconds) {
  if (!Number.isFinite(video.duration)) {
    return;
  }
  video.currentTime = Math.min(Math.max(0, video.currentTime + seconds), video.duration);
}
stage.addEventListener("click", (e) => {
  if (e.target === video) {
    togglePlay();
  }
});
document.addEventListener("keydown", (e) => {
  if (contextMenu.isOpen() || e.ctrlKey || e.metaKey || e.altKey) {
    return;
  }
  switch (e.key) {
    case " ":
      e.preventDefault();
      togglePlay();
      break;
    case ",":
      nudge(-1 / 30);
      break;
    case ".":
      nudge(1 / 30);
      break;
    case "m":
      video.muted = !video.muted;
      break;
    case "f":
      if (document.fullscreenElement) {
        void document.exitFullscreen();
      } else {
        void video.requestFullscreen?.().catch(() => void 0);
      }
      break;
    default:
      break;
  }
});
document.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  const entries = [
    { kind: "item", label: "Copy Frame as PNG", run: () => void copyFramePng() },
    { kind: "item", label: "Save Frame as PNG\u2026", run: () => void saveFramePng() },
    { kind: "divider" },
    {
      kind: "submenu",
      label: "Copy as",
      entries: [
        { kind: "item", label: "File Name", run: () => copyText(fileName, "Copied file name") },
        { kind: "item", label: "Full Path", run: () => copyText(filePath, "Copied path") }
      ]
    },
    { kind: "divider" },
    {
      kind: "submenu",
      label: "Playback",
      entries: [
        { kind: "checkbox", label: "Loop", checked: video.loop, run: toggleLoop },
        { kind: "divider" },
        { kind: "label", label: "Speed" },
        ...SPEEDS.map((rate) => ({
          kind: "radio",
          label: rate === 1 ? "Normal" : `${rate}x`,
          checked: Math.abs(video.playbackRate - rate) < 1e-6,
          run: () => setSpeed(rate)
        }))
      ]
    },
    { kind: "divider" },
    { kind: "submenu", label: "Preferences", entries: themeItems() },
    { kind: "divider" },
    {
      kind: "item",
      label: "Open in Default App",
      run: () => vscode.postMessage({ type: "openExternal" })
    }
  ];
  contextMenu.show(e.pageX, e.pageY, entries);
});
function themeItems() {
  const entry = (label, value) => ({
    kind: "radio",
    label,
    checked: currentTheme === value,
    run: () => setTheme(value)
  });
  return [
    {
      kind: "submenu",
      label: "Theme",
      entries: [
        entry("Auto", "auto"),
        entry("Light", "light"),
        entry("Dark", "dark"),
        entry("Green on black", "green")
      ]
    }
  ];
}
function setTheme(value) {
  applyTheme(value);
  vscode.postMessage({ type: "updateSetting", key: "theme", value });
}
function applyTheme(value) {
  currentTheme = value;
  document.body.setAttribute("data-mc-theme", value);
}
window.addEventListener("message", (event) => {
  const msg = event.data;
  if (!msg) {
    return;
  }
  if (msg.type === "load") {
    load(msg);
  } else if (msg.type === "error") {
    showError(msg.message);
  } else if (msg.type === "setTheme") {
    applyTheme(msg.value);
  } else if (msg.type === "toast") {
    toast(msg.message);
  }
});
vscode.postMessage({ type: "ready" });
//# sourceMappingURL=video.js.map
