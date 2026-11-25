// video-routes.js
import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { uploadPublicBlob } from '../utils/azure-storage.js';
import { BlobServiceClient } from '@azure/storage-blob';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

// Safe video types with more flexible detection
function sniffVideoType(buf) {
    if (!buf || buf.length < 12) return null;
    
    // Check for MP4 (ftyp box at offset 4)
    // MP4 files start with '....ftyp' where the first 4 bytes can vary
    if (buf.length >= 12 && 
        buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) {
        return 'video/mp4';
    }
    
    // Check for MOV / QuickTime (moov or mdat)
    if (buf.length >= 8 && 
        ((buf[4] === 0x6D && buf[5] === 0x6F && buf[6] === 0x6F && buf[7] === 0x76) ||
         (buf[4] === 0x6D && buf[5] === 0x64 && buf[6] === 0x61 && buf[7] === 0x74))) {
        return 'video/quicktime';
    }
    
    // Check for WebM (EBML header)
    if (buf.length >= 4 && 
        buf[0] === 0x1A && buf[1] === 0x45 && buf[2] === 0xDF && buf[3] === 0xA3) {
        return 'video/webm';
    }
    
    // Check for AVI (RIFF header)
    if (buf.length >= 12 && 
        buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
        buf[8] === 0x41 && buf[9] === 0x56 && buf[10] === 0x49 && buf[11] === 0x20) {
        return 'video/avi';
    }
    
    // Check for M4V (similar to MP4)
    if (buf.length >= 12 && 
        buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) {
        return 'video/mp4';
    }
    
    return null;
} 

const UPLOAD_DIR = path.join('uploads', 'videos');
const VIDEOS_CONTAINER = process.env.AZURE_VIDEOS_CONTAINER || 'videos';
const AZURE_ENABLED = Boolean(process.env.AZURE_STORAGE_CONNECTION_STRING);

if (!AZURE_ENABLED && !fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

/* =========================
   Multer Configuration - Larger limit for videos
========================= */
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 500 * 1024 * 1024, // 500MB for videos
    },
    fileFilter: (_req, file, cb) => {
        // Allow common video types by extension and mime
        const allowedMimes = [
            'video/mp4', 
            'video/quicktime', 
            'video/webm', 
            'video/avi', 
            'video/x-msvideo', 
            'video/mov',
            'video/mpeg',
            'video/m4v'
        ];
        
        // Also check file extension as fallback
        const ext = path.extname(file.originalname).toLowerCase();
        const allowedExts = ['.mp4', '.mov', '.webm', '.avi', '.m4v', '.mpeg', '.mpg'];
        
        if (!allowedMimes.includes(file.mimetype) && !allowedExts.includes(ext)) {
            return cb(new Error('Only MP4, MOV, WebM, AVI, or M4V videos are allowed'));
        }
        cb(null, true);
    },
});

const uploadSingleVideo = (req, res, next) => {
    upload.single('video')(req, res, (err) => {
        if (err instanceof multer.MulterError) {
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(413).json({
                    error: 'Video size must be less than 500MB',
                });
            }
            return res.status(400).json({
                error: err.message,
            });
        }
        if (err) {
            return res.status(400).json({
                error: err.message,
            });
        }
        next();
    });
};

function buildObjectName(originalname) {
    const safeName = (originalname || 'video').replace(/[^\w.\-]+/g, '-');
    const rand = Math.random().toString(36).slice(2, 8);
    return `celebrity/video/${Date.now()}-${rand}-${safeName}`;
}

/* =========================
   Upload Video
========================= */
router.post('/', authenticateToken, uploadSingleVideo, async (req, res) => {
    if (!req.file) {
        return res.status(400).json({
            error: 'No file uploaded',
        });
    }

    // Verify video type by sniffing the buffer
    const contentType = sniffVideoType(req.file.buffer);
    
    // If sniffing fails, fallback to the file's mimetype or extension
    let finalContentType = contentType;
    if (!finalContentType) {
        // Try to determine from mimetype
        if (req.file.mimetype && req.file.mimetype.startsWith('video/')) {
            finalContentType = req.file.mimetype;
        } else {
            // Fallback to extension
            const ext = path.extname(req.file.originalname).toLowerCase();
            const extMap = {
                '.mp4': 'video/mp4',
                '.mov': 'video/quicktime',
                '.webm': 'video/webm',
                '.avi': 'video/avi',
                '.m4v': 'video/mp4',
                '.mpeg': 'video/mpeg',
                '.mpg': 'video/mpeg'
            };
            finalContentType = extMap[ext] || 'video/mp4';
        }
    }

    const objectName = buildObjectName(req.file.originalname);

    // Upload to Azure Blob Storage
    if (AZURE_ENABLED) {
        try {
            const url = await uploadPublicBlob(
                VIDEOS_CONTAINER,
                objectName,
                req.file.buffer,
                finalContentType,
            );
            return res.status(201).json({
                url,
                message: 'Video uploaded successfully',
            });
        } catch (error) {
            console.error('Video blob upload error:', error);
            // Fall through to disk fallback
        }
    }

    // Fallback: local disk
    try {
        if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
        const diskPath = path.join(UPLOAD_DIR, path.basename(objectName));
        fs.writeFileSync(diskPath, req.file.buffer);
        return res.status(201).json({
            url: `/uploads/videos/${path.basename(objectName)}`,
            message: 'Video uploaded successfully',
        });
    } catch (error) {
        console.error('Video disk write error:', error);
        return res.status(500).json({ error: 'Failed to store video' });
    }
});

/* =========================
   Delete Video
========================= */
router.delete('/:fileName', authenticateToken, async (req, res) => {
    try {
        const { fileName } = req.params;
        if (!fileName) {
            return res.status(400).json({
                error: 'File name is required',
            });
        }

        const safeFileName = path.basename(fileName);
        let removed = false;

        // Best-effort blob deletion
        if (AZURE_ENABLED) {
            try {
                const blobService = BlobServiceClient.fromConnectionString(
                    process.env.AZURE_STORAGE_CONNECTION_STRING,
                );
                const containerClient = blobService.getContainerClient(VIDEOS_CONTAINER);
                const result = await containerClient
                    .getBlockBlobClient(`celebrity/video/${safeFileName}`)
                    .deleteIfExists();
                removed = removed || result.succeeded;
            } catch (error) {
                console.error('Video blob deletion error:', error);
            }
        }

        // Best-effort disk deletion
        const filePath = path.join(UPLOAD_DIR, safeFileName);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            removed = true;
        }

        if (!removed) {
            return res.status(404).json({
                error: 'Video not found',
            });
        }

        res.status(200).json({
            message: 'Video deleted successfully',
        });
    } catch (error) {
        console.error('Video deletion error:', error);
        res.status(500).json({
            error: 'Failed to delete video',
        });
    }
});

export default router;
