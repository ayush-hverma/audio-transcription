import { useState, useEffect } from 'react';
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import SignIn from './SignIn';
import MainApp from './MainApp';
import AdminPanel from './AdminPanel';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Check if user is already signed in
    const user = localStorage.getItem('user');
    setIsAuthenticated(!!user);
    setLoading(false);
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 to-purple-50">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
          <p className="text-gray-600">Loading...</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/signin" replace />;
  }

  return <>{children}</>;
}

function AppWithAuth() {
  const navigate = useNavigate();
  const location = useLocation();
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Check if user is already signed in
    const user = localStorage.getItem('user');
    if (user) {
      setIsAuthenticated(true);
      // Redirect to word-level if on signin page
      if (location.pathname === '/signin') {
        navigate('/word-level', { replace: true });
      }
    }
    setLoading(false);
  }, [navigate, location.pathname]);

  const handleSignIn = (userInfo: any) => {
    setIsAuthenticated(true);
    navigate('/word-level', { replace: true });
  };

  const handleSignOut = () => {
    localStorage.removeItem('user');
    localStorage.removeItem('access_token');
    setIsAuthenticated(false);
    navigate('/signin', { replace: true });
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 to-purple-50">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
          <p className="text-gray-600">Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <Routes>
      <Route 
        path="/signin" 
        element={
          isAuthenticated ? (
            <Navigate to="/word-level" replace />
          ) : (
            <SignIn onSignIn={handleSignIn} />
          )
        } 
      />
      <Route
        path="/word-level/*"
        element={
          <ProtectedRoute>
            <MainApp onSignOut={handleSignOut} />
          </ProtectedRoute>
        }
      />
      <Route
        path="/phrase-level/*"
        element={
          <ProtectedRoute>
            <MainApp onSignOut={handleSignOut} />
          </ProtectedRoute>
        }
      />
      <Route
        path="/admin"
        element={
          <ProtectedRoute>
            <AdminPanel />
          </ProtectedRoute>
        }
      />
      <Route 
        path="/" 
        element={
          <Navigate 
            to={isAuthenticated ? "/word-level" : "/signin"} 
            replace 
          />
        } 
      />
    </Routes>
  );
}

export default AppWithAuth;

