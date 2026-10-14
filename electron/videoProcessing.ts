import { spawn } from 'node:child_process';
import os from 'node:os';

let videoQueue: Promise<unknown> = Promise.resolve();

// Include output-name allocation and cleanup in the job, not just encoding.
export function enqueueVideoJob<T>(job: () => Promise<T>): Promise<T> {
  const result = videoQueue.then(job);
  videoQueue = result.catch(() => undefined);
  return result;
}

export function runVideoProcess(ffmpegPath: string, args: string[]): Promise<void> {
  if (!ffmpegPath) return Promise.reject(new Error('ffmpeg binary not available.'));
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, [
      '-nostdin', '-filter_threads', '1', '-filter_complex_threads', '1', ...args
    ], { windowsHide: true });
    child.once('spawn', () => {
      try {
        if (child.pid) os.setPriority(child.pid, os.constants.priority.PRIORITY_LOW);
      } catch (error) {
        console.warn('[video] Could not lower processing priority.', error);
      }
    });
    let stderr = '';
    child.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-2000); });
    child.once('error', reject);
    child.once('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`Video processing failed (${code}): ${stderr.slice(-700)}`));
    });
  });
}

export function sessionVideoOutroArgs(videoPath: string, finalImagePath: string, logoPath: string, outputPath: string): string[] {
  // Bound decoder, filter, and encoder threads independently; an encoder-only
  // limit still allows a large filter graph to compete with the camera feed.
  const args = ['-y', '-threads', '1', '-i', videoPath,
    '-loop', '1', '-framerate', '24', '-t', '5', '-threads', '1', '-i', finalImagePath];
  if (logoPath) args.push('-loop', '1', '-framerate', '24', '-t', '2.5', '-threads', '1', '-i', logoPath);
  const canvas = 'scale=720:1280:force_original_aspect_ratio=decrease:flags=bicubic,pad=720:1280:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1';
  const filters = [
    `[0:v]fps=24,${canvas},setpts=PTS-STARTPTS[v0]`,
    '[1:v]split=2[photoBg][photoFg]',
    '[photoBg]scale=90:160:force_original_aspect_ratio=increase,crop=90:160,gblur=sigma=22,scale=720:1280:flags=bicubic,eq=brightness=-0.24:saturation=1.15[photoBgReady]',
    '[photoFg]scale=666:1200:force_original_aspect_ratio=decrease[photoFgReady]',
    "[photoBgReady][photoFgReady]overlay=(W-w)/2:(H-h)/2,zoompan=z='min(zoom+0.00042,1.05)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=720x1280:fps=24,setsar=1,fade=t=in:st=0:d=0.35,fade=t=out:st=4.5:d=0.5,setpts=PTS-STARTPTS[v1]"
  ];
  if (logoPath) filters.push(
    '[2:v]scale=434:434:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=24,fade=t=in:st=0:d=0.4,fade=t=out:st=2:d=0.5,setpts=PTS-STARTPTS[v2]',
    '[v0][v1][v2]concat=n=3:v=1:a=0[outv]'
  );
  else filters.push('[v0][v1]concat=n=2:v=1:a=0[outv]');
  args.push(
    '-filter_complex', filters.join(';'), '-map', '[outv]', '-map', '0:a?',
    '-af', `apad=pad_dur=${logoPath ? '7.5' : '5'}`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-threads', '1',
    '-pix_fmt', 'yuv420p', '-r', '24', '-video_track_timescale', '24000', '-tag:v', 'avc1',
    '-c:a', 'aac', '-b:a', '112k', '-shortest', '-movflags', '+faststart', outputPath
  );
  return args;
}
