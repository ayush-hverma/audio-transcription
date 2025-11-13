import { useState, useRef, useMemo, useCallback } from 'react';
import axios from 'axios';
import { Upload, Play, Download, Save, Edit2, Check, X, Loader2, Users, Smile } from 'lucide-react';
import AudioWaveformPlayer, { AudioWaveformPlayerHandle } from './components/AudioWaveformPlayer';

const API_BASE_URL = 'http://localhost:5001';

interface Phrase {
  start: string;
  end: string;
  speaker: string;
  text: string;
  emotion: string;
  language: string;
  end_of_speech: boolean;
}

interface TranscriptionData {
  phrases: Phrase[];
  language: string;
  audio_duration: number;
  total_phrases: number;
  reference_text?: string;
  metadata?: {
    filename: string;
    audio_path: string;
  };
}

function PhrasesApp() {
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [referenceFile, setReferenceFile] = useState<File | null>(null);
  const [referenceText, setReferenceText] = useState('');
  const [sourceLanguage, setSourceLanguage] = useState('Gujarati');
  const languages = [
    'Gujarati', 'Hindi', 'Bengali', 'Tamil', 'Telugu', 'Marathi',
    'Kannada', 'Malayalam', 'Punjabi', 'Urdu', 'English', 'Hinglish'
  ];
  const [loading, setLoading] = useState(false);
  const [transcriptionData, setTranscriptionData] = useState<TranscriptionData | null>(null);
  const [audioUrl, setAudioUrl] = useState('');
  const [audioDuration, setAudioDuration] = useState<number | null>(null);
  const [currentPlayingIndex, setCurrentPlayingIndex] = useState<number | null>(null);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editValues, setEditValues] = useState<{
    start: string;
    end: string;
    text: string;
    speaker: string;
    emotion: string;
    end_of_speech: boolean;
  }>({
    start: '',
    end: '',
    text: '',
    speaker: '',
    emotion: '',
    end_of_speech: false,
  });
  const [hasChanges, setHasChanges] = useState(false);
  
  const playerRef = useRef<AudioWaveformPlayerHandle | null>(null);

  const handleAudioFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setAudioFile(e.target.files[0]);
    }
  };

  const handleReferenceFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      setReferenceFile(file);
      
      const reader = new FileReader();
      reader.onload = (event) => {
        if (event.target?.result) {
          setReferenceText(event.target.result as string);
        }
      };
      reader.readAsText(file);
    }
  };

  const handleTranscribe = async () => {
    if (!audioFile) {
      alert('Please select an audio file');
      return;
    }

    setLoading(true);

    try {
      const formData = new FormData();
      formData.append('audio_file', audioFile);
      formData.append('source_language', sourceLanguage);
      
      if (referenceText) {
        formData.append('reference_text', referenceText);
      }

      const response = await axios.post(`${API_BASE_URL}/api/transcribe/phrases`, formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
        },
      });

      if (response.data.success) {
        setTranscriptionData(response.data.data);
        if (response.data.data.metadata?.audio_path) {
          setAudioUrl(`${API_BASE_URL}${response.data.data.metadata.audio_path}`);
        }
        if (response.data.data.audio_duration && response.data.data.audio_duration > 0) {
          setAudioDuration(response.data.data.audio_duration);
        } else {
          setAudioDuration(null);
        }
      } else {
        alert(`Error: ${response.data.error}`);
      }
    } catch (error: any) {
      console.error('Error:', error);
      alert(`Error: ${error.response?.data?.error || error.message}`);
    } finally {
      setLoading(false);
    }
  };

  const timeToSeconds = (timeStr: string): number => {
    const parts = timeStr.split(':');
    if (parts.length === 4) {
      // HH:MM:SS:mmm
      return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]) + parseFloat(parts[3]) / 1000;
    } else if (parts.length === 3) {
      // H:MM:SS.mmm or HH:MM:SS
      return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
    }
    return parseFloat(timeStr);
  };

  const phraseTimings = useMemo(() => {
    if (!transcriptionData) return [];

    return transcriptionData.phrases.map((phrase) => ({
      start: timeToSeconds(phrase.start),
      end: timeToSeconds(phrase.end),
    }));
  }, [transcriptionData]);

  const effectiveDuration = useMemo(() => {
    if (audioDuration !== null && audioDuration > 0) {
      return audioDuration;
    }
    if (transcriptionData?.audio_duration && transcriptionData.audio_duration > 0) {
      return transcriptionData.audio_duration;
    }
    return null;
  }, [audioDuration, transcriptionData]);

  const playPhrase = (index: number) => {
    if (!transcriptionData || !playerRef.current) return;

    const phrase = transcriptionData.phrases[index];
    const startTime = timeToSeconds(phrase.start);
    const endTime = timeToSeconds(phrase.end);

    setCurrentPlayingIndex(index);
    playerRef.current.playSegment(startTime, endTime);
  };

  const handlePlayerTimeUpdate = useCallback(
    (current: number) => {
      if (!transcriptionData || phraseTimings.length === 0) {
        setCurrentPlayingIndex((prev) => (prev !== null ? null : prev));
        return;
      }

      let nextIndex: number | null = null;
      for (let i = 0; i < phraseTimings.length; i += 1) {
        const timing = phraseTimings[i];
        if (current >= timing.start && current <= timing.end) {
          nextIndex = i;
          break;
        }
      }

      if (nextIndex !== null) {
        setCurrentPlayingIndex((prev) => (prev === nextIndex ? prev : nextIndex));
      } else {
        setCurrentPlayingIndex((prev) => (prev !== null ? null : prev));
      }
    },
    [transcriptionData, phraseTimings],
  );

  const handlePlayerPause = useCallback(() => {
    setCurrentPlayingIndex((prev) => (prev !== null ? null : prev));
  }, []);

  const handlePlayerReady = useCallback((playerDuration: number) => {
    if (playerDuration > 0) {
      setAudioDuration(playerDuration);
    }
  }, []);

  const startEdit = (index: number) => {
    const phrase = transcriptionData!.phrases[index];
    setEditingIndex(index);
    setEditValues({
      start: phrase.start,
      end: phrase.end,
      text: phrase.text,
      speaker: phrase.speaker,
      emotion: phrase.emotion,
      end_of_speech: phrase.end_of_speech,
    });
  };

  const cancelEdit = () => {
    setEditingIndex(null);
    setEditValues({
      start: '',
      end: '',
      text: '',
      speaker: '',
      emotion: '',
      end_of_speech: false,
    });
  };

  const saveEdit = () => {
    if (editingIndex === null || !transcriptionData) return;

    const updatedPhrases = [...transcriptionData.phrases];
    updatedPhrases[editingIndex] = {
      ...updatedPhrases[editingIndex],
      start: editValues.start,
      end: editValues.end,
      text: editValues.text,
      speaker: editValues.speaker,
      emotion: editValues.emotion,
      end_of_speech: editValues.end_of_speech,
    };

    setTranscriptionData({
      ...transcriptionData,
      phrases: updatedPhrases,
    });

    setEditingIndex(null);
    setHasChanges(true);
  };

  const acknowledgeChanges = () => {
    alert('Changes saved successfully!');
    setHasChanges(false);
  };

  const downloadTranscription = () => {
    if (!transcriptionData) return;

    const dataStr = JSON.stringify(transcriptionData, null, 2);
    const dataBlob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(dataBlob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `phrases_transcription_${Date.now()}.json`;
    link.click();
  };

  const getEmotionColor = (emotion: string): string => {
    const emotionColors: Record<string, string> = {
      happy: 'bg-yellow-100 text-yellow-800 border-yellow-300',
      sad: 'bg-blue-100 text-blue-800 border-blue-300',
      angry: 'bg-red-100 text-red-800 border-red-300',
      calm: 'bg-green-100 text-green-800 border-green-300',
      excited: 'bg-orange-100 text-orange-800 border-orange-300',
      neutral: 'bg-gray-100 text-gray-800 border-gray-300',
      frustrated: 'bg-purple-100 text-purple-800 border-purple-300',
      polite: 'bg-teal-100 text-teal-800 border-teal-300',
      surprised: 'bg-pink-100 text-pink-800 border-pink-300',
    };
    return emotionColors[emotion.toLowerCase()] || 'bg-gray-100 text-gray-800 border-gray-300';
  };

  const getSpeakerColor = (speaker: string): string => {
    const colors = [
      'bg-blue-50 border-blue-300',
      'bg-green-50 border-green-300',
      'bg-purple-50 border-purple-300',
      'bg-pink-50 border-pink-300',
      'bg-yellow-50 border-yellow-300',
      'bg-indigo-50 border-indigo-300',
    ];
    const hash = speaker.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    return colors[hash % colors.length];
  };

  const getPhraseClassName = (index: number): string => {
    let classes = 'p-4 rounded-lg border-2 cursor-pointer transition-all duration-200 hover:shadow-lg mb-3';
    
    if (currentPlayingIndex === index) {
      classes += ' ring-4 ring-blue-400 scale-[1.02] bg-blue-50';
    }
    
    return classes;
  };

  return (
    <main className="min-h-screen p-8 bg-gradient-to-br from-purple-50 to-pink-50">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold text-gray-800 mb-2">
            Phrase-Level Transcription Editor
          </h1>
          <p className="text-gray-600">Speaker diarization, emotion detection, and phrase-level editing</p>
        </div>

        {/* Upload Section */}
        {!transcriptionData && (
          <div className="bg-white rounded-lg shadow-xl p-8 mb-8">
            <h2 className="text-2xl font-semibold mb-6 text-gray-800">Upload Audio File</h2>
            
            {/* Audio File Upload */}
            <div className="mb-6">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Audio File *
              </label>
              <div className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center hover:border-purple-500 transition-colors">
                <input
                  type="file"
                  accept=".mp3,.wav,.m4a,.ogg,.flac,.aac"
                  onChange={handleAudioFileChange}
                  className="hidden"
                  id="audio-upload"
                />
                <label htmlFor="audio-upload" className="cursor-pointer">
                  <Upload className="mx-auto h-12 w-12 text-gray-400 mb-2" />
                  <p className="text-sm text-gray-600">
                    {audioFile ? audioFile.name : 'Click to upload audio file'}
                  </p>
                  <p className="text-xs text-gray-400 mt-1">MP3, WAV, M4A, OGG, FLAC, AAC</p>
                </label>
              </div>
            </div>

            {/* Source Language */}
            <div className="mb-6">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Source Language *
              </label>
              <select
                value={sourceLanguage}
                onChange={(e) => setSourceLanguage(e.target.value)}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent"
              >
                {languages.map((lang) => (
                  <option key={lang} value={lang}>
                    {lang}
                  </option>
                ))}
              </select>
            </div>

            {/* Reference Text */}
            <div className="mb-6">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Reference Text (Optional)
              </label>
              <div className="mb-3">
                <input
                  type="file"
                  accept=".txt"
                  onChange={handleReferenceFileChange}
                  className="hidden"
                  id="reference-upload"
                />
                <label
                  htmlFor="reference-upload"
                  className="inline-flex items-center px-4 py-2 border border-gray-300 rounded-lg cursor-pointer hover:bg-gray-50"
                >
                  <Upload className="h-4 w-4 mr-2" />
                  {referenceFile ? referenceFile.name : 'Upload Reference File'}
                </label>
              </div>
              <textarea
                value={referenceText}
                onChange={(e) => setReferenceText(e.target.value)}
                placeholder="Or paste reference text here..."
                className="w-full h-32 px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent"
              />
            </div>

            {/* Transcribe Button */}
            <button
              onClick={handleTranscribe}
              disabled={loading || !audioFile}
              className="w-full bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700 disabled:bg-gray-400 text-white font-semibold py-3 px-6 rounded-lg transition-colors flex items-center justify-center"
            >
              {loading ? (
                <>
                  <Loader2 className="animate-spin h-5 w-5 mr-2" />
                  Processing...
                </>
              ) : (
                <>
                  <Play className="h-5 w-5 mr-2" />
                  Transcribe Audio
                </>
              )}
            </button>
          </div>
        )}

        {/* Results Section */}
        {transcriptionData && (
          <div className="space-y-6">
            {/* Info Bar */}
            <div className="bg-white rounded-lg shadow-lg p-6">
              <div className="flex justify-between items-center flex-wrap gap-4">
                <div>
                  <h2 className="text-2xl font-semibold text-gray-800">Transcription Results</h2>
                </div>
                <div className="flex gap-2">
                  {hasChanges && (
                    <button
                      onClick={acknowledgeChanges}
                      className="bg-green-600 hover:bg-green-700 text-white font-semibold py-2 px-4 rounded-lg transition-colors flex items-center"
                    >
                      <Save className="h-4 w-4 mr-2" />
                      Save Changes
                    </button>
                  )}
                  <button
                    onClick={downloadTranscription}
                    className="bg-purple-600 hover:bg-purple-700 text-white font-semibold py-2 px-4 rounded-lg transition-colors flex items-center"
                  >
                    <Download className="h-4 w-4 mr-2" />
                    Download
                  </button>
                  <button
                    onClick={() => {
                      const confirmReset = window.confirm('Start a new transcription? Unsaved changes will be lost.');
                      if (!confirmReset) return;
                      setTranscriptionData(null);
                      setAudioFile(null);
                      setReferenceFile(null);
                      setReferenceText('');
                      setAudioDuration(null);
                      setHasChanges(false);
                    }}
                    className="bg-gray-600 hover:bg-gray-700 text-white font-semibold py-2 px-4 rounded-lg transition-colors"
                  >
                    New Transcription
                  </button>
                </div>
              </div>

              {/* Stats */}
              <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="bg-gray-50 rounded-lg p-3">
                  <div className="text-sm text-gray-600">Total Phrases</div>
                  <div className="text-2xl font-bold text-gray-800">{transcriptionData.total_phrases}</div>
                </div>
                <div className="bg-gray-50 rounded-lg p-3">
                  <div className="text-sm text-gray-600">Duration</div>
                  <div className="text-2xl font-bold text-gray-800">
                    {effectiveDuration !== null ? `${effectiveDuration.toFixed(3)}s` : '—'}
                  </div>
                </div>
                <div className="bg-gray-50 rounded-lg p-3">
                  <div className="text-sm text-gray-600">Speakers</div>
                  <div className="text-2xl font-bold text-gray-800">
                    {new Set(transcriptionData.phrases.map(p => p.speaker)).size}
                  </div>
                </div>
                <div className="bg-gray-50 rounded-lg p-3">
                  <div className="text-sm text-gray-600">Language</div>
                  <div className="text-xl font-bold text-gray-800">{transcriptionData.language}</div>
                </div>
              </div>
            </div>

            {/* Audio Player */}
            <div className="bg-white rounded-lg shadow-lg p-6">
              <h3 className="text-lg font-semibold mb-3 text-gray-800">Audio Player</h3>
              <AudioWaveformPlayer
                ref={playerRef}
                audioUrl={audioUrl}
                onTimeUpdate={handlePlayerTimeUpdate}
                onEnded={() => setCurrentPlayingIndex(null)}
                onPause={handlePlayerPause}
                onReady={handlePlayerReady}
              />
            </div>

            {/* Phrases List */}
            <div className="bg-white rounded-lg shadow-lg p-6">
              <h3 className="text-xl font-semibold mb-2 text-gray-800">Transcribed Phrases</h3>
              <p className="text-sm text-gray-600 mb-4">Click on any phrase to play audio segment</p>
              
              <div className="space-y-3">
                {transcriptionData.phrases.map((phrase, index) => (
                  <div
                    key={index}
                    className={`${getPhraseClassName(index)} ${getSpeakerColor(phrase.speaker)}`}
                  >
                    {editingIndex === index ? (
                      // Edit Mode
                      <div className="space-y-4">
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-2">
                            <Users className="h-4 w-4 text-gray-600" />
                            <input
                              type="text"
                              value={editValues.speaker}
                              onChange={(e) => setEditValues({ ...editValues, speaker: e.target.value })}
                              className="px-3 py-2 text-sm border rounded font-semibold text-gray-800"
                              placeholder="Speaker"
                            />
                          </div>
                          <div className="flex gap-2">
                            <button
                              onClick={saveEdit}
                              className="bg-green-600 text-white p-2 rounded hover:bg-green-700"
                            >
                              <Check className="h-4 w-4" />
                            </button>
                            <button
                              onClick={cancelEdit}
                              className="bg-red-600 text-white p-2 rounded hover:bg-red-700"
                            >
                              <X className="h-4 w-4" />
                            </button>
                          </div>
                        </div>
                        <div>
                          <label className="text-xs text-gray-600">Phrase Text</label>
                          <textarea
                            value={editValues.text}
                            onChange={(e) => setEditValues({ ...editValues, text: e.target.value })}
                            className="w-full px-3 py-2 text-sm border rounded mt-1"
                            rows={3}
                            placeholder="Edit phrase text"
                          />
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                          <div>
                            <label className="text-xs text-gray-600">Start Time</label>
                            <input
                              type="text"
                              value={editValues.start}
                              onChange={(e) => setEditValues({ ...editValues, start: e.target.value })}
                              className="w-full px-3 py-2 text-sm border rounded"
                              placeholder="HH:MM:SS:mmm"
                            />
                          </div>
                          <div>
                            <label className="text-xs text-gray-600">End Time</label>
                            <input
                              type="text"
                              value={editValues.end}
                              onChange={(e) => setEditValues({ ...editValues, end: e.target.value })}
                              className="w-full px-3 py-2 text-sm border rounded"
                              placeholder="HH:MM:SS:mmm"
                            />
                          </div>
                          <div>
                            <label className="text-xs text-gray-600">Emotion</label>
                            <input
                              type="text"
                              value={editValues.emotion}
                              onChange={(e) => setEditValues({ ...editValues, emotion: e.target.value })}
                              className="w-full px-3 py-2 text-sm border rounded"
                              placeholder="Emotion"
                            />
                          </div>
                          <div className="flex items-center gap-2 mt-2 md:mt-6">
                            <input
                              id={`endOfSpeech-${index}`}
                              type="checkbox"
                              checked={editValues.end_of_speech}
                              onChange={(e) => setEditValues({ ...editValues, end_of_speech: e.target.checked })}
                              className="h-4 w-4 text-purple-600 focus:ring-purple-500 border-gray-300 rounded"
                            />
                            <label htmlFor={`endOfSpeech-${index}`} className="text-sm text-gray-600">
                              End of speech
                            </label>
                          </div>
                        </div>
                      </div>
                    ) : (
                      // View Mode
                      <div onClick={() => playPhrase(index)}>
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-3">
                            <div className="flex items-center gap-2">
                              <Users className="h-4 w-4 text-gray-600" />
                              <span className="font-semibold text-gray-800">{phrase.speaker}</span>
                            </div>
                            <span className={`px-3 py-1 rounded-full text-xs font-medium border ${getEmotionColor(phrase.emotion)}`}>
                              <Smile className="inline h-3 w-3 mr-1" />
                              {phrase.emotion}
                            </span>
                          </div>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              startEdit(index);
                            }}
                            className="bg-white hover:bg-gray-100 p-2 rounded-lg shadow border border-gray-300 transition-colors"
                          >
                            <Edit2 className="h-4 w-4 text-gray-600" />
                          </button>
                        </div>
                        <div className="text-lg text-gray-800 mb-2 leading-relaxed">{phrase.text}</div>
                        <div className="flex items-center gap-4 text-sm text-gray-600">
                          <span className="flex items-center gap-1">
                            <Play className="h-3 w-3" />
                            {phrase.start}
                          </span>
                          <span>→</span>
                          <span>{phrase.end}</span>
                          {phrase.end_of_speech && (
                            <span className="px-2 py-1 text-xs font-medium text-purple-700 bg-purple-100 border border-purple-300 rounded">
                              End of Speech
                            </span>
                          )}
                          {currentPlayingIndex === index && (
                            <span className="ml-auto text-blue-600 font-semibold animate-pulse">
                              ▶ Playing
                            </span>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

export default PhrasesApp;

