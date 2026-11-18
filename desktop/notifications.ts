import { desktopNoticeSchema } from '../shared/desktop-notifications.js';

export interface NativeNotice {
  on(event: 'click' | 'close' | 'show' | 'failed', listener: (...args: unknown[]) => void): unknown;
  show(): void;
  close(): void;
}

export const taskbarBadgeSize = 16;
const badgeDigits = [
  ['111', '101', '101', '101', '111'],
  ['010', '110', '010', '010', '111'],
  ['111', '001', '111', '100', '111'],
  ['111', '001', '111', '001', '111'],
  ['101', '101', '111', '001', '001'],
  ['111', '100', '111', '001', '111'],
  ['111', '100', '111', '101', '111'],
  ['111', '001', '010', '010', '010'],
  ['111', '101', '111', '101', '111'],
  ['111', '101', '111', '001', '111'],
];

/** Draw a taskbar counter in the premultiplied BGRA format used by Windows. */
export function taskbarBadgeBitmap(count: number): Buffer {
  const pixels = Buffer.alloc(taskbarBadgeSize * taskbarBadgeSize * 4);
  const center = (taskbarBadgeSize - 1) / 2;
  for (let y = 0; y < taskbarBadgeSize; y++) {
    for (let x = 0; x < taskbarBadgeSize; x++) {
      const distance = Math.hypot(x - center, y - center);
      const coverage = Math.max(0, Math.min(1, 8 - distance));
      const red = Math.max(0, Math.min(1, 6.5 - distance));
      const outline = coverage - red;
      const offset = (y * taskbarBadgeSize + x) * 4;
      pixels[offset] = Math.round(69 * red + 255 * outline);
      pixels[offset + 1] = Math.round(50 * red + 255 * outline);
      pixels[offset + 2] = Math.round(200 * red + 255 * outline);
      pixels[offset + 3] = Math.round(255 * coverage);
    }
  }
  const digits = String(Math.min(99, count));
  const scaleX = digits.length === 1 ? 2 : 1;
  const digitWidth = 3 * scaleX;
  const startX = digits.length === 1 ? 5 : 4;
  for (const [index, digit] of [...digits].entries()) {
    const originX = startX + index * (digitWidth + 2);
    for (const [row, pattern] of badgeDigits[Number(digit)].entries()) {
      for (let column = 0; column < pattern.length; column++) {
        if (pattern[column] !== '1') continue;
        for (let rowOffset = 0; rowOffset < 2; rowOffset++) {
          const y = 3 + row * 2 + rowOffset;
          const offset = (y * taskbarBadgeSize + originX + column * scaleX) * 4;
          pixels.fill(255, offset, offset + scaleX * 4);
        }
      }
    }
  }
  return pixels;
}

/** Owns native objects and invalidates their callbacks on logout, navigation and shutdown. */
export class DesktopNotifications {
  private readonly notices = new Set<NativeNotice>();
  private generation = 0;
  constructor(private readonly create: (title: string, body: string) => NativeNotice, private readonly open: (caseId: string) => void,
    private readonly isForeground: () => boolean = () => false) {}
  show(value: unknown): Promise<void> {
    const notice = desktopNoticeSchema.parse(value);
    // The settings button intentionally tests delivery while the chat has focus.
    if (this.isForeground() && !/^test:\d+$/.test(notice.key)) return Promise.resolve();
    const generation = this.generation;
    const native = this.create(notice.title, notice.body);
    this.notices.add(native);
    if (this.notices.size > 20) { const oldest = this.notices.values().next().value!; oldest.close(); this.notices.delete(oldest); }
    native.on('click', () => { if (generation === this.generation) this.open(notice.caseId); });
    native.on('close', () => this.notices.delete(native));
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Windows 未确认通知显示，请检查系统通知设置。')), 5000);
      native.on('show', () => { clearTimeout(timer); resolve(); });
      native.on('failed', () => { clearTimeout(timer); this.notices.delete(native); reject(new Error('Windows 无法显示通知，请检查系统通知设置。')); });
      native.on('close', () => { clearTimeout(timer); resolve(); });
      try { native.show(); } catch (cause) { clearTimeout(timer); this.notices.delete(native); reject(cause); }
    });
  }
  clear(): void {
    this.generation++;
    for (const notice of this.notices) notice.close();
    this.notices.clear();
  }
}
