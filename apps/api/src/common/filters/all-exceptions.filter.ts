import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger
} from "@nestjs/common";

interface DbErrorLike {
  code?: string;
  name?: string;
  message?: string;
}

interface ErrorPayload {
  code: string;
  message: string;
  requestId?: string;
  details?: unknown;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<any>();
    const request = ctx.getRequest<any>();
    const requestId = request.requestId ?? "unknown";

    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const dbError = exception as DbErrorLike;
    const isDbUnavailableError =
      dbError?.code === "P1001" ||
      dbError?.name === "PrismaClientInitializationError" ||
      dbError?.message?.includes("Can't reach database server");
    const statusCodeName = this.getStatusCodeName(status);

    if (exception instanceof HttpException) {
      const exceptionResponse = exception.getResponse();
      const parsed = this.parseHttpExceptionResponse(exceptionResponse, statusCodeName, requestId);
      response.status(status).json({ error: parsed });
      return;
    }

    this.logUnexpectedError(exception, requestId, request);
    if (isDbUnavailableError) {
      response.status(HttpStatus.SERVICE_UNAVAILABLE).json({
        error: {
          code: "SERVICE_UNAVAILABLE",
          message: "Database unavailable.",
          requestId
        }
      });
      return;
    }

    const message =
      process.env.NODE_ENV === "production" ? "Something went wrong." : "Unexpected error.";
    response.status(status).json({
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message,
        requestId
      }
    });
  }

  private parseHttpExceptionResponse(
    exceptionResponse: string | object,
    defaultCode: string,
    requestId: string
  ): ErrorPayload {
    if (typeof exceptionResponse === "string") {
      return {
        code: defaultCode,
        message: exceptionResponse,
        requestId
      };
    }

    const responseBody = exceptionResponse as {
      code?: string;
      message?: string | string[];
      details?: unknown;
    };

    if (responseBody.code === "VALIDATION_ERROR") {
      return {
        code: "VALIDATION_ERROR",
        message: typeof responseBody.message === "string" ? responseBody.message : "Invalid request.",
        details: responseBody.details ?? [],
        requestId
      };
    }

    const message =
      typeof responseBody.message === "string"
        ? responseBody.message
        : Array.isArray(responseBody.message)
          ? responseBody.message.join(", ")
          : "Request failed.";

    return {
      code: responseBody.code ?? defaultCode,
      message,
      requestId
    };
  }

  private getStatusCodeName(status: number): string {
    const label = HttpStatus[status];
    return typeof label === "string" ? label : `HTTP_${status}`;
  }

  private logUnexpectedError(exception: unknown, requestId: string, request: any): void {
    const safePath = request.originalUrl ?? request.url;
    const baseMessage = `Unhandled error [requestId=${requestId}] ${request.method} ${safePath}`;

    if (exception instanceof Error) {
      this.logger.error(baseMessage, exception.stack);
      return;
    }

    this.logger.error(`${baseMessage} ${JSON.stringify(exception)}`);
  }
}
