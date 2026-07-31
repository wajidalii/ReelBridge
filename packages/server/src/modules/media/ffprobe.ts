import ffmpeg from 'fluent-ffmpeg';

export interface VideoMetadata {
  durationSeconds?: number;
  width?: number;
  height?: number;
}

export function probeVideoMetadata(filePath: string): Promise<VideoMetadata> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (error, data) => {
      if (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      const videoStream = data.streams.find((stream) => stream.codec_type === 'video');
      resolve({
        durationSeconds: data.format.duration ? Math.round(data.format.duration) : undefined,
        width: videoStream?.width,
        height: videoStream?.height,
      });
    });
  });
}
