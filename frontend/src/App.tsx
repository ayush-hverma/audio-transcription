import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import axios from 'axios';
import { Upload, Play, Download, Save, Edit2, Check, X, Loader2, Database, Edit, FolderOpen, Trash2, Plus, ChevronLeft, ChevronRight, Search, ArrowUpDown, ArrowUp, ArrowDown, Flag } from 'lucide-react';
import AudioWaveformPlayer, { AudioWaveformPlayerHandle } from './components/AudioWaveformPlayer';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;

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

// Helper function to get user_id (for backward compatibility)
const getUserId = (): string | null => {
  return getUserInfo().id;
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
  is_edited?: boolean;
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
    filename?: string;
    source_language?: string;
    audio_path?: string;
    flag_reason?: string;
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
  user_id?: string;
  assigned_user_id?: string;
  status?: 'done' | 'pending' | 'flagged';
  is_flagged?: boolean;
  flag_reason?: string;
}

interface SavedTranscriptionDocument {
  _id: string;
  transcription_data: {
    words?: Word[];
    phrases?: any[];
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

function App() {
  const { filename } = useParams<{ filename?: string }>();
  const navigate = useNavigate();
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
  const [selectedWordIndex, setSelectedWordIndex] = useState<number | null>(null);
  const [savingToDatabase, setSavingToDatabase] = useState(false);
  const [currentTranscriptionId, setCurrentTranscriptionId] = useState<string | null>(null);
  const [isUploadModalOpen, setIsUploadModalOpen] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [newFilename, setNewFilename] = useState('');
  const [savedTranscriptions, setSavedTranscriptions] = useState<SavedTranscriptionSummary[]>([]);
  const [allSavedTranscriptions, setAllSavedTranscriptions] = useState<SavedTranscriptionSummary[]>([]);
  const [loadingSaved, setLoadingSaved] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage] = useState(20); // 20 items per page for table
  const [totalItems, setTotalItems] = useState(0);
  const [isAddingWord, setIsAddingWord] = useState(false);
  const [newWordValues, setNewWordValues] = useState<{ start: string; end: string; word: string }>({
    start: '',
    end: '',
    word: '',
  });
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [languageFilter, setLanguageFilter] = useState<string>('');
  const [dateFilter, setDateFilter] = useState<string>('');
  const [sortField, setSortField] = useState<'filename' | 'status' | 'created_at'>('created_at');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const [flagging, setFlagging] = useState<string | null>(null);
  const [showFlagDropdown, setShowFlagDropdown] = useState<string | null>(null);
  const [dropdownPosition, setDropdownPosition] = useState<{ top: number; right: number } | null>(null);

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

  const secondsToTimeString = (seconds: number): string => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    const milliseconds = Math.floor((secs % 1) * 1000);
    const secsInt = Math.floor(secs);

    const pad = (value: number, digits: number) => value.toString().padStart(digits, '0');

    if (hours > 0) {
      return `${hours}:${pad(minutes, 2)}:${pad(secsInt, 2)}.${pad(milliseconds, 3)}`;
    }
    return `${minutes}:${pad(secsInt, 2)}.${pad(milliseconds, 3)}`;
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
    if (!filename) {
      fetchSavedTranscriptions();
    }
  }, [currentPage, filename]);

  // Load transcription when filename is in URL
  useEffect(() => {
    if (filename) {
      const decodedFilename = decodeURIComponent(filename);
      loadTranscriptionByFilename(decodedFilename);
    } else {
      // Clear transcription data when navigating away from detail view
      setTranscriptionData(null);
      setAudioUrl('');
      setCurrentTranscriptionId(null);
      setHasChanges(false);
    }
  }, [filename]);

  const fetchSavedTranscriptions = async () => {
    setLoadingSaved(true);
    try {
      const config = getAxiosConfig();
      // Fetch all transcriptions first to filter and get total count
      const response = await axios.get(
        `${API_BASE_URL}/api/transcriptions?limit=1000&skip=0`,
        config
      );
      if (response.data.success) {
        const allTranscriptions = response.data.data.transcriptions || [];
        // Filter only 'words' type transcriptions
        const wordsTranscriptions = allTranscriptions.filter(
          (t: SavedTranscriptionSummary) => t.transcription_type === 'words'
        );
        setAllSavedTranscriptions(wordsTranscriptions);
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

  // Filter and sort transcriptions
  useEffect(() => {
    let filtered = [...allSavedTranscriptions];

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
    setSavedTranscriptions(paginated);
  }, [allSavedTranscriptions, searchTerm, statusFilter, languageFilter, dateFilter, sortField, sortDirection, currentPage, itemsPerPage]);

  // Reset to page 1 when filters change
  useEffect(() => {
    setCurrentPage(1);
  }, [searchTerm, statusFilter, languageFilter, dateFilter, sortField, sortDirection]);

  const loadTranscriptionByFilename = async (filenameToLoad: string) => {
    setLoadingSaved(true);
    try {
      const config = getAxiosConfig();
      // Fetch all transcriptions to find by filename
      const response = await axios.get(
        `${API_BASE_URL}/api/transcriptions?limit=1000&skip=0`,
        config
      );
      if (response.data.success) {
        const allTranscriptions = response.data.data.transcriptions || [];
        // Find transcription by filename
        const transcription = allTranscriptions.find(
          (t: SavedTranscriptionSummary) => t.filename === filenameToLoad && t.transcription_type === 'words'
        );
        
        if (transcription) {
          // Load the full transcription details
          const detailResponse = await axios.get(`${API_BASE_URL}/api/transcriptions/${transcription._id}`, config);
          if (detailResponse.data.success) {
            const doc: SavedTranscriptionDocument = detailResponse.data.data;
            const transcriptionData = doc.transcription_data;

            if (transcriptionData.transcription_type === 'words' && transcriptionData.words) {
              // Convert saved transcription to App's TranscriptionData format
              const loadedData: TranscriptionData = {
                words: transcriptionData.words,
                language: transcriptionData.language,
                audio_path: '', // Will be set from S3
                audio_duration: transcriptionData.audio_duration,
                total_words: transcriptionData.total_words || transcriptionData.words.length,
                metadata: {
                  filename: transcriptionData.metadata?.filename || 'Loaded Transcription',
                  audio_path: '', // Will be set from S3
                },
              };

              setTranscriptionData(loadedData);
              setCurrentTranscriptionId(doc._id);

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
            alert(`Error: ${detailResponse.data.error}`);
            navigate('/word-level');
          }
        } else {
          alert(`Transcription with filename "${filenameToLoad}" not found`);
          navigate('/word-level');
        }
      } else {
        alert(`Error: ${response.data.error}`);
        navigate('/word-level');
      }
    } catch (error: any) {
      console.error('Error loading transcription:', error);
      alert(`Error: ${error.response?.data?.error || error.message}`);
      navigate('/word-level');
    } finally {
      setLoadingSaved(false);
    }
  };

  const loadSavedTranscription = async (_id: string, transcriptionFilename?: string) => {
    // Navigate to the transcription detail route
    const filenameToUse = transcriptionFilename || 'transcription';
    const encodedFilename = encodeURIComponent(filenameToUse);
    navigate(`/word-level/transcription/${encodedFilename}`);
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
        // If we deleted the last item on the page, go to previous page
        if (savedTranscriptions.length === 1 && currentPage > 1) {
          setCurrentPage(prev => prev - 1);
        } else {
          fetchSavedTranscriptions();
        }
      } else {
        alert(`Error: ${response.data.error}`);
      }
    } catch (error: any) {
      console.error('Error deleting transcription:', error);
      alert(`Error: ${error.response?.data?.error || error.message}`);
    }
  };

  const handleFlagTranscription = async (transcriptionId: string, currentFlagged: boolean, reason?: string) => {
    setFlagging(transcriptionId);
    setShowFlagDropdown(null);
    try {
      const config = getAxiosConfig();
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
        fetchSavedTranscriptions(); // Reload data
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
        const data = response.data.data;
        // Ensure filename is set in metadata if not present
        if (!data.metadata?.filename && audioFile) {
          data.metadata = {
            ...data.metadata,
            filename: audioFile.name
          };
        }
        setTranscriptionData(data);
        setCurrentTranscriptionId(null); // New transcription, no ID yet
        if (data.metadata?.audio_path) {
          setAudioUrl(`${API_BASE_URL}${data.metadata.audio_path}`);
        }
        setIsUploadModalOpen(false); // Close modal after successful transcription
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
    setSelectedWordIndex(index);
    playerRef.current.playSegment(startTime, endTime);
  };

  const handleWordTimeUpdate = useCallback(
    (index: number, start: number, end: number) => {
      if (!transcriptionData) return;

      const updatedWords = [...transcriptionData.words];
      updatedWords[index] = {
        ...updatedWords[index],
        start: secondsToTimeString(start),
        end: secondsToTimeString(end),
        duration: end - start,
        is_edited: true, // Mark as edited when timings are changed
      };

      setTranscriptionData({
        ...transcriptionData,
        words: updatedWords,
      });

      setHasChanges(true);
    },
    [transcriptionData],
  );

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
    // Keep the word highlighted at the paused timestamp
    if (!transcriptionData || wordTimings.length === 0 || !playerRef.current) {
      return;
    }

    const currentTime = playerRef.current.getCurrentTime();
    let pausedIndex: number | null = null;
    
    for (let i = 0; i < wordTimings.length; i += 1) {
      const timing = wordTimings[i];
      if (currentTime >= timing.start && currentTime <= timing.end) {
        pausedIndex = i;
        break;
      }
    }

    // Set the current playing index to the word at the paused timestamp
    // This will keep it highlighted even when paused
    setCurrentPlayingIndex(pausedIndex);
  }, [transcriptionData, wordTimings]);

  const startEdit = (index: number) => {
    const word = transcriptionData!.words[index];
    setEditingIndex(index);
    setEditValues({ start: word.start, end: word.end, word: word.word });
  };

  const cancelEdit = () => {
    setEditingIndex(null);
    setEditValues({ start: '', end: '', word: '' });
  };

  const startAddWord = () => {
    setIsAddingWord(true);
    setNewWordValues({ start: '', end: '', word: '' });
  };

  const cancelAddWord = () => {
    setIsAddingWord(false);
    setNewWordValues({ start: '', end: '', word: '' });
  };

  const addWord = () => {
    if (!transcriptionData) return;

    const startTime = newWordValues.start.trim();
    const endTime = newWordValues.end.trim();
    const wordText = newWordValues.word.trim();

    if (!startTime || !endTime || !wordText) {
      alert('Please fill in all fields (word, start time, end time)');
      return;
    }

    // Validate time format and values
    const startSeconds = timeToSeconds(startTime);
    const endSeconds = timeToSeconds(endTime);

    if (isNaN(startSeconds) || isNaN(endSeconds)) {
      alert('Invalid time format. Please use format: MM:SS.mmm or H:MM:SS.mmm');
      return;
    }

    if (startSeconds >= endSeconds) {
      alert('Start time must be less than end time');
      return;
    }

    if (startSeconds < 0 || endSeconds > transcriptionData.audio_duration) {
      alert(`Times must be between 0 and ${transcriptionData.audio_duration.toFixed(3)} seconds`);
      return;
    }

    // Create new word
    const newWord: Word = {
      start: startTime,
      end: endTime,
      word: wordText,
      duration: endSeconds - startSeconds,
      language: transcriptionData.language,
    };

    // Insert word at the correct position based on start time
    const updatedWords = [...transcriptionData.words];
    let insertIndex = updatedWords.length;
    
    for (let i = 0; i < updatedWords.length; i++) {
      const wordStart = timeToSeconds(updatedWords[i].start);
      if (startSeconds < wordStart) {
        insertIndex = i;
        break;
      }
    }

    updatedWords.splice(insertIndex, 0, newWord);

    setTranscriptionData({
      ...transcriptionData,
      words: updatedWords,
      total_words: updatedWords.length,
    });

    setIsAddingWord(false);
    setNewWordValues({ start: '', end: '', word: '' });
    setHasChanges(true);
  };

  const deleteWord = (index: number) => {
    if (!transcriptionData) return;

    const word = transcriptionData.words[index];
    const confirmed = window.confirm(
      `Are you sure you want to delete the word "${word.word}"?\n\n` +
      `Time: ${word.start} - ${word.end}\n\n` +
      'This action cannot be undone.'
    );

    if (!confirmed) return;

    const updatedWords = transcriptionData.words.filter((_, i) => i !== index);

    // Clear selection/editing if the deleted word was selected/being edited
    if (selectedWordIndex === index) {
      setSelectedWordIndex(null);
    } else if (selectedWordIndex !== null && selectedWordIndex > index) {
      // Adjust selected index if a word before it was deleted
      setSelectedWordIndex(selectedWordIndex - 1);
    }

    if (editingIndex === index) {
      setEditingIndex(null);
      setEditValues({ start: '', end: '', word: '' });
    } else if (editingIndex !== null && editingIndex > index) {
      // Adjust editing index if a word before it was deleted
      setEditingIndex(editingIndex - 1);
    }

    if (currentPlayingIndex === index) {
      setCurrentPlayingIndex(null);
    } else if (currentPlayingIndex !== null && currentPlayingIndex > index) {
      // Adjust playing index if a word before it was deleted
      setCurrentPlayingIndex(currentPlayingIndex - 1);
    }

    setTranscriptionData({
      ...transcriptionData,
      words: updatedWords,
      total_words: updatedWords.length,
    });

    setHasChanges(true);
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
      is_edited: true, // Mark as edited
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

    setSavingToDatabase(true);

    try {
      // Extract audio filename from audio_path
      const audioPath = transcriptionData.metadata?.audio_path || transcriptionData.audio_path || '';
      const audioFilename = audioPath.split('/').pop() || '';
      
      // Use renamed filename if available, otherwise use original
      const finalFilename = transcriptionData.metadata?.filename || audioFilename;

      // Prepare transcription data
      const transcriptionDataToSave = {
        words: transcriptionData.words,
        language: transcriptionData.language,
        audio_duration: transcriptionData.audio_duration,
        total_words: transcriptionData.total_words,
        reference_text: transcriptionData.reference_text,
        has_reference: transcriptionData.has_reference,
        transcription_type: 'words',
        metadata: {
          ...transcriptionData.metadata,
          filename: finalFilename
        }
      };

      const userId = getUserId(); // Optional, for tracking purposes

      // If we have a current transcription ID, update it; otherwise create a new one
      if (currentTranscriptionId) {
        // Update existing transcription
        const config = getAxiosConfig();
        const updateData: any = { transcription_data: transcriptionDataToSave };
        // Include user_id to mark who saved the changes
        if (userId) {
          updateData.user_id = userId;
        }
        const response = await axios.put(
          `${API_BASE_URL}/api/transcriptions/${currentTranscriptionId}`,
          updateData,
          config
        );

        if (response.data.success) {
          alert('Changes saved successfully to database!');
          setHasChanges(false);
          fetchSavedTranscriptions(); // Refresh the saved transcriptions list
        } else {
          alert(`Error: ${response.data.error}`);
        }
      } else {
        // Create new transcription (user_id is optional)
        const saveData: any = {
          audio_path: audioPath,
          audio_filename: audioFilename,
          transcription_data: transcriptionDataToSave
        };
        if (userId) {
          saveData.user_id = userId;
        }

        const response = await axios.post(
          `${API_BASE_URL}/api/transcription/save-to-database`,
          saveData
        );

        if (response.data.success) {
          // Store the new transcription ID if returned
          if (response.data.data?._id) {
            setCurrentTranscriptionId(response.data.data._id);
          }
          alert('Changes saved successfully to database!');
          setHasChanges(false);
          fetchSavedTranscriptions(); // Refresh the saved transcriptions list
        } else {
          alert(`Error: ${response.data.error}`);
        }
      }
    } catch (error: any) {
      console.error('Error saving:', error);
      alert(`Error: ${error.response?.data?.error || error.message}`);
    } finally {
      setSavingToDatabase(false);
    }
  };

  const downloadTranscription = () => {
    if (!transcriptionData) return;

    const file_name = transcriptionData.metadata?.filename || 'audio.mp3';
    
    // Generate numeric ID (use timestamp)
    const id = Date.now();

    // Transform words to annotations format
    const annotations = transcriptionData.words.map((word: Word) => ({
      start: word.start,
      end: word.end,
      Transcription: [word.word]
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
      const audioPath = transcriptionData.metadata?.audio_path || transcriptionData.audio_path || '';
      const audioFilename = audioPath.split('/').pop() || '';
      
      // Use renamed filename if available, otherwise use original
      const finalFilename = transcriptionData.metadata?.filename || audioFilename;

      // Prepare transcription data
      const transcriptionDataToSave = {
        words: transcriptionData.words,
        language: transcriptionData.language,
        audio_duration: transcriptionData.audio_duration,
        total_words: transcriptionData.total_words,
        reference_text: transcriptionData.reference_text,
        has_reference: transcriptionData.has_reference,
        transcription_type: 'words',
        metadata: {
          ...transcriptionData.metadata,
          filename: finalFilename
        }
      };

      const userId = getUserId(); // Optional, for tracking purposes

      const saveData: any = {
        audio_path: audioPath,
        audio_filename: audioFilename,
        transcription_data: transcriptionDataToSave
      };
      if (userId) {
        saveData.user_id = userId;
      }

      const response = await axios.post(
        `${API_BASE_URL}/api/transcription/save-to-database`,
        saveData
      );

      if (response.data.success) {
        // Store the new transcription ID if returned
        if (response.data.data?._id) {
          setCurrentTranscriptionId(response.data.data._id);
        }
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

  const matchesReference = (word: string): boolean | null => {
    if (!referenceText) return null;

    // Simple word matching (can be improved with fuzzy matching)
    const refWords = referenceText.split(/\s+/);
    return refWords.includes(word.replace(/<[^>]*>/g, '').trim());
  };

  const getWordClassName = (index: number, word: string): string => {
    if (!transcriptionData) return '';
    
    const wordObj = transcriptionData.words[index];
    const isEdited = wordObj?.is_edited === true;
    
    let classes = 'inline-block px-3 py-2 m-1 rounded border-2 cursor-pointer transition-all duration-200 hover:shadow-lg';

    // Edited words get special highlighting (highest priority)
    if (isEdited) {
      classes += ' word-edited';
    } else if (currentPlayingIndex === index) {
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
        <div className="flex items-center justify-between mb-8">
          <div className="text-center flex-1">
            <h1 className="text-4xl font-bold text-gray-800 mb-2">
              Word-Level Transcription Module
            </h1>
            <p className="text-gray-600">Upload audio, transcribe, and edit word-level timestamps</p>
          </div>
          {!transcriptionData && getUserInfo().isAdmin && (
            <button
              onClick={() => setIsUploadModalOpen(true)}
              className="ml-4 bg-blue-600 hover:bg-blue-700 text-white font-semibold py-2 px-4 rounded-lg transition-colors flex items-center gap-2"
            >
              <Upload className="h-5 w-5" />
              Upload Audio
            </button>
          )}
        </div>

        {/* Upload Modal */}
        {isUploadModalOpen && getUserInfo().isAdmin && (
          <div 
            className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
            onClick={(e) => {
              if (e.target === e.currentTarget) {
                setIsUploadModalOpen(false);
              }
            }}
          >
            <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
              {/* Modal Header */}
              <div className="sticky top-0 bg-white border-b border-gray-200 px-8 py-4 flex items-center justify-between">
                <h2 className="text-2xl font-semibold text-gray-800">Upload Audio File</h2>
                <button
                  onClick={() => setIsUploadModalOpen(false)}
                  className="text-gray-500 hover:text-gray-700"
                >
                  <X className="h-6 w-6" />
                </button>
              </div>
              
              {/* Modal Content */}
              <div className="px-8 pb-8 mt-4">
            {/* Audio File Upload and Reference Text Side by Side */}
            <div className="mb-6 grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Audio File Upload */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Audio File *
                </label>
                <div className="border-2 border-dashed border-gray-300 rounded-lg p-4 text-center hover:border-blue-500 transition-colors">
                  <input
                    type="file"
                    accept=".mp3,.wav,.m4a,.ogg,.flac,.aac"
                    onChange={handleAudioFileChange}
                    className="hidden"
                    id="audio-upload"
                  />
                  <label htmlFor="audio-upload" className="cursor-pointer">
                    <Upload className="mx-auto h-8 w-8 text-gray-400 mb-2" />
                    <p className="text-sm text-gray-600">
                      {audioFile ? audioFile.name : 'Click to upload audio file'}
                    </p>
                    <p className="text-xs text-gray-400 mt-1">MP3, WAV, M4A, OGG, FLAC, AAC</p>
                  </label>
                </div>
              </div>

              {/* Reference Text */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Reference Text (Optional)
                </label>
                <div className="border-2 border-dashed border-gray-300 rounded-lg p-4 text-center hover:border-blue-500 transition-colors">
                  <input
                    type="file"
                    accept=".txt"
                    onChange={handleReferenceFileChange}
                    className="hidden"
                    id="reference-upload"
                  />
                  <label htmlFor="reference-upload" className="cursor-pointer">
                    <Upload className="mx-auto h-8 w-8 text-gray-400 mb-2" />
                    <p className="text-sm text-gray-600">
                      {referenceFile ? referenceFile.name : 'Click to upload reference file'}
                    </p>
                    <p className="text-xs text-gray-400 mt-1">TXT</p>
                  </label>
                </div>
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
            </div>
          </div>
        )}

        <div className="max-w-7xl mx-auto mb-4">
          <h2 className="text-2xl font-bold text-gray-800 mb-4">Saved Data</h2>

          {/* Saved Transcriptions Table Section */}
        {!transcriptionData && (
            <div className="bg-white rounded-lg shadow-lg p-6">
              {/* Filter Controls */}
              <div className="mb-6 space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 h-5 w-5" />
                    <input
                      type="text"
                      placeholder="Search by filename..."
                      value={searchTerm}
                      onChange={(e) => setSearchTerm(e.target.value)}
                      className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    />
                  </div>
                  <select
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value)}
                    className="px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  >
                    <option value="">All Status</option>
                    <option value="done">Done</option>
                    <option value="pending">Pending</option>
                    <option value="flagged">Flagged</option>
                  </select>
                  <select
                    value={languageFilter}
                    onChange={(e) => setLanguageFilter(e.target.value)}
                    className="px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  >
                    <option value="">All Languages</option>
                    {Array.from(new Set(allSavedTranscriptions.map(t => t.language).filter(Boolean))).sort().map(lang => (
                      <option key={lang} value={lang}>{lang}</option>
                    ))}
                  </select>
                  <input
                    type="date"
                    value={dateFilter}
                    onChange={(e) => setDateFilter(e.target.value)}
                    className="px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
                {(searchTerm || statusFilter || languageFilter || dateFilter) && (
                  <button
                    onClick={() => {
                      setSearchTerm('');
                      setStatusFilter('');
                      setLanguageFilter('');
                      setDateFilter('');
                    }}
                    className="text-sm text-blue-600 hover:text-blue-800 flex items-center gap-1"
                  >
                    <X className="h-4 w-4" />
                    Clear Filters
                  </button>
                )}
              </div>

            {loadingSaved ? (
                <div className="flex justify-center items-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
              </div>
            ) : savedTranscriptions.length === 0 ? (
                <div className="text-center py-12 text-gray-500">
                  <Database className="h-16 w-16 mx-auto mb-4 text-gray-400" />
                  <p className="text-lg">No transcriptions found</p>
                  <p className="text-sm text-gray-400 mt-2">
                    {allSavedTranscriptions.length === 0 
                      ? 'No assigned word-level transcriptions found'
                      : 'No transcriptions match your filters'}
                  </p>
              </div>
            ) : (
              <>
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
                            Language
                          </th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                            Actions
                          </th>
                        </tr>
                      </thead>
                      <tbody className="bg-white divide-y divide-gray-200">
                        {savedTranscriptions.map((transcription, index) => {
                          const serialNumber = (currentPage - 1) * itemsPerPage + index + 1;
                          return (
                            <tr key={transcription._id} className="hover:bg-gray-50">
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
                              <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-500">
                                {transcription.language}
                              </td>
                              <td className="px-4 py-3 whitespace-nowrap text-sm font-medium">
                                <div className="flex items-center gap-2">
                                  <button
                                    onClick={() => loadSavedTranscription(transcription._id, transcription.filename)}
                                    disabled={loadingSaved}
                                    className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white font-semibold py-2 px-4 rounded-lg transition-colors flex items-center gap-2"
                                  >
                                    <FolderOpen className="h-4 w-4" />
                                    Load Transcription
                                  </button>
                                  <div className="relative">
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        if (transcription.is_flagged) {
                                          handleFlagTranscription(transcription._id, true);
                                        } else {
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
                                        deleteSavedTranscription(transcription._id);
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
              
              {/* Pagination Controls */}
              {totalItems > itemsPerPage && (
                    <div className="mt-6 flex items-center justify-between border-t border-gray-200 pt-4">
                      <div className="flex items-center text-sm text-gray-700">
                      Showing {((currentPage - 1) * itemsPerPage) + 1} to {Math.min(currentPage * itemsPerPage, totalItems)} of {totalItems} transcriptions
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                      disabled={currentPage === 1 || loadingSaved}
                          className="flex items-center gap-1 px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <ChevronLeft className="h-4 w-4" />
                      Previous
                    </button>
                    
                    <div className="flex items-center gap-1">
                      {Array.from({ length: Math.ceil(totalItems / itemsPerPage) }, (_, i) => i + 1)
                        .filter(page => {
                          const totalPages = Math.ceil(totalItems / itemsPerPage);
                          return page === 1 || 
                                 page === totalPages || 
                                 (page >= currentPage - 1 && page <= currentPage + 1);
                        })
                        .map((page, index, array) => {
                          const prevPage = array[index - 1];
                          const showEllipsis = prevPage && page - prevPage > 1;
                          
                          return (
                            <div key={page} className="flex items-center gap-1">
                              {showEllipsis && (
                                <span className="px-2 text-gray-500">...</span>
                              )}
                              <button
                                onClick={() => setCurrentPage(page)}
                                disabled={loadingSaved}
                                className={`px-3 py-2 text-sm font-medium rounded-lg transition-colors ${
                                  currentPage === page
                                    ? 'bg-blue-600 text-white'
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
                      disabled={currentPage >= Math.ceil(totalItems / itemsPerPage) || loadingSaved}
                          className="flex items-center gap-1 px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
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
        )}
        </div>

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
                        className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-lg font-semibold"
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
                      <div className="flex flex-col gap-1 mt-1">
                        {transcriptionData.metadata?.filename && (
                          <div className="flex items-center gap-2">
                            <span className="text-sm text-gray-600">
                              File: {transcriptionData.metadata.filename}
                            </span>
                            {getUserInfo().isAdmin && (
                              <button
                                onClick={() => {
                                  setNewFilename(transcriptionData.metadata?.filename || '');
                                  setIsRenaming(true);
                                }}
                                className="text-blue-600 hover:text-blue-800"
                                title="Rename file"
                              >
                                <Edit className="h-4 w-4" />
                              </button>
                            )}
                          </div>
                        )}
                        
                        {/* Display flag reason if available from saved data */}
                        {(() => {
                          // We need to find the saved transcription record to get the flag reason
                          // since it's not part of transcriptionData structure usually
                          const savedRecord = allSavedTranscriptions.find(t => 
                            t.filename === transcriptionData.metadata?.filename || 
                            t._id === currentTranscriptionId
                          );
                          
                          if (savedRecord && (savedRecord as any).is_flagged) {
                            return (
                              <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-red-100 text-red-800 border border-red-200 self-start">
                                <Flag className="h-4 w-4 mr-1 fill-current" />
                                Flagged: {(savedRecord as any).flag_reason || 'No reason provided'}
                              </span>
                            );
                          }
                          return null;
                        })()}
                      </div>
                    </div>
                  )}
                </div>
                <div className="flex gap-2">
                  {hasChanges && (
                    <button
                      onClick={saveChanges}
                      disabled={savingToDatabase}
                      className="bg-green-600 hover:bg-green-700 disabled:bg-gray-400 text-white font-semibold py-2 px-4 rounded-lg transition-colors flex items-center"
                    >
                      {savingToDatabase ? (
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
                  {/* <button
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
                  </button> */}
                  <button
                    onClick={downloadTranscription}
                    className="bg-blue-600 hover:bg-blue-700 text-white font-semibold py-2 px-4 rounded-lg transition-colors flex items-center"
                  >
                    <Download className="h-4 w-4 mr-2" />
                    Download
                  </button>
                  {currentTranscriptionId && (
                    <div className="relative">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          const savedRecord = allSavedTranscriptions.find(t => t._id === currentTranscriptionId);
                          const isFlagged = savedRecord?.is_flagged || false;
                          
                          if (isFlagged) {
                            handleFlagTranscription(currentTranscriptionId, true);
                          } else {
                            if (showFlagDropdown === currentTranscriptionId) {
                              setShowFlagDropdown(null);
                            } else {
                              const rect = e.currentTarget.getBoundingClientRect();
                              setDropdownPosition({
                                top: rect.bottom + 5,
                                right: window.innerWidth - rect.right
                              });
                              setShowFlagDropdown(currentTranscriptionId);
                            }
                          }
                        }}
                        disabled={flagging === currentTranscriptionId}
                        className={`font-semibold py-2 px-4 rounded-lg transition-colors flex items-center gap-2 ${
                           (allSavedTranscriptions.find(t => t._id === currentTranscriptionId)?.is_flagged)
                            ? 'bg-red-100 text-red-600 hover:bg-red-200 border border-red-200'
                            : 'bg-white text-gray-600 hover:bg-gray-100 border border-gray-300'
                        }`}
                        title={(allSavedTranscriptions.find(t => t._id === currentTranscriptionId)?.is_flagged) ? "Unflag transcription" : "Flag transcription"}
                      >
                        {flagging === currentTranscriptionId ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Flag className={`h-4 w-4 ${(allSavedTranscriptions.find(t => t._id === currentTranscriptionId)?.is_flagged) ? 'fill-current' : ''}`} />
                        )}
                        {(allSavedTranscriptions.find(t => t._id === currentTranscriptionId)?.is_flagged) ? 'Flagged' : 'Flag'}
                      </button>
                    </div>
                  )}
                  <button
                    onClick={() => {
                      if (hasChanges) {
                        const confirmReset = window.confirm('Discard changes and go back?');
                        if (!confirmReset) return;
                      }
                      navigate('/word-level');
                    }}
                    className="bg-gray-600 hover:bg-gray-700 text-white font-semibold py-2 px-4 rounded-lg transition-colors"
                  >
                    Close
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
              <div className="mt-4 flex gap-4 text-sm flex-wrap">
                {referenceText && (
                  <>
                    <div className="flex items-center">
                      <div className="w-4 h-4 bg-green-200 border-2 border-green-400 rounded mr-2"></div>
                      <span>Correct</span>
                    </div>
                    <div className="flex items-center">
                      <div className="w-4 h-4 bg-yellow-200 border-2 border-yellow-400 rounded mr-2"></div>
                      <span>Incorrect</span>
                    </div>
                  </>
                )}
                <div className="flex items-center">
                  <div className="w-4 h-4 bg-purple-200 border-2 border-purple-500 rounded mr-2 relative">
                    <span className="absolute top-0 right-0 text-[0.5rem] text-purple-600">✎</span>
                  </div>
                  <span>Edited</span>
                </div>
                <div className="flex items-center">
                  <div className="w-4 h-4 bg-blue-300 border-2 border-blue-500 rounded mr-2"></div>
                  <span>Playing</span>
                </div>
              </div>
            </div>

            {/* Audio Player */}
            <div className="sticky top-0 z-50 bg-white rounded-lg shadow-lg p-6">
              <h3 className="text-lg font-semibold mb-3 text-gray-800">Audio Player</h3>
              <AudioWaveformPlayer
                ref={playerRef}
                audioUrl={audioUrl}
                onTimeUpdate={handlePlayerTimeUpdate}
                onEnded={() => {
                  setCurrentPlayingIndex(null);
                  setSelectedWordIndex(null);
                }}
                onPause={handlePlayerPause}
                selectedWord={
                  selectedWordIndex !== null && transcriptionData
                    ? {
                        word: transcriptionData.words[selectedWordIndex].word,
                        start: timeToSeconds(transcriptionData.words[selectedWordIndex].start),
                        end: timeToSeconds(transcriptionData.words[selectedWordIndex].end),
                        index: selectedWordIndex,
                      }
                    : null
                }
                onWordTimeUpdate={handleWordTimeUpdate}
                onUnselectWord={() => setSelectedWordIndex(null)}
              />
            </div>

            {/* Words Grid */}
            <div className="bg-white rounded-lg shadow-lg p-6">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-xl font-semibold text-gray-800">Transcribed Words</h3>
                <button
                  onClick={startAddWord}
                  className="bg-green-600 hover:bg-green-700 text-white font-semibold py-2 px-4 rounded-lg transition-colors flex items-center gap-2"
                  title="Add new word"
                >
                  <Plus className="h-4 w-4" />
                  Add Word
                </button>
              </div>
              <p className="text-sm text-gray-600 mb-4">
                Click on any word to play audio segment and display it in the waveform. 
                Use arrow keys to adjust times (1ms steps): ←/→ for start time, Shift+←/→ for end time. Enter to play.
              </p>
              
              {/* Add Word Form */}
              {isAddingWord && (
                <div className="mb-4 p-4 border-2 border-green-500 rounded-lg bg-green-50">
                  <div className="flex items-center justify-between mb-3">
                    <h4 className="text-lg font-semibold text-gray-800">Add New Word</h4>
                    <button
                      onClick={cancelAddWord}
                      className="text-gray-600 hover:text-gray-800"
                    >
                      <X className="h-5 w-5" />
                    </button>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-3">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Word *
                      </label>
                      <input
                        type="text"
                        value={newWordValues.word}
                        onChange={(e) => setNewWordValues({ ...newWordValues, word: e.target.value })}
                        placeholder="Enter word"
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent"
                        autoFocus
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            addWord();
                          }
                        }}
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Start Time * (MM:SS.mmm or H:MM:SS.mmm)
                      </label>
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={newWordValues.start}
                          onChange={(e) => setNewWordValues({ ...newWordValues, start: e.target.value })}
                          placeholder="0:00.000"
                          className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent font-mono"
                        />
                        <button
                          type="button"
                          onClick={() => {
                            if (playerRef.current) {
                              const currentTime = playerRef.current.getCurrentTime();
                              setNewWordValues({ ...newWordValues, start: secondsToTimeString(currentTime) });
                            }
                          }}
                          className="px-3 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg text-xs font-semibold whitespace-nowrap"
                          title="Set to current audio position"
                        >
                          Use Current
                        </button>
                      </div>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        End Time * (MM:SS.mmm or H:MM:SS.mmm)
                      </label>
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={newWordValues.end}
                          onChange={(e) => setNewWordValues({ ...newWordValues, end: e.target.value })}
                          placeholder="0:00.000"
                          className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent font-mono"
                        />
                        <button
                          type="button"
                          onClick={() => {
                            if (playerRef.current) {
                              const currentTime = playerRef.current.getCurrentTime();
                              setNewWordValues({ ...newWordValues, end: secondsToTimeString(currentTime) });
                            }
                          }}
                          className="px-3 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg text-xs font-semibold whitespace-nowrap"
                          title="Set to current audio position"
                        >
                          Use Current
                        </button>
                      </div>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={addWord}
                      className="bg-green-600 hover:bg-green-700 text-white font-semibold py-2 px-4 rounded-lg transition-colors flex items-center gap-2"
                    >
                      <Check className="h-4 w-4" />
                      Add Word
                    </button>
                    <button
                      onClick={cancelAddWord}
                      className="bg-gray-600 hover:bg-gray-700 text-white font-semibold py-2 px-4 rounded-lg transition-colors flex items-center gap-2"
                    >
                      <X className="h-4 w-4" />
                      Cancel
                    </button>
                  </div>
                </div>
              )}

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
                        {/* Edit and Delete Buttons (shown on hover) */}
                        <div className="absolute top-1 right-1 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              startEdit(index);
                            }}
                            className="bg-white rounded-full p-1 shadow hover:bg-blue-50"
                            title="Edit word"
                          >
                            <Edit2 className="h-3 w-3 text-blue-600" />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              deleteWord(index);
                            }}
                            className="bg-white rounded-full p-1 shadow hover:bg-red-50"
                            title="Delete word"
                          >
                            <Trash2 className="h-3 w-3 text-red-600" />
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

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
      </div>
    </main>
  );
}

export default App;

