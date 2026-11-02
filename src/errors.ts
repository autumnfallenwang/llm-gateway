export class BackendError extends Error {
  httpStatus: number;
  errorType: string;
  errorCode: string;
  /** The request field the error is about (OpenAI's `error.param`), when it's one field. */
  param: string | null;

  constructor(
    message: string,
    httpStatus: number,
    errorType: string,
    errorCode: string,
    options?: { cause?: unknown; param?: string },
  ) {
    super(message, options);
    this.name = "BackendError";
    this.httpStatus = httpStatus;
    this.errorType = errorType;
    this.errorCode = errorCode;
    this.param = options?.param ?? null;
  }
}
