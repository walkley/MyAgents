/**
 * Shared file type utilities
 *
 * Used by both frontend and backend for consistent file type detection.
 */

/** Image file extensions that should be treated as image attachments (not copied to myagents_files) */
export const IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'bmp',
  'ico',
]);

/**
 * Check if a filename represents an image file based on extension
 */
export function isImageFile(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return IMAGE_EXTENSIONS.has(ext);
}

/**
 * Get file extension from filename (lowercase, without dot)
 */
export function getFileExtension(filename: string): string {
  return filename.split('.').pop()?.toLowerCase() ?? '';
}

/**
 * Supported image MIME types for clipboard/attachment handling
 */
export const ALLOWED_IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
];

/**
 * Check if a MIME type is a supported image type
 */
export function isImageMimeType(mimeType: string): boolean {
  return ALLOWED_IMAGE_MIME_TYPES.includes(mimeType) || mimeType.startsWith('image/');
}

/** Text-based file extensions that can be previewed in FilePreviewModal */
export const PREVIEWABLE_EXTENSIONS = new Set([
  'txt', 'md', 'json', 'js', 'ts', 'tsx', 'jsx', 'html', 'css', 'scss',
  'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'log', 'sh', 'bash',
  'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'hpp', 'swift', 'kt',
  // Dotfiles (e.g., .gitignore -> extension is 'gitignore')
  'gitignore', 'dockerignore', 'editorconfig', 'prettierrc', 'eslintrc',
  'npmrc', 'nvmrc', 'env', 'local', 'example', 'development', 'production',
]);

/**
 * Check if a filename can be previewed as text (code / markdown / plain text)
 */
export function isPreviewable(filename: string): boolean {
  const ext = getFileExtension(filename);
  return PREVIEWABLE_EXTENSIONS.has(ext);
}
