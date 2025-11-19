import { useState, useRef, useMemo, useCallback, useEffect } from 'react';
import axios from 'axios';
import { Upload, Play, Download, Save, Edit2, Check, X, Loader2, Users, Smile, Database, ChevronDown, ChevronUp, Edit, FolderOpen, Trash2 } from 'lucide-react';
import AudioWaveformPlayer, { AudioWaveformPlayerHandle } from './components/AudioWaveformPlayer';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || (import.meta.env.DEV ? 'http://localhost:5002' : '/api');

// Helper function to get user_id from localStorage
const getUserId = (): string | null => {
  try {
    const userStr = localStorage.getItem('user');
    if (userStr) {
      const user = JSON.parse(userStr);
      return user.sub || user.id || null; // Google OAuth uses 'sub' as the unique user ID
    }
  } catch (error) {
    console.error('Error getting user ID:', error);
  }
  return null;
};

// Helper function to get axios config with user_id header
const getAxiosConfig = () => {
  const userId = getUserId();
  if (!userId) {
    throw new Error('User not authenticated. Please sign in again.');
  }
  return {
    headers: {
      'X-User-ID': userId
    }
  };
};

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

interface TranscriptionData {
  phrases: Phrase[];
  language: string;
  audio_duration: number;
  total_phrases: number;
  reference_text?: string;
  metadata?: {
    filename?: string;
    audio_path?: string;
  };
}

interface SavedTranscriptionSummary {
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

interface SavedTranscriptionDocument {
  _id: string;
  transcription_data: {
    words?: any[];
    phrases?: Phrase[];
    language: string;
    audio_duration: number;
    total_words?: number;
    total_phrases?: number;
    transcription_type: 'words' | 'phrases';
    metadata?: {
      filename?: string;
    };
  };
  s3_metadata: {
    url: string;
    bucket: string;
    key: string;
  };
  created_at: string;
  updated_at: string;
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
  const [savingToDatabase, setSavingToDatabase] = useState(false);
  const [isUploadFormExpanded, setIsUploadFormExpanded] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [newFilename, setNewFilename] = useState('');
  const [savedTranscriptions, setSavedTranscriptions] = useState<SavedTranscriptionSummary[]>([]);
  const [loadingSaved, setLoadingSaved] = useState(false);
  
  const playerRef = useRef<AudioWaveformPlayerHandle | null>(null);

  // Fetch saved transcriptions on mount
  useEffect(() => {
    fetchSavedTranscriptions();
  }, []);

  const fetchSavedTranscriptions = async () => {
    setLoadingSaved(true);
    try {
      const config = getAxiosConfig();
      const response = await axios.get(`${API_BASE_URL}/api/transcriptions`, config);
      if (response.data.success) {
        const allTranscriptions = response.data.data.transcriptions || [];
        // Filter only 'phrases' type transcriptions
        const phrasesTranscriptions = allTranscriptions.filter(
          (t: SavedTranscriptionSummary) => t.transcription_type === 'phrases'
        );
        setSavedTranscriptions(phrasesTranscriptions);
      }
    } catch (error: any) {
      console.error('Error fetching saved transcriptions:', error);
      // Don't show alert if user is not authenticated (might be loading)
      if (error.message && error.message.includes('not authenticated')) {
        // Silently fail - user might not be signed in yet
        return;
      }
    } finally {
      setLoadingSaved(false);
    }
  };

  const loadSavedTranscription = async (id: string) => {
    setLoadingSaved(true);
    try {
      const config = getAxiosConfig();
      const response = await axios.get(`${API_BASE_URL}/api/transcriptions/${id}`, config);
      if (response.data.success) {
        const doc: SavedTranscriptionDocument = response.data.data;
        const transcriptionData = doc.transcription_data;

        if (transcriptionData.transcription_type === 'phrases' && transcriptionData.phrases) {
          // Convert saved transcription to PhrasesApp's TranscriptionData format
          const loadedData: TranscriptionData = {
            phrases: transcriptionData.phrases,
            language: transcriptionData.language,
            audio_duration: transcriptionData.audio_duration,
            total_phrases: transcriptionData.total_phrases || transcriptionData.phrases.length,
            metadata: {
              filename: transcriptionData.metadata?.filename || 'Loaded Transcription',
              audio_path: '', // Will be set from S3
            },
          };

          setTranscriptionData(loadedData);
          setAudioDuration(transcriptionData.audio_duration);

          // Set audio URL using proxy endpoint
          if (doc.s3_metadata?.url) {
            const s3Url = encodeURIComponent(doc.s3_metadata.url);
            setAudioUrl(`${API_BASE_URL}/api/audio/s3-proxy?url=${s3Url}`);
          } else if (doc.s3_metadata?.key) {
            const s3Key = encodeURIComponent(doc.s3_metadata.key);
            setAudioUrl(`${API_BASE_URL}/api/audio/s3-proxy?key=${s3Key}`);
          }

          setHasChanges(false);
        }
      } else {
        alert(`Error: ${response.data.error}`);
      }
    } catch (error: any) {
      console.error('Error loading transcription:', error);
      alert(`Error: ${error.response?.data?.error || error.message}`);
    } finally {
      setLoadingSaved(false);
    }
  };

  const deleteSavedTranscription = async (id: string) => {
    const confirmed = window.confirm(
      'Are you sure you want to delete this transcription?\n\n' +
      'This action cannot be undone.'
    );
    
    if (!confirmed) return;

    try {
      const config = getAxiosConfig();
      const response = await axios.delete(`${API_BASE_URL}/api/transcriptions/${id}`, config);
      if (response.data.success) {
        alert('Transcription deleted successfully!');
        fetchSavedTranscriptions();
      } else {
        alert(`Error: ${response.data.error}`);
      }
    } catch (error: any) {
      console.error('Error deleting transcription:', error);
      alert(`Error: ${error.response?.data?.error || error.message}`);
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
        const data = response.data.data;
        // Ensure filename is set in metadata if not present
        if (!data.metadata?.filename && audioFile) {
          data.metadata = {
            ...data.metadata,
            filename: audioFile.name
          };
        }
        setTranscriptionData(data);
        if (data.metadata?.audio_path) {
          setAudioUrl(`${API_BASE_URL}${data.metadata.audio_path}`);
        }
        if (data.audio_duration && data.audio_duration > 0) {
          setAudioDuration(data.audio_duration);
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
    
    // Calculate duration from start and end times
    const startSeconds = timeToSeconds(editValues.start);
    const endSeconds = timeToSeconds(editValues.end);
    const duration = endSeconds - startSeconds;
    
    updatedPhrases[editingIndex] = {
      ...updatedPhrases[editingIndex],
      start: editValues.start,
      end: editValues.end,
      text: editValues.text,
      speaker: editValues.speaker,
      emotion: editValues.emotion,
      end_of_speech: editValues.end_of_speech,
      duration: duration,
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

    const file_name = transcriptionData.metadata?.filename || 'audio.mp3';
    
    // Generate numeric ID (use timestamp)
    const id = Date.now();

    // Transform phrases to annotations format
    const annotations = transcriptionData.phrases.map((phrase: Phrase) => ({
      start: phrase.start,
      end: phrase.end,
      Transcription: [phrase.text]
    }));

    // Create output in exact format and order
    const outputData = {
      id: id,
      file_name: file_name,
      annotations: annotations
    };

    const dataStr = JSON.stringify(outputData, null, 2);
    const dataBlob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(dataBlob);
    const link = document.createElement('a');
    link.href = url;
    
    // Get filename from metadata, sanitize it, and ensure .json extension
    const filename = file_name;
    // Remove invalid filename characters and ensure it ends with .json
    const sanitizedFilename = filename.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, '_');
    const finalFilename = sanitizedFilename.endsWith('.json') ? sanitizedFilename : `${sanitizedFilename}.json`;
    
    link.download = finalFilename;
    link.click();
  };

  const handleRename = () => {
    if (!newFilename.trim() || !transcriptionData) {
      alert('Please enter a valid filename');
      return;
    }

    setTranscriptionData({
      ...transcriptionData,
      metadata: {
        ...transcriptionData.metadata,
        filename: newFilename.trim()
      }
    });

    setIsRenaming(false);
    setNewFilename('');
  };

  const saveToDatabase = async () => {
    if (!transcriptionData) return;

    setSavingToDatabase(true);

    try {
      // Extract audio filename from audio_path
      const audioPath = transcriptionData.metadata?.audio_path || '';
      const audioFilename = audioPath.split('/').pop() || '';
      
      // Use renamed filename if available, otherwise use original
      const finalFilename = transcriptionData.metadata?.filename || audioFilename;

      // Prepare transcription data
      const transcriptionDataToSave = {
        phrases: transcriptionData.phrases,
        language: transcriptionData.language,
        audio_duration: transcriptionData.audio_duration,
        total_phrases: transcriptionData.total_phrases,
        reference_text: transcriptionData.reference_text,
        transcription_type: 'phrases',
        metadata: {
          ...transcriptionData.metadata,
          filename: finalFilename
        }
      };

      const userId = getUserId();
      if (!userId) {
        alert('User not authenticated. Please sign in again.');
        return;
      }

      const saveData = {
        audio_path: audioPath,
        audio_filename: audioFilename,
        transcription_data: transcriptionDataToSave,
        user_id: userId
      };

      const response = await axios.post(
        `${API_BASE_URL}/api/transcription/save-to-database`,
        saveData
      );

      if (response.data.success) {
        alert(`Successfully saved to database!`);
        fetchSavedTranscriptions(); // Refresh the saved transcriptions list
      } else {
        alert(`Error: ${response.data.error}`);
      }
    } catch (error: any) {
      console.error('Error saving to database:', error);
      alert(`Error: ${error.response?.data?.error || error.message}`);
    } finally {
      setSavingToDatabase(false);
    }
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
            Phrase-Level Transcription Module
          </h1>
          <p className="text-gray-600">Speaker diarization, emotion detection, and phrase-level editing</p>
        </div>

        {/* Upload Section */}
        {!transcriptionData && (
          <div className="bg-white rounded-lg shadow-xl mb-8 max-w-2xl mx-auto overflow-hidden">
            {/* Collapsible Header */}
            <button
              onClick={() => setIsUploadFormExpanded(!isUploadFormExpanded)}
              className="w-full p-8 flex items-center justify-between hover:bg-gray-50 transition-colors"
            >
              <h2 className="text-2xl font-semibold text-gray-800">Upload Audio File</h2>
              {isUploadFormExpanded ? (
                <ChevronUp className="h-6 w-6 text-gray-600" />
              ) : (
                <ChevronDown className="h-6 w-6 text-gray-600" />
              )}
            </button>
            
            {/* Collapsible Content */}
            <div className={`px-8 pb-8 transition-all duration-300 ease-in-out ${
              isUploadFormExpanded ? 'max-h-[2000px] opacity-100' : 'max-h-0 opacity-0 overflow-hidden'
            }`}>
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
          </div>
        )}

        {/* Saved Transcriptions Section */}
        {!transcriptionData && (
          <div className="max-w-7xl mx-auto mb-8">
            {loadingSaved ? (
              <div className="flex justify-center items-center py-8">
                <Loader2 className="h-8 w-8 animate-spin text-purple-600" />
              </div>
            ) : savedTranscriptions.length === 0 ? (
              <div className="text-center py-8 text-gray-500">
                <Database className="h-12 w-12 mx-auto mb-3 text-gray-400" />
                <p>No saved phrase-level transcriptions found</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {savedTranscriptions.map((transcription) => (
                  <div
                    key={transcription._id}
                    className="bg-gray-50 rounded-lg p-4 border border-gray-200 hover:border-purple-300 hover:shadow-md transition-all"
                  >
                    <div className="flex items-start justify-between mb-2">
                      <h3 className="font-semibold text-gray-800 text-sm truncate flex-1">
                        {transcription.filename || 'Untitled'}
                      </h3>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteSavedTranscription(transcription._id);
                        }}
                        className="ml-2 text-red-600 hover:text-red-800 p-1"
                        title="Delete"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                    <div className="text-xs text-gray-600 space-y-1 mb-3">
                      <div className="flex justify-between">
                        <span>Phrases:</span>
                        <span className="font-medium">{transcription.total_phrases}</span>
                      </div>
                      <div className="flex justify-between">
                        <span>Duration:</span>
                        <span className="font-medium">{transcription.audio_duration?.toFixed(2) || '0.00'}s</span>
                      </div>
                      <div className="flex justify-between">
                        <span>Language:</span>
                        <span className="font-medium">{transcription.language}</span>
                      </div>
                      <div className="flex justify-between">
                        <span>Created:</span>
                        <span className="font-medium">{new Date(transcription.created_at).toLocaleDateString()}</span>
                      </div>
                    </div>
                    <button
                      onClick={() => loadSavedTranscription(transcription._id)}
                      disabled={loadingSaved}
                      className="w-full bg-purple-600 hover:bg-purple-700 disabled:bg-gray-400 text-white font-semibold py-2 px-4 rounded-lg transition-colors flex items-center justify-center gap-2"
                    >
                      <FolderOpen className="h-4 w-4" />
                      Load Transcription
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Results Section */}
        {transcriptionData && (
          <div className="space-y-6">
            {/* Info Bar */}
            <div className="bg-white rounded-lg shadow-lg p-6">
              <div className="flex justify-between items-center flex-wrap gap-4">
                <div className="flex-1">
                  {isRenaming ? (
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={newFilename}
                        onChange={(e) => setNewFilename(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            handleRename();
                          } else if (e.key === 'Escape') {
                            setIsRenaming(false);
                            setNewFilename('');
                          }
                        }}
                        className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent text-lg font-semibold"
                        placeholder="Enter new filename"
                        autoFocus
                      />
                      <button
                        onClick={handleRename}
                        className="bg-green-600 hover:bg-green-700 text-white px-3 py-2 rounded-lg"
                      >
                        <Check className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => {
                          setIsRenaming(false);
                          setNewFilename('');
                        }}
                        className="bg-gray-600 hover:bg-gray-700 text-white px-3 py-2 rounded-lg"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  ) : (
                    <div>
                      <h2 className="text-2xl font-semibold text-gray-800">Transcription Results</h2>
                      {transcriptionData.metadata?.filename && (
                        <div className="flex items-center gap-2 mt-1">
                          <span className="text-sm text-gray-600">
                            File: {transcriptionData.metadata.filename}
                          </span>
                          <button
                            onClick={() => {
                              setNewFilename(transcriptionData.metadata?.filename || '');
                              setIsRenaming(true);
                            }}
                            className="text-purple-600 hover:text-purple-800"
                            title="Rename file"
                          >
                            <Edit className="h-4 w-4" />
                          </button>
                        </div>
                      )}
                    </div>
                  )}
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
                    onClick={saveToDatabase}
                    disabled={savingToDatabase}
                    className="bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-400 text-white font-semibold py-2 px-4 rounded-lg transition-colors flex items-center"
                  >
                    {savingToDatabase ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Saving...
                      </>
                    ) : (
                      <>
                        <Database className="h-4 w-4 mr-2" />
                        Save to Database
                      </>
                    )}
                  </button>
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

