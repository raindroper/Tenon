/** Curated pairs keep randomly assigned scene colors calm and readable. IDs are persisted with scenes. */
export const SCENE_THEME_IDS = ['sage', 'ocean', 'clay', 'lavender', 'rose', 'sand', 'teal', 'slate'] as const;
export type SceneThemeId = typeof SCENE_THEME_IDS[number];

export const SCENE_THEMES: Record<SceneThemeId, { name: string; background: string; accent: string }> = {
  sage: { name: '鼠尾草', background: '#f4f6ef', accent: '#365246' },
  ocean: { name: '海盐蓝', background: '#eff5f8', accent: '#315b76' },
  clay: { name: '陶土', background: '#faf2ed', accent: '#864d37' },
  lavender: { name: '雾紫', background: '#f4f1f9', accent: '#655080' },
  rose: { name: '蔷薇', background: '#faf0f3', accent: '#88475f' },
  sand: { name: '麦田', background: '#f9f5e9', accent: '#766026' },
  teal: { name: '青瓷', background: '#edf6f3', accent: '#28665f' },
  slate: { name: '雨灰', background: '#f0f3f7', accent: '#4b5b78' },
};

export function isSceneThemeId(value: unknown): value is SceneThemeId {
  return typeof value === 'string' && SCENE_THEME_IDS.some(id => id === value);
}

export function pickSceneTheme(used: readonly string[] = []): SceneThemeId {
  const unused = SCENE_THEME_IDS.filter(id => !used.includes(id));
  const choices = unused.length ? unused : SCENE_THEME_IDS;
  return choices[Math.floor(Math.random() * choices.length)]!;
}

/** Stable compatibility color for legacy scenes, including snapshots from an older server. */
export function legacySceneTheme(id: string): SceneThemeId {
  if (id === 'personal-growth') return 'sage';
  let hash = 0;
  for (const character of id) hash = (Math.imul(hash, 31) + character.codePointAt(0)!) | 0;
  return SCENE_THEME_IDS[(hash >>> 0) % SCENE_THEME_IDS.length]!;
}

export function sceneTheme(id: string, themeId?: string) {
  return SCENE_THEMES[isSceneThemeId(themeId) ? themeId : legacySceneTheme(id)];
}
