export class BackendError extends Error {
  httpStatus: number;
  errorType: string;
  errorCode: string;

  constructor(
    message: string,
    httpStatus: number,
    errorType: string,
    errorCode: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "BackendError";
    this.httpStatus = httpStatus;
    this.errorType = errorType;
    this.errorCode = errorCode;
  }
}
