import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Logger } from '../utils/logger.js';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.tiff']);

export interface OutputFile {
  filePath:  string;
  fileName:  string;
  extension: string;
  isImage:   boolean;
  sizeBytes: number;
}

export class OutputsManager {
  constructor(
    private baseDir: string,
    private logger: Logger,
  ) {}

  /**
   * Prepare the per-bot outputs directory.
   * The directory is now per-bot (not per-chat) — e.g. /tmp/metabot_temp_<user>_<bot>/
   * Clear all existing files to ensure a clean slate before each execution.
   */
  prepareDir(_chatId: string): string {
    const dir = this.baseDir;
    try {
      if (fs.existsSync(dir)) {
        // Clear all files in the directory
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile()) continue;
          try { fs.unlinkSync(path.join(dir, entry.name)); } catch { /* ignore */ }
        }
      } else {
        fs.mkdirSync(dir, { recursive: true });
      }
    } catch {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.logger.debug({ dir }, 'Prepared outputs directory');
    return dir;
  }

  /** Scan the outputs directory and return metadata for each file found. */
  scanOutputs(outputsDir: string): OutputFile[] {
    const results: OutputFile[] = [];
    try {
      if (!fs.existsSync(outputsDir)) return results;
      const entries = fs.readdirSync(outputsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const filePath = path.join(outputsDir, entry.name);
        const ext      = path.extname(entry.name).toLowerCase();
        const stat     = fs.statSync(filePath);
        if (stat.size === 0) continue;
        results.push({
          filePath,
          fileName:  entry.name,
          extension: ext,
          isImage:   IMAGE_EXTENSIONS.has(ext),
          sizeBytes: stat.size,
        });
      }
    } catch (err) {
      this.logger.warn({ err, outputsDir }, 'Failed to scan outputs directory');
    }
    return results;
  }

  /**
   * Immediately clean up all files in the outputs directory.
   * Called after files have been sent — no deferred cleanup needed since
   * output-handler already deletes each file after sending.
   */
  cleanup(outputsDir: string): void {
    try {
      if (!fs.existsSync(outputsDir)) return;
      const entries = fs.readdirSync(outputsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        try { fs.unlinkSync(path.join(outputsDir, entry.name)); } catch { /* ignore */ }
      }
      this.logger.debug({ outputsDir }, 'Cleaned up outputs directory');
    } catch { /* ignore */ }
  }

  /** Check if a file extension is a text-based format that can be sent as text. */
  static isTextFile(ext: string): boolean {
    const textExts = new Set(['.txt', '.md', '.csv', '.json', '.xml', '.yaml', '.yml', '.log', '.html', '.css', '.js', '.ts', '.py', '.sh', '.sql', '.ini', '.cfg', '.conf', '.toml']);
    return textExts.has(ext);
  }

  /** Map file extension to Feishu file type for im.v1.file.create. */
  static feishuFileType(ext: string): string {
    switch (ext) {
      case '.pdf':  return 'pdf';
      case '.doc':
      case '.docx': return 'doc';
      case '.xls':
      case '.xlsx': return 'xls';
      case '.ppt':
      case '.pptx': return 'ppt';
      default:      return 'stream';
    }
  }
}
