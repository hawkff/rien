export const DefaultPresetList = {
  'mp3 (256kbps)': { extension: 'mp3' },
  // Saves the downloaded stream as it is
  'Source': { extension: undefined },
};

// Configs can still name the removed Custom preset, which now gets mp3.
export const presetName = (selectedPreset?: string) =>
  selectedPreset === 'Source' ? 'Source' : 'mp3 (256kbps)';

// The file extension for a stream that is saved as it is. The MIME type names
// the container, as in `audio/webm; codecs="opus"`. Audio in MP4 is M4A.
export const containerOf = (format: {
  mime_type: string;
  has_video: boolean;
}) => {
  const container = format.mime_type.split(/[/;]/)[1];
  return container === 'mp4' && !format.has_video ? 'm4a' : container;
};
