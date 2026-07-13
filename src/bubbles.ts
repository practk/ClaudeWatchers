// 視窗內泡泡通知:閱後即焚,不進 Windows 通知中心。純 DOM 模組(比照 confetti.ts)。

export type BubbleKind = "done" | "waiting" | "info";

const MAX_BUBBLES = 3;
const DISMISS_MS = 4000;

export function showBubble(kind: BubbleKind, title: string, body: string): void {
  const layer = document.querySelector<HTMLDivElement>("#bubble-layer");
  if (!layer) return;

  while (layer.children.length >= MAX_BUBBLES) {
    layer.firstElementChild?.remove();
  }

  const el = document.createElement("div");
  el.className = `bubble bubble-${kind}`;
  const titleEl = document.createElement("div");
  titleEl.className = "bubble-title";
  titleEl.textContent = title;
  const bodyEl = document.createElement("div");
  bodyEl.className = "bubble-body";
  bodyEl.textContent = body;
  el.append(titleEl, bodyEl);
  layer.appendChild(el);

  let timer = 0;
  const dismiss = () => {
    el.classList.add("bubble-out");
    el.addEventListener("transitionend", () => el.remove(), { once: true });
    window.setTimeout(() => el.remove(), 400); // transition 沒觸發時的保險
  };
  const startTimer = () => {
    timer = window.setTimeout(dismiss, DISMISS_MS);
  };
  el.addEventListener("mouseenter", () => clearTimeout(timer));
  el.addEventListener("mouseleave", startTimer);
  startTimer();
}
