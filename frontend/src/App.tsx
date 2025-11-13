import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import axios from 'axios';
import { Upload, Play, Download, Save, Edit2, Check, X, Loader2 } from 'lucide-react';
import AudioWaveformPlayer, { AudioWaveformPlayerHandle } from './components/AudioWaveformPlayer';

const API_BASE_URL = 'http://localhost:5001';

interface Word {
  start: string;
  end: string;
  word: string;
  duration: number;
  language: string;
}

interface TranscriptionData {
  words: Word[];
  language: string;
  audio_path: string;
  audio_duration: number;
  total_words: number;
  reference_text?: string;
  has_reference?: boolean;
  metadata?: {
    filename: string;
    source_language: string;
    audio_path: string;
  };
}

function App() {
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [referenceFile, setReferenceFile] = useState<File | null>(null);
  const [referenceText, setReferenceText] = useState('');
  const [sourceLanguage, setSourceLanguage] = useState('Gujarati');
  const [languages, setLanguages] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [transcriptionData, setTranscriptionData] = useState<TranscriptionData | null>(null);
  const [audioUrl, setAudioUrl] = useState('');
  const [currentPlayingIndex, setCurrentPlayingIndex] = useState<number | null>(null);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editValues, setEditValues] = useState<{ start: string; end: string; word: string }>({
    start: '',
    end: '',
    word: '',
  });
  const [hasChanges, setHasChanges] = useState(false);

  const playerRef = useRef<AudioWaveformPlayerHandle | null>(null);

  const timeToSeconds = (timeStr: string): number => {
    const parts = timeStr.split(':');
    if (parts.length === 3) {
      // H:MM:SS.mmm
      return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
    } else if (parts.length === 2) {
      // MM:SS.mmm
      return parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
    }
    return parseFloat(timeStr);
  };

  const wordTimings = useMemo(() => {
    if (!transcriptionData) return [];

    return transcriptionData.words.map((word) => ({
      start: timeToSeconds(word.start),
      end: timeToSeconds(word.end),
    }));
  }, [transcriptionData]);

  // Fetch languages on mount
  useEffect(() => {
    fetchLanguages();
  }, []);

  const fetchLanguages = async () => {
    try {
      const response = await axios.get(`${API_BASE_URL}/api/languages`);
      if (response.data.success) {
        setLanguages(response.data.languages.map((l: any) => l.name));
      }
    } catch (error) {
      console.error('Error fetching languages:', error);
    }
  };

  const handleAudioFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setAudioFile(e.target.files[0]);
    }
  };

  const handleReferenceFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      setReferenceFile(file);

      // Read file content
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
      formData.append('target_language', 'English');

      if (referenceText) {
        formData.append('reference_text', referenceText);
      }

      const response = await axios.post(`${API_BASE_URL}/api/transcribe`, formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
        },
      });

      if (response.data.success) {
        setTranscriptionData(response.data.data);
        if (response.data.data.metadata?.audio_path) {
          setAudioUrl(`${API_BASE_URL}${response.data.data.metadata.audio_path}`);
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

  const playWord = (index: number) => {
    if (!transcriptionData || !playerRef.current) return;

    const word = transcriptionData.words[index];
    const startTime = timeToSeconds(word.start);
    const endTime = timeToSeconds(word.end);

    setCurrentPlayingIndex(index);
    playerRef.current.playSegment(startTime, endTime);
  };

  const handlePlayerTimeUpdate = useCallback(
    (current: number) => {
      if (!transcriptionData || wordTimings.length === 0) {
        setCurrentPlayingIndex((prev) => (prev !== null ? null : prev));
        return;
      }

      let nextIndex: number | null = null;
      for (let i = 0; i < wordTimings.length; i += 1) {
        const timing = wordTimings[i];
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
    [transcriptionData, wordTimings],
  );

  const handlePlayerPause = useCallback(() => {
    setCurrentPlayingIndex((prev) => (prev !== null ? null : prev));
  }, []);

  const startEdit = (index: number) => {
    const word = transcriptionData!.words[index];
    setEditingIndex(index);
    setEditValues({ start: word.start, end: word.end, word: word.word });
  };

  const cancelEdit = () => {
    setEditingIndex(null);
    setEditValues({ start: '', end: '', word: '' });
  };

  const saveEdit = () => {
    if (editingIndex === null || !transcriptionData) return;

    const updatedWords = [...transcriptionData.words];
    updatedWords[editingIndex] = {
      ...updatedWords[editingIndex],
      start: editValues.start,
      end: editValues.end,
      word: editValues.word,
      duration: timeToSeconds(editValues.end) - timeToSeconds(editValues.start),
    };

    setTranscriptionData({
      ...transcriptionData,
      words: updatedWords,
    });

    setEditingIndex(null);
    setHasChanges(true);
  };

  const saveChanges = async () => {
    if (!transcriptionData) return;

    try {
      const filename = transcriptionData.metadata?.filename || 'transcription.json';
      const saveData = {
        filename: `${Date.now()}_${filename}_edited.json`,
        words: transcriptionData.words,
        language: transcriptionData.language,
        audio_path: transcriptionData.audio_path,
        audio_duration: transcriptionData.audio_duration,
      };

      const response = await axios.post(`${API_BASE_URL}/api/transcription/save`, saveData);

      if (response.data.success) {
        alert('Changes saved successfully!');
        setHasChanges(false);
      } else {
        alert(`Error: ${response.data.error}`);
      }
    } catch (error: any) {
      console.error('Error saving:', error);
      alert(`Error: ${error.response?.data?.error || error.message}`);
    }
  };

  const downloadTranscription = () => {
    if (!transcriptionData) return;

    const dataStr = JSON.stringify(transcriptionData, null, 2);
    const dataBlob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(dataBlob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `transcription_${Date.now()}.json`;
    link.click();
  };

  const matchesReference = (word: string): boolean | null => {
    if (!referenceText) return null;

    // Simple word matching (can be improved with fuzzy matching)
    const refWords = referenceText.split(/\s+/);
    return refWords.includes(word.replace(/<[^>]*>/g, '').trim());
  };

  const getWordClassName = (index: number, word: string): string => {
    let classes = 'inline-block px-3 py-2 m-1 rounded border-2 cursor-pointer transition-all duration-200 hover:shadow-lg';

    if (currentPlayingIndex === index) {
      classes += ' word-playing';
    } else {
      const match = matchesReference(word);
      if (match === true) {
        classes += ' word-correct';
      } else if (match === false) {
        classes += ' word-incorrect';
      } else {
        classes += ' bg-gray-100 border-gray-300';
      }
    }

    return classes;
  };

  return (
    <main className="min-h-screen p-8 bg-gradient-to-br from-blue-50 to-purple-50">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold text-gray-800 mb-2">
            Data Studio: Phonetic Transcription Module
          </h1>
          <p className="text-gray-600">Upload audio, transcribe, and edit word-level timestamps</p>
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
              <div className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center hover:border-blue-500 transition-colors">
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
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
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
                className="w-full h-32 px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>

            {/* Transcribe Button */}
            <button
              onClick={handleTranscribe}
              disabled={loading || !audioFile}
              className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white font-semibold py-3 px-6 rounded-lg transition-colors flex items-center justify-center"
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
                      onClick={saveChanges}
                      className="bg-green-600 hover:bg-green-700 text-white font-semibold py-2 px-4 rounded-lg transition-colors flex items-center"
                    >
                      <Save className="h-4 w-4 mr-2" />
                      Save Changes
                    </button>
                  )}
                  <button
                    onClick={downloadTranscription}
                    className="bg-blue-600 hover:bg-blue-700 text-white font-semibold py-2 px-4 rounded-lg transition-colors flex items-center"
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
                      setHasChanges(false);
                    }}
                    className="bg-gray-600 hover:bg-gray-700 text-white font-semibold py-2 px-4 rounded-lg transition-colors"
                  >
                    New Transcription
                  </button>
                </div>
              </div>
              <div className="mt-4 grid grid-cols-2 md:grid-cols-3 gap-4">
                <div className="bg-gray-50 rounded-lg p-3">
                  <div className="text-sm text-gray-600">Total Words</div>
                  <div className="text-2xl font-bold text-gray-800">{transcriptionData.total_words}</div>
                </div>
                <div className="bg-gray-50 rounded-lg p-3">
                  <div className="text-sm text-gray-600">Duration</div>
                  <div className="text-2xl font-bold text-gray-800">
                    {transcriptionData.audio_duration.toFixed(3)}s
                  </div>
                </div>
                <div className="bg-gray-50 rounded-lg p-3">
                  <div className="text-sm text-gray-600">Language</div>
                  <div className="text-xl font-bold text-gray-800">{transcriptionData.language}</div>
                </div>
              </div>

              {/* Legend */}
              {referenceText && (
                <div className="mt-4 flex gap-4 text-sm">
                  <div className="flex items-center">
                    <div className="w-4 h-4 bg-green-200 border-2 border-green-400 rounded mr-2"></div>
                    <span>Correct</span>
                  </div>
                  <div className="flex items-center">
                    <div className="w-4 h-4 bg-yellow-200 border-2 border-yellow-400 rounded mr-2"></div>
                    <span>Incorrect</span>
                  </div>
                  <div className="flex items-center">
                    <div className="w-4 h-4 bg-blue-300 border-2 border-blue-500 rounded mr-2"></div>
                    <span>Playing</span>
                  </div>
                </div>
              )}
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
              />
            </div>

            {/* Words Grid */}
            <div className="bg-white rounded-lg shadow-lg p-6">
              <h3 className="text-xl font-semibold mb-2 text-gray-800">Transcribed Words</h3>
              <p className="text-sm text-gray-600 mb-4">Click on any word to play audio segment</p>
              <div className="flex flex-wrap gap-0">
                {transcriptionData.words.map((word, index) => (
                  <div key={index} className="relative group">
                    {editingIndex === index ? (
                      // Edit Mode
                      <div className="inline-block p-2 m-1 border-2 border-blue-500 rounded bg-blue-50">
                        <div className="space-y-2">
                          <label className="text-xs text-gray-600">Word</label>
                          <textarea
                            value={editValues.word}
                            onChange={(e) => setEditValues({ ...editValues, word: e.target.value })}
                            className="w-full px-2 py-1 text-sm border rounded"
                            rows={1}
                            placeholder="Word"
                          />
                          <label className="text-xs text-gray-600">Start time</label>
                          <textarea
                            value={editValues.start}
                            onChange={(e) => setEditValues({ ...editValues, start: e.target.value })}
                            className="w-full px-2 py-1 text-xs border rounded"
                            placeholder="Start time"
                          />
                          <label className="text-xs text-gray-600">End time</label>
                          <textarea
                            value={editValues.end}
                            onChange={(e) => setEditValues({ ...editValues, end: e.target.value })}
                            className="w-full px-2 py-1 text-xs border rounded"
                            rows={1}
                            placeholder="End time"
                          />
                          <div className="flex gap-1">
                            <button
                              onClick={saveEdit}
                              className="flex-1 bg-green-600 text-white p-1 rounded text-xs hover:bg-green-700"
                            >
                              <Check className="h-3 w-3 mx-auto" />
                            </button>
                            <button
                              onClick={cancelEdit}
                              className="flex-1 bg-red-600 text-white p-1 rounded text-xs hover:bg-red-700"
                            >
                              <X className="h-3 w-3 mx-auto" />
                            </button>
                          </div>
                        </div>
                      </div>
                    ) : (
                      // View Mode
                      <div
                        className={getWordClassName(index, word.word)}
                        onClick={() => playWord(index)}
                      >
                        <div className="font-medium">{word.word}</div>
                        <div className="text-xs text-gray-500 mt-1">
                          {word.start} - {word.end}
                        </div>
                        {/* Edit Button (shown on hover) */}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            startEdit(index);
                          }}
                          className="absolute top-1 right-1 bg-white rounded-full p-1 shadow opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          <Edit2 className="h-3 w-3 text-blue-600" />
                        </button>
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

export default App;

