/**
 * Blink Clip Card
 *
 * Plays the newest clips written by blink.save_recent_clips, in a card shaped
 * like the built-in camera card. Clips are read through Home Assistant's media
 * source API, so they stay behind authentication and nothing is copied into
 * /config/www.
 *
 * https://github.com/schmierlappe/blink-clip-card
 */

const CARD_VERSION = "1.0.9";

console.info(
  `%c BLINK-CLIP-CARD %c ${CARD_VERSION} `,
  "color:#fff;background:#3a7bd5;font-weight:700;border-radius:3px 0 0 3px",
  "color:#3a7bd5;background:#fff;font-weight:700;border-radius:0 3px 3px 0"
);

const DEFAULTS = {
  path: "local/blink",
  clips: 6,
  refresh_interval: 60,
  aspect_ratio: "16:9",
  autoplay: false,
  muted: true,
  utc_timestamps: true,
};

/* -------------------------------------------------------------------------
 * Filenames
 *
 * blink.save_recent_clips writes %Y%m%d_%H%M%S_[camera name].mp4 and the name
 * is not configurable, so it is safe to parse. The timestamp prefix also means
 * a plain descending sort by name is already newest-first.
 * ---------------------------------------------------------------------- */

const VIDEO_FILE = /\.(mp4|m4v|mov|webm)$/i;

const CLIP_NAME = /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})_(.+?)\.\w+$/;

function parseClip(title, utc) {
  const m = CLIP_NAME.exec(title);
  if (!m) return { time: null, camera: null };
  const [, y, mo, d, h, mi, s, camera] = m.map((v) => v);
  const time = utc
    ? new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s))
    : new Date(+y, +mo - 1, +d, +h, +mi, +s);
  return { time, camera };
}

function normalize(s) {
  return String(s).toLowerCase().replace(/[\s_-]+/g, "");
}

function relativeTime(date, locale) {
  if (!date) return "";
  const diff = Math.round((date.getTime() - Date.now()) / 1000);
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (abs < 60) return rtf.format(Math.round(diff), "second");
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  if (abs < 604800) return rtf.format(Math.round(diff / 86400), "day");
  return date.toLocaleString(locale, {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function clock(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const s = Math.floor(seconds % 60);
  const m = Math.floor(seconds / 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function reducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function ratioToCss(value) {
  const m = /^(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)$/.exec(String(value || "16:9"));
  return m ? `${m[1]} / ${m[2]}` : "16 / 9";
}

// resolve_media hands out signed URLs that stop working after `expires`
// seconds. Re-resolve a little before that so a dashboard that stays open
// (wall tablets) keeps playing.
const URL_EXPIRES = 3600;
const URL_TTL_MS = (URL_EXPIRES - 600) * 1000;

// Lower bound for refresh_interval, so a typo can't poll the media API every second.
const MIN_REFRESH = 10;

/**
 * The text without leading and trailing slashes. A loop rather than
 * /^\/+|\/+$/: on a long run of slashes that does not end the string, that
 * pattern is retried from every one of them (super-linear backtracking).
 */
function trimSlashes(text) {
  let start = 0;
  let end = text.length;
  while (start < end && text[start] === "/") start++;
  while (end > start && text[end - 1] === "/") end--;
  return text.slice(start, end);
}

function toMediaId(path) {
  const clean = trimSlashes(String(path || DEFAULTS.path));
  return `media-source://media_source/${clean}`;
}

/* -------------------------------------------------------------------------
 * Card
 * ---------------------------------------------------------------------- */

class BlinkClipCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._clips = [];
    this._index = 0;
    this._urls = new Map();
    this._state = "loading";
    this._message = "";
    this._detail = "";
    this._built = false;
    this._busy = false;
    this._gen = 0; // bumped on every setConfig; results of older loads are dropped
    this._reloadPending = false;
  }

  static getConfigElement() {
    return document.createElement("blink-clip-card-editor");
  }

  static getStubConfig() {
    return { type: "custom:blink-clip-card", path: DEFAULTS.path };
  }

  setConfig(config) {
    if (config.clips !== undefined) {
      const n = Number(config.clips);
      if (!Number.isInteger(n) || n < 1 || n > 30) {
        throw new Error("clips must be a whole number between 1 and 30");
      }
    }
    if (config.refresh_interval !== undefined && !Number.isFinite(Number(config.refresh_interval))) {
      throw new Error("refresh_interval must be a number of seconds");
    }
    this._config = { ...DEFAULTS, ...config };
    this._gen++;
    this._clips = [];
    this._index = 0;
    this._urls.clear();
    this._state = "loading";
    if (this._built) this._render();
    if (this._hass) void this._load(true);
    // The editor creates preview cards that are never attached; only poll
    // while on the page. connectedCallback starts the timer otherwise.
    if (this.isConnected) this._startTimer();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (!this._built) this._build();
    if (first && this._config) void this._load(true);
    else this._paintPoster();
  }

  getCardSize() {
    return 5;
  }

  connectedCallback() {
    this._startTimer();
  }

  disconnectedCallback() {
    this._stopTimer();
  }

  _startTimer() {
    this._stopTimer();
    const secs = Number(this._config?.refresh_interval ?? DEFAULTS.refresh_interval);
    if (secs > 0) {
      const ms = Math.max(secs, MIN_REFRESH) * 1000;
      this._timer = setInterval(() => void this._load(false), ms);
    }
  }

  _stopTimer() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  /* ------------------------------------------------------------ loading -- */

  async _load(showSpinner) {
    if (!this._hass || !this._config) return;
    if (this._busy) {
      // A config change while a load is in flight must not be lost: run
      // again once the current one is through.
      if (showSpinner) this._reloadPending = true;
      return;
    }
    this._busy = true;
    const gen = this._gen;
    if (showSpinner) {
      this._state = "loading";
      this._render();
    }

    try {
      const res = await this._hass.callWS({
        type: "media_source/browse_media",
        media_content_id: toMediaId(this._config.path),
      });
      if (gen !== this._gen) return; // config changed meanwhile; this result is stale

      const next = this._pickClips(res.children || []);
      if (!showSpinner && this._keepCurrent(next)) return;
      this._applyClips(next);
    } catch (err) {
      if (gen === this._gen) this._loadFailed(err, showSpinner);
    } finally {
      this._busy = false;
      if (this._reloadPending) {
        this._reloadPending = false;
        void this._load(true);
      }
    }
  }

  /** The newest clips for this card from a media_source folder listing, newest first. */
  _pickClips(children) {
    const utc = this._config.utc_timestamps !== false;
    let files = children.filter((c) => !c.can_expand && VIDEO_FILE.test(c.title));
    files.forEach((f) => Object.assign(f, parseClip(f.title, utc)));

    if (this._config.camera) {
      const want = normalize(this._config.camera);
      files = files.filter((f) =>
        f.camera ? normalize(f.camera) === want : normalize(f.title).includes(want)
      );
    }

    files.sort((a, b) => b.title.localeCompare(a.title));
    return files.slice(0, Number(this._config.clips));
  }

  /**
   * Whether a background refresh should leave the card as it is. Rebuilding
   * the card replaces the <video>, which stops playback and loses position and
   * mute state, so only redraw when the list really changed, and never in the
   * middle of a clip (the next refresh picks the change up).
   */
  _keepCurrent(next) {
    if (this._state !== "ready") return false;
    const ids = (list) => list.map((c) => c.media_content_id).join("\n");
    if (ids(next) === ids(this._clips)) return true;
    const video = this.shadowRoot.querySelector("video");
    return Boolean(video && !video.paused && !video.ended);
  }

  _applyClips(next) {
    const newestChanged = next[0]?.media_content_id !== this._clips[0]?.media_content_id;
    const userIsBrowsing = this._index > 0;

    this._clips = next;
    if (!userIsBrowsing || newestChanged) this._index = 0;

    if (next.length) {
      this._state = "ready";
    } else {
      this._state = "empty";
      this._message = "No clips found";
    }
    this._render();
    if (next.length) void this._show();
  }

  _loadFailed(err, showSpinner) {
    if (!showSpinner && this._state === "ready" && this._clips.length) {
      // One failed background check shouldn't replace clips that are on screen.
      console.warn("blink-clip-card: refresh failed, keeping current clips", err);
      return;
    }
    this._state = "error";
    this._message = `Could not read ${this._config.path}`;
    this._detail = err?.message || String(err);
    this._render();
  }

  /** A still-valid signed URL for the clip from the cache, or undefined. */
  _cachedUrl(id) {
    const hit = this._urls.get(id);
    if (!hit) return undefined;
    if (Date.now() - hit.at > URL_TTL_MS) {
      this._urls.delete(id);
      return undefined;
    }
    return hit.url;
  }

  async _resolve(clip) {
    const cached = this._cachedUrl(clip.media_content_id);
    if (cached) return cached;
    const res = await this._hass.callWS({
      type: "media_source/resolve_media",
      media_content_id: clip.media_content_id,
      expires: URL_EXPIRES,
    });
    this._urls.set(clip.media_content_id, { url: res.url, at: Date.now() });
    return res.url;
  }

  async _show() {
    const clip = this._clips[this._index];
    const video = this.shadowRoot.querySelector("video");
    if (!clip || !video) return;
    if (video.dataset.clip === clip.media_content_id) return;
    try {
      const url = await this._resolve(clip);
      video.dataset.clip = clip.media_content_id;
      video.src = url;
      this._scrubbing = false;
      this.shadowRoot.querySelector(".stage")?.classList.remove("playing");
      if (this._config.autoplay) video.play().catch(() => {});
    } catch (err) {
      this._state = "error";
      this._message = "Could not open this clip";
      this._detail = err?.message || String(err);
      this._render();
    }
  }

  _select(i) {
    if (i < 0 || i >= this._clips.length || i === this._index) return;
    const adjacent = Math.abs(i - this._index) === 1;
    if (adjacent && !reducedMotion()) {
      this._slide(i > this._index ? 1 : -1, i);
      return;
    }
    this._index = i;
    this._render();
    void this._show();
  }

  /**
   * Carousel transition. The outgoing clip continues in the direction of
   * travel and the incoming one arrives from the opposite edge, so the
   * gesture resolves instead of snapping back.
   */
  _slide(dir, target) {
    if (this._sliding) return;
    this._sliding = true;

    const video = this.shadowRoot.querySelector("video");
    const stage = this.shadowRoot.querySelector(".stage");
    if (!video) {
      this._sliding = false;
      this._index = target;
      this._render();
      void this._show();
      return;
    }

    video.pause();
    stage?.classList.remove("playing");
    video.style.transition = "";
    video.style.transform = `translateX(${dir * 100}%)`;
    video.style.opacity = "0";

    setTimeout(() => {
      this._enterFrom = -dir;
      this._index = target;
      this._sliding = false;
      this._render();
      void this._show();
    }, 260);
  }

  /* ---------------------------------------------------------- rendering -- */

  _build() {
    this.shadowRoot.innerHTML = `<style>${BlinkClipCard.styles}</style><ha-card></ha-card>`;
    this._card = this.shadowRoot.querySelector("ha-card");
    this._built = true;
    this._render();
  }

  _paintPoster() {
    const video = this.shadowRoot.querySelector("video");
    if (!video || !this._config?.entity) return;
    const pic = this._hass.states[this._config.entity]?.attributes?.entity_picture;
    // Compare the attribute, not video.poster: the property is the resolved
    // absolute URL and would never equal the relative entity_picture, so the
    // poster was reset on every state change in Home Assistant.
    if (pic && video.getAttribute("poster") !== pic) video.setAttribute("poster", pic);
  }

  _name() {
    if (this._config.title) return this._config.title;
    const ent = this._config.entity ? this._hass?.states[this._config.entity] : null;
    if (ent) return ent.attributes.friendly_name || this._config.entity;
    const clip = this._clips[this._index];
    return (clip?.camera || this._config.camera || "Blink").replaceAll("_", " ");
  }

  _render() {
    if (!this._card) return;
    this._card.style.setProperty("--bcc-ratio", ratioToCss(this._config?.aspect_ratio));

    if (this._state === "loading") {
      this._card.innerHTML =
        `<div class="stage"><div class="msg">` +
        `<ha-circular-progress indeterminate size="small"></ha-circular-progress>` +
        `</div></div>`;
      return;
    }

    if (this._state === "error" || this._state === "empty") {
      this._card.innerHTML = this._messageMarkup();
      return;
    }

    const clip = this._clips[this._index];
    this._card.innerHTML = this._playerMarkup(clip);

    this._wire();
    this._paintPoster();

    const video = this.shadowRoot.querySelector("video");
    const cached = this._cachedUrl(clip.media_content_id);
    if (video && cached) {
      video.dataset.clip = clip.media_content_id;
      video.src = cached;
    }
  }

  _messageMarkup() {
    const error = this._state === "error";
    const icon = error ? "mdi:alert-circle-outline" : "mdi:video-off-outline";
    const hint = error ? this._detail : "Clips appear here once the save automation has run.";
    return `
        <div class="stage">
          <div class="msg">
            <ha-icon icon="${icon}"></ha-icon>
            <p>${esc(this._message)}</p>
            <p class="detail">${esc(hint)}</p>
          </div>
        </div>`;
  }

  /** Chevrons for older/newer, or nothing when there is only one clip. */
  _navMarkup() {
    if (this._clips.length < 2) return "";
    const olderOff = this._index >= this._clips.length - 1 ? "disabled" : "";
    const newerOff = this._index <= 0 ? "disabled" : "";
    return `<button class="nav older" ${olderOff}
                       aria-label="Older clip"><ha-icon icon="mdi:chevron-left"></ha-icon></button>
               <button class="nav newer" ${newerOff}
                       aria-label="Newer clip"><ha-icon icon="mdi:chevron-right"></ha-icon></button>`;
  }

  /** One segment per clip below the controls, or nothing when there is only one clip. */
  _stripMarkup(locale) {
    if (this._clips.length < 2) return "";
    const segs = this._clips.map((c, i) => {
      const on = i === this._index;
      const label = c.time ? c.time.toLocaleString(locale) : c.title;
      return `<button class="seg${on ? " on" : ""}" data-i="${i}"
                           aria-current="${on}"
                           title="${esc(label)}"><i></i></button>`;
    });
    return `<div class="strip">${segs.join("")}</div>`;
  }

  _playerMarkup(clip) {
    const locale = this._hass?.locale?.language || navigator.language || "en";
    const stamp = clip.time ? relativeTime(clip.time, locale) : clip.title.replace(/\.\w+$/, "");
    const counter = this._clips.length > 1 ? ` · ${this._index + 1}/${this._clips.length}` : "";

    return `
      <div class="stage">
        <video playsinline preload="metadata" ${this._config.muted ? "muted" : ""}></video>
        <div class="scrim"></div>
        <button class="bigplay" aria-label="Play clip">
          <svg viewBox="0 0 24 24" aria-hidden="true"><polygon points="8.33,5 8.33,19 19.33,12"/></svg>
        </button>
        <div class="meta">
          <button class="name"${this._config.entity ? "" : " disabled"}>${esc(this._name())}</button>
          <span class="stamp">${esc(stamp)}${counter}</span>
        </div>
        ${this._navMarkup()}
      </div>
      <div class="controls">
        <button class="pp" aria-label="Play"><ha-icon icon="mdi:play"></ha-icon></button>
        <span class="t cur">0:00</span>
        <input class="seek" type="range" min="0" max="1000" value="0" step="1" aria-label="Seek">
        <span class="t dur">0:00</span>
        <button class="mute" aria-label="Mute">
          <ha-icon icon="${this._config.muted ? "mdi:volume-off" : "mdi:volume-high"}"></ha-icon>
        </button>
        <button class="fs" aria-label="Fullscreen"><ha-icon icon="mdi:fullscreen"></ha-icon></button>
      </div>
      ${this._stripMarkup(locale)}`;
  }

  _wire() {
    const r = this.shadowRoot;
    r.querySelector(".older")?.addEventListener("click", () => this._select(this._index + 1));
    r.querySelector(".newer")?.addEventListener("click", () => this._select(this._index - 1));

    const video = r.querySelector("video");
    const stage = r.querySelector(".stage");
    const pp = r.querySelector(".pp");
    const seek = r.querySelector(".seek");
    const cur = r.querySelector(".cur");
    const dur = r.querySelector(".dur");
    const mute = r.querySelector(".mute");

    const setIcon = (btn, icon) => btn?.querySelector("ha-icon")?.setAttribute("icon", icon);
    const paint = () => {
      const pct = video.duration ? (video.currentTime / video.duration) * 100 : 0;
      seek.style.setProperty("--pct", `${pct}%`);
    };

    // The overlay is only there to make the name readable on a paused frame.
    // Once playback starts it is in the way, so it goes immediately.
    video.addEventListener("play", () => {
      stage.classList.add("playing");
      setIcon(pp, "mdi:pause");
      pp.setAttribute("aria-label", "Pause");
    });
    const stopped = () => {
      stage.classList.remove("playing");
      setIcon(pp, "mdi:play");
      pp.setAttribute("aria-label", "Play");
    };
    video.addEventListener("pause", stopped);
    video.addEventListener("ended", stopped);

    // A signed URL can still expire (e.g. the device slept past the TTL).
    // Drop it and resolve a fresh one, once per clip, so this can't loop.
    video.addEventListener("error", () => {
      const id = video.dataset.clip;
      if (!id || video.dataset.retried === id) return;
      video.dataset.retried = id;
      this._urls.delete(id);
      delete video.dataset.clip;
      void this._show();
    });

    video.addEventListener("loadedmetadata", () => {
      dur.textContent = clock(video.duration);
      seek.value = 0;
      cur.textContent = "0:00";
      paint();
    });
    video.addEventListener("timeupdate", () => {
      if (this._scrubbing || !video.duration) return;
      seek.value = Math.round((video.currentTime / video.duration) * 1000);
      cur.textContent = clock(video.currentTime);
      paint();
    });

    pp.addEventListener("click", () => {
      if (video.paused) video.play().catch(() => {});
      else video.pause();
    });
    r.querySelector(".bigplay")?.addEventListener("click", (ev) => {
      ev.stopPropagation();
      video.play().catch(() => {});
    });
    stage.addEventListener("click", (ev) => {
      if (ev.target.closest(".nav, .name, .bigplay")) return;
      if (this._swiped) {
        this._swiped = false;
        return;
      }
      if (video.paused) video.play().catch(() => {});
      else video.pause();
    });

    seek.addEventListener("input", () => {
      this._scrubbing = true;
      const t = (seek.value / 1000) * (video.duration || 0);
      cur.textContent = clock(t);
      seek.style.setProperty("--pct", `${seek.value / 10}%`);
    });
    const commit = () => {
      if (!this._scrubbing) return;
      this._scrubbing = false;
      if (video.duration) video.currentTime = (seek.value / 1000) * video.duration;
    };
    seek.addEventListener("change", commit);
    seek.addEventListener("pointerup", commit);

    mute.addEventListener("click", () => {
      video.muted = !video.muted;
      setIcon(mute, video.muted ? "mdi:volume-off" : "mdi:volume-high");
      mute.setAttribute("aria-label", video.muted ? "Unmute" : "Mute");
    });
    r.querySelector(".fs")?.addEventListener("click", () => {
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      } else if (video.requestFullscreen) {
        // iPhone Safari rejects element fullscreen for <video>; use its own player there.
        video.requestFullscreen().catch(() => video.webkitEnterFullscreen?.());
      } else {
        video.webkitEnterFullscreen?.();
      }
    });

    // Swipe between clips. Older clips sit to the left (matching the chevrons
    // and the strip), so dragging right brings an older one in.
    if (this._clips.length > 1) {
      const SLOP = 8; // px before a drag counts as horizontal
      let active = false;
      let startX = 0;
      let startY = 0;
      let startT = 0;
      let dx = 0;
      let horizontal = false;
      let pid = null;

      const canGo = (dir) => {
        const t = this._index + dir;
        return t >= 0 && t < this._clips.length;
      };

      stage.addEventListener("pointerdown", (ev) => {
        if (this._sliding) return;
        if (ev.pointerType === "mouse" && ev.button !== 0) return;
        active = true;
        horizontal = false;
        startX = ev.clientX;
        startY = ev.clientY;
        startT = performance.now();
        dx = 0;
        pid = ev.pointerId;
      });

      stage.addEventListener("pointermove", (ev) => {
        if (!active) return;
        dx = ev.clientX - startX;
        const dy = ev.clientY - startY;

        if (!horizontal) {
          if (Math.abs(dy) > SLOP && Math.abs(dy) > Math.abs(dx)) {
            active = false; // vertical intent, hand it back to the page
            return;
          }
          if (Math.abs(dx) <= SLOP) return;
          horizontal = true;
          try {
            stage.setPointerCapture(pid);
          } catch (e) {
            /* capture is a nicety, not a requirement */
          }
        }

        // Track the finger 1:1, with resistance when there is nothing to
        // reveal in that direction.
        const towards = dx > 0 ? 1 : -1;
        const eff = canGo(towards) ? dx : dx * 0.28;
        video.style.transition = "none";
        video.style.transform = `translateX(${eff}px)`;
      });

      const finish = () => {
        if (!active) return;
        active = false;
        try {
          if (pid !== null) stage.releasePointerCapture(pid);
        } catch (e) {
          /* already released */
        }
        if (!horizontal) return;

        // Any real drag suppresses the tap-to-play toggle that follows it.
        this._swiped = true;
        setTimeout(() => (this._swiped = false), 350);

        const width = stage.clientWidth || 1;
        const velocity = dx / Math.max(performance.now() - startT, 1); // px/ms
        const dir = dx > 0 ? 1 : -1;
        const committed = Math.abs(dx) > width * 0.22 || Math.abs(velocity) > 0.45;

        if (committed && canGo(dir)) {
          video.style.transition = "";
          this._slide(dir, this._index + dir);
        } else {
          video.style.transition = "";
          video.style.transform = "";
        }
      };

      stage.addEventListener("pointerup", finish);
      stage.addEventListener("pointercancel", finish);
    }

    // Arrival half of a carousel transition.
    if (this._enterFrom) {
      const from = this._enterFrom;
      this._enterFrom = 0;
      video.style.transition = "none";
      video.style.transform = `translateX(${from * 100}%)`;
      video.style.opacity = "0";
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          video.style.transition = "";
          video.style.transform = "";
          video.style.opacity = "";
        })
      );
    }

    r.querySelectorAll(".seg").forEach((el) =>
      el.addEventListener("click", () => this._select(Number(el.dataset.i)))
    );
    r.querySelector(".name")?.addEventListener("click", () => {
      if (!this._config.entity) return;
      this.dispatchEvent(
        new CustomEvent("hass-more-info", {
          detail: { entityId: this._config.entity },
          bubbles: true,
          composed: true,
        })
      );
    });
  }

  static get styles() {
    return `
      ha-card { overflow: hidden; padding: 0; }

      .stage {
        position: relative; width: 100%;
        aspect-ratio: var(--bcc-ratio, 16 / 9);
        background: #000;
        touch-action: pan-y;
        user-select: none; -webkit-user-select: none;
      }
      video {
        width: 100%; height: 100%; object-fit: cover; display: block; background: #000;
        transition: transform .3s cubic-bezier(.32, .72, 0, 1),
                    opacity .3s cubic-bezier(.32, .72, 0, 1);
        will-change: transform;
      }

      .scrim {
        position: absolute; inset: auto 0 0 0; height: 76px;
        background: linear-gradient(transparent, rgba(0,0,0,.72));
        pointer-events: none;
        transition: opacity .12s linear;
      }
      .meta {
        position: absolute; left: 12px; right: 12px; bottom: 12px;
        display: flex; align-items: baseline; justify-content: space-between; gap: 8px;
        pointer-events: none;
        transition: opacity .12s linear;
      }
      .bigplay {
        position: absolute; inset: 0; margin: auto;
        width: 56px; height: 56px; padding: 0;
        border: 0; border-radius: 50%; cursor: pointer;
        background: rgba(0,0,0,.45);
        backdrop-filter: blur(2px);
        color: #fff;
        display: block; line-height: 0;
        transition: opacity .12s linear, background .15s ease;
      }
      .bigplay:hover { background: rgba(0,0,0,.62); }
      .bigplay:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 3px; }
      .bigplay svg {
        display: block; width: 34px; height: 34px; margin: 11px;
        fill: currentColor;
      }

      .stage.playing .scrim,
      .stage.playing .meta,
      .stage.playing .bigplay { opacity: 0; }
      .stage.playing .bigplay { pointer-events: none; }
      .stage.playing .name { pointer-events: none; }
      .name {
        pointer-events: auto; background: none; border: 0; padding: 0;
        font: 500 15px/1.2 var(--ha-card-header-font-family, inherit);
        color: #fff; text-shadow: 0 1px 4px rgba(0,0,0,.9); cursor: pointer;
      }
      .name[disabled] { cursor: default; }
      .name:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 3px; }
      .stamp {
        font: 400 12px/1.2 var(--ha-card-header-font-family, inherit);
        color: rgba(255,255,255,.82); text-shadow: 0 1px 4px rgba(0,0,0,.9);
        white-space: nowrap;
      }

      .nav {
        position: absolute; top: 50%; transform: translateY(-50%);
        width: 36px; height: 36px; border: 0; border-radius: 50%;
        background: rgba(0,0,0,.42); color: #fff; cursor: pointer;
        display: grid; place-items: center; --mdc-icon-size: 24px;
        opacity: 0; transition: opacity .18s ease;
      }
      .stage:hover .nav, .nav:focus-visible { opacity: 1; }
      .nav[disabled] { opacity: 0 !important; pointer-events: none; }
      .older { left: 8px; } .newer { right: 8px; }
      @media (hover: none) { .nav { opacity: .8; } }

      /* transport, always visible, below the video so nothing covers the picture */
      .controls {
        display: flex; align-items: center; gap: 8px;
        padding: 6px 8px 6px 4px;
        background: var(--ha-card-background, var(--card-background-color));
        color: var(--primary-text-color);
      }
      .controls button {
        flex: 0 0 auto; width: 34px; height: 34px;
        border: 0; border-radius: 50%; background: none; cursor: pointer;
        color: var(--primary-text-color);
        display: grid; place-items: center; --mdc-icon-size: 22px;
      }
      .controls button:hover { background: var(--divider-color, rgba(127,127,127,.2)); }
      .controls button:focus-visible { outline: 2px solid var(--primary-color); outline-offset: -2px; }
      .t {
        flex: 0 0 auto; font-variant-numeric: tabular-nums;
        font: 400 12px/1 var(--ha-card-header-font-family, inherit);
        color: var(--secondary-text-color);
      }
      .seek {
        flex: 1 1 auto; min-width: 40px; height: 20px; margin: 0;
        -webkit-appearance: none; appearance: none; background: none; cursor: pointer;
        --pct: 0%;
      }
      .seek::-webkit-slider-runnable-track {
        height: 4px; border-radius: 2px;
        background: linear-gradient(to right,
          var(--primary-color) var(--pct), var(--divider-color, #d0d0d0) var(--pct));
      }
      .seek::-moz-range-track {
        height: 4px; border-radius: 2px; background: var(--divider-color, #d0d0d0);
      }
      .seek::-moz-range-progress {
        height: 4px; border-radius: 2px; background: var(--primary-color);
      }
      .seek::-webkit-slider-thumb {
        -webkit-appearance: none; appearance: none;
        width: 12px; height: 12px; margin-top: -4px; border: 0; border-radius: 50%;
        background: var(--primary-color);
      }
      .seek::-moz-range-thumb {
        width: 12px; height: 12px; border: 0; border-radius: 50%;
        background: var(--primary-color);
      }
      .seek:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; }

      /* one segment per clip, newest on the right */
      .strip {
        display: flex; flex-direction: row-reverse; gap: 2px;
        padding: 10px 12px 12px;
        background: var(--ha-card-background, var(--card-background-color));
      }
      .seg {
        flex: 1; height: 14px; padding: 0; border: 0; background: none;
        cursor: pointer; display: grid; align-items: center;
      }
      .seg i {
        display: block; height: 3px; border-radius: 2px;
        background: var(--divider-color, #d0d0d0);
        transition: background .15s ease, height .15s ease;
      }
      .seg:hover i { background: var(--secondary-text-color); }
      .seg.on i { background: var(--primary-color); height: 5px; }
      .seg:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 1px; }

      .msg {
        position: absolute; inset: 0; padding: 16px;
        display: flex; flex-direction: column; align-items: center; justify-content: center;
        gap: 8px; text-align: center; color: var(--secondary-text-color);
      }
      .msg ha-icon { --mdc-icon-size: 32px; }
      .msg p { margin: 0; font-size: 14px; }
      .msg .detail { font-size: 12px; opacity: .7; }

      @media (prefers-reduced-motion: reduce) {
        .nav, .seg i, .bigplay, .scrim, .meta { transition: none; }
        video { transition: none; }
      }
    `;
  }
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

customElements.define("blink-clip-card", BlinkClipCard);

/* -------------------------------------------------------------------------
 * Visual editor
 * ---------------------------------------------------------------------- */

const SCHEMA = [
  { name: "path", required: true, selector: { text: {} } },
  { name: "title", selector: { text: {} } },
  { name: "camera", selector: { text: {} } },
  { name: "entity", selector: { entity: { filter: [{ domain: "camera" }] } } },
  {
    type: "grid",
    schema: [
      { name: "clips", selector: { number: { min: 1, max: 30, mode: "box" } } },
      { name: "refresh_interval", selector: { number: { min: 0, max: 3600, mode: "box" } } },
      { name: "aspect_ratio", selector: { text: {} } },
    ],
  },
  {
    type: "grid",
    schema: [
      { name: "autoplay", selector: { boolean: {} } },
      { name: "muted", selector: { boolean: {} } },
      { name: "utc_timestamps", selector: { boolean: {} } },
    ],
  },
];

const LABELS = {
  path: "Media folder (relative to your media root)",
  title: "Name shown on the video",
  camera: "Camera name in the filename",
  entity: "Camera entity (still image and details)",
  clips: "Clips in the strip",
  refresh_interval: "Check for new clips every (seconds)",
  aspect_ratio: "Aspect ratio",
  autoplay: "Play on load",
  muted: "Start muted",
  utc_timestamps: "Filenames are in UTC",
};

class BlinkClipCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = config;
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  _render() {
    if (!this._config || !this._hass) return;
    if (!this._form) {
      this._form = document.createElement("ha-form");
      this._form.computeLabel = (s) => LABELS[s.name] || s.name;
      this._form.addEventListener("value-changed", (ev) => {
        ev.stopPropagation();
        this.dispatchEvent(
          new CustomEvent("config-changed", {
            detail: { config: { type: "custom:blink-clip-card", ...ev.detail.value } },
            bubbles: true,
            composed: true,
          })
        );
      });
      this.appendChild(this._form);
    }
    this._form.hass = this._hass;
    this._form.schema = SCHEMA;
    this._form.data = { ...DEFAULTS, ...this._config };
  }
}

customElements.define("blink-clip-card-editor", BlinkClipCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "blink-clip-card",
  name: "Blink Clip Card",
  description: "Plays the newest clips saved from your Blink cameras.",
  preview: false,
  documentationURL: "https://github.com/schmierlappe/blink-clip-card",
});
