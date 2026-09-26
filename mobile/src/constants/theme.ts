export const colors = {
  accent: '#1DB954',
  accentHover: '#1ed760',
  base: '#0a0a0a',
  raised: '#121212',
  elevated: '#181818',
  hover: '#282828',
  border: '#2a2a2a',
  text: '#ffffff',
  textSecondary: '#b3b3b3',
  textMuted: '#6a6a6a',
  danger: '#f87171',
  warning: '#facc15',
  info: '#60a5fa',
  /** Per-service brand colours, shared by the settings rows and login screens. */
  filebrowser: '#3b82f6',
  downtify: '#f97316'
} as const

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32
} as const

export const radius = {
  sm: 6,
  md: 10,
  lg: 16,
  full: 999
} as const

/**
 * Heights of the persistent chrome that floats over every tab screen. Scrollable
 * content pads its bottom by `contentBottom` so the last row never ends up behind
 * the mini player or the tab bar.
 */
export const layout = {
  tabBar: 58,
  miniPlayer: 60,
  /** tab bar + mini player + a little breathing room */
  contentBottom: 58 + 60 + spacing.lg
} as const
