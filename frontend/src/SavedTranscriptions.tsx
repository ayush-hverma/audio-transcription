import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import axios from 'axios';
import { Database, Play, Save, Edit2, Check, X, Loader2, ArrowLeft, Download, Trash2, Edit, ChevronLeft, ChevronRight, Search, ArrowUpDown, ArrowUp, ArrowDown, FolderOpen, Flag } from 'lucide-react';
import AudioWaveformPlayer, { AudioWaveformPlayerHandle } from './components/AudioWaveformPlayer';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || (import.meta.env.DEV ? 'http://localhost:5002' : '/api');

// Helper function to get user info from localStorage
const getUserInfo = (): { id: string | null; isAdmin: boolean } => {
  try {
    const userStr = localStorage.getItem('user');
    if (userStr) {
      const user = JSON.parse(userStr);
      return {
        id: user.sub || user.id || null, // Google OAuth uses 'sub' as the unique user ID
        isAdmin: user.is_admin || false
      };
    }
  } catch (error) {
    console.error('Error getting user info:', error);
  }
  return { id: null, isAdmin: false };
};

// Helper function to get axios config with user headers
const getAxiosConfig = () => {
  const { id, isAdmin } = getUserInfo();
  const headers: Record<string, string> = {};
  if (id) {
    headers['X-User-ID'] = id;
  }
  headers['X-Is-Admin'] = isAdmin ? 'true' : 'false';
  return { headers };
};

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
  status?: 'done' | 'pending' | 'flagged';
  is_flagged?: boolean;
  flag_reason?: string;
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
    metadata?: {
      filename?: string;
    };
    flag_reason?: string;
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
  const [allTranscriptions, setAllTranscriptions] = useState<TranscriptionSummary[]>([]);
  const [selectedTranscription, setSelectedTranscription] = useState<TranscriptionDocument | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage] = useState(20); // 20 items per page for table
  const [totalItems, setTotalItems] = useState(0);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [languageFilter, setLanguageFilter] = useState<string>('');
  const [transcriptionTypeFilter, setTranscriptionTypeFilter] = useState<string>('');
  const [dateFilter, setDateFilter] = useState<string>('');
  const [sortField, setSortField] = useState<'filename' | 'status' | 'created_at'>('created_at');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
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
  const [flagging, setFlagging] = useState<string | null>(null);
  const [showFlagDropdown, setShowFlagDropdown] = useState<string | null>(null);
  const [dropdownPosition, setDropdownPosition] = useState<{ top: number; right: number } | null>(null);
  const [isRenaming, setIsRenaming] = useState(false);
  const [newFilename, setNewFilename] = useState('');

  const playerRef = useRef<AudioWaveformPlayerHandle | null>(null);

  useEffect(() => {
    fetchTranscriptions();
  }, [currentPage]);

  const fetchTranscriptions = async () => {
    setLoading(true);
    try {
      const config = getAxiosConfig();
      // Fetch all transcriptions to filter and sort
      const response = await axios.get(
        `${API_BASE_URL}/api/transcriptions?limit=1000&skip=0`,
        config
      );
      if (response.data.success) {
        setAllTranscriptions(response.data.data.transcriptions || []);
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

  // Filter and sort transcriptions
  useEffect(() => {
    let filtered = [...allTranscriptions];

    // Apply search filter
    if (searchTerm) {
      const searchLower = searchTerm.toLowerCase();
      filtered = filtered.filter(t => 
        t.filename?.toLowerCase().includes(searchLower) ||
        (t.status && t.status.toLowerCase().includes(searchLower))
      );
    }

    // Apply status filter
    if (statusFilter) {
      filtered = filtered.filter(t => t.status === statusFilter);
    }

    // Apply language filter
    if (languageFilter) {
      filtered = filtered.filter(t => t.language === languageFilter);
    }

    // Apply transcription type filter
    if (transcriptionTypeFilter) {
      filtered = filtered.filter(t => t.transcription_type === transcriptionTypeFilter);
    }

    // Apply date filter
    if (dateFilter) {
      const filterDate = new Date(dateFilter);
      filtered = filtered.filter(t => {
        const transcriptionDate = new Date(t.created_at);
        return transcriptionDate.getFullYear() === filterDate.getFullYear() &&
               transcriptionDate.getMonth() === filterDate.getMonth() &&
               transcriptionDate.getDate() === filterDate.getDate();
      });
    }

    // Apply sorting
    filtered.sort((a, b) => {
      // First, sort by status (pending first, then done)
      const aStatus = a.status || 'pending';
      const bStatus = b.status || 'pending';
      
      // If statuses are different, pending comes first
      if (aStatus !== bStatus) {
        if (aStatus === 'pending') return -1;
        if (bStatus === 'pending') return 1;
      }
      
      // If statuses are the same (or both are done), apply secondary sort
      let aValue: any;
      let bValue: any;

      if (sortField === 'filename') {
        aValue = (a.filename || '').toLowerCase();
        bValue = (b.filename || '').toLowerCase();
      } else if (sortField === 'status') {
        // When sorting by status, we've already sorted by status above, so just use secondary sort by created_at
        aValue = new Date(a.created_at).getTime();
        bValue = new Date(b.created_at).getTime();
      } else if (sortField === 'created_at') {
        aValue = new Date(a.created_at).getTime();
        bValue = new Date(b.created_at).getTime();
      }

      // Apply secondary sort direction
      if (aValue < bValue) return sortDirection === 'asc' ? -1 : 1;
      if (aValue > bValue) return sortDirection === 'asc' ? 1 : -1;
      return 0;
    });

    setTotalItems(filtered.length);

    // Apply pagination
    const skip = (currentPage - 1) * itemsPerPage;
    const paginated = filtered.slice(skip, skip + itemsPerPage);
    setTranscriptions(paginated);
  }, [allTranscriptions, searchTerm, statusFilter, languageFilter, transcriptionTypeFilter, dateFilter, sortField, sortDirection, currentPage, itemsPerPage]);

  // Reset to page 1 when filters change
  useEffect(() => {
    setCurrentPage(1);
  }, [searchTerm, statusFilter, languageFilter, transcriptionTypeFilter, dateFilter, sortField, sortDirection]);

  const fetchTranscriptionDetails = async (id: string) => {
    setLoadingDetails(true);
    try {
      const config = getAxiosConfig();
      const response = await axios.get(`${API_BASE_URL}/api/transcriptions/${id}`, config);
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
      const config = getAxiosConfig();
      const response = await axios.put(
        `${API_BASE_URL}/api/transcriptions/${selectedTranscription._id}`,
        {
          transcription_data: selectedTranscription.transcription_data,
        },
        config
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

    const transcriptionData = selectedTranscription.transcription_data;
    const file_name = transcriptionData.metadata?.filename || 'audio.mp3';
    
    // Convert MongoDB _id to numeric ID (extract numeric part or use timestamp)
    let id: number;
    try {
      // Try to extract numeric part from _id, or use timestamp
      const idStr = selectedTranscription._id;
      // If _id is a MongoDB ObjectId, use timestamp part, otherwise try to parse
      if (idStr.length === 24) {
        // MongoDB ObjectId - extract timestamp (first 8 hex chars)
        id = parseInt(idStr.substring(0, 8), 16);
      } else {
        // Try to parse as number, or use current timestamp
        id = parseInt(idStr) || Date.now();
      }
    } catch {
      id = Date.now();
    }

    // Transform annotations based on transcription type
    let annotations: Array<{ start: string; end: string; Transcription: string[] }>;
    
    if (transcriptionData.transcription_type === 'words' && transcriptionData.words) {
      annotations = transcriptionData.words.map((word: Word) => ({
        start: word.start,
        end: word.end,
        Transcription: [word.word]
      }));
    } else if (transcriptionData.transcription_type === 'phrases' && transcriptionData.phrases) {
      annotations = transcriptionData.phrases.map((phrase: Phrase) => ({
        start: phrase.start,
        end: phrase.end,
        Transcription: [phrase.text]
      }));
    } else {
      annotations = [];
    }

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

  const handleRename = async () => {
    if (!newFilename.trim() || !selectedTranscription) {
      alert('Please enter a valid filename');
      return;
    }

    setSaving(true);
    try {
      // Update the transcription data with new filename
      const updatedTranscription = {
        ...selectedTranscription,
        transcription_data: {
          ...selectedTranscription.transcription_data,
          metadata: {
            ...(selectedTranscription.transcription_data.metadata || {}),
            filename: newFilename.trim()
          }
        }
      };

      const config = getAxiosConfig();
      const response = await axios.put(
        `${API_BASE_URL}/api/transcriptions/${selectedTranscription._id}`,
        {
          transcription_data: updatedTranscription.transcription_data,
        },
        config
      );

      if (response.data.success) {
        setSelectedTranscription(updatedTranscription);
        setIsRenaming(false);
        setNewFilename('');
        setHasChanges(false);
        // Refresh the list
        fetchTranscriptions();
        alert('Filename updated successfully!');
      } else {
        alert(`Error: ${response.data.error}`);
      }
    } catch (error: any) {
      console.error('Error renaming:', error);
      alert(`Error: ${error.response?.data?.error || error.message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleFlagTranscription = async (transcriptionId: string, currentFlagged: boolean, reason?: string) => {
    setFlagging(transcriptionId);
    setShowFlagDropdown(null);
    try {
      const config = getAxiosConfig();
      // If unflagging (currentFlagged is true), reason is not needed/cleared.
      // If flagging (currentFlagged is false), reason is required.
      const newFlaggedState = !currentFlagged;
      
      const response = await axios.post(
        `${API_BASE_URL}/api/transcriptions/${transcriptionId}/flag`,
        { 
          is_flagged: newFlaggedState,
          flag_reason: newFlaggedState ? reason : null
        },
        config
      );

      if (response.data.success) {
        // Reload data
        fetchTranscriptions();
        // If we are viewing this transcription, reload its details to update the flag status
        if (selectedTranscription && selectedTranscription._id === transcriptionId) {
          fetchTranscriptionDetails(transcriptionId);
        }
      } else {
        alert(`Error: ${response.data.error}`);
      }
    } catch (error: any) {
      console.error('Error flagging transcription:', error);
      alert(`Error: ${error.response?.data?.error || error.message}`);
    } finally {
      setFlagging(null);
    }
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
      const config = getAxiosConfig();
      const response = await axios.delete(`${API_BASE_URL}/api/transcriptions/${id}`, config);

      if (response.data.success) {
        alert('Transcription deleted successfully!');
        
        // If we're viewing the deleted transcription, go back to list
        if (selectedTranscription && selectedTranscription._id === id) {
          setSelectedTranscription(null);
          setHasChanges(false);
        }
        
        // Refresh the list
        fetchTranscriptions();
        // If we deleted the last item on the page, go to previous page
        if (transcriptions.length === 1 && currentPage > 1) {
          setCurrentPage(prev => prev - 1);
        }
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
                      className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent text-2xl font-bold"
                      placeholder="Enter new filename"
                      autoFocus
                    />
                    <button
                      onClick={handleRename}
                      disabled={saving}
                      className="bg-green-600 hover:bg-green-700 disabled:bg-gray-400 text-white px-3 py-2 rounded-lg"
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
                    <h1 className="text-4xl font-bold text-gray-800 mb-2 flex items-center gap-2">
                      {selectedTranscription.transcription_data.metadata?.filename || 'Saved Transcription'}
                      {getUserInfo().isAdmin && (
                        <button
                          onClick={() => {
                            setNewFilename(selectedTranscription.transcription_data.metadata?.filename || 'Untitled');
                            setIsRenaming(true);
                          }}
                          className="text-indigo-600 hover:text-indigo-800"
                          title="Rename file"
                        >
                          <Edit className="h-5 w-5" />
                        </button>
                      )}
                    </h1>
                    <div className="flex flex-wrap gap-2 mb-2">
                      <p className="text-gray-600">
                        Created: {new Date(selectedTranscription.created_at).toLocaleString()}
                      </p>
                      {/* Display flag reason badge if present in the document structure. Note: The flag reason is stored in the root document, not inside transcription_data, but let's check where we put it. 
                          Actually, in storage.py it's at root level. We need to access it from selectedTranscription directly.
                          Wait, selectedTranscription is TranscriptionDocument type. I need to update the interface.
                      */}
                      {(selectedTranscription as any).is_flagged && (
                        <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-red-100 text-red-800 border border-red-200">
                          <Flag className="h-4 w-4 mr-1 fill-current" />
                          Flagged: {(selectedTranscription as any).flag_reason || 'No reason provided'}
                        </span>
                      )}
                    </div>
                  </div>
                )}
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
                <div className="relative">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      if ((selectedTranscription as any).is_flagged) {
                        handleFlagTranscription(selectedTranscription._id, true);
                      } else {
                        if (showFlagDropdown === selectedTranscription._id) {
                          setShowFlagDropdown(null);
                        } else {
                          const rect = e.currentTarget.getBoundingClientRect();
                          setDropdownPosition({
                            top: rect.bottom + 5,
                            right: window.innerWidth - rect.right
                          });
                          setShowFlagDropdown(selectedTranscription._id);
                        }
                      }
                    }}
                    disabled={flagging === selectedTranscription._id}
                    className={`font-semibold py-2 px-4 rounded-lg transition-colors flex items-center gap-2 ${
                      (selectedTranscription as any).is_flagged
                        ? 'bg-red-100 text-red-600 hover:bg-red-200 border border-red-200'
                        : 'bg-white text-gray-600 hover:bg-gray-100 border border-gray-300'
                    }`}
                    title={(selectedTranscription as any).is_flagged ? "Unflag transcription" : "Flag transcription"}
                  >
                    {flagging === selectedTranscription._id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Flag className={`h-4 w-4 ${(selectedTranscription as any).is_flagged ? 'fill-current' : ''}`} />
                    )}
                    {(selectedTranscription as any).is_flagged ? 'Flagged' : 'Flag'}
                  </button>
                </div>
                {getUserInfo().isAdmin && (
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
                )}
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
            <div className="sticky top-0 z-50 bg-white rounded-lg shadow-lg p-6 mb-6">
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

        {/* Filter Controls */}
        <div className="mb-6 bg-white rounded-lg shadow-lg p-6">
          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 h-5 w-5" />
                <input
                  type="text"
                  placeholder="Search by filename..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                />
              </div>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
              >
                <option value="">All Status</option>
                <option value="done">Done</option>
                <option value="pending">Pending</option>
                <option value="flagged">Flagged</option>
              </select>
              <select
                value={transcriptionTypeFilter}
                onChange={(e) => setTranscriptionTypeFilter(e.target.value)}
                className="px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
              >
                <option value="">All Types</option>
                <option value="words">Words</option>
                <option value="phrases">Phrases</option>
              </select>
              <select
                value={languageFilter}
                onChange={(e) => setLanguageFilter(e.target.value)}
                className="px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
              >
                <option value="">All Languages</option>
                {Array.from(new Set(allTranscriptions.map(t => t.language).filter(Boolean))).sort().map(lang => (
                  <option key={lang} value={lang}>{lang}</option>
                ))}
              </select>
              <input
                type="date"
                value={dateFilter}
                onChange={(e) => setDateFilter(e.target.value)}
                className="px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
              />
            </div>
            {(searchTerm || statusFilter || languageFilter || transcriptionTypeFilter || dateFilter) && (
              <button
                onClick={() => {
                  setSearchTerm('');
                  setStatusFilter('');
                  setLanguageFilter('');
                  setTranscriptionTypeFilter('');
                  setDateFilter('');
                }}
                className="text-sm text-indigo-600 hover:text-indigo-800 flex items-center gap-1"
              >
                <X className="h-4 w-4" />
                Clear Filters
              </button>
            )}
          </div>
        </div>

        {loading ? (
          <div className="flex justify-center items-center py-12 bg-white rounded-lg shadow-lg">
            <Loader2 className="h-8 w-8 animate-spin text-indigo-600" />
          </div>
        ) : transcriptions.length === 0 ? (
          <div className="bg-white rounded-lg shadow-lg p-12 text-center">
            <Database className="h-16 w-16 text-gray-400 mx-auto mb-4" />
            <p className="text-gray-600 text-lg">No saved transcriptions found</p>
            <p className="text-gray-400 text-sm mt-2">
              {allTranscriptions.length === 0 
                ? 'Save a transcription to see it here'
                : 'No transcriptions match your filters'}
            </p>
          </div>
        ) : (
          <>
          <div className="bg-white rounded-lg shadow-lg overflow-hidden">
            {/* Table */}
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-100">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider w-16">
                      S.No.
                    </th>
                    <th 
                      className="px-4 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider cursor-pointer hover:bg-gray-200"
                      onClick={() => {
                        if (sortField === 'filename') {
                          setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
                        } else {
                          setSortField('filename');
                          setSortDirection('asc');
                        }
                      }}
                    >
                      <div className="flex items-center gap-2">
                        Filename
                        {sortField === 'filename' ? (
                          sortDirection === 'asc' ? <ArrowUp className="h-4 w-4" /> : <ArrowDown className="h-4 w-4" />
                        ) : (
                          <ArrowUpDown className="h-4 w-4 text-gray-400" />
                        )}
                      </div>
                    </th>
                    <th 
                      className="px-4 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider cursor-pointer hover:bg-gray-200"
                      onClick={() => {
                        if (sortField === 'status') {
                          setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
                        } else {
                          setSortField('status');
                          setSortDirection('asc');
                        }
                      }}
                    >
                      <div className="flex items-center gap-2">
                        Status
                        {sortField === 'status' ? (
                          sortDirection === 'asc' ? <ArrowUp className="h-4 w-4" /> : <ArrowDown className="h-4 w-4" />
                        ) : (
                          <ArrowUpDown className="h-4 w-4 text-gray-400" />
                        )}
                      </div>
                    </th>
                    <th 
                      className="px-4 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider cursor-pointer hover:bg-gray-200"
                      onClick={() => {
                        if (sortField === 'created_at') {
                          setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
                        } else {
                          setSortField('created_at');
                          setSortDirection('desc');
                        }
                      }}
                    >
                      <div className="flex items-center gap-2">
                        Created Date
                        {sortField === 'created_at' ? (
                          sortDirection === 'asc' ? <ArrowUp className="h-4 w-4" /> : <ArrowDown className="h-4 w-4" />
                        ) : (
                          <ArrowUpDown className="h-4 w-4 text-gray-400" />
                        )}
                      </div>
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                      Type
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                      Language
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {transcriptions.map((transcription, index) => {
                    const serialNumber = (currentPage - 1) * itemsPerPage + index + 1;
                    return (
                      <tr key={transcription._id} className="hover:bg-gray-50 cursor-pointer" onClick={() => fetchTranscriptionDetails(transcription._id)}>
                        <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-500">
                          {serialNumber}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          <div className="flex items-center">
                            <Database className="h-5 w-5 text-gray-400 mr-2" />
                            <span className="text-sm font-medium text-gray-900">
                              {transcription.filename || 'Untitled'}
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          <span
                            className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                              transcription.status === 'done'
                                ? 'bg-green-100 text-green-800'
                                : transcription.status === 'flagged'
                                ? 'bg-red-100 text-red-800'
                                : 'bg-yellow-100 text-yellow-800'
                            }`}
                          >
                            {transcription.status === 'done' ? 'Done' : transcription.status === 'flagged' ? 'Flagged' : 'Pending'}
                          </span>
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-500">
                          {new Date(transcription.created_at).toLocaleDateString()}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          <span className={`px-2 py-1 rounded-full text-xs font-medium capitalize ${
                            transcription.transcription_type === 'words'
                              ? 'bg-blue-100 text-blue-800'
                              : 'bg-purple-100 text-purple-800'
                          }`}>
                            {transcription.transcription_type}
                          </span>
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-500">
                          {transcription.language}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-sm font-medium" onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => fetchTranscriptionDetails(transcription._id)}
                              className="bg-indigo-600 hover:bg-indigo-700 text-white font-semibold py-2 px-4 rounded-lg transition-colors flex items-center gap-2"
                            >
                              <FolderOpen className="h-4 w-4" />
                              Load Transcription
                            </button>
                            <div className="relative">
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (transcription.is_flagged) {
                                    // If already flagged, unflag immediately
                                    handleFlagTranscription(transcription._id, true);
                                  } else {
                                    // If not flagged, toggle dropdown
                                    if (showFlagDropdown === transcription._id) {
                                      setShowFlagDropdown(null);
                                    } else {
                                      const rect = e.currentTarget.getBoundingClientRect();
                                      setDropdownPosition({
                                        top: rect.bottom + 5,
                                        right: window.innerWidth - rect.right
                                      });
                                      setShowFlagDropdown(transcription._id);
                                    }
                                  }
                                }}
                                disabled={flagging === transcription._id}
                                className={`font-semibold py-2 px-4 rounded-lg transition-colors flex items-center justify-center ${
                                  transcription.is_flagged
                                    ? 'bg-red-100 text-red-600 hover:bg-red-200'
                                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                                }`}
                                title={transcription.is_flagged ? "Unflag transcription" : "Flag transcription"}
                              >
                                {flagging === transcription._id ? (
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                  <Flag className={`h-4 w-4 ${transcription.is_flagged ? 'fill-current' : ''}`} />
                                )}
                              </button>
                            </div>
                            {getUserInfo().isAdmin && (
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
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
          
          {/* Pagination Controls */}
          {totalItems > itemsPerPage && (
            <div className="mt-8 flex items-center justify-between bg-white rounded-lg shadow-lg p-4">
              <div className="flex items-center gap-2 text-sm text-gray-600">
                <span>
                  Showing {((currentPage - 1) * itemsPerPage) + 1} to {Math.min(currentPage * itemsPerPage, totalItems)} of {totalItems} transcriptions
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                  disabled={currentPage === 1 || loading}
                  className="flex items-center gap-1 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  <ChevronLeft className="h-4 w-4" />
                  Previous
                </button>
                
                <div className="flex items-center gap-1">
                  {Array.from({ length: Math.ceil(totalItems / itemsPerPage) }, (_, i) => i + 1)
                    .filter(page => {
                      // Show first page, last page, current page, and pages around current
                      const totalPages = Math.ceil(totalItems / itemsPerPage);
                      return page === 1 || 
                             page === totalPages || 
                             (page >= currentPage - 1 && page <= currentPage + 1);
                    })
                    .map((page, index, array) => {
                      // Add ellipsis between non-consecutive pages
                      const prevPage = array[index - 1];
                      const showEllipsis = prevPage && page - prevPage > 1;
                      
                      return (
                        <div key={page} className="flex items-center gap-1">
                          {showEllipsis && (
                            <span className="px-2 text-gray-500">...</span>
                          )}
                          <button
                            onClick={() => setCurrentPage(page)}
                            disabled={loading}
                            className={`px-3 py-2 text-sm font-medium rounded-lg transition-colors ${
                              currentPage === page
                                ? 'bg-indigo-600 text-white'
                                : 'text-gray-700 bg-white border border-gray-300 hover:bg-gray-50'
                            } disabled:opacity-50 disabled:cursor-not-allowed`}
                          >
                            {page}
                          </button>
                        </div>
                      );
                    })}
                </div>
                
                <button
                  onClick={() => setCurrentPage(prev => Math.min(Math.ceil(totalItems / itemsPerPage), prev + 1))}
                  disabled={currentPage >= Math.ceil(totalItems / itemsPerPage) || loading}
                  className="flex items-center gap-1 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  Next
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}
          </>
        )}
      </div>

      {/* Fixed Flag Dropdown */}
      {showFlagDropdown && dropdownPosition && (
        <>
          <div className="fixed inset-0 z-[100]" onClick={() => setShowFlagDropdown(null)}></div>
          <div
            className="fixed w-64 bg-white rounded-lg shadow-xl border border-gray-200 z-[101] overflow-hidden"
            style={{
              top: dropdownPosition.top,
              right: dropdownPosition.right,
            }}
          >
            <div className="p-2 border-b border-gray-100 bg-gray-50 text-xs font-semibold text-gray-500 uppercase tracking-wider">
              Select Reason
            </div>
            <div className="py-1">
              {[
                "Transcribed Word not seperated",
                "Transcribed words repeated",
                "Missing transcribed words"
              ].map((reason) => (
                <button
                  key={reason}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleFlagTranscription(showFlagDropdown, false, reason);
                  }}
                  className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 hover:text-gray-900"
                >
                  {reason}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </main>
  );
}

export default SavedTranscriptions;

