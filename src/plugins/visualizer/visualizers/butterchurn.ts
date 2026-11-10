import { Visualizer } from './visualizer';

import type { VisualizerPluginConfig } from '../index';
import type Butterchurn from 'butterchurn';

class ButterchurnVisualizer extends Visualizer {
  private visualizer?: ReturnType<typeof Butterchurn.createVisualizer>;
  private destroyed: boolean = false;
  private animFrameHandle: number | null = null;

  constructor(
    audioContext: AudioContext,
    audioSource: MediaElementAudioSourceNode,
    canvas: HTMLCanvasElement,
    audioNode: GainNode,
    _stream: MediaStream,
    config: VisualizerPluginConfig,
  ) {
    super(audioSource, audioNode);

    // butterchurn and its presets are large, so they load only once this
    // visualizer is used.
    Promise.all([import('butterchurn'), import('butterchurn-presets')])
      .then(([{ default: Butterchurn }, { default: ButterchurnPresets }]) => {
        if (this.destroyed) return;

        const preset = ButterchurnPresets[config.butterchurn.preset];
        const visualizer = Butterchurn.createVisualizer(audioContext, canvas, {
          width: canvas.width,
          height: canvas.height,
        });
        const renderVisualizer = () => {
          if (this.destroyed) return;
          visualizer.render();
          this.animFrameHandle = requestAnimationFrame(renderVisualizer);
        };

        visualizer.loadPreset(preset, config.butterchurn.blendTimeInSeconds);
        visualizer.connectAudio(audioNode);
        this.visualizer = visualizer;

        // Start animation request loop. Do not use setInterval!
        this.animFrameHandle = requestAnimationFrame(renderVisualizer);
      })
      .catch((error: unknown) => {
        console.error('Could not load butterchurn:', error);
      });
  }

  resize(width: number, height: number) {
    this.visualizer?.setRendererSize(width, height);
  }

  destroy() {
    if (this.animFrameHandle) cancelAnimationFrame(this.animFrameHandle);
    this.destroyed = true;
    try {
      this.audioSource.disconnect(this.audioNode);
    } catch {}
  }
}

export default ButterchurnVisualizer;
