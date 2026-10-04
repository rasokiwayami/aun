export class AppError extends Error {
  constructor(code, status = 422) { super(code); this.code = code; this.status = status; }
}
export function fail(code, status) { throw new AppError(code, status); }
export function requireThat(condition, code = 'invalid_input', status = 422) { if (!condition) fail(code, status); }
