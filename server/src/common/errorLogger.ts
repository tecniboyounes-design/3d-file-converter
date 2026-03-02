/**
 * Error Logger - Logs conversion errors to data/errorLogs file
 * 
 * Only logs on error cases. Each entry includes:
 * - Timestamp
 * - Input/output extensions
 * - Route taken
 * - Steps completed and which step failed
 * - Error message
 */

import fs from 'fs-extra';
import path from 'path';

const ERROR_LOG_PATH = path.resolve(process.cwd(), 'data', 'errorLogs');

export interface ConversionErrorLogEntry {
  inputFormat: string;
  outputFormat: string;
  fileName: string;
  route: string;
  stepsCompleted: string[];
  failedStep: string;
  errorMessage: string;
}

/**
 * Log a conversion error to the errorLogs file
 */
export async function logConversionError(entry: ConversionErrorLogEntry): Promise<void> {
  try {
    // Ensure data directory exists
    await fs.ensureDir(path.dirname(ERROR_LOG_PATH));

    const timestamp = new Date().toISOString();
    const separator = '─'.repeat(60);

    const logEntry = [
      separator,
      `[${timestamp}] CONVERSION ERROR`,
      `  File:          ${entry.fileName}`,
      `  Input Format:  ${entry.inputFormat.toUpperCase()}`,
      `  Output Format: ${entry.outputFormat.toUpperCase()}`,
      `  Route:         ${entry.route}`,
      `  Steps Completed:`,
      ...entry.stepsCompleted.map(s => `    ✓ ${s}`),
      `  Failed Step:   ✗ ${entry.failedStep}`,
      `  Error:         ${entry.errorMessage}`,
      separator,
      '', // blank line between entries
    ].join('\n');

    await fs.appendFile(ERROR_LOG_PATH, logEntry + '\n');
  } catch (logErr) {
    // Don't let logging errors affect the conversion flow
    console.error(`[ErrorLogger] Failed to write error log: ${logErr instanceof Error ? logErr.message : String(logErr)}`);
  }
}
