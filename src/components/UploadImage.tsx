import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Upload } from '@aws-sdk/lib-storage';
import { S3_BUCKET_NAME, s3Client } from '../config/aws';
import { Upload as UploadIcon, X, Download, ArrowLeft, Copy, Loader2, Camera, ShieldAlert } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { useLocation, useNavigate } from 'react-router-dom';
import { getUserEvents, getEventById, updateEventData } from '../config/eventStorage';
import imageCompression from 'browser-image-compression';

const MAX_FILE_SIZE = 200 * 1024 * 1024; // 200MB
const BATCH_SIZE = 20; // Increased for faster processing
const IMAGES_PER_PAGE = 50;
const MAX_PARALLEL_UPLOADS = 10; // Increased for faster parallel processing
const MAX_DIMENSION = 2048;
const UPLOAD_TIMEOUT = 300000; // 5 minutes timeout for large files

const COMPRESSION_OPTIONS = {
  maxSizeMB: 1,
  maxWidthOrHeight: 1920,
  useWebWorker: true,
  fileType: 'image/jpeg',
  initialQuality: 0.7
};

const UploadImage = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const containerRef = useRef<HTMLDivElement>(null);
  const [currentPage, setCurrentPage] = useState(1);

  const [images, setImages] = useState<File[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadSuccess, setUploadSuccess] = useState(false);
  const [eventId, setEventId] = useState<string>('');
  const [uploadedUrls, setUploadedUrls] = useState<string[]>([]);
  const [events, setEvents] = useState<{ id: string; name: string }[]>([]);
  const [selectedEvent, setSelectedEvent] = useState<string>('');
  const [showQRModal, setShowQRModal] = useState(false);
  const [showCopySuccess, setShowCopySuccess] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ current: number; total: number } | null>(null);
  const [imagePreviews, setImagePreviews] = useState<{ [key: string]: string }>({});
  const [eventCode, setEventCode] = useState<string>('');
  const [isAuthorized, setIsAuthorized] = useState<boolean | null>(null);
  const [authorizationMessage, setAuthorizationMessage] = useState<string>('');
  const [compressionProgress, setCompressionProgress] = useState<{ current: number; total: number } | null>(null);
  const [isCompressing, setIsCompressing] = useState(false);

  // Handle scroll for pagination
  const handleScroll = useCallback(() => {
    if (!containerRef.current) return;
    
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    if (scrollHeight - scrollTop - clientHeight < 100) {
      setCurrentPage(prev => prev + 1);
    }
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (container) {
      container.addEventListener('scroll', handleScroll);
      return () => container.removeEventListener('scroll', handleScroll);
    }
  }, [handleScroll]);

  useEffect(() => {
    const initializeComponent = async () => {
      const userEmail = localStorage.getItem('userEmail');
      if (!userEmail) return;

      try {
        // Fetch user events
        const userEvents = await getUserEvents(userEmail);
        const eventsList = userEvents.map(event => ({
          id: event.id,
          name: event.name,
        }));
        setEvents(eventsList);

        // Extract eventId from URL params or state or localStorage
        let targetEventId = '';
        
        // Check URL parameters first
        const searchParams = new URLSearchParams(window.location.search);
        const urlEventId = searchParams.get('eventId');
        
        if (urlEventId) {
          console.log('EventId from URL params:', urlEventId);
          targetEventId = urlEventId;
        } 
        // Check location state (from navigation)
        else if (location.state?.eventId) {
          console.log('EventId from location state:', location.state.eventId);
          targetEventId = location.state.eventId;
        }
        // Check localStorage as last resort
        else {
          const storedEventId = localStorage.getItem('currentEventId');
          if (storedEventId) {
            console.log('EventId from localStorage:', storedEventId);
            targetEventId = storedEventId;
          }
        }

        if (targetEventId) {
          // Find the event in the list to confirm it exists
          const eventExists = eventsList.some(event => event.id === targetEventId);
          
          if (eventExists) {
            setEventId(targetEventId);
            setSelectedEvent(targetEventId);
            console.log('Set selected event to:', targetEventId);
          } else {
            console.warn('Event ID from URL/state not found in user events:', targetEventId);
          }
        }
      } catch (error) {
        console.error('Error initializing UploadImage component:', error);
      }
    };

    initializeComponent();
  }, [location]);

  // Find the current event name for display
  const getSelectedEventName = () => {
    const event = events.find(e => e.id === selectedEvent);
    return event ? event.name : 'Select an Event';
  };

  const handleImageChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const files = Array.from(e.target.files);
      
      // Validate files before proceeding
      const validFiles = [];
      const invalidFiles = [];
      
      for (const file of files) {
        const fileName = file.name.toLowerCase();
        const isValidType = file.type.startsWith('image/');
        const isValidSize = file.size <= MAX_FILE_SIZE;
        const isNotSelfie = !fileName.includes('selfie') && !fileName.includes('self');
        
        if (!isValidType) {
          invalidFiles.push({ name: file.name, reason: 'Not a valid image file' });
        } else if (!isValidSize) {
          invalidFiles.push({ name: file.name, reason: 'Exceeds the 200MB size limit' });
        } else if (!isNotSelfie) {
          invalidFiles.push({ name: file.name, reason: 'Selfie images are not allowed' });
        } else {
          validFiles.push(file);
        }
      }

      // Show error message for invalid files
      if (invalidFiles.length > 0) {
        const warningMessage = `${invalidFiles.length} file(s) were skipped:\n${
          invalidFiles.slice(0, 5).map(f => `- ${f.name}: ${f.reason}`).join('\n')
        }${invalidFiles.length > 5 ? `\n...and ${invalidFiles.length - 5} more` : ''}`;
        
        alert(warningMessage);
      }

      // Process valid images in batches to prevent memory issues
      const processBatch = async (files: File[]) => {
        const batchPromises = files.map(async (file) => {
          try {
            // Create preview URL
            const previewUrl = URL.createObjectURL(file);
            setImagePreviews(prev => ({ ...prev, [file.name]: previewUrl }));
            return file;
          } catch (error) {
            console.error(`Error creating preview for ${file.name}:`, error);
            return file; // Still return the file even if preview fails
          }
        });

        const processedFiles = await Promise.all(batchPromises);
        setImages(prev => [...prev, ...processedFiles]);
      };

      // Process files in batches
      for (let i = 0; i < validFiles.length; i += BATCH_SIZE) {
        const batch = validFiles.slice(i, i + BATCH_SIZE);
        processBatch(batch);
      }
    }
  }, []);

  // Cleanup preview URLs when component unmounts or images are removed
  useEffect(() => {
    return () => {
      Object.values(imagePreviews).forEach(url => URL.revokeObjectURL(url));
    };
  }, [imagePreviews]);

  const removeImage = useCallback((index: number) => {
    setImages(prev => {
      const newImages = prev.filter((_, i) => i !== index);
      // Cleanup preview URL
      const removedFile = prev[index];
      if (removedFile && imagePreviews[removedFile.name]) {
        URL.revokeObjectURL(imagePreviews[removedFile.name]);
        setImagePreviews(prev => {
          const newPreviews = { ...prev };
          delete newPreviews[removedFile.name];
          return newPreviews;
        });
      }
      return newImages;
    });
  }, [imagePreviews]);

  const uploadToS3 = useCallback(
    async (file: File, fileName: string): Promise<string> => {
      if (!selectedEvent) {
        throw new Error('Event ID is required for uploading images.');
      }
      console.log(`Uploading file: ${fileName}`);
      const sessionId = localStorage.getItem('sessionId');
      const folderPath = `events/shared/${selectedEvent}/images/${fileName}`;

      // Upload original file without compression
      let fileBuffer: ArrayBuffer;
      try {
        fileBuffer = await file.arrayBuffer();
      } catch (error) {
        console.error(`Failed to read file ${fileName}:`, error);
        throw new Error('Failed to process file. Please try again.');
      }

      const fileUint8Array = new Uint8Array(fileBuffer);

      const uploadParams = {
        Bucket: S3_BUCKET_NAME,
        Key: folderPath,
        Body: fileUint8Array,
        ContentType: file.type,
        Metadata: {
          'event-id': selectedEvent,
          'session-id': sessionId || '',
          'upload-date': new Date().toISOString(),
          'original-size': file.size.toString(),
          'needs-compression': (file.size > 5 * 1024 * 1024).toString()
        },
      };

      const uploadInstance = new Upload({
        client: s3Client,
        params: uploadParams,
        partSize: 50 * 1024 * 1024, // Increased to 50MB for faster uploads
        queueSize: 8, // Increased for better parallelization
        leavePartsOnError: false,
      });

      let uploadTimeout: NodeJS.Timeout;
      const uploadPromise = new Promise<string>((resolve, reject) => {
        uploadTimeout = setTimeout(() => {
          reject(new Error('Upload timed out. Please try again.'));
        }, UPLOAD_TIMEOUT);

        uploadInstance.on('httpUploadProgress', (progress) => {
          const loaded = progress.loaded || 0;
          const total = progress.total || 1;
          console.log(`Upload progress for ${fileName}:`, {
            loaded,
            total,
            percentage: Math.round((loaded / total) * 100)
          });
        });

        uploadInstance.done()
          .then(() => resolve(folderPath))
          .catch(reject)
          .finally(() => clearTimeout(uploadTimeout));
      });

      return uploadPromise;
    },
    [selectedEvent]
  );

  // New function to compress and replace images in background
  const compressAndReplaceImages = useCallback(async (urls: string[]) => {
    setIsCompressing(true);
    setCompressionProgress({ current: 0, total: urls.length });

    try {
      for (let i = 0; i < urls.length; i++) {
        const url = urls[i];
        const key = url.split('.com/')[1];
        
        // Get the original file from S3
        const response = await fetch(url);
        const blob = await response.blob();
        const file = new File([blob], key.split('/').pop() || 'image.jpg', { type: blob.type });

        // Only compress if file is larger than 5MB
        if (file.size > 5 * 1024 * 1024) {
          try {
            const compressedFile = await imageCompression(file, COMPRESSION_OPTIONS);
            console.log(`Compressed ${file.name} from ${file.size} to ${compressedFile.size} bytes`);

            // Upload compressed version
            const compressedBuffer = await compressedFile.arrayBuffer();
            const compressedUint8Array = new Uint8Array(compressedBuffer);

            const uploadParams = {
              Bucket: S3_BUCKET_NAME,
              Key: key,
              Body: compressedUint8Array,
              ContentType: file.type,
              Metadata: {
                'event-id': selectedEvent,
                'session-id': localStorage.getItem('sessionId') || '',
                'upload-date': new Date().toISOString(),
                'compressed-size': compressedFile.size.toString(),
                'compressed': 'true'
              },
            };

            const uploadInstance = new Upload({
              client: s3Client,
              params: uploadParams,
              partSize: 20 * 1024 * 1024,
              queueSize: 4,
              leavePartsOnError: false,
            });

            await uploadInstance.done();
          } catch (error) {
            console.warn(`Failed to compress ${file.name}, keeping original:`, error);
          }
        }

        setCompressionProgress(prev => prev ? { ...prev, current: i + 1 } : null);
      }
    } catch (error) {
      console.error('Error during background compression:', error);
    } finally {
      setIsCompressing(false);
      setCompressionProgress(null);
    }
  }, [selectedEvent]);

  const handleUpload = useCallback(async () => {
    if (images.length === 0) {
      alert('Please select at least one image to upload.');
      return;
    }
    if (!selectedEvent) {
      alert('Please select or create an event before uploading images.');
      return;
    }

    setIsUploading(true);
    setUploadSuccess(false);
    
    let uploadedCount = 0;
    const totalCount = images.length;
    setUploadProgress({ current: 0, total: totalCount });

    try {
      // Process all images in parallel with a larger batch size
      const batchSize = Math.min(MAX_PARALLEL_UPLOADS, 10);
      const batches = [];
      for (let i = 0; i < images.length; i += batchSize) {
        batches.push(images.slice(i, i + batchSize));
      }

      const urls = [];
      const failedUploads = [];

      // Process all batches in parallel
      const batchPromises = batches.map(async (batch) => {
        const batchResults = await Promise.allSettled(
          batch.map(async (image, index) => {
            try {
              if (!image.type.startsWith('image/')) {
                throw new Error('Not a valid image file');
              }
              if (image.size > MAX_FILE_SIZE) {
                throw new Error('Exceeds the 200MB size limit');
              }
              
              const safeFileName = image.name.replace(/[^a-zA-Z0-9.-]/g, '_');
              const fileName = `${Date.now()}-${index}-${safeFileName}`;
              
              const imageUrl = await uploadToS3(image, fileName);
              uploadedCount++;
              setUploadProgress({ current: uploadedCount, total: totalCount });
              return `https://${S3_BUCKET_NAME}.s3.amazonaws.com/${imageUrl}`;
            } catch (error) {
              console.error(`Failed to upload ${image.name}:`, error);
              failedUploads.push({ 
                name: image.name, 
                reason: error instanceof Error ? error.message : 'Unknown error' 
              });
              return null;
            }
          })
        );

        return batchResults.map(result => 
          result.status === 'fulfilled' ? result.value : null
        );
      });

      // Wait for all batches to complete
      const allResults = await Promise.all(batchPromises);
      const validUrls = allResults.flat().filter((url): url is string => url !== null);
      urls.push(...validUrls);

      // Clean up preview URLs
      images.forEach(image => {
        if (imagePreviews[image.name]) {
          URL.revokeObjectURL(imagePreviews[image.name]);
        }
      });

      console.log('Uploaded images:', urls);
      setUploadedUrls(urls);
      localStorage.setItem('currentEventId', selectedEvent);
      setEventId(selectedEvent);
      
      const userEmail = localStorage.getItem('userEmail');
      if (userEmail) {
        try {
          const currentEvent = await getEventById(selectedEvent);
          if (currentEvent) {
            await updateEventData(selectedEvent, userEmail, {
              photoCount: (currentEvent.photoCount || 0) + urls.length
            });
          }
        } catch (error) {
          console.error('Error updating photoCount:', error);
        }
      }
      
      if (failedUploads.length > 0) {
        const message = `${urls.length} images uploaded successfully.\n${failedUploads.length} images failed to upload.`;
        alert(message);
      }
      
      setUploadSuccess(true);
      
      if (urls.length > 0) {
        setShowQRModal(true);
        // Start background compression after showing QR code
        compressAndReplaceImages(urls);
      }
      
      setImages([]);
      setImagePreviews({});
    } catch (error) {
      console.error('Error uploading images:', error);
      alert(error instanceof Error ? error.message : 'Failed to upload images. Please try again.');
    } finally {
      setIsUploading(false);
      setUploadProgress(null);
    }
  }, [images, selectedEvent, uploadToS3, imagePreviews, compressAndReplaceImages]);

  const handleDownload = useCallback(async (url: string) => {
    try {
      const response = await fetch(url, {
        mode: 'cors',
        headers: {
          'Cache-Control': 'no-cache',
        },
      });

      if (!response.ok) {
        const errorMessage = `Failed to download image (${response.status}): ${response.statusText}`;
        console.error(errorMessage);
        alert(errorMessage);
        throw new Error(errorMessage);
      }

      const contentType = response.headers.get('content-type');
      if (!contentType || !contentType.includes('image/')) {
        const errorMessage = 'Invalid image format received';
        console.error(errorMessage);
        alert(errorMessage);
        throw new Error(errorMessage);
      }

      const blob = await response.blob();
      const fileName = decodeURIComponent(url.split('/').pop() || 'image.jpg');

      const link = document.createElement('a');
      link.href = window.URL.createObjectURL(blob);
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(link.href);
      console.log(`Successfully downloaded: ${fileName}`);
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : 'An unexpected error occurred while downloading the image';
      console.error('Error downloading image:', error);
      alert(errorMessage);
      throw error;
    }
  }, []);

  const handleDownloadAll = useCallback(async () => {
    const downloadPromises = uploadedUrls.map(url =>
      handleDownload(url).catch(error => ({ error, url }))
    );
    const results = await Promise.allSettled(downloadPromises);

    let successCount = 0;
    let failedUrls: string[] = [];
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        successCount++;
      } else {
        failedUrls.push(uploadedUrls[index]);
      }
    });

    if (failedUrls.length === 0) {
      alert(`Successfully downloaded all ${successCount} images!`);
    } else {
      alert(`Downloaded ${successCount} images. Failed to download ${failedUrls.length} images. Please try again later.`);
    }
  }, [uploadedUrls, handleDownload]);

  const handleCopyLink = useCallback(() => {
    const link = `${window.location.origin}/attendee-dashboard?eventId=${selectedEvent}`;
    navigator.clipboard.writeText(link);
    setShowCopySuccess(true);
    setTimeout(() => setShowCopySuccess(false), 2000);
  }, [selectedEvent]);

  const handleDownloadQR = useCallback(() => {
    try {
      const canvas = document.createElement('canvas');
      const svg = document.querySelector('.qr-modal svg');
      if (!svg) {
        throw new Error('QR code SVG element not found');
      }
      const svgData = new XMLSerializer().serializeToString(svg);
      const img = new Image();
      img.onload = () => {
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          throw new Error('Could not get canvas context');
        }
        ctx.drawImage(img, 0, 0);
        canvas.toBlob((blob) => {
          if (!blob) {
            throw new Error('Could not create image blob');
          }
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `selfie-upload-qr-${selectedEvent}.png`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }, 'image/png');
      };
      img.src = 'data:image/svg+xml;base64,' + btoa(svgData);
    } catch (error) {
      console.error('Error downloading QR code:', error);
      alert('Failed to download QR code. Please try again.');
    }
  }, [selectedEvent]);

  // Add a function to check if the user is authorized to upload
  const checkAuthorization = useCallback(async (eventId: string) => {
    if (!eventId) {
      setIsAuthorized(null);
      setAuthorizationMessage('');
      return;
    }

    const userEmail = localStorage.getItem('userEmail');
    if (!userEmail) {
      setIsAuthorized(false);
      setAuthorizationMessage('You need to log in to upload images.');
      return;
    }

    try {
      const event = await getEventById(eventId);
      if (!event) {
        setIsAuthorized(false);
        setAuthorizationMessage('Event not found with the provided code.');
        return;
      }

      // Check if user is the event creator
      if (event.organizerId === userEmail || event.userEmail === userEmail) {
        setIsAuthorized(true);
        setAuthorizationMessage('You are authorized as the event creator.');
        return;
      }

      // Check if user's email is in the emailAccess list
      if (event.emailAccess && Array.isArray(event.emailAccess) && event.emailAccess.includes(userEmail)) {
        setIsAuthorized(true);
        setAuthorizationMessage('You are authorized to upload to this event.');
        return;
      }

      // User is not authorized
      setIsAuthorized(false);
      setAuthorizationMessage('You are not authorized to upload images to this event.');
    } catch (error) {
      console.error('Error checking authorization:', error);
      setIsAuthorized(false);
      setAuthorizationMessage('Error checking authorization. Please try again.');
    }
  }, []);

  // Add event handler for the event code input
  const handleEventCodeSubmit = useCallback(async () => {
    if (!eventCode) {
      alert('Please enter an event code.');
      return;
    }

    try {
      const event = await getEventById(eventCode);
      if (!event) {
        setIsAuthorized(false);
        setAuthorizationMessage('Event not found with the provided code.');
        return;
      }

      // Set the event details
      setSelectedEvent(eventCode);
      setEventId(eventCode);
      localStorage.setItem('currentEventId', eventCode);
      
      // Check authorization
      await checkAuthorization(eventCode);
    } catch (error) {
      console.error('Error checking event code:', error);
      setIsAuthorized(false);
      setAuthorizationMessage('Error checking event code. Please try again.');
    }
  }, [eventCode, checkAuthorization]);

  // Check authorization when event is selected from dropdown
  useEffect(() => {
    if (selectedEvent) {
      checkAuthorization(selectedEvent);
    }
  }, [selectedEvent, checkAuthorization]);

  return (
    <div className="relative bg-grey-100 min-h-screen">
      {/* Add spacer div to push content below navbar */}
      <div className="h-14 sm:h-16 md:h-20"></div>
      
      <div className="container mx-auto px-4 py-2 relative z-10 mt-4">
        <video autoPlay loop muted className="fixed top-0 left-0 w-full h-full object-cover opacity-100 -z-10">
          <source src="tiny.mp4" type="video/mp4" />
          Your browser does not support the video tag.
        </video>
        <div className="relative z-10 container mx-auto px-4 py-4">
          <div className="max-w-lg mx-auto bg-white p-3 sm:p-5 rounded-lg shadow-md border-4 border-blue-900">
            <div className="flex flex-col items-center justify-center mb-4 sm:mb-6 space-y-4">
              {/* Event selection dropdown */}
              <select
                value={selectedEvent}
                onChange={(e) => {
                  const newEventId = e.target.value;
                  setSelectedEvent(newEventId);
                  setEventId(newEventId);
                  // Store in localStorage for persistence
                  if (newEventId) {
                    localStorage.setItem('currentEventId', newEventId);
                  }
                }}
                className="border border-blue-400 rounded-lg px-4 py-2 w-full max-w-md text-black focus:outline-none focus:border-blue-900 bg-white"
              >
                <option value="">Select an Event</option>
                {events.map(event => (
                  <option key={event.id} value={event.id}>
                    {event.name}
                  </option>
                ))}
              </select>

              {/* Or text divider */}
              <div className="flex items-center w-full max-w-md">
                <div className="flex-grow h-px bg-gray-300"></div>
                <span className="px-4 text-gray-500 text-sm">OR</span>
                <div className="flex-grow h-px bg-gray-300"></div>
              </div>

              {/* Event code input */}
              <div className="flex flex-col sm:flex-row w-full max-w-md space-y-2 sm:space-y-0 sm:space-x-2">
                <input
                  type="text"
                  value={eventCode}
                  onChange={(e) => setEventCode(e.target.value)}
                  placeholder="Enter Event Code"
                  className="w-full border border-blue-400 rounded-lg px-4 py-2 text-black focus:outline-none focus:border-blue-900 bg-white"
                />
                <button
                  onClick={handleEventCodeSubmit}
                  className="w-full sm:w-auto px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors duration-200 font-medium min-w-[90px]"
                >
                  Access
                </button>
              </div>

              {/* Authorization status message */}
              {isAuthorized !== null && (
                <div className={`w-full max-w-md p-3 rounded-lg text-sm ${
                  isAuthorized 
                    ? 'bg-green-100 text-green-800 border border-green-300' 
                    : 'bg-red-100 text-red-800 border border-red-300'
                }`}>
                  <div className="flex items-center space-x-2">
                    {isAuthorized 
                      ? <div className="bg-green-200 p-1 rounded-full"><Camera className="w-4 h-4 text-green-700" /></div>
                      : <div className="bg-red-200 p-1 rounded-full"><ShieldAlert className="w-4 h-4 text-red-700" /></div>
                    }
                    <span>{authorizationMessage}</span>
                  </div>
                </div>
              )}

              <h2 className="text-xl sm:text-2xl font-bold text-black text-center">Upload Images</h2>
            </div>
            <div className="space-y-4">
              {/* Only show upload section if authorized */}
              {isAuthorized === true ? (
                <>
                  <div className="flex items-center justify-center w-full">
                    <label
                      htmlFor="file-upload"
                      className="w-full flex flex-col items-center px-4 py-6 bg-blue-100 rounded-lg border-2 border-turquoise border-dashed cursor-pointer hover:border-blue-300 hover:bg-champagne transition-colors duration-200"
                    >
                      <div className="flex flex-col items-center">
                        <img src="/upload-placeholder.svg" alt="Upload" className="w-full h-24 sm:h-32 md:h-36 object-contain" />
                        <p className="text-xs text-blue-500 mt-1">PNG, JPEG, JPG (200MB max) <br /> 50 images/batch for large files</p>
                      </div>
                      <input
                        id="file-upload"
                        type="file"
                        multiple
                        className="hidden"
                        onChange={handleImageChange}
                        accept="image/*"
                      />
                    </label>
                  </div>
                
                  {/* Rest of the upload functionality */}
                  {images.length > 0 && (
                    <div className="mt-4">
                      <p className="text-sm text-blue-600 mb-2">{images.length} file(s) selected</p>
                      <div className="flex flex-wrap gap-2 max-h-60 overflow-y-auto p-2">
                        {images.map((image, index) => (
                          <div key={index} className="relative group">
                            <img
                              src={URL.createObjectURL(image)}
                              alt={`Preview ${index + 1}`}
                              className="w-20 h-20 object-cover rounded"
                            />
                            <button
                              onClick={() => removeImage(index)}
                              className="absolute -top-2 -right-2 bg-blue-500 text-white rounded-full p-1 opacity-0 group-hover:opacity-100 transition-opacity"
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                
                  {uploadSuccess && uploadedUrls.length > 0 && (
                    <div className="mt-4 p-3 sm:p-4 bg-blue-50 rounded-xl shadow-lg border-2 border-blue-200">
                      <h3 className="text-lg font-bold mb-3 text-blue-800 flex items-center">
                        <Camera className="w-4 h-4 mr-2" />
                        Uploaded Images
                      </h3>
                      
                      <div 
                        ref={containerRef}
                        className="grid grid-cols-2 sm:grid-cols-3 gap-2 sm:gap-3 max-h-[320px] overflow-auto p-2 sm:p-3 bg-white rounded-lg shadow-inner"
                      >
                        {uploadedUrls.map((url, index) => (
                          <div key={index} className="relative">
                            <div className="rounded-lg overflow-hidden shadow-md">
                              <img
                                src={url}
                                alt={`Uploaded ${index + 1}`}
                                className="w-full aspect-square object-cover"
                              />
                            </div>
                            <button
                              onClick={() => handleDownload(url)}
                              className="absolute bottom-2 right-2 p-2 bg-white rounded-full shadow-md hover:bg-blue-100 transition-colors"
                              title="Download Image"
                            >
                              <Download className="h-4 w-4 text-blue-700" />
                            </button>
                          </div>
                        ))}
                        {currentPage * IMAGES_PER_PAGE < uploadedUrls.length && (
                          <div className="col-span-full text-center py-4">
                            <Loader2 className="w-6 h-6 animate-spin mx-auto text-blue-500" />
                            <p className="text-sm text-blue-500 mt-2">Loading more images...</p>
                          </div>
                        )}
                      </div>
                      
                      <div className="mt-3 flex justify-between items-center">
                        <div className="text-sm text-blue-700 font-medium">
                          {uploadedUrls.length} {uploadedUrls.length === 1 ? 'image' : 'images'} uploaded
                        </div>
                        {uploadedUrls.length > 1 && (
                          <button
                            onClick={handleDownloadAll}
                            className="flex items-center justify-center py-1.5 px-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors duration-200 shadow-md text-sm"
                          >
                            <Download className="w-3.5 h-3.5 mr-1.5" />
                            Download All
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                
                  <button
                    onClick={handleUpload}
                    disabled={isUploading || images.length === 0}
                    className={`w-full py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white ${
                      isUploading || images.length === 0 
                        ? 'bg-gray-400 cursor-not-allowed opacity-50' 
                        : 'bg-blue-500 hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500'
                    } transition-colors duration-200`}
                  >
                    {isUploading ? (
                      <span className="flex items-center justify-center">
                        <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                        Uploading {uploadProgress?.current}/{uploadProgress?.total}...
                      </span>
                    ) : images.length === 0 ? (
                      'Select images to upload'
                    ) : (
                      `Upload ${images.length} Image${images.length > 1 ? 's' : ''}`
                    )}
                  </button>
                
                  {isUploading && uploadProgress && (
                    <div className="mt-2 w-full bg-gray-200 rounded-full h-2.5">
                      <div 
                        className="bg-blue-600 h-2.5 rounded-full transition-all duration-300" 
                        style={{ width: `${(uploadProgress.current / uploadProgress.total) * 100}%` }}
                      ></div>
                    </div>
                  )}
                </>
              ) : isAuthorized === false ? (
                <div className="text-center py-8">
                  <div className="bg-red-100 p-6 rounded-lg inline-flex flex-col items-center">
                    <ShieldAlert className="w-12 h-12 text-red-500 mb-4" />
                    <h3 className="text-lg font-medium text-red-800">Access Denied</h3>
                    <p className="text-red-700 mt-2 max-w-md">
                      You don't have permission to upload images to this event. 
                      Please contact the event organizer to request access.
                    </p>
                  </div>
                </div>
              ) : (
                <div className="text-center py-8 text-gray-500">
                  Please select an event or enter an event code to continue.
                </div>
              )}
            </div>
            
            {/* QR Modal and other existing components */}
            {showQRModal && (
              <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[9999] p-4 overflow-y-auto">
                <div className="bg-blue-300 rounded-lg p-4 sm:p-6 max-w-sm w-full relative mx-auto mt-20 md:mt-0 mb-20 md:mb-0">
                  <div className="absolute top-2 right-2">
                    <button 
                      onClick={() => setShowQRModal(false)} 
                      className="bg-white rounded-full p-1 text-gray-500 hover:text-gray-700 shadow-md hover:bg-gray-100 transition-colors"
                    >
                      <X className="w-5 h-5" />
                    </button>
                  </div>
                  <div className="flex flex-col items-center space-y-4 pt-6">                    
                    <h3 className="text-lg sm:text-xl font-semibold text-center">Share Event</h3>
                    <p className="text-sm text-blue-700 mb-2 text-center px-2">Share this QR code or link with others to let them find their photos</p>
                    <div className="qr-modal relative bg-white p-3 rounded-lg mx-auto flex justify-center">
                      <QRCodeSVG
                        value={`${window.location.origin}/attendee-dashboard?eventId=${selectedEvent}`}
                        size={180}
                        level="H"
                        includeMargin={true}
                        bgColor="#FFFFFF"
                        fgColor="#000000"
                      />
                      <button
                        onClick={() => {
                          const canvas = document.createElement('canvas');
                          const qrCode = document.querySelector('.qr-modal svg');
                          if (!qrCode) return;
                          
                          const serializer = new XMLSerializer();
                          const svgStr = serializer.serializeToString(qrCode);
                          
                          const img = new Image();
                          img.src = 'data:image/svg+xml;base64,' + btoa(svgStr);
                          
                          img.onload = () => {
                            canvas.width = img.width;
                            canvas.height = img.height;
                            const ctx = canvas.getContext('2d');
                            if (!ctx) return;
                            
                            ctx.fillStyle = '#FFFFFF';
                            ctx.fillRect(0, 0, canvas.width, canvas.height);
                            ctx.drawImage(img, 0, 0);
                            
                            canvas.toBlob((blob) => {
                              if (!blob) return;
                              const url = URL.createObjectURL(blob);
                              const a = document.createElement('a');
                              a.href = url;
                              a.download = `qr-code-${selectedEvent}.png`;
                              document.body.appendChild(a);
                              a.click();
                              document.body.removeChild(a);
                              URL.revokeObjectURL(url);
                            }, 'image/png');
                          };
                        }}
                        className="absolute top-0 right-0 -mt-2 -mr-2 p-1 bg-white rounded-full shadow-md hover:bg-gray-50 transition-colors"
                        title="Download QR Code"
                      >
                        <Download className="w-4 h-4 text-gray-600" />
                      </button>
                    </div>
                    <div className="w-full">
                      <div className="flex items-center justify-between gap-2 p-2 bg-gray-50 rounded">
                        <input
                          type="text"
                          readOnly
                          value={`${window.location.origin}/attendee-dashboard?eventId=${selectedEvent}`}
                          className="flex-1 bg-transparent text-sm overflow-hidden text-ellipsis outline-none"
                        />
                        <button 
                          onClick={handleCopyLink} 
                          className="px-3 py-1.5 bg-blue-500 text-white rounded hover:bg-blue-600 transition-colors flex items-center gap-1 flex-shrink-0"
                        >
                          <Copy className="w-4 h-4" />
                          Copy
                        </button>
                      </div>
                      {showCopySuccess && <p className="text-sm text-green-600 mt-1 text-center">Link copied to clipboard!</p>}
                    </div>
                  </div>
                </div>
              </div>
            )}
            {/*
            {/* Add compression progress indicator */}
            {isCompressing && compressionProgress && (
              <div className="fixed bottom-4 right-4 bg-white p-4 rounded-lg shadow-lg">
                <div className="flex items-center space-x-2">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Compressing images: {compressionProgress.current}/{compressionProgress.total}</span>
                </div>
                <div className="mt-2 w-full bg-gray-200 rounded-full h-2">
                  <div 
                    className="bg-blue-600 h-2 rounded-full transition-all duration-300" 
                    style={{ width: `${(compressionProgress.current / compressionProgress.total) * 100}%` }}
                  ></div>
                </div>
              </div> 
            )}
            
          </div>
        </div>
      </div>
    </div>
  );
};

export default UploadImage;
