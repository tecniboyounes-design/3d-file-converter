/**
 * Environment configuration with validation
 */

export interface Config {
  port: number;
  host: string;
  nodeEnv: 'development' | 'production' | 'test';
  logLevel: string;
  uploadDir: string;
  maxFileSize: number; // in bytes
  conversionTimeout: number; // in ms
  maxConcurrentBlender: number;
  maxConcurrentAssimp: number;
  cleanupIntervalMs: number;
  fileAgeLimitMs: number;
}

function getEnvVar(key: string, defaultValue?: string): string {
  const value = process.env[key] || defaultValue;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function getEnvNumber(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (value === undefined) return defaultValue;
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    throw new Error(`Environment variable ${key} must be a number`);
  }
  return parsed;
}

export const config: Config = {
  port: getEnvNumber('PORT', 3001),
  host: getEnvVar('HOST', '0.0.0.0'),
  nodeEnv: getEnvVar('NODE_ENV', 'development') as Config['nodeEnv'],
  logLevel: getEnvVar('LOG_LEVEL', 'info'),
  uploadDir: getEnvVar('UPLOAD_DIR', './data/uploads'),
  maxFileSize: getEnvNumber('MAX_FILE_SIZE', 100 * 1024 * 1024), // 100MB
  conversionTimeout: getEnvNumber('CONVERSION_TIMEOUT', 5 * 60 * 1000), // 5 minutes
  maxConcurrentBlender: getEnvNumber('MAX_CONCURRENT_BLENDER', 2),
  maxConcurrentAssimp: getEnvNumber('MAX_CONCURRENT_ASSIMP', 5),
  cleanupIntervalMs: getEnvNumber('CLEANUP_INTERVAL_MS', 60 * 1000), // 1 minute
  fileAgeLimitMs: getEnvNumber('FILE_AGE_LIMIT_MS', 2 * 60 * 1000), // 2 minutes
};

export default config;
