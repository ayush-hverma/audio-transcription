import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { Users, FileText, UserCheck, UserX, Loader2, Search, Check, X, ChevronLeft, ChevronRight, ArrowLeft, CheckSquare, Square } from 'lucide-react';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || (import.meta.env.DEV ? 'http://localhost:5002' : '/api');

// Helper function to get user info from localStorage
const getUserInfo = (): { id: string | null; isAdmin: boolean } => {
  try {
    const userStr = localStorage.getItem('user');
    if (userStr) {
      const user = JSON.parse(userStr);
      return {
        id: user.sub || user.id || null,
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

interface User {
  _id: string;
  username: string;
  email: string;
  name: string;
  is_admin: boolean;
}

interface Transcription {
  _id: string;
  filename: string;
  created_at: string;
  language: string;
  assigned_user_id?: string;
  user_id?: string;
}

function AdminPanel() {
  const navigate = useNavigate();
  const [users, setUsers] = useState<User[]>([]);
  const [transcriptions, setTranscriptions] = useState<Transcription[]>([]);
  const [loading, setLoading] = useState(true);
  const [assigning, setAssigning] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedUserId, setSelectedUserId] = useState<string>('');
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage] = useState(20); // 20 items per page
  const [selectedTranscriptions, setSelectedTranscriptions] = useState<Set<string>>(new Set());
  const [bulkAssignUserId, setBulkAssignUserId] = useState<string>('');
  const [bulkAssigning, setBulkAssigning] = useState(false);

  const { isAdmin } = getUserInfo();

  useEffect(() => {
    if (!isAdmin) {
      setMessage({ type: 'error', text: 'Access denied. Admin privileges required.' });
      return;
    }
    loadData();
  }, [isAdmin]);

  // Reset to page 1 when search term changes
  useEffect(() => {
    setCurrentPage(1);
  }, [searchTerm]);

  const loadData = async () => {
    setLoading(true);
    try {
      const config = getAxiosConfig();
      
      // Load users
      const usersResponse = await axios.get(`${API_BASE_URL}/api/admin/users`, config);
      if (usersResponse.data.success) {
        setUsers(usersResponse.data.users.filter((u: User) => !u.is_admin)); // Exclude admins from assignment list
      }

      // Load transcriptions
      const transcriptionsResponse = await axios.get(`${API_BASE_URL}/api/transcriptions?limit=1000`, config);
      if (transcriptionsResponse.data.success) {
        setTranscriptions(transcriptionsResponse.data.data.transcriptions);
      }
    } catch (error: any) {
      setMessage({ type: 'error', text: error.response?.data?.error || 'Failed to load data' });
    } finally {
      setLoading(false);
    }
  };

  const handleAssign = async (transcriptionId: string, userId: string) => {
    setAssigning(transcriptionId);
    try {
      const config = getAxiosConfig();
      const response = await axios.post(
        `${API_BASE_URL}/api/admin/transcriptions/${transcriptionId}/assign`,
        { assigned_user_id: userId },
        config
      );

      if (response.data.success) {
        setMessage({ type: 'success', text: 'Transcription assigned successfully' });
        loadData(); // Reload data
      }
    } catch (error: any) {
      setMessage({ type: 'error', text: error.response?.data?.error || 'Failed to assign transcription' });
    } finally {
      setAssigning(null);
    }
  };

  const handleUnassign = async (transcriptionId: string) => {
    setAssigning(transcriptionId);
    try {
      const config = getAxiosConfig();
      const response = await axios.post(
        `${API_BASE_URL}/api/admin/transcriptions/${transcriptionId}/unassign`,
        {},
        config
      );

      if (response.data.success) {
        setMessage({ type: 'success', text: 'Transcription unassigned successfully' });
        loadData(); // Reload data
      }
    } catch (error: any) {
      setMessage({ type: 'error', text: error.response?.data?.error || 'Failed to unassign transcription' });
    } finally {
      setAssigning(null);
    }
  };

  const handleBulkAssign = async () => {
    if (!bulkAssignUserId || selectedTranscriptions.size === 0) {
      setMessage({ type: 'error', text: 'Please select files and a user to assign' });
      return;
    }

    setBulkAssigning(true);
    const selectedIds = Array.from(selectedTranscriptions);
    console.log(`🔄 Bulk assigning ${selectedIds.length} transcriptions to user ${bulkAssignUserId}`);
    console.log('Selected IDs:', selectedIds);
    
    let successCount = 0;
    let errorCount = 0;
    const errors: string[] = [];

    try {
      const config = getAxiosConfig();
      
      // Assign all selected transcriptions in parallel
      const assignments = selectedIds.map((id, index) =>
        axios.post(
          `${API_BASE_URL}/api/admin/transcriptions/${id}/assign`,
          { assigned_user_id: bulkAssignUserId },
          config
        )
        .then(response => {
          // Verify the response indicates success
          if (response.data && response.data.success) {
            console.log(`✅ Assigned transcription ${index + 1}/${selectedIds.length}: ${id} to user ${bulkAssignUserId}`);
            console.log(`   Response:`, response.data);
            return { success: true, id, response };
          } else {
            const errorMsg = response.data?.error || 'Assignment failed - no success flag';
            console.error(`❌ Assignment failed for ${id}:`, errorMsg);
            errorCount++;
            errors.push(`ID ${id}: ${errorMsg}`);
            return { success: false, id, error: errorMsg };
          }
        })
        .catch(error => {
          errorCount++;
          const errorMsg = error.response?.data?.error || error.message || 'Unknown error';
          errors.push(`ID ${id}: ${errorMsg}`);
          console.error(`❌ Failed to assign transcription ${id}:`, errorMsg);
          if (error.response) {
            console.error(`   Response status: ${error.response.status}`);
            console.error(`   Response data:`, error.response.data);
          }
          return { success: false, id, error: errorMsg };
        })
      );

      const results = await Promise.all(assignments);
      successCount = results.filter(r => r.success).length;

      console.log(`📊 Assignment results: ${successCount} succeeded, ${errorCount} failed`);

      if (successCount > 0) {
        setMessage({ 
          type: 'success', 
          text: `Successfully assigned ${successCount} transcription${successCount > 1 ? 's' : ''}${errorCount > 0 ? `. ${errorCount} failed.` : ''}` 
        });
        setSelectedTranscriptions(new Set()); // Clear selection
        setBulkAssignUserId(''); // Reset dropdown
        loadData(); // Reload data
      } else {
        const errorDetails = errors.length > 0 ? ` Errors: ${errors.slice(0, 3).join('; ')}${errors.length > 3 ? '...' : ''}` : '';
        setMessage({ type: 'error', text: `Failed to assign transcriptions.${errorDetails}` });
      }
    } catch (error: any) {
      console.error('❌ Bulk assignment error:', error);
      setMessage({ type: 'error', text: error.response?.data?.error || 'Failed to assign transcriptions' });
    } finally {
      setBulkAssigning(false);
    }
  };

  const handleBulkUnassign = async () => {
    if (selectedTranscriptions.size === 0) {
      setMessage({ type: 'error', text: 'Please select files to unassign' });
      return;
    }

    setBulkAssigning(true);
    const selectedIds = Array.from(selectedTranscriptions);
    console.log(`🔄 Bulk unassigning ${selectedIds.length} transcriptions`);
    console.log('Selected IDs:', selectedIds);
    
    let successCount = 0;
    let errorCount = 0;
    const errors: string[] = [];

    try {
      const config = getAxiosConfig();
      
      // Unassign all selected transcriptions in parallel
      const unassignments = selectedIds.map((id, index) =>
        axios.post(
          `${API_BASE_URL}/api/admin/transcriptions/${id}/unassign`,
          {},
          config
        )
        .then(response => {
          // Verify the response indicates success
          if (response.data && response.data.success) {
            console.log(`✅ Unassigned transcription ${index + 1}/${selectedIds.length}: ${id}`);
            return { success: true, id, response };
          } else {
            const errorMsg = response.data?.error || 'Unassignment failed - no success flag';
            console.error(`❌ Unassignment failed for ${id}:`, errorMsg);
            errorCount++;
            errors.push(`ID ${id}: ${errorMsg}`);
            return { success: false, id, error: errorMsg };
          }
        })
        .catch(error => {
          errorCount++;
          const errorMsg = error.response?.data?.error || error.message || 'Unknown error';
          errors.push(`ID ${id}: ${errorMsg}`);
          console.error(`❌ Failed to unassign transcription ${id}:`, errorMsg);
          return { success: false, id, error: errorMsg };
        })
      );

      const results = await Promise.all(unassignments);
      successCount = results.filter(r => r.success).length;

      console.log(`📊 Unassignment results: ${successCount} succeeded, ${errorCount} failed`);

      if (successCount > 0) {
        setMessage({ 
          type: 'success', 
          text: `Successfully unassigned ${successCount} transcription${successCount > 1 ? 's' : ''}${errorCount > 0 ? `. ${errorCount} failed.` : ''}` 
        });
        setSelectedTranscriptions(new Set()); // Clear selection
        loadData(); // Reload data
      } else {
        const errorDetails = errors.length > 0 ? ` Errors: ${errors.slice(0, 3).join('; ')}${errors.length > 3 ? '...' : ''}` : '';
        setMessage({ type: 'error', text: `Failed to unassign transcriptions.${errorDetails}` });
      }
    } catch (error: any) {
      console.error('❌ Bulk unassignment error:', error);
      setMessage({ type: 'error', text: error.response?.data?.error || 'Failed to unassign transcriptions' });
    } finally {
      setBulkAssigning(false);
    }
  };

  const getUserName = (userId: string | undefined) => {
    if (!userId) return 'Unassigned';
    const user = users.find(u => u._id === userId);
    return user ? user.name || user.username : userId;
  };

  // Filter transcriptions based on search term
  const filteredTranscriptions = transcriptions.filter(t =>
    t.filename.toLowerCase().includes(searchTerm.toLowerCase()) ||
    getUserName(t.assigned_user_id).toLowerCase().includes(searchTerm.toLowerCase())
  );

  // Calculate pagination
  const totalItems = filteredTranscriptions.length;
  const totalPages = Math.ceil(totalItems / itemsPerPage);
  const startIndex = (currentPage - 1) * itemsPerPage;
  const endIndex = startIndex + itemsPerPage;
  const paginatedTranscriptions = filteredTranscriptions.slice(startIndex, endIndex);

  // Handle select/deselect all
  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      const allIds = new Set(paginatedTranscriptions.map(t => t._id));
      setSelectedTranscriptions(prev => new Set([...prev, ...allIds]));
    } else {
      const currentPageIds = new Set(paginatedTranscriptions.map(t => t._id));
      setSelectedTranscriptions(prev => {
        const newSet = new Set(prev);
        currentPageIds.forEach(id => newSet.delete(id));
        return newSet;
      });
    }
  };

  // Handle individual selection
  const handleSelectTranscription = (id: string, checked: boolean) => {
    setSelectedTranscriptions(prev => {
      const newSet = new Set(prev);
      if (checked) {
        newSet.add(id);
      } else {
        newSet.delete(id);
      }
      return newSet;
    });
  };

  // Check if all current page items are selected
  const allCurrentPageSelected = paginatedTranscriptions.length > 0 && 
    paginatedTranscriptions.every(t => selectedTranscriptions.has(t._id));
  
  // Check if some (but not all) current page items are selected
  const someCurrentPageSelected = paginatedTranscriptions.some(t => selectedTranscriptions.has(t._id)) && 
    !allCurrentPageSelected;

  if (!isAdmin) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-red-600 mb-4">Access Denied</h1>
          <p className="text-gray-600">You need admin privileges to access this page.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="max-w-7xl mx-auto">
        <div className="bg-white rounded-lg shadow-md p-6 mb-6">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-4">
              <button
                onClick={() => navigate(-1)}
                className="flex items-center gap-2 px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
                title="Go back"
              >
                <ArrowLeft className="h-5 w-5" />
                <span className="hidden sm:inline">Back</span>
              </button>
              <div>
                <h1 className="text-3xl font-bold text-gray-800 flex items-center gap-3">
                  <Users className="h-8 w-8 text-blue-600" />
                  Admin Panel
                </h1>
                <p className="text-gray-600 mt-2">Manage transcription assignments</p>
              </div>
            </div>
          </div>

          {message && (
            <div
              className={`mb-4 p-4 rounded-lg ${
                message.type === 'success' ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800'
              }`}
            >
              {message.text}
              <button
                onClick={() => setMessage(null)}
                className="float-right text-gray-500 hover:text-gray-700"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          )}

          <div className="mb-6 space-y-4">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 h-5 w-5" />
              <input
                type="text"
                placeholder="Search transcriptions by filename or assigned user..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>

            {/* Bulk Assignment Controls */}
            {selectedTranscriptions.size > 0 && (
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 flex items-center justify-between flex-wrap gap-4">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-blue-900">
                    {selectedTranscriptions.size} file{selectedTranscriptions.size > 1 ? 's' : ''} selected
                  </span>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <select
                    value={bulkAssignUserId}
                    onChange={(e) => setBulkAssignUserId(e.target.value)}
                    disabled={bulkAssigning}
                    className="text-sm border border-gray-300 rounded px-3 py-2 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:opacity-50"
                  >
                    <option value="">Select user to assign...</option>
                    {users.map((user) => (
                      <option key={user._id} value={user._id}>
                        {user.name || user.username}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={handleBulkAssign}
                    disabled={!bulkAssignUserId || bulkAssigning}
                    className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {bulkAssigning ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Assigning...
                      </>
                    ) : (
                      <>
                        <UserCheck className="h-4 w-4" />
                        Assign Selected
                      </>
                    )}
                  </button>
                  <button
                    onClick={handleBulkUnassign}
                    disabled={bulkAssigning}
                    className="flex items-center gap-2 px-4 py-2 bg-orange-600 text-white rounded-lg hover:bg-orange-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {bulkAssigning ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Unassigning...
                      </>
                    ) : (
                      <>
                        <UserX className="h-4 w-4" />
                        Unassign Selected
                      </>
                    )}
                  </button>
                  <button
                    onClick={() => {
                      setSelectedTranscriptions(new Set());
                      setBulkAssignUserId('');
                    }}
                    className="px-4 py-2 text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
                  >
                    Clear Selection
                  </button>
                </div>
              </div>
            )}
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-100">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider w-12">
                      <button
                        onClick={() => handleSelectAll(!allCurrentPageSelected)}
                        className="flex items-center justify-center"
                        title={allCurrentPageSelected ? 'Deselect all' : 'Select all'}
                      >
                        {allCurrentPageSelected ? (
                          <CheckSquare className="h-5 w-5 text-blue-600" />
                        ) : someCurrentPageSelected ? (
                          <div className="relative">
                            <Square className="h-5 w-5 text-gray-400" />
                            <div className="absolute inset-0 flex items-center justify-center">
                              <div className="h-3 w-3 bg-blue-600 rounded-sm" />
                            </div>
                          </div>
                        ) : (
                          <Square className="h-5 w-5 text-gray-400" />
                        )}
                      </button>
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                      Filename
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                      Language
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                      Created
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                      Assigned To
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {paginatedTranscriptions.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-4 py-8 text-center text-gray-500">
                        {searchTerm ? 'No transcriptions match your search' : 'No transcriptions found'}
                      </td>
                    </tr>
                  ) : (
                    paginatedTranscriptions.map((transcription) => (
                      <tr key={transcription._id} className={`hover:bg-gray-50 ${selectedTranscriptions.has(transcription._id) ? 'bg-blue-50' : ''}`}>
                        <td className="px-4 py-3 whitespace-nowrap">
                          <button
                            onClick={() => handleSelectTranscription(transcription._id, !selectedTranscriptions.has(transcription._id))}
                            className="flex items-center justify-center"
                          >
                            {selectedTranscriptions.has(transcription._id) ? (
                              <CheckSquare className="h-5 w-5 text-blue-600" />
                            ) : (
                              <Square className="h-5 w-5 text-gray-400" />
                            )}
                          </button>
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          <div className="flex items-center">
                            <FileText className="h-5 w-5 text-gray-400 mr-2" />
                            <span className="text-sm font-medium text-gray-900">
                              {transcription.filename}
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-500">
                          {transcription.language}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-500">
                          {new Date(transcription.created_at).toLocaleDateString()}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          <span
                            className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                              transcription.assigned_user_id
                                ? 'bg-green-100 text-green-800'
                                : 'bg-gray-100 text-gray-800'
                            }`}
                          >
                            {getUserName(transcription.assigned_user_id)}
                          </span>
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-sm font-medium">
                          <div className="flex items-center gap-2">
                            <select
                              value={selectedUserId}
                              onChange={(e) => {
                                const userId = e.target.value;
                                setSelectedUserId(userId);
                                if (userId && !bulkAssigning) {
                                  // Only trigger individual assignment if not in bulk mode
                                  handleAssign(transcription._id, userId);
                                }
                              }}
                              disabled={assigning === transcription._id || bulkAssigning}
                              className="text-sm border border-gray-300 rounded px-2 py-1 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:opacity-50"
                            >
                              <option value="">Assign to...</option>
                              {users.map((user) => (
                                <option key={user._id} value={user._id}>
                                  {user.name || user.username}
                                </option>
                              ))}
                            </select>
                            {transcription.assigned_user_id && (
                              <button
                                onClick={() => {
                                  if (!bulkAssigning) {
                                    handleUnassign(transcription._id);
                                  }
                                }}
                                disabled={assigning === transcription._id || bulkAssigning}
                                className="text-red-600 hover:text-red-800 disabled:opacity-50"
                                title="Unassign"
                              >
                                {assigning === transcription._id ? (
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                  <UserX className="h-4 w-4" />
                                )}
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}

          {/* Pagination Controls */}
          {totalItems > itemsPerPage && (
            <div className="mt-6 flex items-center justify-between border-t border-gray-200 pt-4">
              <div className="flex items-center text-sm text-gray-700">
                Showing {startIndex + 1} to {Math.min(endIndex, totalItems)} of {totalItems} transcriptions
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                  disabled={currentPage === 1 || loading}
                  className="flex items-center gap-1 px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <ChevronLeft className="h-4 w-4" />
                  Previous
                </button>
                
                <div className="flex items-center gap-1">
                  {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
                    let page: number;
                    if (totalPages <= 7) {
                      page = i + 1;
                    } else {
                      const totalPages = Math.ceil(totalItems / itemsPerPage);
                      if (currentPage <= 3) {
                        page = i + 1;
                      } else if (currentPage >= totalPages - 2) {
                        page = totalPages - 6 + i;
                      } else {
                        page = currentPage - 3 + i;
                      }
                    }
                    
                    return (
                      <button
                        key={page}
                        onClick={() => setCurrentPage(page)}
                        className={`px-3 py-2 text-sm font-medium rounded-lg ${
                          currentPage === page
                            ? 'bg-blue-600 text-white'
                            : 'text-gray-700 bg-white border border-gray-300 hover:bg-gray-50'
                        }`}
                      >
                        {page}
                      </button>
                    );
                  })}
                </div>

                <button
                  onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
                  disabled={currentPage >= totalPages || loading}
                  className="flex items-center gap-1 px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Next
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default AdminPanel;

