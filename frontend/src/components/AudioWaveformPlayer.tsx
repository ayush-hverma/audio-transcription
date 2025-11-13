import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import WaveSurfer from 'wavesurfer.js';
import { Pause, Play } from 'lucide-react';

export interface AudioWaveformPlayerHandle {
  play: () => void;
  pause: () => void;
  seekTo: (time: number) => void;
  playSegment: (start: number, end?: number) => void;
  getCurrentTime: () => number;
  getDuration: () => number;
}

interface AudioWaveformPlayerProps {
  audioUrl: string;
  onTimeUpdate?: (time: number) => void;
  onReady?: (duration: number) => void;
  onEnded?: () => void;
  onPlay?: () => void;
  onPause?: () => void;
  height?: number;
}

const formatTime = (time: number): string => {
  if (!Number.isFinite(time) || time < 0) {
    return '0:00.000';
  }

  const milliseconds = Math.floor((time % 1) * 1000);
  const totalSeconds = Math.floor(time);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  const pad = (value: number, digits: number) => value.toString().padStart(digits, '0');

  if (hours > 0) {
    return `${hours}:${pad(minutes, 2)}:${pad(seconds, 2)}.${pad(milliseconds, 3)}`;
  }

  return `${minutes}:${pad(seconds, 2)}.${pad(milliseconds, 3)}`;
};

const AudioWaveformPlayer = forwardRef<AudioWaveformPlayerHandle, AudioWaveformPlayerProps>(
  ({ audioUrl, onTimeUpdate, onReady, onEnded, onPlay, onPause, height = 120 }, ref) => {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const audioElementRef = useRef<HTMLAudioElement | null>(null);
    const waveSurferRef = useRef<WaveSurfer | null>(null);
    const [isReady, setIsReady] = useState(false);
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);

    const callbacksRef = useRef<{
      onTimeUpdate?: (time: number) => void;
      onReady?: (duration: number) => void;
      onEnded?: () => void;
      onPlay?: () => void;
      onPause?: () => void;
    }>({});

    useEffect(() => {
      callbacksRef.current = { onTimeUpdate, onReady, onEnded, onPlay, onPause };
    }, [onTimeUpdate, onReady, onEnded, onPlay, onPause]);

    const teardownWaveSurfer = useCallback(() => {
      waveSurferRef.current?.destroy();
      waveSurferRef.current = null;
      setIsReady(false);
    }, []);

    useEffect(() => {
      const audioElement = audioElementRef.current;
      if (!audioElement) return;

      const handleTime = () => {
        const time = audioElement.currentTime;
        setCurrentTime(time);
        callbacksRef.current.onTimeUpdate?.(time);
      };

      const handleLoaded = () => {
        const audioDuration = audioElement.duration;
        if (Number.isFinite(audioDuration)) {
          setDuration(audioDuration);
          setIsReady(true);
          callbacksRef.current.onReady?.(audioDuration);
        }
      };

      const handleEnded = () => {
        setIsPlaying(false);
        callbacksRef.current.onEnded?.();
      };

      const handlePlay = () => {
        setIsPlaying(true);
        callbacksRef.current.onPlay?.();
      };

      const handlePause = () => {
        setIsPlaying(false);
        callbacksRef.current.onPause?.();
      };

      audioElement.addEventListener('timeupdate', handleTime);
      audioElement.addEventListener('seeked', handleTime);
      audioElement.addEventListener('loadedmetadata', handleLoaded);
      audioElement.addEventListener('ended', handleEnded);
      audioElement.addEventListener('play', handlePlay);
      audioElement.addEventListener('pause', handlePause);

      return () => {
        audioElement.removeEventListener('timeupdate', handleTime);
        audioElement.removeEventListener('seeked', handleTime);
        audioElement.removeEventListener('loadedmetadata', handleLoaded);
        audioElement.removeEventListener('ended', handleEnded);
        audioElement.removeEventListener('play', handlePlay);
        audioElement.removeEventListener('pause', handlePause);
      };
    }, []);

    useEffect(() => {
      const audioElement = audioElementRef.current;
      if (!audioElement || !containerRef.current) return;

      teardownWaveSurfer();
      setCurrentTime(0);
      setDuration(0);
      setIsPlaying(false);

      if (!audioUrl) {
        audioElement.src = '';
        return () => {
          teardownWaveSurfer();
        };
      }

      audioElement.src = audioUrl;
      audioElement.crossOrigin = 'anonymous';
      audioElement.load();

      const waveSurfer = WaveSurfer.create({
        container: containerRef.current,
        waveColor: '#93C5FD',
        progressColor: '#1D4ED8',
        cursorColor: '#1E3A8A',
        barWidth: 2,
        barRadius: 3,
        height,
        normalize: true,
        interact: true,
        backend: 'MediaElement',
        media: audioElement,
        mediaControls: false,
        hideScrollbar: true,
      });

      waveSurferRef.current = waveSurfer;

      waveSurfer.on('ready', () => {
        const audioDuration = waveSurfer.getDuration();
        if (Number.isFinite(audioDuration)) {
          setDuration(audioDuration);
          setIsReady(true);
          callbacksRef.current.onReady?.(audioDuration);
        }
      });

      waveSurfer.on('finish', () => {
        setIsPlaying(false);
        callbacksRef.current.onEnded?.();
      });

      return () => {
        teardownWaveSurfer();
      };
    }, [audioUrl, height, teardownWaveSurfer]);

    useImperativeHandle(
      ref,
      () => ({
        play: () => {
          waveSurferRef.current?.play();
        },
        pause: () => {
          waveSurferRef.current?.pause();
        },
        seekTo: (time: number) => {
          if (!waveSurferRef.current) return;
          const clamped = Math.max(0, Math.min(time, waveSurferRef.current.getDuration()));
          waveSurferRef.current.setTime(clamped);
        },
        playSegment: (start: number, end?: number) => {
          if (!waveSurferRef.current) return;
          const segmentStart = Math.max(0, start);
          const segmentEnd = end ?? waveSurferRef.current.getDuration();
          waveSurferRef.current.play(segmentStart, segmentEnd);
        },
        getCurrentTime: () => waveSurferRef.current?.getCurrentTime() ?? currentTime,
        getDuration: () => waveSurferRef.current?.getDuration() ?? duration,
      }),
      [currentTime, duration],
    );

    const togglePlay = () => {
      if (!isReady) return;
      if (isPlaying) {
        waveSurferRef.current?.pause();
      } else {
        waveSurferRef.current?.play();
      }
    };

    return (
      <div className="border border-blue-100 rounded-lg p-4 bg-gradient-to-br from-white to-blue-50 shadow-inner">
        <audio ref={audioElementRef} className="hidden" />
        <div className="flex items-center justify-between gap-4 mb-3">
          <button
            type="button"
            onClick={togglePlay}
            disabled={!isReady}
            className={`flex items-center justify-center h-12 w-12 rounded-full transition-colors ${isReady
                ? 'bg-blue-600 hover:bg-blue-700 text-white shadow-lg'
                : 'bg-gray-300 text-gray-500 cursor-not-allowed'
              }`}
            aria-label={isPlaying ? 'Pause audio' : 'Play audio'}
          >
            {isPlaying ? <Pause className="h-6 w-6" /> : <Play className="h-6 w-6" />}
          </button>
          <div className="flex flex-col text-sm font-mono text-gray-700">
            <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">Current Time</span>
            <span className="text-lg">{formatTime(currentTime)}</span>
          </div>
          <div className="hidden sm:flex flex-col text-sm font-mono text-gray-700 text-right ml-auto">
            <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">Duration</span>
            <span className="text-lg">{formatTime(duration)}</span>
          </div>
        </div>
        <div
          ref={containerRef}
          className="w-full overflow-hidden rounded-md bg-white/60 backdrop-blur-sm border border-blue-100"
        />
      </div>
    );
  },
);

AudioWaveformPlayer.displayName = 'AudioWaveformPlayer';

export default AudioWaveformPlayer;


