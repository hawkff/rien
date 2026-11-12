// The plugin menu groups the plugins into these sections, in this order. A
// plugin that is missing here goes into the last section, "other".
export const pluginSections = {
  playback: [
    'crossfade',
    'disable-autoplay',
    'mpv-keys',
    'playback-speed',
    'quality-changer',
    'skip-disliked-songs',
    'skip-silences',
    'sponsorblock',
    'unobtrusive-player',
    'video-toggle',
  ],
  sound: [
    'audio-compressor',
    'custom-output-device',
    'equalizer',
    'exponential-volume',
    'precise-volume',
  ],
  lyrics: ['captions-selector', 'synced-lyrics'],
  look: [
    'album-color-theme',
    'ambient-mode',
    'blur-nav-bar',
    'clock',
    'hide-cover',
    'transparent-player',
    'visualizer',
  ],
  library: ['album-actions', 'downloader'],
  app: [
    'in-app-menu',
    'navigation',
    'notifications',
    'performance-improvement',
    'picture-in-picture',
    'shortcuts',
    'taskbar-mediacontrol',
    'touchbar',
  ],
  services: [
    'amuse',
    'api-server',
    'discord',
    'lumiastream',
    'music-together',
    'return-dislike',
    'scrobbler',
    'tuna-obs',
  ],
  privacy: ['auth-proxy-adapter', 'do-not-track'],
  other: [],
} satisfies Record<string, string[]>;

export type PluginSection = keyof typeof pluginSections;

export const sectionOf = (id: string) =>
  (Object.keys(pluginSections) as PluginSection[]).find((section) =>
    (pluginSections[section] as string[]).includes(id),
  ) ?? 'other';
