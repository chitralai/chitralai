/** @jsxImportSource react */
import { GoogleOAuthProvider } from "@react-oauth/google";
import React, { useEffect } from "react";

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID;
const ALLOWED_ORIGINS = [
  'https://3dprinting.space',
  'http://localhost:3000',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'https://main.d2egbkasraqmnr.amplifyapp.com',
  'https://main.dlyhbjyn2h6lw.amplifyapp.com'
];

// Allow all origins in development mode
if (import.meta.env.DEV) {
  ALLOWED_ORIGINS.push(window.location.origin);
}

export const GoogleAuthConfig: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  useEffect(() => {
    // Verify current origin is allowed and construct redirect URI
    const currentOrigin = window.location.origin;
    const redirectUri = `${currentOrigin}/auth/google/callback`;
    
    if (!ALLOWED_ORIGINS.includes(currentOrigin)) {
      console.error(`Error: Current origin ${currentOrigin} is not in the allowed list for Google OAuth. Please ensure this redirect URI is configured in Google Cloud Console: ${redirectUri}`);
      return;
    }

    // Handle potential Google Sign-In errors gracefully
    const originalError = console.error;
    console.error = (...args) => {
      // Filter out known Google Sign-In errors in development
      if (
        args[0] && 
        typeof args[0] === 'string' && 
        (args[0].includes('GSI_LOGGER') || 
         args[0].includes('Failed to execute \'postMessage\'') ||
         args[0].includes('Error retrieving a token'))
      ) {
        // Log warning instead of error in development
        if (import.meta.env.DEV) {
          console.warn('Google Sign-In development warning:', args[0]);
          return;
        }
      }
      
      // Provide helpful guidance for common initialization errors
      if (
        args[0] && 
        typeof args[0] === 'string' && 
        args[0].includes('Initialization error:')
      ) {
        const errorMessage = args[0];
        
        // For event not found errors in incognito mode
        if (errorMessage.includes('Event not found') && isIncognitoMode()) {
          console.warn('Event access error in private/incognito mode. Try opening the link in a regular browser window or ensure the URL contains a valid eventId parameter.');
        } else {
          originalError.apply(console, args);
        }
        return;
      }
      
      originalError.apply(console, args);
    };
    
    // Helper to detect incognito/private mode
    const isIncognitoMode = () => {
      try {
        localStorage.setItem('test', 'test');
        localStorage.removeItem('test');
        return false;
      } catch (e) {
        return true;
      }
    };

    return () => {
      console.error = originalError;
    };
  }, []);

  // Add a listener for Google OAuth errors
  useEffect(() => {
    const handleOAuthError = (event: MessageEvent) => {
      if (
        event.data && 
        typeof event.data === 'object' && 
        event.data.type === 'oauth_error'
      ) {
        console.warn('Google OAuth error detected:', event.data.error);
        // Could display a user-friendly message here
      }
    };

    window.addEventListener('message', handleOAuthError);
    return () => window.removeEventListener('message', handleOAuthError);
  }, []);

  if (!GOOGLE_CLIENT_ID) {
    console.warn("Google Client ID is missing. OAuth features will be disabled.");
    return <>{children}</>;
  }

  return (
    <GoogleOAuthProvider 
      clientId={GOOGLE_CLIENT_ID}
      onScriptLoadError={() => {
        console.error("Google Sign-In script failed to load");
      }}
    >
      {children}
    </GoogleOAuthProvider>
  );
};