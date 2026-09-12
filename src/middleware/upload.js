import multer from 'multer';

// Keep audio clips in memory (short voice-query clips, not large files) and
// cap size so a bad client can't exhaust server memory.
export const uploadAudio = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB - generous for a <=30s clip
});
