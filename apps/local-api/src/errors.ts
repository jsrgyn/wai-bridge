export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
export const badRequest = (message = 'Invalid request') =>
  new ApiError(400, 'VALIDATION_ERROR', message);
export const unauthorized = () => new ApiError(401, 'UNAUTHORIZED', 'Authentication required');
export const forbidden = () => new ApiError(403, 'FORBIDDEN', 'Operation not authorized');
export const notFound = (resource = 'Resource') =>
  new ApiError(404, 'NOT_FOUND', `${resource} not found`);
export const conflict = (code = 'CONFLICT', message = 'Operation conflicts with current state') =>
  new ApiError(409, code, message);
