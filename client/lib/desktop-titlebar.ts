interface WindowControlsOverlay extends EventTarget {
  readonly visible: boolean;
  getTitlebarAreaRect(): DOMRect;
}

declare global {
  interface Navigator {
    readonly windowControlsOverlay?: WindowControlsOverlay;
  }
}

export function syncDesktopTitlebar(): void {
  const overlay = navigator.windowControlsOverlay;
  if (!overlay) return;
  const apply = () => {
    document.documentElement.classList.toggle('desktop-titlebar', overlay.visible);
  };
  apply();
  overlay.addEventListener('geometrychange', apply);
}

export {};