import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import WaveSurfer from 'wavesurfer.js';
import RegionsPlugin from 'wavesurfer.js/dist/plugins/regions';
import { Pause, Play, ZoomIn, ZoomOut, RotateCcw, X } from 'lucide-react';

export interface AudioWaveformPlayerHandle {
  play: () => void;
  pause: () => void;
  seekTo: (time: number) => void;
  playSegment: (start: number, end?: number) => void;
  getCurrentTime: () => number;
  getDuration: () => number;
}

interface SelectedWord {
  word: string;
  start: number;
  end: number;
  index: number;
}

interface AudioWaveformPlayerProps {
  audioUrl: string;
  onTimeUpdate?: (time: number) => void;
  onReady?: (duration: number) => void;
  onEnded?: () => void;
  onPlay?: () => void;
  onPause?: () => void;
  height?: number;
  selectedWord?: SelectedWord | null;
  onWordTimeUpdate?: (index: number, start: number, end: number) => void;
  onUnselectWord?: () => void;
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
  ({ audioUrl, onTimeUpdate, onReady, onEnded, onPlay, onPause, height = 150, selectedWord, onWordTimeUpdate, onUnselectWord }, ref) => {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const audioElementRef = useRef<HTMLAudioElement | null>(null);
    const waveSurferRef = useRef<WaveSurfer | null>(null);
    const regionsRef = useRef<RegionsPlugin | null>(null);
    const currentRegionRef = useRef<any>(null);
    const selectedWordIndexRef = useRef<number | null>(null);
    const isUpdatingFromRegionRef = useRef(false);
    const [isReady, setIsReady] = useState(false);
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [zoomLevel, setZoomLevel] = useState(1);
    const zoomLevelRef = useRef(1);
    const BASE_PX_PER_SEC = 20;
    const MIN_ZOOM = 1;
    const MAX_ZOOM = 100;

    const callbacksRef = useRef<{
      onTimeUpdate?: (time: number) => void;
      onReady?: (duration: number) => void;
      onEnded?: () => void;
      onPlay?: () => void;
      onPause?: () => void;
      onWordTimeUpdate?: (index: number, start: number, end: number) => void;
      onUnselectWord?: () => void;
    }>({});

    useEffect(() => {
      callbacksRef.current = { onTimeUpdate, onReady, onEnded, onPlay, onPause, onWordTimeUpdate, onUnselectWord };
    }, [onTimeUpdate, onReady, onEnded, onPlay, onPause, onWordTimeUpdate, onUnselectWord]);

    // Keep zoomLevelRef in sync with zoomLevel
    useEffect(() => {
      zoomLevelRef.current = zoomLevel;
    }, [zoomLevel]);

    const teardownWaveSurfer = useCallback(() => {
      if (currentRegionRef.current) {
        currentRegionRef.current.remove();
        currentRegionRef.current = null;
      }
      regionsRef.current = null;
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
        barWidth: 1,
        barGap: 0.5,
        barRadius: 2,
        height,
        normalize: true,
        interact: true,
        backend: 'MediaElement',
        media: audioElement,
        mediaControls: false,
        hideScrollbar: false,
        // scrollParent: true,
        minPxPerSec: 20,
        // pixelRatio: 1,
      });

      waveSurferRef.current = waveSurfer;

      // Initialize regions plugin
      const regions = waveSurfer.registerPlugin(RegionsPlugin.create());
      regionsRef.current = regions;

      waveSurfer.on('ready', () => {
        const audioDuration = waveSurfer.getDuration();
        if (Number.isFinite(audioDuration) && audioDuration > 0) {
          setDuration(audioDuration);
          setIsReady(true);
          // Apply initial zoom - use requestAnimationFrame to ensure waveform is rendered
          requestAnimationFrame(() => {
            try {
              if (waveSurferRef.current) {
                const currentDuration = waveSurferRef.current.getDuration();
                if (Number.isFinite(currentDuration) && currentDuration > 0) {
                  waveSurferRef.current.zoom(BASE_PX_PER_SEC * zoomLevelRef.current);
                }
              }
            } catch (error) {
              // Waveform might not be fully ready yet, will be applied by zoom effect
              console.debug('Error applying initial zoom:', error);
            }
          });
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

    // Apply zoom when zoomLevel changes
    useEffect(() => {
      if (!waveSurferRef.current || !isReady) return;

      // Use requestAnimationFrame to ensure waveform is ready
      requestAnimationFrame(() => {
        try {
          if (waveSurferRef.current) {
            // Check if audio is actually loaded by verifying duration
            const currentDuration = waveSurferRef.current.getDuration();
            if (Number.isFinite(currentDuration) && currentDuration > 0) {
              waveSurferRef.current.zoom(BASE_PX_PER_SEC * zoomLevel);
            }
          }
        } catch (error) {
          // Silently ignore if audio isn't loaded yet
          console.debug('Waveform not ready for zoom:', error);
        }
      });
    }, [zoomLevel, isReady]);

    // Handle selected word region
    useEffect(() => {
      if (!waveSurferRef.current || !regionsRef.current || !isReady) return;
      if (!selectedWord) {
        // Remove existing region if no word is selected
        if (currentRegionRef.current) {
          currentRegionRef.current.remove();
          currentRegionRef.current = null;
        }
        selectedWordIndexRef.current = null;
        return;
      }

      const duration = waveSurferRef.current.getDuration();
      const start = Math.max(0, Math.min(selectedWord.start, duration));
      const end = Math.max(start, Math.min(selectedWord.end, duration));

      // If the same word is selected, just update the region position
      if (currentRegionRef.current && selectedWordIndexRef.current === selectedWord.index) {
        // Only update if the times actually changed (and not from a region drag)
        if (!isUpdatingFromRegionRef.current) {
          const currentStart = currentRegionRef.current.start;
          const currentEnd = currentRegionRef.current.end;
          if (Math.abs(currentStart - start) > 0.001 || Math.abs(currentEnd - end) > 0.001) {
            currentRegionRef.current.setOptions({ start, end });
          }
        }
        return;
      }

      // Remove existing region if any
      if (currentRegionRef.current) {
        currentRegionRef.current.remove();
        currentRegionRef.current = null;
      }

      // Create new region for selected word
      const region = regionsRef.current.addRegion({
        start,
        end,
        color: 'rgba(59, 130, 246, 0.3)', // blue with transparency
        drag: true,
        resize: true,
        content: selectedWord.word,
        contentEditable: false,
      });

      currentRegionRef.current = region;
      selectedWordIndexRef.current = selectedWord.index;

      // Handle region updates
      const handleUpdate = () => {
        if (region && callbacksRef.current.onWordTimeUpdate) {
          isUpdatingFromRegionRef.current = true;
          const newStart = region.start;
          const newEnd = region.end;
          callbacksRef.current.onWordTimeUpdate(selectedWord.index, newStart, newEnd);
          // Reset flag after a short delay to allow state updates to complete
          setTimeout(() => {
            isUpdatingFromRegionRef.current = false;
          }, 100);
        }
      };

      region.on('update-end', handleUpdate);

      // Scroll to region
      requestAnimationFrame(() => {
        try {
          const regionElement = region.element;
          if (regionElement && containerRef.current) {
            const container = containerRef.current.closest('.overflow-x-auto');
            if (container) {
              const regionLeft = regionElement.offsetLeft;
              const containerWidth = container.clientWidth;
              const scrollLeft = container.scrollLeft;
              const regionCenter = regionLeft - containerWidth / 2 + regionElement.offsetWidth / 2;
              container.scrollTo({
                left: scrollLeft + regionCenter,
                behavior: 'smooth',
              });
            }
          }
        } catch (error) {
          console.debug('Error scrolling to region:', error);
        }
      });

      return () => {
        if (region) {
          region.un('update-end', handleUpdate);
        }
      };
    }, [selectedWord, isReady]);

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

    const handleZoomIn = () => {
      setZoomLevel((prev) => Math.min(prev * 2, MAX_ZOOM));
    };

    const handleZoomOut = () => {
      setZoomLevel((prev) => Math.max(prev / 2, MIN_ZOOM));
    };

    const handleResetZoom = () => {
      setZoomLevel(1);
    };

    // Keyboard shortcuts handler
    useEffect(() => {
      const handleKeyDown = (event: KeyboardEvent) => {
        // Don't handle keyboard shortcuts if user is typing in an input field
        const target = event.target as HTMLElement;
        if (
          target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable
        ) {
          return;
        }

        // Only handle keys when audio is ready
        if (!isReady || !waveSurferRef.current) return;

        // Handle word time adjustment when a word is selected
        if (selectedWord && currentRegionRef.current) {
          const TIME_STEP = 0.001; // 1ms for both normal and shift
          const duration = waveSurferRef.current.getDuration();
          let newStart = currentRegionRef.current.start;
          let newEnd = currentRegionRef.current.end;

          switch (event.key) {
            case 'ArrowLeft': {
              if (event.shiftKey) {
                // Shift + Left: decrease end time
                event.preventDefault();
                newEnd = Math.max(newStart, newEnd - TIME_STEP);
                currentRegionRef.current.setOptions({ end: newEnd });
                if (callbacksRef.current.onWordTimeUpdate) {
                  isUpdatingFromRegionRef.current = true;
                  callbacksRef.current.onWordTimeUpdate(selectedWord.index, newStart, newEnd);
                  setTimeout(() => {
                    isUpdatingFromRegionRef.current = false;
                  }, 50);
                }
              } else {
                // Left: decrease start time
                event.preventDefault();
                newStart = Math.max(0, newStart - TIME_STEP);
                newStart = Math.min(newStart, newEnd - 0.001); // Ensure start < end
                currentRegionRef.current.setOptions({ start: newStart });
                if (callbacksRef.current.onWordTimeUpdate) {
                  isUpdatingFromRegionRef.current = true;
                  callbacksRef.current.onWordTimeUpdate(selectedWord.index, newStart, newEnd);
                  setTimeout(() => {
                    isUpdatingFromRegionRef.current = false;
                  }, 50);
                }
              }
              return;
            }
            case 'ArrowRight': {
              if (event.shiftKey) {
                // Shift + Right: increase end time
                event.preventDefault();
                newEnd = Math.min(duration, newEnd + TIME_STEP);
                currentRegionRef.current.setOptions({ end: newEnd });
                if (callbacksRef.current.onWordTimeUpdate) {
                  isUpdatingFromRegionRef.current = true;
                  callbacksRef.current.onWordTimeUpdate(selectedWord.index, newStart, newEnd);
                  setTimeout(() => {
                    isUpdatingFromRegionRef.current = false;
                  }, 50);
                }
              } else {
                // Right: increase start time
                event.preventDefault();
                newStart = Math.min(newEnd - 0.001, newStart + TIME_STEP);
                currentRegionRef.current.setOptions({ start: newStart });
                if (callbacksRef.current.onWordTimeUpdate) {
                  isUpdatingFromRegionRef.current = true;
                  callbacksRef.current.onWordTimeUpdate(selectedWord.index, newStart, newEnd);
                  setTimeout(() => {
                    isUpdatingFromRegionRef.current = false;
                  }, 50);
                }
              }
              return;
            }
            case 'Enter': {
              // Enter: play the selected word segment
              event.preventDefault();
              if (waveSurferRef.current && currentRegionRef.current) {
                const regionStart = currentRegionRef.current.start;
                const regionEnd = currentRegionRef.current.end;
                waveSurferRef.current.play(regionStart, regionEnd);
              }
              return;
            }
          }
        }

        // Handle general audio controls
        switch (event.key) {
          case ' ': {
            // Space bar: toggle play/pause
            event.preventDefault();
            if (isPlaying) {
              waveSurferRef.current.pause();
            } else {
              waveSurferRef.current.play();
            }
            break;
          }
          case 'ArrowRight': {
            // Right arrow: forward by 1 millisecond (only if no word selected)
            if (!selectedWord) {
              event.preventDefault();
              const currentTime = waveSurferRef.current.getCurrentTime();
              const duration = waveSurferRef.current.getDuration();
              const newTime = Math.min(currentTime + 0.001, duration);
              waveSurferRef.current.setTime(newTime);
            }
            break;
          }
          case 'ArrowLeft': {
            // Left arrow: backward by 1 millisecond (only if no word selected)
            if (!selectedWord) {
              event.preventDefault();
              const currentTime = waveSurferRef.current.getCurrentTime();
              const newTime = Math.max(currentTime - 0.001, 0);
              waveSurferRef.current.setTime(newTime);
            }
            break;
          }
        }
      };

      window.addEventListener('keydown', handleKeyDown);

      return () => {
        window.removeEventListener('keydown', handleKeyDown);
      };
    }, [isReady, isPlaying, selectedWord]);

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
        <div className="flex items-center justify-between gap-2 mb-2">
          <div className="flex items-center gap-1">
            {selectedWord && (
              <div className="flex items-center gap-2 text-xs text-gray-600 bg-blue-50 px-2 py-1 rounded border border-blue-200">
                <span className="font-semibold">Selected: </span>
                <span className="font-mono">{selectedWord.word}</span>
                {onUnselectWord && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      callbacksRef.current.onUnselectWord?.();
                    }}
                    className="ml-1 hover:bg-blue-100 rounded p-0.5 transition-colors"
                    title="Unselect word"
                    aria-label="Unselect word"
                  >
                    <X className="h-3 w-3 text-gray-600 hover:text-gray-800" />
                  </button>
                )}
                {/* <span className="ml-2 text-gray-500">←/→ adjust start (1ms) | Shift+←/→ adjust end (1ms) | Enter to play</span> */}
              </div>
            )}
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={handleZoomOut}
              disabled={!isReady || zoomLevel <= MIN_ZOOM}
              className={`flex items-center justify-center h-8 w-8 rounded transition-colors ${
                isReady && zoomLevel > MIN_ZOOM
                  ? 'bg-blue-500 hover:bg-blue-600 text-white'
                  : 'bg-gray-300 text-gray-500 cursor-not-allowed'
              }`}
              aria-label="Zoom out"
              title="Zoom out"
            >
              <ZoomOut className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={handleResetZoom}
              disabled={!isReady || zoomLevel === 1}
              className={`flex items-center justify-center h-8 w-8 rounded transition-colors ${
                isReady && zoomLevel !== 1
                  ? 'bg-blue-500 hover:bg-blue-600 text-white'
                  : 'bg-gray-300 text-gray-500 cursor-not-allowed'
              }`}
              aria-label="Reset zoom"
              title="Reset zoom"
            >
              <RotateCcw className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={handleZoomIn}
              disabled={!isReady || zoomLevel >= MAX_ZOOM}
              className={`flex items-center justify-center h-8 w-8 rounded transition-colors ${
                isReady && zoomLevel < MAX_ZOOM
                  ? 'bg-blue-500 hover:bg-blue-600 text-white'
                  : 'bg-gray-300 text-gray-500 cursor-not-allowed'
              }`}
              aria-label="Zoom in"
              title="Zoom in"
            >
              <ZoomIn className="h-4 w-4" />
            </button>
            <span className="ml-2 text-xs font-mono text-gray-600 min-w-[60px]">
              {zoomLevel.toFixed(1)}x
            </span>
          </div>
        </div>
        <div className="w-full overflow-x-auto overflow-y-hidden rounded-md bg-white/60 backdrop-blur-sm border border-blue-100">
          <div
            ref={containerRef}
            className="min-w-full"
          />
        </div>
      </div>
    );
  },
);

AudioWaveformPlayer.displayName = 'AudioWaveformPlayer';

export default AudioWaveformPlayer;


