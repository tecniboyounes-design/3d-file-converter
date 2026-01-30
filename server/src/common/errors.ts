/**
 * Custom error classes for consistent error handling
 */

export class AppError extends Error {
  constructor(
    message: string,
    public statusCode: number = 500,
    public code: string = 'INTERNAL_ERROR'
  ) {
    super(message);
    this.name = 'AppError';
    Error.captureStackTrace(this, this.constructor);
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, 400, 'VALIDATION_ERROR');
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends AppError {
  constructor(message: string = 'Resource not found') {
    super(message, 404, 'NOT_FOUND');
    this.name = 'NotFoundError';
  }
}

export class ConversionError extends AppError {
  constructor(message: string, public details?: string) {
    super(message, 500, 'CONVERSION_ERROR');
    this.name = 'ConversionError';
  }
}

export class TimeoutError extends AppError {
  constructor(message: string = 'Operation timed out') {
    super(message, 408, 'TIMEOUT');
    this.name = 'TimeoutError';
  }
}

export class UnsupportedFormatError extends AppError {
  constructor(format: string) {
    super(`Unsupported format: ${format}`, 400, 'UNSUPPORTED_FORMAT');
    this.name = 'UnsupportedFormatError';
  }
}
