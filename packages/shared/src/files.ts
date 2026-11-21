// ============================================
// FTP Types
// ============================================

export interface FTPFileInfo {
  name: string;
  type: 'file' | 'directory';
  size: number;
  modifiedAt?: string | Date;
  path: string;
}

export interface FTPTreeNode extends FTPFileInfo {
  children?: FTPTreeNode[];
}

/**
 * The largest body of one program upload, for all its files: 32 MiB.
 * The server holds the files in memory while it sends them, and a Pi has only 512 MB.
 */
export const PROGRAM_UPLOAD_LIMIT_BYTES = 32 * 1024 * 1024;

// ============================================
// Upload History Types
// ============================================

export interface UploadFile {
  id: number;
  file_name: string;
  created_at: string;
  updated_at: string;
  event_count: number;
  last_path: string;
}

export interface UploadEvent {
  id: number;
  target_name: string | null;
  remote_path: string;
  uploaded_at: string;
  file_content?: string;
}
