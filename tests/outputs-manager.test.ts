import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { OutputsManager } from '../src/bridge/outputs-manager.js';

const mockLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as any;

describe('OutputsManager', () => {
  let tmpDir: string;
  let manager: OutputsManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-test-'));
    manager = new OutputsManager(tmpDir, mockLogger);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('prepareDir', () => {
    it('returns the base directory (per-bot, not per-chat)', () => {
      const dir = manager.prepareDir('chat-123');
      expect(fs.existsSync(dir)).toBe(true);
      expect(dir).toBe(tmpDir);
    });

    it('clears all existing files on prepare', () => {
      const dir = manager.prepareDir('chat-123');
      fs.writeFileSync(path.join(dir, 'old.txt'), 'old content');
      fs.writeFileSync(path.join(dir, 'recent.txt'), 'recent content');
      const dir2 = manager.prepareDir('chat-456');
      // All files should be cleared regardless of age
      expect(fs.readdirSync(dir2)).toHaveLength(0);
    });

    it('creates directory if it does not exist', () => {
      const newDir = path.join(tmpDir, 'subdir');
      const subManager = new OutputsManager(newDir, mockLogger);
      const dir = subManager.prepareDir('chat-123');
      expect(fs.existsSync(dir)).toBe(true);
    });
  });

  describe('scanOutputs', () => {
    it('returns empty for non-existent directory', () => {
      expect(manager.scanOutputs('/nonexistent')).toEqual([]);
    });

    it('detects image files', () => {
      const dir = manager.prepareDir('chat-1');
      fs.writeFileSync(path.join(dir, 'chart.png'), 'fake-png-data');

      const files = manager.scanOutputs(dir);
      expect(files).toHaveLength(1);
      expect(files[0].fileName).toBe('chart.png');
      expect(files[0].isImage).toBe(true);
      expect(files[0].extension).toBe('.png');
    });

    it('detects non-image files', () => {
      const dir = manager.prepareDir('chat-1');
      fs.writeFileSync(path.join(dir, 'report.pdf'), 'fake-pdf-data');

      const files = manager.scanOutputs(dir);
      expect(files).toHaveLength(1);
      expect(files[0].isImage).toBe(false);
      expect(files[0].extension).toBe('.pdf');
    });

    it('skips empty files', () => {
      const dir = manager.prepareDir('chat-1');
      fs.writeFileSync(path.join(dir, 'empty.txt'), '');

      const files = manager.scanOutputs(dir);
      expect(files).toHaveLength(0);
    });

    it('skips directories', () => {
      const dir = manager.prepareDir('chat-1');
      fs.mkdirSync(path.join(dir, 'subdir'));
      fs.writeFileSync(path.join(dir, 'file.txt'), 'content');

      const files = manager.scanOutputs(dir);
      expect(files).toHaveLength(1);
      expect(files[0].fileName).toBe('file.txt');
    });

    it('returns multiple files', () => {
      const dir = manager.prepareDir('chat-1');
      fs.writeFileSync(path.join(dir, 'a.png'), 'img');
      fs.writeFileSync(path.join(dir, 'b.pdf'), 'pdf');
      fs.writeFileSync(path.join(dir, 'c.jpg'), 'jpg');

      const files = manager.scanOutputs(dir);
      expect(files).toHaveLength(3);
    });
  });

  describe('cleanup', () => {
    it('immediately removes all files in the directory', () => {
      const dir = manager.prepareDir('chat-1');
      fs.writeFileSync(path.join(dir, 'file.txt'), 'data');
      fs.writeFileSync(path.join(dir, 'img.png'), 'png');
      manager.cleanup(dir);
      // Files should be removed immediately, directory still exists
      expect(fs.existsSync(dir)).toBe(true);
      expect(fs.readdirSync(dir)).toHaveLength(0);
    });

    it('handles non-existent directory gracefully', () => {
      expect(() => manager.cleanup('/nonexistent/path')).not.toThrow();
    });
  });

  describe('static methods', () => {
    it('isTextFile identifies text extensions', () => {
      expect(OutputsManager.isTextFile('.md')).toBe(true);
      expect(OutputsManager.isTextFile('.py')).toBe(true);
      expect(OutputsManager.isTextFile('.json')).toBe(true);
      expect(OutputsManager.isTextFile('.png')).toBe(false);
      expect(OutputsManager.isTextFile('.pdf')).toBe(false);
    });

    it('feishuFileType maps extensions correctly', () => {
      expect(OutputsManager.feishuFileType('.pdf')).toBe('pdf');
      expect(OutputsManager.feishuFileType('.docx')).toBe('doc');
      expect(OutputsManager.feishuFileType('.xlsx')).toBe('xls');
      expect(OutputsManager.feishuFileType('.pptx')).toBe('ppt');
      expect(OutputsManager.feishuFileType('.zip')).toBe('stream');
    });
  });
});
