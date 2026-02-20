export class BackendError extends Error {
  httpStatus: number;
  errorType: string;
  errorCode: string;

  constructor(message: string, httpStatus: number, errorType: string, errorCode: string) {
    super(message);
    this.name = "BackendError";
    this.httpStatus = httpStatus;
    this.errorType = errorType;
    this.errorCode = errorCode;
  }
}
