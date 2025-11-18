import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import axios from 'axios';
import { Database, Play, Save, Edit2, Check, X, Loader2, ArrowLeft, Download, Trash2 } from 'lucide-react';
import AudioWaveformPlayer, { AudioWaveformPlayerHandle } from './components/AudioWaveformPlayer';

const API_BASE_URL = 'http://localhost:5001';

interface Word {
  start: string;
  end: string;
  word: string;
  duration: number;
  language: string;
}

interface Phrase {
  start: string;
  end: string;
  speaker: string;
  text: string;
  emotion: string;
  language: string;
  end_of_speech: boolean;
  duration?: number;
}

interface TranscriptionSummary {
  _id: string;
  created_at: string;
  updated_at: string;
  transcription_type: 'words' | 'phrases';
  language: string;
  total_words: number;
  total_phrases: number;
  audio_duration: number;
  s3_url: string;
  filename: string;
}

interface TranscriptionDocument {
  _id: string;
  transcription_data: {
    words?: Word[];
    phrases?: Phrase[];
    language: string;
    audio_duration: number;
    total_words?: number;
    total_phrases?: number;
    transcription_type: 'words' | 'phrases';
  };
  s3_metadata: {
    url: string;
    bucket: string;
    key: string;
  };
  created_at: string;
  updated_at: string;
}

function SavedTranscriptions() {
  const [transcriptions, setTranscriptions] = useState<TranscriptionSummary[]>([]);
  const [selectedTranscription, setSelectedTranscription] = useState<TranscriptionDocument | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [audioUrl, setAudioUrl] = useState('');
  const [currentPlayingIndex, setCurrentPlayingIndex] = useState<number | null>(null);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editingPhraseIndex, setEditingPhraseIndex] = useState<number | null>(null);
  const [editValues, setEditValues] = useState<{ start: string; end: string; word: string }>({
    start: '',
    end: '',
    word: '',
  });
  const [editPhraseValues, setEditPhraseValues] = useState<{
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
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const playerRef = useRef<AudioWaveformPlayerHandle | null>(null);

  useEffect(() => {
    fetchTranscriptions();
  }, []);

  const fetchTranscriptions = async () => {
    setLoading(true);
    try {
      const response = await axios.get(`${API_BASE_URL}/api/transcriptions`);
      if (response.data.success) {
        setTranscriptions(response.data.data.transcriptions || []);
      } else {
        alert(`Error: ${response.data.error}`);
      }
    } catch (error: any) {
      console.error('Error fetching transcriptions:', error);
      alert(`Error: ${error.response?.data?.error || error.message}`);
    } finally {
      setLoading(false);
    }
  };

  const fetchTranscriptionDetails = async (id: string) => {
    setLoadingDetails(true);
    try {
      const response = await axios.get(`${API_BASE_URL}/api/transcriptions/${id}`);
      if (response.data.success) {
        const doc = response.data.data;
        setSelectedTranscription(doc);
        // Set audio URL using proxy endpoint to avoid CORS issues
        if (doc.s3_metadata?.url) {
          // Use proxy endpoint instead of direct S3 URL
          const s3Url = encodeURIComponent(doc.s3_metadata.url);
          setAudioUrl(`${API_BASE_URL}/api/audio/s3-proxy?url=${s3Url}`);
        } else if (doc.s3_metadata?.key) {
          // Use key if URL is not available
          const s3Key = encodeURIComponent(doc.s3_metadata.key);
          setAudioUrl(`${API_BASE_URL}/api/audio/s3-proxy?key=${s3Key}`);
        }
      } else {
        alert(`Error: ${response.data.error}`);
      }
    } catch (error: any) {
      console.error('Error fetching transcription details:', error);
      alert(`Error: ${error.response?.data?.error || error.message}`);
    } finally {
      setLoadingDetails(false);
    }
  };

  const timeToSeconds = (timeStr: string): number => {
    const parts = timeStr.split(':');
    if (parts.length === 4) {
      // HH:MM:SS:mmm (phrase format)
      return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]) + parseFloat(parts[3]) / 1000;
    } else if (parts.length === 3) {
      // H:MM:SS.mmm or HH:MM:SS
      return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
    } else if (parts.length === 2) {
      // MM:SS.mmm
      return parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
    }
    return parseFloat(timeStr);
  };

  const wordTimings = useMemo(() => {
    if (!selectedTranscription || selectedTranscription.transcription_data.transcription_type !== 'words') return [];
    const words = selectedTranscription.transcription_data.words || [];
    return words.map((word) => ({
      start: timeToSeconds(word.start),
      end: timeToSeconds(word.end),
    }));
  }, [selectedTranscription]);

  const phraseTimings = useMemo(() => {
    if (!selectedTranscription || selectedTranscription.transcription_data.transcription_type !== 'phrases') return [];
    const phrases = selectedTranscription.transcription_data.phrases || [];
    return phrases.map((phrase) => ({
      start: timeToSeconds(phrase.start),
      end: timeToSeconds(phrase.end),
    }));
  }, [selectedTranscription]);

  const playWord = (index: number) => {
    if (!selectedTranscription || !playerRef.current) return;
    const words = selectedTranscription.transcription_data.words || [];
    const word = words[index];
    const startTime = timeToSeconds(word.start);
    const endTime = timeToSeconds(word.end);

    setCurrentPlayingIndex(index);
    playerRef.current.playSegment(startTime, endTime);
  };

  const playPhrase = (index: number) => {
    if (!selectedTranscription || !playerRef.current) return;
    const phrases = selectedTranscription.transcription_data.phrases || [];
    const phrase = phrases[index];
    const startTime = timeToSeconds(phrase.start);
    const endTime = timeToSeconds(phrase.end);

    setCurrentPlayingIndex(index);
    playerRef.current.playSegment(startTime, endTime);
  };

  const handlePlayerTimeUpdate = useCallback(
    (current: number) => {
      if (!selectedTranscription) {
        setCurrentPlayingIndex((prev) => (prev !== null ? null : prev));
        return;
      }

      const isWordsType = selectedTranscription.transcription_data.transcription_type === 'words';
      const timings = isWordsType ? wordTimings : phraseTimings;

      if (timings.length === 0) {
        setCurrentPlayingIndex((prev) => (prev !== null ? null : prev));
        return;
      }

      let nextIndex: number | null = null;
      for (let i = 0; i < timings.length; i += 1) {
        const timing = timings[i];
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
    [selectedTranscription, wordTimings, phraseTimings],
  );

  const handlePlayerPause = useCallback(() => {
    setCurrentPlayingIndex((prev) => (prev !== null ? null : prev));
  }, []);

  // Show loading state when fetching details - must be after all hooks
  if (loadingDetails) {
    return (
      <main className="min-h-screen p-8 bg-gradient-to-br from-indigo-50 to-purple-50">
        <div className="max-w-7xl mx-auto flex justify-center items-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-indigo-600" />
        </div>
      </main>
    );
  }

  const startEdit = (index: number) => {
    if (!selectedTranscription) return;
    const words = selectedTranscription.transcription_data.words || [];
    const word = words[index];
    setEditingIndex(index);
    setEditValues({ start: word.start, end: word.end, word: word.word });
  };

  const cancelEdit = () => {
    setEditingIndex(null);
    setEditValues({ start: '', end: '', word: '' });
  };

  const saveEdit = () => {
    if (editingIndex === null || !selectedTranscription) return;

    const updatedWords = [...(selectedTranscription.transcription_data.words || [])];
    updatedWords[editingIndex] = {
      ...updatedWords[editingIndex],
      start: editValues.start,
      end: editValues.end,
      word: editValues.word,
      duration: timeToSeconds(editValues.end) - timeToSeconds(editValues.start),
    };

    setSelectedTranscription({
      ...selectedTranscription,
      transcription_data: {
        ...selectedTranscription.transcription_data,
        words: updatedWords,
        total_words: updatedWords.length,
      },
    });

    setEditingIndex(null);
    setHasChanges(true);
  };

  const startEditPhrase = (index: number) => {
    if (!selectedTranscription) return;
    const phrases = selectedTranscription.transcription_data.phrases || [];
    const phrase = phrases[index];
    setEditingPhraseIndex(index);
    setEditPhraseValues({
      start: phrase.start,
      end: phrase.end,
      text: phrase.text,
      speaker: phrase.speaker,
      emotion: phrase.emotion,
      end_of_speech: phrase.end_of_speech,
    });
  };

  const cancelEditPhrase = () => {
    setEditingPhraseIndex(null);
    setEditPhraseValues({
      start: '',
      end: '',
      text: '',
      speaker: '',
      emotion: '',
      end_of_speech: false,
    });
  };

  const saveEditPhrase = () => {
    if (editingPhraseIndex === null || !selectedTranscription) return;

    const updatedPhrases = [...(selectedTranscription.transcription_data.phrases || [])];
    
    // Calculate duration from start and end times
    const startSeconds = timeToSeconds(editPhraseValues.start);
    const endSeconds = timeToSeconds(editPhraseValues.end);
    const duration = endSeconds - startSeconds;
    
    updatedPhrases[editingPhraseIndex] = {
      ...updatedPhrases[editingPhraseIndex],
      start: editPhraseValues.start,
      end: editPhraseValues.end,
      text: editPhraseValues.text,
      speaker: editPhraseValues.speaker,
      emotion: editPhraseValues.emotion,
      end_of_speech: editPhraseValues.end_of_speech,
      duration: duration,
    };

    setSelectedTranscription({
      ...selectedTranscription,
      transcription_data: {
        ...selectedTranscription.transcription_data,
        phrases: updatedPhrases,
        total_phrases: updatedPhrases.length,
      },
    });

    setEditingPhraseIndex(null);
    setHasChanges(true);
  };

  const saveChanges = async () => {
    if (!selectedTranscription) return;

    setSaving(true);
    try {
      const response = await axios.put(
        `${API_BASE_URL}/api/transcriptions/${selectedTranscription._id}`,
        {
          transcription_data: selectedTranscription.transcription_data,
        }
      );

      if (response.data.success) {
        alert('Changes saved successfully!');
        setHasChanges(false);
        // Refresh the list
        fetchTranscriptions();
      } else {
        alert(`Error: ${response.data.error}`);
      }
    } catch (error: any) {
      console.error('Error saving:', error);
      alert(`Error: ${error.response?.data?.error || error.message}`);
    } finally {
      setSaving(false);
    }
  };

  const downloadTranscription = () => {
    if (!selectedTranscription) return;

    const dataStr = JSON.stringify(selectedTranscription, null, 2);
    const dataBlob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(dataBlob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `transcription_${selectedTranscription._id}.json`;
    link.click();
  };

  const deleteTranscription = async (id: string, showConfirm: boolean = true) => {
    if (showConfirm) {
      const confirmed = window.confirm(
        'Are you sure you want to delete this transcription?\n\n' +
        'This action cannot be undone. The following will be permanently deleted:\n' +
        '• Transcription data from database\n' +
        '• Audio file from S3 storage\n\n' +
        'This action is irreversible.'
      );
      
      if (!confirmed) {
        return;
      }
    }

    setDeleting(true);
    try {
      const response = await axios.delete(`${API_BASE_URL}/api/transcriptions/${id}`);

      if (response.data.success) {
        alert('Transcription deleted successfully!');
        
        // If we're viewing the deleted transcription, go back to list
        if (selectedTranscription && selectedTranscription._id === id) {
          setSelectedTranscription(null);
          setHasChanges(false);
        }
        
        // Refresh the list
        fetchTranscriptions();
      } else {
        alert(`Error: ${response.data.error}`);
      }
    } catch (error: any) {
      console.error('Error deleting transcription:', error);
      alert(`Error: ${error.response?.data?.error || error.message}`);
    } finally {
      setDeleting(false);
    }
  };

  const getWordClassName = (index: number): string => {
    let classes = 'inline-block px-3 py-2 m-1 rounded border-2 cursor-pointer transition-all duration-200 hover:shadow-lg';

    if (currentPlayingIndex === index) {
      classes += ' word-playing';
    } else {
      classes += ' bg-gray-100 border-gray-300';
    }

    return classes;
  };

  if (selectedTranscription) {
    const transcriptionData = selectedTranscription.transcription_data;
    const isWordsType = transcriptionData.transcription_type === 'words';
    const words = transcriptionData.words || [];
    const phrases = transcriptionData.phrases || [];

    return (
      <main className="min-h-screen p-8 bg-gradient-to-br from-indigo-50 to-purple-50">
        <div className="max-w-7xl mx-auto">
          {/* Header */}
          <div className="mb-6">
            <button
              onClick={() => {
                if (hasChanges && !window.confirm('Discard changes and go back?')) return;
                setSelectedTranscription(null);
                setHasChanges(false);
                setEditingIndex(null);
              }}
              className="mb-4 flex items-center gap-2 text-gray-600 hover:text-gray-800"
            >
              <ArrowLeft className="h-5 w-5" />
              Back to List
            </button>
            <div className="flex justify-between items-center flex-wrap gap-4">
              <div>
                <h1 className="text-4xl font-bold text-gray-800 mb-2">Saved Transcription</h1>
                <p className="text-gray-600">
                  Created: {new Date(selectedTranscription.created_at).toLocaleString()}
                </p>
              </div>
              <div className="flex gap-2">
                {hasChanges && (
                  <button
                    onClick={saveChanges}
                    disabled={saving}
                    className="bg-green-600 hover:bg-green-700 disabled:bg-gray-400 text-white font-semibold py-2 px-4 rounded-lg transition-colors flex items-center"
                  >
                    {saving ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Saving...
                      </>
                    ) : (
                      <>
                        <Save className="h-4 w-4 mr-2" />
                        Save Changes
                      </>
                    )}
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
                  onClick={() => selectedTranscription && deleteTranscription(selectedTranscription._id)}
                  disabled={deleting}
                  className="bg-red-600 hover:bg-red-700 disabled:bg-gray-400 text-white font-semibold py-2 px-4 rounded-lg transition-colors flex items-center"
                >
                  {deleting ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Deleting...
                    </>
                  ) : (
                    <>
                      <Trash2 className="h-4 w-4 mr-2" />
                      Delete
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>

          {/* Info Bar */}
          <div className="bg-white rounded-lg shadow-lg p-6 mb-6">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="bg-gray-50 rounded-lg p-3">
                <div className="text-sm text-gray-600">
                  {isWordsType ? 'Total Words' : 'Total Phrases'}
                </div>
                <div className="text-2xl font-bold text-gray-800">
                  {isWordsType ? transcriptionData.total_words || words.length : transcriptionData.total_phrases || phrases.length}
                </div>
              </div>
              <div className="bg-gray-50 rounded-lg p-3">
                <div className="text-sm text-gray-600">Duration</div>
                <div className="text-2xl font-bold text-gray-800">
                  {transcriptionData.audio_duration?.toFixed(3) || '0.000'}s
                </div>
              </div>
              <div className="bg-gray-50 rounded-lg p-3">
                <div className="text-sm text-gray-600">Language</div>
                <div className="text-xl font-bold text-gray-800">{transcriptionData.language}</div>
              </div>
              <div className="bg-gray-50 rounded-lg p-3">
                <div className="text-sm text-gray-600">Type</div>
                <div className="text-xl font-bold text-gray-800 capitalize">
                  {transcriptionData.transcription_type}
                </div>
              </div>
            </div>
          </div>

          {/* Audio Player */}
          {audioUrl && (
            <div className="bg-white rounded-lg shadow-lg p-6 mb-6">
              <h3 className="text-lg font-semibold mb-3 text-gray-800">Audio Player</h3>
              <AudioWaveformPlayer
                ref={playerRef}
                audioUrl={audioUrl}
                onTimeUpdate={handlePlayerTimeUpdate}
                onEnded={() => setCurrentPlayingIndex(null)}
                onPause={handlePlayerPause}
              />
            </div>
          )}

          {/* Words/Phrases Display */}
          {isWordsType && words.length > 0 && (
            <div className="bg-white rounded-lg shadow-lg p-6">
              <h3 className="text-xl font-semibold mb-2 text-gray-800">Transcribed Words</h3>
              <p className="text-sm text-gray-600 mb-4">Click on any word to play audio segment</p>
              <div className="flex flex-wrap gap-0">
                {words.map((word, index) => (
                  <div key={index} className="relative group">
                    {editingIndex === index ? (
                      <div className="inline-block p-2 m-1 border-2 border-blue-500 rounded bg-blue-50">
                        <div className="space-y-2">
                          <label className="text-xs text-gray-600">Word</label>
                          <textarea
                            value={editValues.word}
                            onChange={(e) => setEditValues({ ...editValues, word: e.target.value })}
                            className="w-full px-2 py-1 text-sm border rounded"
                            rows={1}
                          />
                          <label className="text-xs text-gray-600">Start time</label>
                          <textarea
                            value={editValues.start}
                            onChange={(e) => setEditValues({ ...editValues, start: e.target.value })}
                            className="w-full px-2 py-1 text-xs border rounded"
                            rows={1}
                          />
                          <label className="text-xs text-gray-600">End time</label>
                          <textarea
                            value={editValues.end}
                            onChange={(e) => setEditValues({ ...editValues, end: e.target.value })}
                            className="w-full px-2 py-1 text-xs border rounded"
                            rows={1}
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
                      <div
                        className={getWordClassName(index)}
                        onClick={() => playWord(index)}
                      >
                        <div className="font-medium">{word.word}</div>
                        <div className="text-xs text-gray-500 mt-1">
                          {word.start} - {word.end}
                        </div>
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
          )}

          {!isWordsType && phrases.length > 0 && (
            <div className="bg-white rounded-lg shadow-lg p-6">
              <h3 className="text-xl font-semibold mb-2 text-gray-800">Transcribed Phrases</h3>
              <p className="text-sm text-gray-600 mb-4">Click on any phrase to play audio segment</p>
              <div className="space-y-3">
                {phrases.map((phrase, index) => (
                  <div
                    key={index}
                    className={`p-4 rounded-lg border-2 cursor-pointer transition-all duration-200 hover:shadow-lg relative group ${
                      currentPlayingIndex === index
                        ? 'ring-4 ring-blue-400 scale-[1.02] bg-blue-50 border-blue-300'
                        : 'border-gray-200 bg-white'
                    }`}
                    onClick={() => playPhrase(index)}
                  >
                    {editingPhraseIndex === index ? (
                      // Edit Mode
                      <div className="space-y-4">
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-2">
                            <span className="text-gray-600">Speaker:</span>
                            <input
                              type="text"
                              value={editPhraseValues.speaker}
                              onChange={(e) => setEditPhraseValues({ ...editPhraseValues, speaker: e.target.value })}
                              className="px-3 py-2 text-sm border rounded font-semibold text-gray-800"
                              placeholder="Speaker"
                            />
                          </div>
                          <div className="flex gap-2">
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                saveEditPhrase();
                              }}
                              className="bg-green-600 text-white p-2 rounded hover:bg-green-700"
                            >
                              <Check className="h-4 w-4" />
                            </button>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                cancelEditPhrase();
                              }}
                              className="bg-red-600 text-white p-2 rounded hover:bg-red-700"
                            >
                              <X className="h-4 w-4" />
                            </button>
                          </div>
                        </div>
                        <div>
                          <label className="text-xs text-gray-600">Phrase Text</label>
                          <textarea
                            value={editPhraseValues.text}
                            onChange={(e) => setEditPhraseValues({ ...editPhraseValues, text: e.target.value })}
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
                              value={editPhraseValues.start}
                              onChange={(e) => setEditPhraseValues({ ...editPhraseValues, start: e.target.value })}
                              className="w-full px-3 py-2 text-sm border rounded"
                              placeholder="HH:MM:SS:mmm"
                            />
                          </div>
                          <div>
                            <label className="text-xs text-gray-600">End Time</label>
                            <input
                              type="text"
                              value={editPhraseValues.end}
                              onChange={(e) => setEditPhraseValues({ ...editPhraseValues, end: e.target.value })}
                              className="w-full px-3 py-2 text-sm border rounded"
                              placeholder="HH:MM:SS:mmm"
                            />
                          </div>
                          <div>
                            <label className="text-xs text-gray-600">Emotion</label>
                            <input
                              type="text"
                              value={editPhraseValues.emotion}
                              onChange={(e) => setEditPhraseValues({ ...editPhraseValues, emotion: e.target.value })}
                              className="w-full px-3 py-2 text-sm border rounded"
                              placeholder="Emotion"
                            />
                          </div>
                          <div className="flex items-center gap-2 mt-2 md:mt-6">
                            <input
                              id={`endOfSpeech-${index}`}
                              type="checkbox"
                              checked={editPhraseValues.end_of_speech}
                              onChange={(e) => setEditPhraseValues({ ...editPhraseValues, end_of_speech: e.target.checked })}
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
                      <div>
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-3">
                            <span className="font-semibold text-gray-800">{phrase.speaker}</span>
                            <span className="px-3 py-1 rounded-full text-xs font-medium bg-purple-100 text-purple-800">
                              {phrase.emotion}
                            </span>
                          </div>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              startEditPhrase(index);
                            }}
                            className="bg-white hover:bg-gray-100 p-2 rounded-lg shadow border border-gray-300 transition-colors opacity-0 group-hover:opacity-100"
                          >
                            <Edit2 className="h-4 w-4 text-gray-600" />
                          </button>
                        </div>
                        <div className="text-lg text-gray-800 mb-2">{phrase.text}</div>
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
          )}
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen p-8 bg-gradient-to-br from-indigo-50 to-purple-50">
      <div className="max-w-7xl mx-auto">
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold text-gray-800 mb-2 flex items-center justify-center gap-3">
            <Database className="h-10 w-10" />
            Saved Transcriptions
          </h1>
          <p className="text-gray-600">View and edit your saved transcriptions</p>
        </div>

        {loading ? (
          <div className="flex justify-center items-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-indigo-600" />
          </div>
        ) : transcriptions.length === 0 ? (
          <div className="bg-white rounded-lg shadow-lg p-12 text-center">
            <Database className="h-16 w-16 text-gray-400 mx-auto mb-4" />
            <p className="text-gray-600 text-lg">No saved transcriptions found</p>
            <p className="text-gray-400 text-sm mt-2">Save a transcription to see it here</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {transcriptions.map((transcription) => (
              <div
                key={transcription._id}
                onClick={() => fetchTranscriptionDetails(transcription._id)}
                className="bg-white rounded-lg shadow-lg p-6 cursor-pointer hover:shadow-xl transition-shadow"
              >
                <div className="flex items-center justify-between mb-4">
                  <span className="px-3 py-1 rounded-full text-xs font-medium bg-indigo-100 text-indigo-800 capitalize">
                    {transcription.transcription_type}
                  </span>
                  <span className="text-xs text-gray-500">
                    {new Date(transcription.created_at).toLocaleDateString()}
                  </span>
                </div>
                <h3 className="text-lg font-semibold text-gray-800 mb-2">
                  {transcription.filename || 'Untitled'}
                </h3>
                <div className="space-y-2 text-sm text-gray-600">
                  <div className="flex justify-between">
                    <span>Language:</span>
                    <span className="font-medium">{transcription.language}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>{transcription.transcription_type === 'words' ? 'Words:' : 'Phrases:'}</span>
                    <span className="font-medium">
                      {transcription.transcription_type === 'words'
                        ? transcription.total_words
                        : transcription.total_phrases}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>Duration:</span>
                    <span className="font-medium">{transcription.audio_duration?.toFixed(2) || '0.00'}s</span>
                  </div>
                </div>
                <div className="mt-4 flex gap-2">
                  <button
                    onClick={() => fetchTranscriptionDetails(transcription._id)}
                    className="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold py-2 px-4 rounded-lg transition-colors flex items-center justify-center"
                  >
                    <Play className="h-4 w-4 mr-2" />
                    View Details
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteTranscription(transcription._id);
                    }}
                    className="bg-red-600 hover:bg-red-700 text-white font-semibold py-2 px-4 rounded-lg transition-colors flex items-center justify-center"
                    title="Delete transcription"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

export default SavedTranscriptions;

