import { useState, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import App from './App';
import PhrasesApp from './PhrasesApp';
import { Mic2, MessageSquare, LogOut, Users } from 'lucide-react';

interface MainAppProps {
  onSignOut?: () => void;
}

function MainApp({ onSignOut }: MainAppProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const [user, setUser] = useState<any>(null);

  useEffect(() => {
    // Get user info from localStorage
    const userStr = localStorage.getItem('user');
    if (userStr) {
      try {
        setUser(JSON.parse(userStr));
      } catch (e) {
        console.error('Error parsing user data:', e);
      }
    }
  }, []);

  const handleSignOut = () => {
    if (onSignOut) {
      onSignOut();
    }
  };

  const isWordLevel = location.pathname.startsWith('/word-level');
  const isPhraseLevel = location.pathname.startsWith('/phrase-level');
  const isAdmin = user?.is_admin || false;

  return (
    <div>
      {/* Header with user info and sign out */}
      <div className="bg-white shadow-sm border-b border-gray-200 px-4 py-3 mb-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center space-x-1">
            <button
              onClick={() => navigate('/word-level')}
              className={`flex items-center gap-2 px-5 py-2 rounded-full font-medium transition-all ${isWordLevel
                  ? 'bg-blue-600 text-white shadow-lg'
                  : 'text-blue-600 hover:bg-blue-50'
                }`}
            >
              <Mic2 className="h-5 w-5" />
              Word-Level
            </button>
            <button
              onClick={() => navigate('/phrase-level')}
              className={`flex items-center gap-2 px-5 py-2 rounded-full font-medium transition-all ${isPhraseLevel
                  ? 'bg-purple-600 text-white shadow-lg'
                  : 'text-purple-600 hover:bg-purple-50'
                }`}
            >
              <MessageSquare className="h-5 w-5" />
              Phrase-Level
            </button>
            {isAdmin && (
              <button
                onClick={() => navigate('/admin')}
                className={`flex items-center gap-2 px-5 py-2 rounded-full font-medium transition-all ${
                  location.pathname === '/admin'
                    ? 'bg-green-600 text-white shadow-lg'
                    : 'text-green-600 hover:bg-green-50'
                }`}
              >
                <Users className="h-5 w-5" />
                Admin
              </button>
            )}
          </div>
          
          {/* User info and sign out */}
          <div className="flex items-center gap-4">
            {user && (
              <div className="flex items-center gap-2 text-gray-700">
                {user.picture && (
                  <img
                    src={user.picture}
                    alt={user.name || 'User'}
                    className="w-8 h-8 rounded-full"
                  />
                )}
                <span className="text-sm font-medium hidden md:block">
                  {user.name || user.email}
                </span>
              </div>
            )}
            <button
              onClick={handleSignOut}
              className="flex items-center gap-2 px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
              title="Sign out"
            >
              <LogOut className="h-4 w-4" />
              <span className="hidden md:inline">Sign Out</span>
            </button>
          </div>
        </div>
      </div>
      
      {/* Content */}
      {isWordLevel && <App />}
      {isPhraseLevel && <PhrasesApp />}
    </div>
  );
}

export default MainApp;

